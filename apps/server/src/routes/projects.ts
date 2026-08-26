import { Hono } from 'hono';
import { authenticate, requirePermission } from '../middleware/auth.ts';
import { env } from '../config/env.ts';
import {
  listProjects,
  getOwnedProject,
  createProject,
  updateProject,
  deleteProject,
  assignChatToProject,
  listProjectFiles,
  listProjectMemory,
  addProjectMemory,
  updateProjectMemory,
  deleteProjectMemory,
  getProjectMemoryEntry,
} from '../lib/projects.ts';
import { saveUpload, deleteFile, getOwnedFile } from '../lib/files.ts';
import { indexFile, deleteFileIndex } from '../lib/rag.ts';
import { KLASSEN, KLASSEN_LISTE, normalisiereKlasse, rang, darfHerabstufen } from '../lib/classification.ts';
import { enqueueOcr, istOcrFähig } from '../lib/ocr-queue.ts';
import { db, sqliteConnection as sqlite } from '../db/client.ts';
import { files } from '../db/schema.ts';
import { eq } from 'drizzle-orm';
import { hasPermission } from '../lib/permissions.ts';
import { logAudit, logChange, requestMeta } from '../lib/audit.ts';
import { log } from '../lib/logger.ts';
import type { AppEnv } from '../types.ts';
import { modulAktiv } from '../lib/module.ts';

export const projectRoutes = new Hono<AppEnv>();
projectRoutes.use('*', authenticate);

// Modul abgeschaltet -> Bereich existiert für den Nutzer nicht. Die Route
// antwortet dann einheitlich mit 404, statt halb zu funktionieren.
projectRoutes.use('*', async (c, next) => {
  if (!modulAktiv('projects')) return c.json({ error: 'Dieser Bereich ist in dieser Installation nicht aktiv.' }, 404);
  await next();
});

const fileView = (f: { id: string; filename: string; kind: string; size: number; extractedText: string | null; createdAt: string | null; classification?: string | null }) => ({
  id: f.id,
  filename: f.filename,
  kind: f.kind,
  size: f.size,
  hasText: !!f.extractedText,
  chars: f.extractedText?.length ?? 0,
  createdAt: f.createdAt,
  classification: normalisiereKlasse(f.classification),
});

// --- Projekte ----------------------------------------------------------------
projectRoutes.get('/projects', (c) => {
  const user = c.get('user');
  return c.json({ projects: listProjects(user.id) });
});

projectRoutes.post('/projects', async (c) => {
  const user = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; description?: string; instructions?: string; color?: string; vaultScope?: string };
  const name = String(body.name ?? '').trim();
  if (!name) return c.json({ error: 'Name erforderlich' }, 400);
  const project = createProject(user.id, { name, description: body.description, instructions: body.instructions, color: body.color, vaultScope: body.vaultScope });
  logAudit({ ...requestMeta(c), userId: user.id, username: user.username, action: 'PROJECT_CREATED', resourceType: 'project', resourceId: project.id, resourceLabel: project.name });
  return c.json({ project }, 201);
});

projectRoutes.get('/projects/:id', (c) => {
  const user = c.get('user');
  const id = c.req.param('id')!;
  const project = getOwnedProject(user.id, id);
  if (!project) return c.json({ error: 'Projekt nicht gefunden' }, 404);
  return c.json({ project, files: listProjectFiles(user.id, id).map(fileView), memory: listProjectMemory(id) });
});

projectRoutes.patch('/projects/:id', async (c) => {
  const user = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; description?: string; instructions?: string; color?: string; vaultScope?: string };
  const id = c.req.param('id')!;
  const before = getOwnedProject(user.id, id);
  const project = updateProject(user.id, id, body);
  if (!project) return c.json({ error: 'Projekt nicht gefunden' }, 404);
  logChange({ c, userId: user.id, username: user.username, action: 'PROJECT_UPDATED', resourceType: 'project', resourceId: id, resourceLabel: project.name,
    before: { name: before?.name, beschreibung: before?.description, vorgaben: before?.instructions },
    after: { name: project.name, beschreibung: project.description, vorgaben: project.instructions } });
  return c.json({ project });
});

projectRoutes.delete('/projects/:id', (c) => {
  const user = c.get('user');
  const id = c.req.param('id')!;
  const before = getOwnedProject(user.id, id);
  if (!deleteProject(user.id, id)) return c.json({ error: 'Projekt nicht gefunden' }, 404);
  logAudit({ ...requestMeta(c), userId: user.id, username: user.username, action: 'PROJECT_DELETED', resourceType: 'project', resourceId: id, resourceLabel: before?.name ?? null,
    details: { hinweis: 'Chats und Dateien wurden nur gelöst, nicht gelöscht' } });
  return c.json({ ok: true });
});

// Chat einem Projekt zuordnen / lösen.
projectRoutes.post('/chat/:id/project', async (c) => {
  const user = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as { projectId?: string | null };
  const projectId = body.projectId ?? null;
  const chatId = c.req.param('id')!;
  if (!assignChatToProject(user.id, chatId, projectId)) return c.json({ error: 'Chat oder Projekt nicht gefunden' }, 404);
  logAudit({ ...requestMeta(c), userId: user.id, username: user.username, action: projectId ? 'CHAT_ASSIGNED_TO_PROJECT' : 'CHAT_REMOVED_FROM_PROJECT',
    resourceType: 'chat', resourceId: chatId, details: { projektId: projectId, projekt: projectId ? (getOwnedProject(user.id, projectId)?.name ?? null) : null } });
  return c.json({ ok: true });
});

// --- Projekt-Kontext („Projekt-Memory") --------------------------------------
// Bewusst sichtbar und änderbar: der Nutzer soll sehen, was die KI in diesem
// Projekt mitführt, und Falsches selbst korrigieren können.
projectRoutes.get('/projects/:id/memory', (c) => {
  const user = c.get('user');
  const id = c.req.param('id')!;
  if (!getOwnedProject(user.id, id)) return c.json({ error: 'Projekt nicht gefunden' }, 404);
  return c.json({ memory: listProjectMemory(id) });
});

projectRoutes.post('/projects/:id/memory', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id')!;
  if (!getOwnedProject(user.id, id)) return c.json({ error: 'Projekt nicht gefunden' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { text?: string };
  const eintrag = addProjectMemory(id, String(body.text ?? ''), { source: 'manual', createdBy: user.username });
  if (!eintrag) return c.json({ error: 'Text erforderlich (oder bereits vorhanden)' }, 400);
  logAudit({ ...requestMeta(c), userId: user.id, username: user.username, action: 'PROJECT_MEMORY_ADDED', resourceType: 'project', resourceId: id, details: { text: eintrag.text } });
  return c.json({ entry: eintrag }, 201);
});

projectRoutes.patch('/projects/:id/memory/:entryId', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id')!;
  if (!getOwnedProject(user.id, id)) return c.json({ error: 'Projekt nicht gefunden' }, 404);
  const entryId = Number(c.req.param('entryId'));
  const vorher = getProjectMemoryEntry(entryId);
  if (!vorher || vorher.projectId !== id) return c.json({ error: 'Eintrag nicht gefunden' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { text?: string };
  if (!updateProjectMemory(entryId, String(body.text ?? ''))) return c.json({ error: 'Text erforderlich' }, 400);
  logChange({ c, userId: user.id, username: user.username, action: 'PROJECT_MEMORY_UPDATED', resourceType: 'project', resourceId: id,
    before: { text: vorher.text }, after: { text: String(body.text ?? '').trim() } });
  return c.json({ ok: true });
});

projectRoutes.delete('/projects/:id/memory/:entryId', (c) => {
  const user = c.get('user');
  const id = c.req.param('id')!;
  if (!getOwnedProject(user.id, id)) return c.json({ error: 'Projekt nicht gefunden' }, 404);
  const entryId = Number(c.req.param('entryId'));
  const vorher = getProjectMemoryEntry(entryId);
  if (!vorher || vorher.projectId !== id || !deleteProjectMemory(entryId)) return c.json({ error: 'Eintrag nicht gefunden' }, 404);
  logAudit({ ...requestMeta(c), userId: user.id, username: user.username, action: 'PROJECT_MEMORY_DELETED', resourceType: 'project', resourceId: id, details: { text: vorher.text } });
  return c.json({ ok: true });
});

// --- Projektdateien (in allen Chats des Projekts verfügbar) -------------------
projectRoutes.post('/projects/:id/files', requirePermission('files.upload'), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id')!;
  if (!getOwnedProject(user.id, id)) return c.json({ error: 'Projekt nicht gefunden' }, 404);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'Ungültiger Upload' }, 400);
  }
  const uploaded = form.getAll('files').filter((f): f is File => f instanceof File);
  if (uploaded.length === 0) return c.json({ error: 'Keine Datei übermittelt' }, 400);

  const maxMb = hasPermission(user.id, user.role, 'files.large') ? env.MAX_UPLOAD_MB_LARGE : env.MAX_UPLOAD_MB;
  for (const f of uploaded) {
    if (f.size > maxMb * 1024 * 1024) return c.json({ error: `"${f.name}" überschreitet ${maxMb} MB` }, 400);
  }

  const projektKlasse = normalisiereKlasse(getOwnedProject(user.id, id)?.classification);

  try {
    const ocr = hasPermission(user.id, user.role, 'docs.ocr');
    const rows = [];
    for (const f of uploaded) {
      const row = await saveUpload(user.id, f, undefined, ocr);
      // Neue Dateien erben die Einstufung des Projekts. Ohne das läge eine
      // frisch hochgeladene Fachdokument in einem als geheim eingestuften Projekt
      // trotzdem auf „intern" — und ginge damit ins Allgemeinwissen ein.
      db.update(files).set({ projectId: id, classification: projektKlasse }).where(eq(files.id, row.id)).run();
      row.classification = projektKlasse;
      if (row.extractedText) {
        await indexFile(row.id, row.extractedText).catch((err) => log.warn('[Projekte] Indexierung fehlgeschlagen', { error: (err as Error).message }));
      }
      if (istOcrFähig(row.filename, row.extractedText)) enqueueOcr(row.id);
      rows.push(fileView(row));
      logAudit({ ...requestMeta(c), userId: user.id, username: user.username, action: 'PROJECT_FILE_ADDED', resourceType: 'project', resourceId: id,
        resourceLabel: getOwnedProject(user.id, id)?.name ?? null, details: { datei: row.filename, groesse: row.size } });
    }
    return c.json({ files: rows }, 201);
  } catch (err) {
    log.error('[Projekte] Upload-Fehler', { error: (err as Error).message });
    return c.json({ error: 'Datei konnte nicht verarbeitet werden' }, 500);
  }
});

// „Aus dem Projekt entfernen" darf die Datei NICHT vernichten. Bisher rief
// diese Route deleteFile() auf — die Datei war samt Inhalt und Suchindex weg,
// auch wenn sie in Wahrheit zu einem anderen Projekt gehörte oder an einem
// laufenden Chat hing. Entfernen heißt jetzt: Projektbezug lösen.
projectRoutes.delete('/projects/:id/files/:fileId', async (c) => {
  const user = c.get('user');
  const projektId = c.req.param('id')!;
  const fileId = c.req.param('fileId')!;
  const before = getOwnedFile(user.id, fileId);
  if (!before) return c.json({ error: 'Datei nicht gefunden' }, 404);
  // Nur lösen, wenn die Datei WIRKLICH zu diesem Projekt gehört.
  if (before.projectId !== projektId) {
    return c.json({ error: 'Diese Datei gehört nicht zu diesem Projekt.' }, 400);
  }
  const ok = db.update(files).set({ projectId: null }).where(eq(files.id, fileId)).run().changes > 0;
  if (ok) {
    logAudit({ ...requestMeta(c), userId: user.id, username: user.username, action: 'PROJECT_FILE_REMOVED', resourceType: 'project', resourceId: projektId, details: { datei: before.filename, hinweis: 'nur Projektbezug gelöst, Datei bleibt erhalten' } });
  }
  return ok ? c.json({ ok: true }) : c.json({ error: 'Datei nicht gefunden' }, 404);
});

// --- Datenklassifizierung ----------------------------------------------------
// Einstufung eines Projekts setzen. Sie gilt als Vorgabe für alle Dateien
// darin. Heraufstufen darf jeder Eigentümer; Herabstufen entfernt einen Schutz
// und verlangt das Recht 'data.declassify'.
projectRoutes.patch('/projects/:id/classification', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const projekt = getOwnedProject(user.id, id);
  if (!projekt) return c.json({ error: 'Projekt nicht gefunden' }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { classification?: string; mitDateien?: boolean };
  const neu = normalisiereKlasse(body.classification);
  const alt = normalisiereKlasse(projekt.classification);
  if (rang(neu) < rang(alt) && !darfHerabstufen(user.id, user.role)) {
    return c.json({ error: `Herabstufen von „${KLASSEN[alt].label}" auf „${KLASSEN[neu].label}" erfordert das Recht „Einstufung herabsetzen".` }, 403);
  }

  sqlite.prepare('UPDATE projects SET classification = ?, updated_at = datetime(\'now\') WHERE id = ? AND user_id = ?').run(neu, id, user.id);
  let dateien = 0;
  if (body.mitDateien !== false) {
    // Vorhandene Dateien mitziehen — sonst bleibt ein Fachdokument ungeschützt,
    // nur weil sie vor der Einstufung hochgeladen wurde.
    dateien = sqlite.prepare('UPDATE files SET classification = ? WHERE project_id = ? AND user_id = ?').run(neu, id, user.id).changes;
  }
  logChange({ c, userId: user.id, username: user.username, action: 'DATA_CLASSIFIED', resourceType: 'project',
    resourceId: id, resourceLabel: projekt.name, before: { classification: alt }, after: { classification: neu },
    extra: { dateienMitgezogen: dateien } });
  log.info('[Klassifizierung] Projekt eingestuft', { projekt: projekt.name, von: alt, auf: neu, dateien });
  return c.json({ ok: true, classification: neu, dateien });
});

// Einstufung einer einzelnen Datei setzen (darf über der Projektvorgabe liegen).
projectRoutes.patch('/files/:id/classification', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const datei = sqlite.prepare('SELECT id, filename, classification FROM files WHERE id = ? AND user_id = ?').get(id, user.id) as
    | { id: string; filename: string; classification: string }
    | undefined;
  if (!datei) return c.json({ error: 'Datei nicht gefunden' }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { classification?: string };
  const neu = normalisiereKlasse(body.classification);
  const alt = normalisiereKlasse(datei.classification);
  if (rang(neu) < rang(alt) && !darfHerabstufen(user.id, user.role)) {
    return c.json({ error: `Herabstufen erfordert das Recht „Einstufung herabsetzen".` }, 403);
  }
  sqlite.prepare('UPDATE files SET classification = ? WHERE id = ? AND user_id = ?').run(neu, id, user.id);
  logChange({ c, userId: user.id, username: user.username, action: 'DATA_CLASSIFIED', resourceType: 'file',
    resourceId: id, resourceLabel: datei.filename, before: { classification: alt }, after: { classification: neu } });
  return c.json({ ok: true, classification: neu });
});

// Welche Stufen gibt es, und was darf ich?
projectRoutes.get('/classifications', (c) => {
  const user = c.get('user');
  return c.json({
    klassen: KLASSEN_LISTE.map((k) => ({ key: k, ...KLASSEN[k] })),
    darfHerabstufen: darfHerabstufen(user.id, user.role),
  });
});
