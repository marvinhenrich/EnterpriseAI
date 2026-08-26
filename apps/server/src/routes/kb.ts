import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { authenticate, requirePermission } from '../middleware/auth.ts';
import { env } from '../config/env.ts';
import {
  addKbDocument,
  listKbDocuments,
  listKbDocumentsFor,
  deleteKbDocument,
  getKbDocument,
  getKbDocumentFor,
  updateKbDocument,
  getKbDocumentText,
  retrieveKb,
} from '../lib/kb.ts';
import {
  listNotes,
  listNotesFor,
  getNote,
  getNoteFor,
  getNoteByTitle,
  createNote,
  updateNote,
  deleteNote,
  backlinksFor,
  outgoingLinks,
  parseTags,
  normalizeTags,
  normalizeFolder,
  vaultStats,
  searchVaultText,
  listRevisions,
  getRevision,
  restoreRevision,
} from '../lib/vault.ts';
import { logAudit, logChange, requestMeta } from '../lib/audit.ts';
import { normalizeVisibility, VISIBILITY } from '../lib/visibility.ts';
import { log } from '../lib/logger.ts';
import type { AppEnv } from '../types.ts';
import { modulAktiv } from '../lib/module.ts';

// =============================================================================
// Wissens-Vault: Notizen (Obsidian-artig) + Dokumente + Suche.
// Lesen: Permission kb.query · Pflegen: kb.manage.
// =============================================================================

export const kbRoutes = new Hono<AppEnv>();
kbRoutes.use('*', authenticate);

// Modul abgeschaltet -> Bereich existiert für den Nutzer nicht. Die Route
// antwortet dann einheitlich mit 404, statt halb zu funktionieren.
kbRoutes.use('*', async (c, next) => {
  if (!modulAktiv('vault')) return c.json({ error: 'Dieser Bereich ist in dieser Installation nicht aktiv.' }, 404);
  await next();
});

const docView = (d: ReturnType<typeof listKbDocuments>[number]) => ({
  id: d.id,
  title: d.title,
  filename: d.filename,
  size: d.size,
  chunks: d.chunks,
  folder: d.folder ?? '',
  tags: parseTags(d.tags),
  visibility: d.visibility ?? '',
  aiUse: !!d.aiUse,
  mime: d.mime,
  createdAt: d.createdAt,
});

const noteView = (n: ReturnType<typeof listNotes>[number]) => ({
  id: n.id,
  title: n.title,
  folder: n.folder ?? '',
  tags: parseTags(n.tags),
  visibility: n.visibility ?? '',
  aiUse: !!n.aiUse,
  chunks: n.chunks,
  createdByName: n.createdByName,
  updatedByName: n.updatedByName,
  createdAt: n.createdAt,
  updatedAt: n.updatedAt,
});

// --- Übersicht: Notizen + Dokumente + Ordner + Tags --------------------------
kbRoutes.get('/kb/overview', requirePermission('kb.query'), (c) => {
  const user = c.get('user');
  const viewer = { userId: user.id, role: user.role };
  return c.json({
    notes: listNotesFor(viewer).map(noteView),
    documents: listKbDocumentsFor(viewer).map(docView),
    stats: vaultStats(viewer),
    // Welche Stufen darf dieser Nutzer vergeben/sehen (für die Oberfläche)?
    visibilityLevels: Object.entries(VISIBILITY).map(([key, v]) => ({ key, label: v.label, help: v.help })),
  });
});

// Bestandsroute (Kompatibilität): reine Dokumentliste.
kbRoutes.get('/kb/documents', requirePermission('kb.query'), (c) => {
  const user = c.get('user');
  return c.json({ documents: listKbDocumentsFor({ userId: user.id, role: user.role }).map(docView) });
});

// --- Notizen -----------------------------------------------------------------
kbRoutes.get('/kb/notes/:id', requirePermission('kb.query'), (c) => {
  const user = c.get('user');
  // „nicht gefunden" statt „kein Zugriff": verrät nicht einmal die Existenz.
  const note = getNoteFor({ userId: user.id, role: user.role }, c.req.param('id')!);
  if (!note) return c.json({ error: 'Notiz nicht gefunden' }, 404);
  return c.json({
    note: { ...noteView(note), content: note.content },
    backlinks: backlinksFor(note.title),
    links: outgoingLinks(note.content),
  });
});

kbRoutes.post('/kb/notes', requirePermission('kb.manage'), async (c) => {
  const user = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as { title?: string; content?: string; folder?: string; tags?: unknown; visibility?: string; aiUse?: boolean };
  const title = String(body.title ?? '').trim();
  if (!title) return c.json({ error: 'Titel erforderlich' }, 400);
  if (getNoteByTitle(title)) return c.json({ error: 'Es gibt bereits eine Notiz mit diesem Titel' }, 409);
  try {
    const note = await createNote({ title, content: body.content ?? '', folder: body.folder, tags: body.tags, visibility: normalizeVisibility(body.visibility), aiUse: body.aiUse !== false, userId: user.id, userName: user.username });
    logAudit({ ...requestMeta(c), userId: user.id, username: user.username, action: 'VAULT_NOTE_CREATED', resourceType: 'note', resourceId: note.id, resourceLabel: title, details: { ordner: note.folder } });
    return c.json({ note: { ...noteView(note), content: note.content } }, 201);
  } catch (err) {
    log.error('[Vault] Notiz anlegen fehlgeschlagen', { error: (err as Error).message });
    return c.json({ error: 'Notiz konnte nicht angelegt werden' }, 500);
  }
});

kbRoutes.patch('/kb/notes/:id', requirePermission('kb.manage'), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id')!;
  const body = (await c.req.json().catch(() => ({}))) as { title?: string; content?: string; folder?: string; tags?: unknown; visibility?: string; aiUse?: boolean };
  // Titelkollision vermeiden (Wiki-Links referenzieren über den Titel).
  if (body.title) {
    const other = getNoteByTitle(body.title.trim());
    if (other && other.id !== id) return c.json({ error: 'Es gibt bereits eine Notiz mit diesem Titel' }, 409);
  }
  try {
    // Pflegen setzt Sehen voraus — sonst könnte jemand ohne Leserecht den
    // Inhalt über den Änderungsvergleich im Audit-Log abgreifen.
    const before = getNoteFor({ userId: user.id, role: user.role }, id);
    if (!before) return c.json({ error: 'Notiz nicht gefunden' }, 404);
    const note = await updateNote(id, body, user.username);
    if (!note) return c.json({ error: 'Notiz nicht gefunden' }, 404);
    logChange({
      c, userId: user.id, username: user.username, action: 'VAULT_NOTE_UPDATED',
      resourceType: 'note', resourceId: id, resourceLabel: note.title,
      before: { titel: before?.title, ordner: before?.folder, tags: parseTags(before?.tags), inhalt: before?.content },
      after: { titel: note.title, ordner: note.folder, tags: parseTags(note.tags), inhalt: note.content },
    });
    return c.json({ note: { ...noteView(note), content: note.content } });
  } catch (err) {
    log.error('[Vault] Notiz speichern fehlgeschlagen', { error: (err as Error).message });
    return c.json({ error: 'Notiz konnte nicht gespeichert werden' }, 500);
  }
});

kbRoutes.delete('/kb/notes/:id', requirePermission('kb.manage'), (c) => {
  const user = c.get('user');
  const id = c.req.param('id')!;
  const before = getNoteFor({ userId: user.id, role: user.role }, id);
  if (!before || !deleteNote(id)) return c.json({ error: 'Notiz nicht gefunden' }, 404);
  logAudit({ ...requestMeta(c), userId: user.id, username: user.username, action: 'VAULT_NOTE_DELETED', resourceType: 'note', resourceId: id, resourceLabel: before?.title ?? null,
    details: { ordner: before?.folder, inhaltLaenge: before?.content?.length ?? 0 } });
  return c.json({ ok: true });
});

// --- Versionshistorie einer Notiz (wer hat wann was geändert) ----------------
kbRoutes.get('/kb/notes/:id/history', requirePermission('kb.query'), (c) => {
  const user = c.get('user');
  const id = c.req.param('id')!;
  if (!getNoteFor({ userId: user.id, role: user.role }, id)) return c.json({ error: 'Notiz nicht gefunden' }, 404);
  return c.json({ revisions: listRevisions(id) });
});

// Eine Version inkl. Inhalt + Inhalt der Vorgängerversion (für den Vergleich).
kbRoutes.get('/kb/notes/:id/history/:revId', requirePermission('kb.query'), (c) => {
  const user = c.get('user');
  const noteId = c.req.param('id')!;
  // Alte Stände enthalten den vollen Inhalt — dieselbe Schranke wie beim Original.
  if (!getNoteFor({ userId: user.id, role: user.role }, noteId)) return c.json({ error: 'Version nicht gefunden' }, 404);
  const rev = getRevision(Number(c.req.param('revId')));
  if (!rev || rev.noteId !== noteId) return c.json({ error: 'Version nicht gefunden' }, 404);
  const all = listRevisions(noteId);
  const idx = all.findIndex((r) => r.id === rev.id);
  const prevMeta = idx >= 0 && idx < all.length - 1 ? all[idx + 1] : undefined;
  const prev = prevMeta ? getRevision(prevMeta.id) : undefined;
  return c.json({ revision: rev, previous: prev ? { id: prev.id, content: prev.content, title: prev.title, createdAt: prev.createdAt } : null });
});

// Version wiederherstellen (erzeugt einen neuen Stand, löscht keine Historie).
kbRoutes.post('/kb/notes/:id/history/:revId/restore', requirePermission('kb.manage'), async (c) => {
  const user = c.get('user');
  const noteId = c.req.param('id')!;
  const revId = Number(c.req.param('revId'));
  const rev = getRevision(revId);
  if (!rev || rev.noteId !== noteId) return c.json({ error: 'Version nicht gefunden' }, 404);
  const note = await restoreRevision(revId, user.username, user.id);
  if (!note) return c.json({ error: 'Wiederherstellung fehlgeschlagen' }, 404);
  logAudit({ ...requestMeta(c), userId: user.id, username: user.username, action: 'VAULT_NOTE_RESTORED', resourceType: 'note', resourceId: noteId,
    resourceLabel: note.title, details: { version: revId, standVom: rev.createdAt } });
  return c.json({ note: { ...noteView(note), content: note.content } });
});

// --- Dokumente ---------------------------------------------------------------
kbRoutes.post('/kb/documents', requirePermission('kb.manage'), async (c) => {
  const user = c.get('user');
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'Ungültiger Upload' }, 400);
  }
  const files = form.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) return c.json({ error: 'Keine Datei übermittelt' }, 400);
  const folder = normalizeFolder(form.get('folder') ?? '');
  const visibility = normalizeVisibility(form.get('visibility') ?? '');
  const tags = normalizeTags(form.get('tags') ?? '');
  const maxBytes = env.MAX_UPLOAD_MB_LARGE * 1024 * 1024;
  for (const f of files) if (f.size > maxBytes) return c.json({ error: `"${f.name}" überschreitet ${env.MAX_UPLOAD_MB_LARGE} MB` }, 400);

  try {
    const added = [];
    for (const f of files) {
      const doc = await addKbDocument(f, user.id, undefined, folder, tags, visibility);
      added.push(docView(doc));
    }
    logAudit({ ...requestMeta(c), userId: user.id, username: user.username, action: 'VAULT_DOCUMENT_ADDED', details: { count: added.length, folder } });
    return c.json({ documents: added }, 201);
  } catch (err) {
    log.error('[Vault] Upload-Fehler', { error: (err as Error).message });
    return c.json({ error: 'Dokument konnte nicht verarbeitet werden' }, 500);
  }
});

// Inhalt eines Dokuments lesen (Viewer im Vault).
kbRoutes.get('/kb/documents/:id/content', requirePermission('kb.query'), (c) => {
  const user = c.get('user');
  const id = c.req.param('id')!;
  const doc = getKbDocumentFor({ userId: user.id, role: user.role }, id);
  if (!doc) return c.json({ error: 'Nicht gefunden' }, 404);
  return c.json({ document: docView(doc), text: getKbDocumentText(id) });
});

// Originaldatei herunterladen.
kbRoutes.get('/kb/documents/:id/file', requirePermission('kb.query'), (c) => {
  const user = c.get('user');
  const doc = getKbDocumentFor({ userId: user.id, role: user.role }, c.req.param('id')!);
  if (!doc) return c.json({ error: 'Nicht gefunden' }, 404);
  const stream = Readable.toWeb(createReadStream(doc.storedPath)) as ReadableStream;
  c.header('Content-Type', doc.mime || 'application/octet-stream');
  c.header('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.filename)}"`);
  return c.body(stream);
});

// Metadaten ändern (Titel, Ordner, Tags).
kbRoutes.patch('/kb/documents/:id', requirePermission('kb.manage'), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id')!;
  const body = (await c.req.json().catch(() => ({}))) as { title?: string; folder?: string; tags?: unknown; visibility?: string; aiUse?: boolean };
  const before = getKbDocumentFor({ userId: user.id, role: user.role }, id);
  if (!before) return c.json({ error: 'Nicht gefunden' }, 404);
  const doc = updateKbDocument(id, {
    title: body.title,
    folder: body.folder !== undefined ? normalizeFolder(body.folder) : undefined,
    tags: body.tags !== undefined ? normalizeTags(body.tags) : undefined,
    visibility: body.visibility !== undefined ? normalizeVisibility(body.visibility) : undefined,
    aiUse: body.aiUse,
  });
  if (!doc) return c.json({ error: 'Nicht gefunden' }, 404);
  logChange({ c, userId: user.id, username: user.username, action: 'VAULT_DOCUMENT_UPDATED', resourceType: 'document', resourceId: id, resourceLabel: doc.title,
    before: { titel: before?.title, ordner: before?.folder, tags: parseTags(before?.tags) },
    after: { titel: doc.title, ordner: doc.folder, tags: parseTags(doc.tags) } });
  return c.json({ document: docView(doc) });
});

kbRoutes.delete('/kb/documents/:id', requirePermission('kb.manage'), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!id || !getKbDocumentFor({ userId: user.id, role: user.role }, id)) return c.json({ error: 'Nicht gefunden' }, 404);
  const ok = await deleteKbDocument(id);
  if (ok) logAudit({ ...requestMeta(c), userId: user.id, username: user.username, action: 'VAULT_DOCUMENT_DELETED', resourceId: id });
  return ok ? c.json({ ok: true }) : c.json({ error: 'Nicht gefunden' }, 404);
});

// --- Suche (Volltext + semantisch) -------------------------------------------
kbRoutes.get('/kb/search', requirePermission('kb.query'), async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const mode = c.req.query('mode') === 'semantic' ? 'semantic' : 'text';
  if (q.length < 2) return c.json({ query: q, mode, hits: [] });

  const user = c.get('user');
  const viewer = { userId: user.id, role: user.role };
  if (mode === 'text') return c.json({ query: q, mode, hits: searchVaultText(q, viewer) });

  // Semantisch: dieselbe Suche, die auch die KI im Chat nutzt.
  try {
    const hits = await retrieveKb(q, viewer, 8);
    return c.json({
      query: q,
      mode,
      hits: hits.map((h) => ({
        id: h.docId,
        type: h.kind,
        title: h.title,
        folder: '',
        snippet: h.content.replace(/\s+/g, ' ').slice(0, 240),
        score: Math.round((1 - h.distance) * 100),
      })),
    });
  } catch (err) {
    log.warn('[Vault] Semantische Suche fehlgeschlagen', { error: (err as Error).message });
    return c.json({ query: q, mode, hits: [], error: 'Semantische Suche nicht verfügbar' });
  }
});
