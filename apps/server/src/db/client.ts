import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { env } from '../config/env.ts';
import * as schema from './schema.ts';
import { serverPfad } from '../config/pfade.ts';

// DB-Pfad relativ zum Server-Arbeitsbereich (apps/server), nicht zum
// Arbeitsverzeichnis — sonst trifft ein Skript aus scripts/ eine andere Datei.
const dbPath = serverPfad(env.DATABASE_PATH);
mkdirSync(dirname(dbPath), { recursive: true });

const sqlite = new Database(dbPath);
// WAL für nebenläufige Lese-/Schreibzugriffe und bessere Robustheit bei Absturz.
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 5000');

// sqlite-vec laden + Vektor-Tabelle für RAG (Datei-Chunks, bge-m3 = 1024 dim).
// vec0: Vektor-Spalte zuerst (cosine-Distanz), file_id als filterbare Metadaten-
// Spalte (Scoping auf angehängte Dateien), content als Auxiliary (+).
sqliteVec.load(sqlite);

/**
 * Spalten einer Tabelle — leere Liste, wenn es die Tabelle (noch) nicht gibt.
 *
 * Die von Drizzle verwalteten Tabellen (chats, files, kb_documents …) entstehen
 * erst durch `db:migrate`. Dieses Modul läuft aber schon beim Import — bei einer
 * frischen Installation also VOR der ersten Migration. Ein ungeprüftes
 * `ALTER TABLE` oder `CREATE INDEX` bricht dann mit „no such table" ab und die
 * Installation scheitert. Darum gilt hier durchgehend: nichts anfassen, was es
 * noch nicht gibt — beim nächsten Start ist die Tabelle da und wird nachgezogen.
 */
const spaltenVon = (tabelle: string): string[] =>
  (sqlite.prepare(`PRAGMA table_info(${tabelle})`).all() as { name: string }[]).map((c) => c.name);

const tabelleDa = (tabelle: string): boolean => spaltenVon(tabelle).length > 0;

/** Spalte anlegen, falls Tabelle existiert und die Spalte fehlt. */
const spalteNachruesten = (tabelle: string, spalte: string, definition: string): void => {
  const cols = spaltenVon(tabelle);
  if (cols.length > 0 && !cols.includes(spalte)) {
    sqlite.exec(`ALTER TABLE ${tabelle} ADD COLUMN ${spalte} ${definition}`);
  }
};

/** Index anlegen, falls die Tabelle existiert. */
const indexNachruesten = (tabelle: string, sql: string): void => {
  if (tabelleDa(tabelle)) sqlite.exec(sql);
};
sqlite.exec('DROP TABLE IF EXISTS file_chunks'); // alte 768-dim-Tabelle (nomic) entfernen
sqlite.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks USING vec0(
  embedding FLOAT[1024] distance_metric=cosine,
  file_id TEXT,
  +content TEXT
)`);
// Firmenweites Wissens-Vault (eigener Vektor-Index, doc_id-Metadaten).
sqlite.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks USING vec0(
  embedding FLOAT[1024] distance_metric=cosine,
  doc_id TEXT,
  +content TEXT
)`);

// Etiketten-Datenbank (geteilt): Labels + Begriffe + Scan-Jobs.
// Idempotent (CREATE IF NOT EXISTS) — sicher bei jedem Start für die Live-DB.
sqlite.exec(`CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'pdf',
  size INTEGER NOT NULL DEFAULT 0,
  pages INTEGER,
  ocr_text TEXT,
  ocr_status TEXT NOT NULL DEFAULT 'pending',
  last_found TEXT,
  last_status TEXT,
  last_scan_id TEXT,
  uploaded_by INTEGER,
  uploaded_by_name TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_labels_created ON labels(created_at)`);
sqlite.exec(`CREATE TABLE IF NOT EXISTS label_terms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL,
  variants TEXT,
  added_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_label_terms_term ON label_terms(term)`);
// Idempotente Migration: variants-Spalte nachrüsten, falls Tabelle älter ist.
{
  const cols = (sqlite.prepare(`PRAGMA table_info(label_terms)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('variants')) sqlite.exec(`ALTER TABLE label_terms ADD COLUMN variants TEXT`);
}
sqlite.exec(`CREATE TABLE IF NOT EXISTS label_scans (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'running',
  started_by INTEGER,
  started_by_name TEXT,
  started_at TEXT DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  term_count INTEGER NOT NULL DEFAULT 0,
  error TEXT
)`);
// Verwaiste „running"-Scans nach einem Neustart als unterbrochen markieren (Prod-Robustheit).
sqlite.exec(`UPDATE label_scans SET status='failed', error='durch Neustart unterbrochen', finished_at=CURRENT_TIMESTAMP WHERE status='running'`);

// Bildgenerierung: Jobs/Galerie (persistent). Idempotent.
sqlite.exec(`CREATE TABLE IF NOT EXISTS image_jobs (
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  user_name TEXT,
  prompt TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'turbo',
  width INTEGER, height INTEGER, steps INTEGER, seed INTEGER,
  negative_prompt TEXT,
  ref_path TEXT,
  mask_path TEXT,
  image_strength REAL,
  status TEXT NOT NULL DEFAULT 'queued',
  image_path TEXT,
  ms INTEGER,
  error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  finished_at TEXT
)`);
// Idempotente Migration: img2img-Spalten nachrüsten, falls Tabelle älter ist.
{
  const cols = (sqlite.prepare(`PRAGMA table_info(image_jobs)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('ref_path')) sqlite.exec(`ALTER TABLE image_jobs ADD COLUMN ref_path TEXT`);
  if (!cols.includes('mask_path')) sqlite.exec(`ALTER TABLE image_jobs ADD COLUMN mask_path TEXT`);
  if (!cols.includes('image_strength')) sqlite.exec(`ALTER TABLE image_jobs ADD COLUMN image_strength REAL`);
}
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_image_jobs_user ON image_jobs(user_id)`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_image_jobs_status ON image_jobs(status)`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_image_jobs_created ON image_jobs(created_at)`);
// Verwaiste „running"-Bild-Jobs nach Neustart als fehlgeschlagen markieren (queued bleibt → wird weiterverarbeitet).
sqlite.exec(`UPDATE image_jobs SET status='failed', error='durch Neustart unterbrochen', finished_at=CURRENT_TIMESTAMP WHERE status='running'`);

// Chats: pinned/archived-Spalten idempotent nachrüsten (Alt-DB ohne diese Spalten).
spalteNachruesten('chats', 'pinned', 'INTEGER NOT NULL DEFAULT 0');
spalteNachruesten('chats', 'archived', 'INTEGER NOT NULL DEFAULT 0');

// Projekte: bündeln Chats, eigene Dateien und projektweite Anweisungen. Idempotent.
sqlite.exec(`CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  instructions TEXT,
  color TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, updated_at)`);
sqlite.exec(`CREATE TABLE IF NOT EXISTS project_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'auto',
  chat_id TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_project_memory ON project_memory(project_id, created_at)`);
spalteNachruesten('chats', 'project_id', 'TEXT');
indexNachruesten('chats', `CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(project_id)`);
spalteNachruesten('files', 'project_id', 'TEXT');
spalteNachruesten('files', 'ocr_state', 'TEXT');
indexNachruesten('files', `CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id)`);

// Wissens-Vault: Notizen (Markdown, Obsidian-artig) + Wiki-Link-Verknüpfungen.
sqlite.exec(`CREATE TABLE IF NOT EXISTS vault_notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  folder TEXT NOT NULL DEFAULT '',
  tags TEXT,
  chunks INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_by_name TEXT,
  updated_by_name TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_vault_notes_updated ON vault_notes(updated_at)`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_vault_notes_folder ON vault_notes(folder)`);
sqlite.exec(`CREATE TABLE IF NOT EXISTS vault_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_note_id TEXT NOT NULL,
  to_title TEXT NOT NULL
)`);
sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_link_unique ON vault_links(from_note_id, to_title)`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_vault_link_to ON vault_links(to_title)`);
sqlite.exec(`CREATE TABLE IF NOT EXISTS vault_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  folder TEXT NOT NULL DEFAULT '',
  tags TEXT,
  edited_by TEXT,
  edited_by_id INTEGER,
  action TEXT NOT NULL DEFAULT 'update',
  summary TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_vault_rev_note ON vault_revisions(note_id, created_at)`);

// kb_documents / vault_notes: Ordner, Tags und Sichtbarkeitsstufe nachrüsten.
spalteNachruesten('kb_documents', 'folder', `TEXT NOT NULL DEFAULT ''`);
spalteNachruesten('kb_documents', 'tags', 'TEXT');
spalteNachruesten('kb_documents', 'visibility', `TEXT NOT NULL DEFAULT ''`);
spalteNachruesten('kb_documents', 'ai_use', 'INTEGER NOT NULL DEFAULT 1');
spalteNachruesten('vault_notes', 'visibility', `TEXT NOT NULL DEFAULT ''`);
spalteNachruesten('vault_notes', 'ai_use', 'INTEGER NOT NULL DEFAULT 1');
spalteNachruesten('projects', 'vault_scope', `TEXT NOT NULL DEFAULT 'all'`);

// Leistungsmessung: je KI-Anfrage eine Zeile. Damit sind Verschlechterungen
// sichtbar, bevor sich jemand beschwert. Bewusst schlank (kein Inhalt).
sqlite.exec(`CREATE TABLE IF NOT EXISTS perf_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  model TEXT,
  prompt_chars INTEGER NOT NULL DEFAULT 0,
  context_sources INTEGER NOT NULL DEFAULT 0,
  ttfb_ms INTEGER,
  total_ms INTEGER,
  eval_count INTEGER,
  had_error INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_perf_created ON perf_log(created_at)`);

// Nutzer-Feedback (→ Admin-Panel). Idempotent, sicher bei jedem Start.
sqlite.exec(`CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT,
  category TEXT NOT NULL DEFAULT 'other',
  rating INTEGER,
  message TEXT NOT NULL,
  context TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
{
  const cols = (sqlite.prepare(`PRAGMA table_info(feedback)`).all() as { name: string }[]).map((c) => c.name);
  if (cols.length > 0) {
    if (!cols.includes('response')) sqlite.exec(`ALTER TABLE feedback ADD COLUMN response TEXT`);
    if (!cols.includes('handled_by')) sqlite.exec(`ALTER TABLE feedback ADD COLUMN handled_by TEXT`);
    if (!cols.includes('handled_at')) sqlite.exec(`ALTER TABLE feedback ADD COLUMN handled_at TEXT`);
  }
}
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at)`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status)`);

// --- Modulverwaltung ---------------------------------------------------------
// Welche Funktionen diese Installation nutzt. Nur Abweichungen stehen hier;
// was fehlt, gilt als aktiv — eine leere Tabelle heißt „alles an".
sqlite.exec(`CREATE TABLE IF NOT EXISTS module (
  id TEXT PRIMARY KEY,
  aktiv INTEGER NOT NULL DEFAULT 1,
  geaendert_am TEXT DEFAULT CURRENT_TIMESTAMP
)`);

// --- Datenklassifizierung ----------------------------------------------------
// Jede Ablage trägt eine Stufe (offen | intern | vertraulich | geheim). Ohne
// diese Spalten läuft die Zugriffsprüfung ins Leere — deshalb idempotent
// nachrüsten, damit auch eine frische Installation vollständig ist.
for (const t of ['files', 'projects', 'chats']) {
  spalteNachruesten(t, 'classification', `TEXT NOT NULL DEFAULT 'intern'`);
}
// user_scope: Datei gehört ausschließlich der hochladenden Person.
spalteNachruesten('files', 'user_scope', 'INTEGER NOT NULL DEFAULT 0');
indexNachruesten('files', `CREATE INDEX IF NOT EXISTS idx_files_classification ON files(classification)`);

// Leistungsmessung: Zusatzfelder für die Kontext-Aufschlüsselung.
for (const [sp, def] of [
  ['system_chars', 'INTEGER'], ['history_chars', 'INTEGER'], ['tool_def_chars', 'INTEGER'],
  ['tool_rounds', 'INTEGER'], ['streamed', 'INTEGER'],
] as const) {
  spalteNachruesten('perf_log', sp, def);
}

export const db = drizzle(sqlite, { schema, casing: 'snake_case' });
export const sqliteConnection = sqlite;
export { schema };
