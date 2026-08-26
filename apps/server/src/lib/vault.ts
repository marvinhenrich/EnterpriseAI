import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { db, sqliteConnection as sqlite } from '../db/client.ts';
import { vaultNotes, vaultLinks, vaultRevisions, kbDocuments } from '../db/schema.ts';
import { embed } from '../llm/ollama.ts';
import { chunkText } from './rag.ts';
import { log } from './logger.ts';
import { visibleLevels, maySee, normalizeVisibility, type VisibilityLevel } from './visibility.ts';

// =============================================================================
// Wissens-Vault: firmenweites Wissenssystem aus Notizen (Markdown, Obsidian-
// artig mit [[Wiki-Links]] und Backlinks) UND hochgeladenen Dokumenten.
// Beides landet im selben Vektor-Index (kb_chunks) und wird von der KI genutzt.
// Strikt intern — keine Cloud, keine externen Dienste.
// =============================================================================

export type NoteRow = typeof vaultNotes.$inferSelect;

const insChunk = sqlite.prepare('INSERT INTO kb_chunks(embedding, doc_id, content) VALUES (?, ?, ?)');
const delChunks = sqlite.prepare('DELETE FROM kb_chunks WHERE doc_id = ?');

function toBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Tags normalisieren: getrimmt, ohne führendes #, ohne Duplikate. */
export function normalizeTags(tags: unknown): string[] {
  const list = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(/[,\s]+/) : [];
  const out: string[] = [];
  for (const t of list) {
    const clean = String(t).trim().replace(/^#/, '');
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out.slice(0, 20);
}

/** Ordnerpfad normalisieren: "/QM//Prüfpläne/" → "QM/Prüfpläne". */
export function normalizeFolder(folder: unknown): string {
  return String(folder ?? '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('/')
    .slice(0, 200);
}

// --- Wiki-Links --------------------------------------------------------------

/** Extrahiert alle [[Titel]]-Verweise aus einem Markdown-Text. */
export function extractWikiLinks(content: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\][|]+?)(?:\|[^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const title = (m[1] ?? '').trim();
    if (title && !out.some((t) => t.toLowerCase() === title.toLowerCase())) out.push(title);
  }
  return out;
}

/** Verknüpfungen einer Notiz neu schreiben (Basis für Backlinks). */
function syncLinks(noteId: string, content: string): void {
  db.delete(vaultLinks).where(eq(vaultLinks.fromNoteId, noteId)).run();
  for (const title of extractWikiLinks(content)) {
    try {
      db.insert(vaultLinks).values({ fromNoteId: noteId, toTitle: title.toLowerCase() }).run();
    } catch {
      /* Duplikat — ignorieren */
    }
  }
}

export interface LinkRef {
  id: string;
  title: string;
}

/** Notizen, die auf diese Notiz verweisen („Wird erwähnt in"). */
export function backlinksFor(title: string): LinkRef[] {
  return sqlite
    .prepare(
      `SELECT n.id, n.title FROM vault_links l
         JOIN vault_notes n ON n.id = l.from_note_id
        WHERE l.to_title = ? ORDER BY n.title`,
    )
    .all(title.toLowerCase()) as LinkRef[];
}

/** Ausgehende Links einer Notiz, aufgelöst auf existierende Notizen. */
export function outgoingLinks(content: string): { title: string; id: string | null }[] {
  return extractWikiLinks(content).map((t) => {
    const row = sqlite.prepare('SELECT id FROM vault_notes WHERE lower(title) = ?').get(t.toLowerCase()) as { id: string } | undefined;
    return { title: t, id: row?.id ?? null };
  });
}

// --- Indexierung -------------------------------------------------------------

/** Notiz-Inhalt in den Vektor-Index schreiben (für die KI-Suche). */
async function indexNote(id: string, title: string, content: string): Promise<number> {
  delChunks.run(id);
  const text = `${title}\n\n${content}`.trim();
  if (!text) return 0;
  let n = 0;
  for (const ch of chunkText(text)) {
    try {
      insChunk.run(toBlob(await embed(ch)), id, ch);
      n++;
    } catch (err) {
      log.warn('[Vault] Embedding fehlgeschlagen', { id, error: (err as Error).message });
    }
  }
  return n;
}

// --- Versionshistorie --------------------------------------------------------

export type RevisionRow = typeof vaultRevisions.$inferSelect;

/** Grobe Zeilenstatistik für die Kurzbeschreibung („+12 / −3 Zeilen"). */
function lineSummary(before: string, after: string): string {
  const b = before.split('\n');
  const a = after.split('\n');
  const bSet = new Map<string, number>();
  for (const l of b) bSet.set(l, (bSet.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of a) {
    const n = bSet.get(l) ?? 0;
    if (n > 0) bSet.set(l, n - 1);
    else added++;
  }
  const removed = [...bSet.values()].reduce((x, y) => x + y, 0);
  if (added === 0 && removed === 0) return 'keine Zeilenänderung';
  return `+${added} / −${removed} Zeilen`;
}

/** Aktuellen Stand einer Notiz als Version festhalten. */
function saveRevision(note: NoteRow, action: 'create' | 'update' | 'restore', editedBy: string, editedById?: number, summary?: string): void {
  try {
    db.insert(vaultRevisions)
      .values({
        noteId: note.id,
        title: note.title,
        content: note.content,
        folder: note.folder,
        tags: note.tags,
        editedBy,
        editedById: editedById ?? null,
        action,
        summary: summary ?? null,
      })
      .run();
  } catch (err) {
    log.warn('[Vault] Version konnte nicht gespeichert werden', { id: note.id, error: (err as Error).message });
  }
}

/** Versionen einer Notiz, neueste zuerst (ohne Inhalt — für die Übersicht). */
export function listRevisions(noteId: string): Omit<RevisionRow, 'content'>[] {
  return sqlite
    .prepare(
      `SELECT id, note_id AS noteId, title, folder, tags, edited_by AS editedBy, edited_by_id AS editedById,
              action, summary, created_at AS createdAt, length(content) AS contentLength
         FROM vault_revisions WHERE note_id = ? ORDER BY id DESC`,
    )
    .all(noteId) as Omit<RevisionRow, 'content'>[];
}

/** Eine einzelne Version inkl. Inhalt (für den Vergleich). */
export function getRevision(id: number): RevisionRow | undefined {
  return db.select().from(vaultRevisions).where(eq(vaultRevisions.id, id)).get();
}

/** Version wiederherstellen — erzeugt einen neuen Stand, löscht keine Historie. */
export async function restoreRevision(revId: number, userName: string, userId?: number): Promise<NoteRow | undefined> {
  const rev = getRevision(revId);
  if (!rev) return undefined;
  const note = getNote(rev.noteId);
  if (!note) return undefined;
  const summary = lineSummary(note.content, rev.content);
  await updateNote(rev.noteId, { title: rev.title, content: rev.content, folder: rev.folder, tags: parseTags(rev.tags) }, userName, userId, 'restore', summary);
  return getNote(rev.noteId);
}

// --- Notizen-CRUD ------------------------------------------------------------

export interface Viewer { userId: number; role: string }

/** Ohne Viewer: nur intern (Pflege, Indexierung). Für Anzeigen listNotesFor(). */
export function listNotes(): NoteRow[] {
  return db.select().from(vaultNotes).orderBy(desc(vaultNotes.updatedAt)).all();
}

/** Notizen, die dieser Nutzer sehen darf. */
export function listNotesFor(viewer: Viewer): NoteRow[] {
  const levels = visibleLevels(viewer.userId, viewer.role) as string[];
  return listNotes().filter((n) => levels.includes(String(n.visibility ?? '')));
}

export function getNote(id: string): NoteRow | undefined {
  return db.select().from(vaultNotes).where(eq(vaultNotes.id, id)).get();
}

/** Notiz nur, wenn die Sichtbarkeitsstufe es erlaubt. */
export function getNoteFor(viewer: Viewer, id: string): NoteRow | undefined {
  const n = getNote(id);
  return n && maySee(viewer.userId, viewer.role, n.visibility) ? n : undefined;
}

export function getNoteByTitle(title: string): NoteRow | undefined {
  return sqlite.prepare('SELECT * FROM vault_notes WHERE lower(title) = ?').get(title.toLowerCase()) as NoteRow | undefined;
}

export async function createNote(input: {
  title: string;
  content?: string;
  folder?: string;
  tags?: unknown;
  visibility?: unknown;
  aiUse?: boolean;
  userId: number;
  userName: string;
}): Promise<NoteRow> {
  const id = randomUUID();
  const content = input.content ?? '';
  const row = db
    .insert(vaultNotes)
    .values({
      id,
      title: input.title.trim().slice(0, 200),
      content,
      folder: normalizeFolder(input.folder),
      tags: JSON.stringify(normalizeTags(input.tags)),
      visibility: normalizeVisibility(input.visibility),
      aiUse: input.aiUse ?? true,
      createdBy: input.userId,
      createdByName: input.userName,
      updatedByName: input.userName,
    })
    .returning()
    .get();
  syncLinks(id, content);
  const n = await indexNote(id, row.title, content);
  db.update(vaultNotes).set({ chunks: n }).where(eq(vaultNotes.id, id)).run();
  saveRevision({ ...row, chunks: n }, 'create', input.userName, input.userId, 'Notiz angelegt');
  log.info('[Vault] Notiz angelegt', { id, title: row.title, chunks: n });
  return { ...row, chunks: n };
}

export async function updateNote(
  id: string,
  patch: { title?: string; content?: string; folder?: string; tags?: unknown; visibility?: unknown; aiUse?: boolean },
  userName: string,
  userId?: number,
  action: 'update' | 'restore' = 'update',
  summaryOverride?: string,
): Promise<NoteRow | undefined> {
  const existing = getNote(id);
  if (!existing) return undefined;
  const title = patch.title !== undefined ? patch.title.trim().slice(0, 200) || existing.title : existing.title;
  const content = patch.content !== undefined ? patch.content : existing.content;
  const set: Record<string, unknown> = { title, content, updatedByName: userName, updatedAt: new Date().toISOString().slice(0, 19).replace('T', ' ') };
  if (patch.folder !== undefined) set.folder = normalizeFolder(patch.folder);
  if (patch.tags !== undefined) set.tags = JSON.stringify(normalizeTags(patch.tags));
  if (patch.visibility !== undefined) set.visibility = normalizeVisibility(patch.visibility);
  if (patch.aiUse !== undefined) set.aiUse = patch.aiUse;

  db.update(vaultNotes).set(set).where(eq(vaultNotes.id, id)).run();
  // Nur neu indexieren, wenn sich Inhalt/Titel geändert haben (spart Embeddings).
  if (patch.content !== undefined || patch.title !== undefined) {
    syncLinks(id, content);
    const n = await indexNote(id, title, content);
    db.update(vaultNotes).set({ chunks: n }).where(eq(vaultNotes.id, id)).run();
  }
  const after = getNote(id);
  // Version nur festhalten, wenn sich inhaltlich etwas geändert hat.
  if (
    after &&
    (after.title !== existing.title || after.content !== existing.content || after.folder !== existing.folder || after.tags !== existing.tags)
  ) {
    saveRevision(after, action, userName, userId, summaryOverride ?? lineSummary(existing.content, after.content));
  }
  return after;
}

export function deleteNote(id: string): boolean {
  const row = getNote(id);
  if (!row) return false;
  delChunks.run(id);
  db.delete(vaultLinks).where(eq(vaultLinks.fromNoteId, id)).run();
  db.delete(vaultNotes).where(eq(vaultNotes.id, id)).run();
  log.info('[Vault] Notiz gelöscht', { id, title: row.title });
  return true;
}

// --- Ordner & Tags -----------------------------------------------------------

export interface VaultStats {
  notes: number;
  documents: number;
  chunks: number;
  folders: string[];
  tags: { tag: string; count: number }[];
}

export function vaultStats(viewer: Viewer): VaultStats {
  const levels = visibleLevels(viewer.userId, viewer.role) as string[];
  const notes = listNotes().filter((n) => levels.includes(String(n.visibility ?? '')));
  const docs = db.select().from(kbDocuments).all().filter((d) => levels.includes(String(d.visibility ?? '')));
  const chunks = (sqlite.prepare('SELECT count(*) c FROM kb_chunks').get() as { c: number }).c;

  const folders = new Set<string>();
  const tagCount = new Map<string, number>();
  for (const item of [...notes, ...docs]) {
    const f = (item as { folder?: string }).folder ?? '';
    if (f) {
      // Auch Elternpfade als Ordner führen ("A/B" → "A" und "A/B").
      const parts = f.split('/');
      for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join('/'));
    }
    for (const t of parseTags((item as { tags?: string | null }).tags)) {
      tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
    }
  }

  return {
    notes: notes.length,
    documents: docs.length,
    chunks,
    folders: [...folders].sort((a, b) => a.localeCompare(b)),
    tags: [...tagCount.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
  };
}

// --- Suche (Volltext) --------------------------------------------------------

export interface VaultSearchHit {
  id: string;
  type: 'note' | 'document';
  title: string;
  folder: string;
  snippet: string;
  score?: number;
}

function snippetAround(text: string, query: string, radius = 70): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const idx = clean.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return clean.slice(0, radius * 2) + (clean.length > radius * 2 ? '…' : '');
  const start = Math.max(0, idx - radius);
  const end = Math.min(clean.length, idx + query.length + radius);
  return (start > 0 ? '…' : '') + clean.slice(start, end) + (end < clean.length ? '…' : '');
}

/** Volltextsuche über Notizen (Titel/Inhalt) und Dokument-Abschnitte. */
export function searchVaultText(query: string, viewer: Viewer, limit = 40): VaultSearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const like = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
  // SICHERHEIT: Stufe direkt in die Abfrage — gesperrte Inhalte werden gar
  // nicht erst geladen.
  const levels = visibleLevels(viewer.userId, viewer.role);
  const ph = levels.map(() => '?').join(',');

  const notes = sqlite
    .prepare(
      `SELECT id, title, folder, content FROM vault_notes
        WHERE (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\') AND visibility IN (${ph})
        ORDER BY updated_at DESC`,
    )
    .all(like, like, ...levels) as { id: string; title: string; folder: string; content: string }[];

  const hits: VaultSearchHit[] = notes.map((n) => ({
    id: n.id,
    type: 'note',
    title: n.title,
    folder: n.folder ?? '',
    snippet: snippetAround(n.content || n.title, q),
  }));

  // Dokumente: über die indexierten Abschnitte durchsuchen (ein Treffer je Dokument).
  const docRows = sqlite
    .prepare(
      `SELECT d.id, d.title, d.folder, k.content
         FROM kb_chunks k JOIN kb_documents d ON d.id = k.doc_id
        WHERE k.content LIKE ? ESCAPE '\\' AND d.visibility IN (${ph})`,
    )
    .all(like, ...levels) as { id: string; title: string; folder: string | null; content: string }[];
  const seen = new Set<string>();
  for (const r of docRows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    hits.push({ id: r.id, type: 'document', title: r.title, folder: r.folder ?? '', snippet: snippetAround(r.content, q) });
  }

  // Titeltreffer bei Dokumenten ohne Abschnittstreffer ergänzen.
  const titleDocs = sqlite
    .prepare(`SELECT id, title, folder FROM kb_documents WHERE (title LIKE ? ESCAPE '\\' OR filename LIKE ? ESCAPE '\\') AND visibility IN (${ph})`)
    .all(like, like, ...levels) as { id: string; title: string; folder: string | null }[];
  for (const d of titleDocs) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    hits.push({ id: d.id, type: 'document', title: d.title, folder: d.folder ?? '', snippet: '' });
  }

  return hits.slice(0, limit);
}
