import { Hono } from 'hono';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { env } from '../config/env.ts';
import { authenticate, requirePermission } from '../middleware/auth.ts';
import { saveUpload, getOwnedFile, deleteFile, ocrFile } from '../lib/files.ts';
import { sqliteConnection as sqlite } from '../db/client.ts';
import { darfInsVault, darfHerabstufen, normalisiereKlasse, KLASSEN } from '../lib/classification.ts';
import { indexFile, deleteFileIndex } from '../lib/rag.ts';
import { enqueueOcr, istOcrFähig } from '../lib/ocr-queue.ts';
import { hasPermission } from '../lib/permissions.ts';
import { logAudit, requestMeta } from '../lib/audit.ts';
import { log } from '../lib/logger.ts';
import type { AppEnv } from '../types.ts';

export const fileRoutes = new Hono<AppEnv>();
fileRoutes.use('*', authenticate);

// POST /api/upload — multipart, Feld "files" (ein- oder mehrfach).
fileRoutes.post('/upload', requirePermission('files.upload'), async (c) => {
  const user = c.get('user');
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'Ungültiger Upload' }, 400);
  }
  const uploaded = form.getAll('files').filter((f): f is File => f instanceof File);
  const chatId = (form.get('chatId') as string) || undefined;

  if (uploaded.length === 0) return c.json({ error: 'Keine Datei übermittelt' }, 400);
  if (uploaded.length > env.MAX_FILES_PER_QUERY) {
    return c.json({ error: `Maximal ${env.MAX_FILES_PER_QUERY} Dateien pro Upload` }, 400);
  }
  // Größen-Tier: mit Permission 'files.large' höheres Limit.
  const maxMb = hasPermission(user.id, user.role, 'files.large') ? env.MAX_UPLOAD_MB_LARGE : env.MAX_UPLOAD_MB;
  const maxBytes = maxMb * 1024 * 1024;
  for (const f of uploaded) {
    if (f.size > maxBytes) return c.json({ error: `"${f.name}" überschreitet ${maxMb} MB` }, 400);
  }

  try {
    const ocr = hasPermission(user.id, user.role, 'docs.ocr'); // Bilder per OCR lesen
    const rows = [];
    for (const f of uploaded) {
      const row = await saveUpload(user.id, f, chatId, ocr);
      // Alles mit Text (inkl. OCR-Bilder) für RAG indexieren.
      if (row.extractedText) {
        await indexFile(row.id, row.extractedText).catch((err) => log.warn('[Upload] Indexierung fehlgeschlagen', { error: (err as Error).message }));
      }
      // Ohne Textebene (Scan, Foto): Erkennung im Hintergrund anstoßen. Der
      // Upload wartet NICHT darauf — ein 8-seitiges PDF kostet rund 20 s.
      if (istOcrFähig(row.filename, row.extractedText)) enqueueOcr(row.id);
      rows.push({
        id: row.id,
        filename: row.filename,
        kind: row.kind,
        size: row.size,
        hasText: !!row.extractedText,
        chars: row.extractedText?.length ?? 0,
      });
    }
    logAudit({ ...requestMeta(c), userId: user.id, username: user.username, action: 'FILE_UPLOADED', resourceType: 'file',
      details: { anzahl: rows.length, dateien: rows.map((r) => r.filename).join(', '), chatId: chatId ?? null } });
    return c.json({ files: rows }, 201);
  } catch (err) {
    log.error('[Upload] Fehler', { error: (err as Error).message });
    return c.json({ error: 'Datei konnte nicht verarbeitet werden' }, 500);
  }
});

// GET /api/files/:id — Datei herunterladen (nur Eigentümer).
fileRoutes.get('/files/:id', (c) => {
  const user = c.get('user');
  const row = getOwnedFile(user.id, c.req.param('id'));
  if (!row) return c.json({ error: 'Datei nicht gefunden' }, 404);
  const stream = Readable.toWeb(createReadStream(row.storedPath)) as ReadableStream;
  c.header('Content-Type', row.mime || 'application/octet-stream');
  c.header('Content-Disposition', `inline; filename="${encodeURIComponent(row.filename)}"`);
  return c.body(stream);
});

// POST /api/files/:id/ocr — Text aus einem hochgeladenen Bild erkennen (offline).
// On-demand: bewusste Nutzeraktion auf dem eigenen Bild → nur files.upload nötig.
fileRoutes.post('/files/:id/ocr', requirePermission('files.upload'), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id')!;
  const res = await ocrFile(user.id, id);
  if (!res.ok) return c.json({ error: res.error ?? 'OCR fehlgeschlagen' }, res.error === 'Datei nicht gefunden' ? 404 : 400);
  // Erkannten Text für RAG indexieren (damit er auch im Kontext auffindbar ist).
  if (res.text.trim()) await indexFile(id, res.text).catch((err) => log.warn('[OCR] Indexierung fehlgeschlagen', { error: (err as Error).message }));
  logAudit({ ...requestMeta(c), userId: user.id, username: user.username, action: 'FILE_OCR', resourceType: 'file', resourceId: id, details: { zeichen: res.text.length } });
  return c.json({ text: res.text, chars: res.text.length });
});

// PATCH /api/files/:id/scope — Datei als Referenz markieren.
// Referenzdateien gelten in ALLEN Projekten des Nutzers. Gedacht für fachliche
// Grundlagen (Rechenlogik, Normen, Rohstofftabellen), die sonst in jedes
// Projekt einzeln hochgeladen werden müssten.
fileRoutes.patch('/files/:id/scope', requirePermission('files.upload'), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id')!;
  const row = getOwnedFile(user.id, id);
  if (!row) return c.json({ error: 'Datei nicht gefunden' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { userScope?: boolean };
  const neu = body.userScope === true ? 1 : 0;
  // Eine eingestufte Datei zur projektübergreifenden Referenz zu machen, zieht
  // sie in JEDEN Chat des Nutzers — und stuft damit jeden Chat hoch. Das ist
  // eine bewusste Entscheidung, keine Nebensache: nur mit dem Freigaberecht.
  if (neu === 1 && !darfInsVault(row.classification) && !darfHerabstufen(user.id, user.role)) {
    return c.json({
      error: `„${row.filename}" ist als „${KLASSEN[normalisiereKlasse(row.classification)].label}" eingestuft. ` +
        'Als projektübergreifende Referenz würde sie in jedes Ihrer Gespräche einfließen und diese hochstufen. ' +
        'Dafür wird das Recht „Einstufung herabsetzen" benötigt.',
    }, 403);
  }
  sqlite.prepare('UPDATE files SET user_scope = ? WHERE id = ? AND user_id = ?').run(neu, id, user.id);
  logAudit({ ...requestMeta(c), userId: user.id, username: user.username, action: 'FILE_SCOPE_SET',
    resourceType: 'file', resourceId: id, resourceLabel: row.filename, details: { referenz: neu === 1 } });
  return c.json({ ok: true, userScope: neu === 1 });
});

// GET /api/files/references — eigene Referenzdateien auflisten.
fileRoutes.get('/files/references', (c) => {
  const user = c.get('user');
  const rows = sqlite
    .prepare("SELECT id, filename, length(coalesce(extracted_text,'')) AS zeichen, classification FROM files WHERE user_id = ? AND user_scope = 1")
    .all(user.id);
  return c.json({ references: rows });
});

// DELETE /api/files/:id
fileRoutes.delete('/files/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const before = getOwnedFile(user.id, id);
  const ok = await deleteFile(user.id, id);
  if (ok) {
    deleteFileIndex(id);
    logAudit({ ...requestMeta(c), userId: user.id, username: user.username, action: 'FILE_DELETED', resourceType: 'file', resourceId: id, resourceLabel: before?.filename ?? null });
  }
  return ok ? c.json({ ok: true }) : c.json({ error: 'Datei nicht gefunden' }, 404);
});
