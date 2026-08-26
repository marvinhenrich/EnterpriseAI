import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { labels, labelTerms, labelScans } from '../db/schema.ts';
import { env } from '../config/env.ts';
import { log } from './logger.ts';

// =============================================================================
// Geteilte Etiketten-Datenbank. Persistente Labels + Begriffe + EIN
// gemeinsamer Scan-Job ("der große Topf"). OCR wird je Label gecacht → erneute
// Scans (z. B. nach Begriffsänderung) sind schnell. Rein intern (OCR-Dienst lokal).
// =============================================================================

const LABELS_DIR = resolve(process.cwd(), 'data/labels');
mkdirSync(LABELS_DIR, { recursive: true });
const OCR_GROUPS = ['latin', 'cyrillic', 'chinese']; // Sprachen automatisch (KI entscheidet)
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff']);

// Aggressive Normalisierung (OCR-tolerant): klein, Diakritika weg, Satzzeichen → Leer.
function norm(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // č→c, é→e … (OCR verschluckt Akzente oft)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Begrenzte Levenshtein-Distanz (mit Früh-Abbruch). a,b kurz (Begriff/Token).
function lev(a: string, b: string, max: number): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > max) return max + 1;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (cur[j]! < best) best = cur[j]!;
    }
    if (best > max) return max + 1; // ganze Zeile schon > max → raus
    prev = cur;
  }
  return prev[n]!;
}

// Token-Index nach Länge (für schnelles Fuzzy ohne O(n²) über den ganzen Text).
function tokenIndex(hay: string): Map<number, string[]> {
  const idx = new Map<number, string[]>();
  for (const tok of hay.split(' ')) {
    if (!tok) continue;
    const arr = idx.get(tok.length);
    if (arr) arr.push(tok); else idx.set(tok.length, [tok]);
  }
  return idx;
}

// Begriff gefunden? Exakt (Teilstring) bevorzugt; sonst Fuzzy auf Einzel-Token
// (Längen-gefiltert, ~1 Fehler je 4 Zeichen). Mehrwort/kurz/CJK → nur exakt.
function termMatches(hay: string, idx: Map<number, string[]>, n: string): boolean {
  if (!n) return false;
  if (hay.includes(n)) return true;
  if (n.includes(' ') || n.length < 4) return false; // mehrwortig/kurz → exakt
  const maxErr = Math.max(1, Math.floor(n.length / 4));
  for (let L = n.length - maxErr; L <= n.length + maxErr; L++) {
    for (const tok of idx.get(L) ?? []) {
      if (lev(n, tok, maxErr) <= maxErr) return true;
    }
  }
  return false;
}

// --- Labels ------------------------------------------------------------------
export function addLabel(userId: number, userName: string, filename: string, buffer: Buffer): { id: string } {
  const id = randomUUID();
  const ext = extname(filename).toLowerCase();
  const kind = IMAGE_EXTS.has(ext) ? 'image' : 'pdf';
  const storedPath = join(LABELS_DIR, `${id}${ext || (kind === 'image' ? '.png' : '.pdf')}`);
  writeFileSync(storedPath, buffer);
  db.insert(labels).values({ id, filename, storedPath, kind, size: buffer.length, uploadedBy: userId, uploadedByName: userName }).run();
  return { id };
}

export function listLabels() {
  return db.select().from(labels).orderBy(desc(labels.createdAt)).all().map((l) => ({
    id: l.id,
    filename: l.filename,
    kind: l.kind,
    size: l.size,
    pages: l.pages,
    ocrStatus: l.ocrStatus,
    status: l.lastStatus,
    found: l.lastFound ? (JSON.parse(l.lastFound) as string[]) : [],
    uploadedByName: l.uploadedByName,
    createdAt: l.createdAt,
  }));
}

export function deleteLabel(id: string): boolean {
  const row = db.select().from(labels).where(eq(labels.id, id)).get();
  if (!row) return false;
  if (existsSync(row.storedPath)) try { unlinkSync(row.storedPath); } catch { /* egal */ }
  db.delete(labels).where(eq(labels.id, id)).run();
  return true;
}

export function labelStats() {
  const total = db.select({ c: sql<number>`count(*)` }).from(labels).get()?.c ?? 0;
  const ocrDone = db.select({ c: sql<number>`count(*)` }).from(labels).where(eq(labels.ocrStatus, 'done')).get()?.c ?? 0;
  const hits = db.select({ c: sql<number>`count(*)` }).from(labels).where(eq(labels.lastStatus, 'treffer')).get()?.c ?? 0;
  const terms = db.select({ c: sql<number>`count(*)` }).from(labelTerms).get()?.c ?? 0;
  return { total, ocrDone, hits, terms };
}

// --- Begriffe (Richtlinie) ---------------------------------------------------
export function listTerms() {
  return db.select().from(labelTerms).orderBy(labelTerms.term).all().map((t) => ({
    id: t.id,
    term: t.term,
    variants: t.variants ? (JSON.parse(t.variants) as string[]) : null, // null = wird noch übersetzt
  }));
}

export function addTerms(userId: number, terms: string[]): number {
  let added = 0;
  for (const raw of terms) {
    const term = raw.trim();
    if (!term) continue;
    const res = db.insert(labelTerms).values({ term, addedBy: userId }).onConflictDoNothing().run();
    added += res.changes;
  }
  if (added > 0) void translatePending(); // im Hintergrund DE → alle Sprachen
  return added;
}

// --- Mehrsprachige Übersetzung der Begriffe (gpt-oss) ------------------------
// Deutsche Begriffe werden in alle Zielsprachen + Synonyme übersetzt, sodass der
// Scan inhaltsgleiche Treffer in JEDER Sprache findet. Ergebnis je Begriff gecacht.
// EIN Begriff → alle Sprachvarianten. Begriff-für-Begriff = zuverlässig (keine
// Auslassung wie bei Batch). Gibt null bei Fehler (→ bleibt pending, Retry später).
async function translateOne(germanTerm: string): Promise<string[] | null> {
  const prompt =
    `Du bist ein präziser Fachterminologie-Übersetzer für Gefahrstoff-/Produktetiketten. ` +
    `Übersetze den deutschen Begriff „${germanTerm}" INHALTLICH EXAKT (auf die korrekte chemische/sachliche Bedeutung achten — ` +
    `z. B. „Bleichromat" = Blei(II)-chromat = lead chromate = 铬酸铅) in Englisch, Serbisch (kyrillisch UND lateinisch) und ` +
    `Chinesisch (vereinfacht). Ergänze gängige Synonyme, Trivialnamen, Summenformel und Schreibweisen. ` +
    `Antworte AUSSCHLIESSLICH mit JSON ohne weiteren Text: {"variants":["<jede fremdsprachige Variante und jedes Synonym als eigener String>"]}`;
  try {
    const res = await fetch(`${env.OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: env.OLLAMA_MODEL, stream: false, options: { temperature: 0.1, num_predict: 2000 }, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(90000),
    });
    const data = (await res.json().catch(() => ({}))) as { message?: { content?: string } };
    const m = (data.message?.content ?? '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]) as { variants?: unknown[] };
    if (!Array.isArray(obj.variants)) return null;
    const variants = obj.variants.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
    return [...new Set(variants)];
  } catch (err) {
    log.warn('[Labels] Übersetzung fehlgeschlagen', { term: germanTerm, error: (err as Error).message });
    return null;
  }
}

let translating = false;
export async function translatePending(): Promise<void> {
  if (translating) return;
  translating = true;
  try {
    const pending = db.select().from(labelTerms).where(sql`variants IS NULL`).all();
    for (const t of pending) {
      let variants = await translateOne(t.term);
      if (variants === null) variants = await translateOne(t.term); // 1× Retry (Zuverlässigkeit)
      // null bleibt null (pending) → späterer Retry; sonst speichern (auch leer = genuin keine).
      if (variants !== null) db.update(labelTerms).set({ variants: JSON.stringify(variants) }).where(eq(labelTerms.id, t.id)).run();
    }
  } finally {
    translating = false;
  }
}

/** Alle Begriffe neu übersetzen (variants zurücksetzen + neu). */
export async function retranslateAll(): Promise<void> {
  db.update(labelTerms).set({ variants: null }).run();
  await translatePending();
}

export function deleteTerm(id: number): boolean {
  return db.delete(labelTerms).where(eq(labelTerms.id, id)).run().changes > 0;
}

export function clearTerms(): number {
  return db.delete(labelTerms).run().changes;
}

// --- Scan-Job (geteilt, gehärtet) -------------------------------------------
let activeScan: string | null = null; // In-Process-Lock (ein Node-Daemon)

export function currentScan() {
  return db.select().from(labelScans).orderBy(desc(labelScans.startedAt)).limit(1).get() ?? null;
}

function runningScan() {
  return db.select().from(labelScans).where(eq(labelScans.status, 'running')).get() ?? null;
}

async function ocrLabel(buffer: Buffer, kind: string): Promise<{ text: string; pages: number }> {
  const res = await fetch(`${env.CLASSIFIER_URL}/ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data_base64: buffer.toString('base64'), groups: OCR_GROUPS, kind }),
    signal: AbortSignal.timeout(env.CLASSIFIER_OCR_TIMEOUT_MS),
  });
  const d = (await res.json().catch(() => ({}))) as { text?: string; pages?: number; error?: string };
  if (!res.ok) throw new Error(d.error ?? 'OCR fehlgeschlagen');
  return { text: d.text ?? '', pages: d.pages ?? 0 };
}

/** Startet den gemeinsamen Scan. Wirft, wenn bereits einer läuft (gehärtet). */
export function startScan(userId: number, userName: string): { id: string } {
  if (activeScan || runningScan()) throw new Error('Es läuft bereits ein Scan.');
  const total = db.select({ c: sql<number>`count(*)` }).from(labels).get()?.c ?? 0;
  if (total === 0) throw new Error('Keine Etiketten in der Datenbank.');
  const termCount = db.select({ c: sql<number>`count(*)` }).from(labelTerms).get()?.c ?? 0;
  if (termCount === 0) throw new Error('Keine Begriffe in der Richtlinie.');
  const id = randomUUID();
  activeScan = id;
  db.insert(labelScans).values({ id, status: 'running', startedBy: userId, startedByName: userName, total, termCount, done: 0, hits: 0 }).run();
  void runScan(id).catch((e) => log.error('[Labels] Scan-Crash', { error: (e as Error).message }));
  return { id };
}

export function cancelScan(): boolean {
  const r = runningScan();
  if (!r) return false;
  db.update(labelScans).set({ status: 'canceled' }).where(eq(labelScans.id, r.id)).run();
  return true;
}

async function runScan(scanId: string): Promise<void> {
  try {
    // Sicherstellen: alle Begriffe sind in alle Sprachen übersetzt (gecacht) — so
    // findet der Scan inhaltsgleiche Treffer in JEDER Sprache.
    await translatePending();
    // Suchstrings je Begriff = deutscher Begriff + alle Varianten (normalisiert).
    const terms = db.select().from(labelTerms).all().map((t) => {
      const variants = t.variants ? (JSON.parse(t.variants) as string[]) : [];
      const needles = [t.term, ...variants].map(norm).filter((n, i, a) => n && a.indexOf(n) === i);
      return { de: t.term, needles };
    }).filter((t) => t.needles.length > 0);
    const ids = db.select({ id: labels.id }).from(labels).all().map((r) => r.id);
    let done = 0, hits = 0;
    for (const lid of ids) {
      // Abbruch-Check (gehärtet, geteilt)
      const st = db.select({ status: labelScans.status }).from(labelScans).where(eq(labelScans.id, scanId)).get();
      if (!st || st.status === 'canceled') break;

      const l = db.select().from(labels).where(eq(labels.id, lid)).get();
      if (!l) { done++; continue; }
      try {
        let text = l.ocrStatus === 'done' && l.ocrText ? l.ocrText : '';
        if (!text) {
          const buf = readFileSync(l.storedPath);
          const r = await ocrLabel(buf, l.kind);
          text = r.text;
          db.update(labels).set({ ocrText: text, ocrStatus: 'done', pages: r.pages }).where(eq(labels.id, lid)).run();
        }
        const hay = norm(text);
        const idx = tokenIndex(hay); // einmal je Label → Fuzzy bleibt schnell
        // Treffer, wenn der deutsche Begriff ODER irgendeine Übersetzungsvariante vorkommt.
        const found = terms.filter((t) => t.needles.some((nd) => termMatches(hay, idx, nd))).map((t) => t.de);
        const status = found.length ? 'treffer' : 'ok';
        if (found.length) hits++;
        db.update(labels).set({ lastFound: JSON.stringify(found), lastStatus: status, lastScanId: scanId }).where(eq(labels.id, lid)).run();
      } catch (err) {
        db.update(labels).set({ ocrStatus: 'failed', lastStatus: 'fehler', lastScanId: scanId }).where(eq(labels.id, lid)).run();
        log.warn('[Labels] OCR/Match fehlgeschlagen', { label: lid, error: (err as Error).message });
      }
      done++;
      db.update(labelScans).set({ done, hits }).where(eq(labelScans.id, scanId)).run();
    }
    const final = db.select({ status: labelScans.status }).from(labelScans).where(eq(labelScans.id, scanId)).get();
    const wasCanceled = final?.status === 'canceled';
    db.update(labelScans).set({ status: wasCanceled ? 'canceled' : 'done', finishedAt: sql`CURRENT_TIMESTAMP`, done, hits }).where(eq(labelScans.id, scanId)).run();
    log.info('[Labels] Scan fertig', { scanId, done, hits, canceled: wasCanceled });
  } catch (err) {
    db.update(labelScans).set({ status: 'failed', error: (err as Error).message, finishedAt: sql`CURRENT_TIMESTAMP` }).where(eq(labelScans.id, scanId)).run();
    log.error('[Labels] Scan fehlgeschlagen', { scanId, error: (err as Error).message });
  } finally {
    if (activeScan === scanId) activeScan = null;
  }
}
