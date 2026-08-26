import { mkdirSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { sqliteConnection as sqlite } from '../db/client.ts';
import { kbDocuments } from '../db/schema.ts';
import { env } from '../config/env.ts';
import { embed } from '../llm/ollama.ts';
import { chunkText } from './rag.ts';
import { extractFileText } from './files.ts';
import { log } from './logger.ts';
import { visibleLevels, maySee, type VisibilityLevel } from './visibility.ts';
import { serverPfad } from '../config/pfade.ts';

// =============================================================================
// Wissens-Vault, Teil „Dokumente" (firmenweit, intern). Eigener Vektor-Index
// (kb_chunks, geteilt mit den Vault-Notizen). Dokumente werden von Kuratoren
// (Permission kb.manage) gepflegt und sind für alle mit kb.query durchsuchbar.
// Strikt intern — keine Cloud. Notizen siehe lib/vault.ts.
// =============================================================================

export type KbDocument = typeof kbDocuments.$inferSelect;

// Cosine-Distanz: kleiner = relevanter.
// Wert empirisch am echten Bestand kalibriert (2026-08-11):
//   passende Fragen  → 0.41–0.51  (z. B. „Wann ist eine Sonderfreigabe erlaubt?" 0.34)
//   themenfremde     → ab 0.66    (z. B. „Wie ist das Wetter in Rom?" 0.66)
// 0.55 liegt sauber in der Lücke: gültige Treffer kommen durch, themenfremde
// Dokumente werden abgewiesen. Zu locker (vorher 0.62) war nachweislich eine
// Hauptquelle für Falschinformationen — lieber kein Treffer als ein falscher.
const KB_MAX_DISTANCE = 0.55;
// Bis hierher gilt ein Treffer als eindeutig zur Frage passend und wird ohne
// weitere Prüfung übernommen. Darüber bis KB_MAX_DISTANCE liegt der Graubereich.
const KB_SICHER = 0.45;
const KB_TOP_K = 6; // etwas mehr Kontext — die Fusion filtert Unpassendes bereits weg

function toBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

function kbRoot(): string {
  const dir = join(serverPfad(env.UPLOAD_DIR), 'kb');
  mkdirSync(dir, { recursive: true });
  return dir;
}

const insChunk = sqlite.prepare('INSERT INTO kb_chunks(embedding, doc_id, content) VALUES (?, ?, ?)');
const delChunks = sqlite.prepare('DELETE FROM kb_chunks WHERE doc_id = ?');

/** Dokument ins Wissens-Vault aufnehmen (speichern, extrahieren, indexieren). */
export async function addKbDocument(file: File, uploadedBy: number, title?: string, folder = '', tags: string[] = [], visibility: VisibilityLevel = ''): Promise<KbDocument> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const ext = extname(file.name).toLowerCase();
  const id = randomUUID();
  const storedPath = join(kbRoot(), `${id}${ext}`);
  await writeFile(storedPath, buffer);

  const text = (await extractFileText(buffer, file.name)).trim();
  const chunks = text ? chunkText(text) : [];
  let n = 0;
  for (const ch of chunks) {
    try {
      insChunk.run(toBlob(await embed(ch)), id, ch);
      n++;
    } catch (err) {
      log.warn('[KB] Embedding fehlgeschlagen', { id, error: (err as Error).message });
    }
  }

  const row = db
    .insert(kbDocuments)
    .values({ id, title: (title || file.name).trim(), filename: file.name, storedPath, mime: file.type || null, size: buffer.length, chunks: n, folder, tags: JSON.stringify(tags), visibility, uploadedBy })
    .returning()
    .get();
  log.info('[Vault] Dokument aufgenommen', { id, title: row.title, chunks: n });
  return row;
}

/** Ohne Viewer: nur intern verwenden (z. B. Pflege). Für Anzeigen listKbDocumentsFor(). */
export function listKbDocuments(): KbDocument[] {
  return db.select().from(kbDocuments).orderBy(desc(kbDocuments.createdAt)).all();
}

/** Dokumente, die dieser Nutzer sehen darf. */
export function listKbDocumentsFor(viewer: Viewer): KbDocument[] {
  const levels = visibleLevels(viewer.userId, viewer.role) as string[];
  return listKbDocuments().filter((d) => levels.includes(String(d.visibility ?? '')));
}

export function getKbDocument(id: string): KbDocument | undefined {
  return db.select().from(kbDocuments).where(eq(kbDocuments.id, id)).get();
}

/** Dokument nur, wenn die Sichtbarkeitsstufe es erlaubt. */
export function getKbDocumentFor(viewer: Viewer, id: string): KbDocument | undefined {
  const d = getKbDocument(id);
  return d && maySee(viewer.userId, viewer.role, d.visibility) ? d : undefined;
}

/** Metadaten eines Dokuments ändern (Titel, Ordner, Tags). */
export function updateKbDocument(id: string, patch: { title?: string; folder?: string; tags?: string[]; visibility?: VisibilityLevel; aiUse?: boolean }): KbDocument | undefined {
  const set: Record<string, unknown> = {};
  if (patch.title !== undefined && patch.title.trim()) set.title = patch.title.trim().slice(0, 200);
  if (patch.folder !== undefined) set.folder = patch.folder;
  if (patch.tags !== undefined) set.tags = JSON.stringify(patch.tags);
  if (patch.visibility !== undefined) set.visibility = patch.visibility;
  if (patch.aiUse !== undefined) set.aiUse = patch.aiUse;
  if (Object.keys(set).length === 0) return getKbDocument(id);
  db.update(kbDocuments).set(set).where(eq(kbDocuments.id, id)).run();
  return getKbDocument(id);
}

export async function deleteKbDocument(id: string): Promise<boolean> {
  const row = db.select().from(kbDocuments).where(eq(kbDocuments.id, id)).get();
  if (!row) return false;
  delChunks.run(id);
  await unlink(row.storedPath).catch(() => {});
  db.delete(kbDocuments).where(eq(kbDocuments.id, id)).run();
  return true;
}

interface KbHit {
  docId: string;
  title: string;
  content: string;
  distance: number;
  kind: 'note' | 'document';
}

// --- Hybride Suche -----------------------------------------------------------
// Reine Vektorsuche verfehlt exakte Begriffe (Artikelnummern, „PS8160", „UZ 102"),
// reine Stichwortsuche verfehlt Umschreibungen. Deshalb beides parallel und über
// Reciprocal Rank Fusion zusammenführen — das ist robuster als jedes für sich.

const RRF_K = 60; // Dämpfung: Rang 1 zählt ~1/61, Rang 10 ~1/70
// Semantik wiegt schwerer als reine Wortfunde: ein Alltagswort steht in
// vielen Abschnitten, die eigentliche Definition findet nur die Vektorsuche.
// Der Stichwort-Arm bleibt wichtig für exakte Bezeichner (PS8160, UZ 102).
const W_VEC = 1.0;
const W_KW = 0.6;

/**
 * Nur SPEZIFISCHE Begriffe für den Stichwort-Arm: Bezeichner mit Ziffern
 * (PS8160), Abkürzungen in Großbuchstaben (UZ, AS2) und ungewöhnlich lange
 * Fachwörter. Alltagswörter bleiben draußen — sie stehen in
 * vielen Abschnitten, alle bekämen denselben Trefferwert und die Reihenfolge
 * wäre zufällig. Solche Fragen beantwortet die semantische Suche besser.
 */
const STOPWORDS = new Set(
  ('der die das den dem des ein eine einen einer eines und oder aber wie was wer wo wann warum ist sind war waren ' +
   'hat haben wird werden kann können soll sollen muss müssen für mit von zu im in am an auf bei aus nach über ' +
   'unter vor durch gibt es sich nicht auch noch nur mehr sehr bitte mir mich uns wir ich du sie ihr man').split(' '),
);
function keywords(query: string): string[] {
  return [...new Set(
    query
      .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !STOPWORDS.has(w.toLowerCase()))
      .filter((w) => /\d/.test(w) || /^[A-ZÄÖÜ]{2,}/.test(w) || w.length >= 12)
      .map((w) => w.toLowerCase()),
  )].slice(0, 8);
}

interface Scored { docId: string; content: string; distance: number; rrf: number }

/** Stichwortsuche über die indexierten Abschnitte (deckt exakte Begriffe ab). */
function keywordHits(query: string, limit: number, gesamt: number): { docId: string; content: string }[] {
  // Nur SELTENE Begriffe zählen. „Zusammensetzung" hat 15 Zeichen und galt
  // damit als Bezeichner — steht aber als Abschnitt 3 in jedem
  // Sicherheitsdatenblatt und zog deshalb zu jeder Chemiefrage Treffer heran.
  const words = keywords(query).filter((w) => istSelten(w, gesamt));
  if (words.length === 0) return [];
  // Abschnitte, die möglichst viele der Suchbegriffe enthalten, zuerst.
  // Klammern zwingend: in SQLite bindet '+' stärker als LIKE.
  const conds = words.map(() => '(lower(content) LIKE ?)').join(' + ');
  const params = words.map((w) => `%${w}%`);
  try {
    return sqlite
      .prepare(
        `SELECT doc_id AS docId, content, (${conds}) AS treffer
           FROM kb_chunks
          WHERE treffer > 0
          ORDER BY treffer DESC
          LIMIT ?`,
      )
      .all(...params, limit) as { docId: string; content: string }[];
  } catch (err) {
    log.warn('[Vault] Stichwortsuche fehlgeschlagen', { error: (err as Error).message });
    return [];
  }
}

export interface Viewer { userId: number; role: string }

/**
 * Hybride Suche über das Wissens-Vault (Notizen + Dokumente).
 *
 * SICHERHEIT: `viewer` ist PFLICHT. Gefiltert wird auf Ebene der Abschnitte —
 * gesperrte Inhalte gelangen damit weder in die Trefferliste noch in den
 * Prompt. Ohne diesen Filter würde die KI Vertrauliches ausplaudern.
 */
/**
 * Begriffe, die eine Frage inhaltlich festlegen.
 *
 * Wortlänge allein taugt nicht als Maßstab: „Zusammensetzung" ist lang, steht
 * aber als Abschnitt 3 in JEDEM Sicherheitsdatenblatt — als Beleg wertlos.
 * Entscheidend ist die Seltenheit IM BESTAND. Ein Begriff belegt einen Treffer
 * nur, wenn er in wenigen Abschnitten vorkommt.
 */
const HAEUFIG_ANTEIL = 0.12; // ab hier gilt ein Wort als Allerweltsbegriff
const haeufigkeitCache = new Map<string, number>();

function istSelten(wort: string, gesamt: number): boolean {
  let n = haeufigkeitCache.get(wort);
  if (n === undefined) {
    n = (sqlite.prepare('SELECT count(*) c FROM kb_chunks WHERE lower(content) LIKE ?').get(`%${wort}%`) as { c: number }).c;
    haeufigkeitCache.set(wort, n);
  }
  return n > 0 && n / Math.max(gesamt, 1) <= HAEUFIG_ANTEIL;
}

function kandidatenBegriffe(query: string): string[] {
  return [...new Set(
    query
      .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3)
      .filter((w) => /\d/.test(w) || /^[A-ZÄÖÜ]{2,}/.test(w) || w.length >= 8)
      .map((w) => w.toLowerCase()),
  )];
}

function haeufigkeit(wort: string): number {
  let n = haeufigkeitCache.get(wort);
  if (n === undefined) {
    n = (sqlite.prepare('SELECT count(*) c FROM kb_chunks WHERE lower(content) LIKE ?').get(`%${wort}%`) as { c: number }).c;
    haeufigkeitCache.set(wort, n);
  }
  return n;
}

function spezifischeBegriffe(query: string, gesamt: number): string[] {
  return kandidatenBegriffe(query).filter((w) => istSelten(w, gesamt));
}

/**
 * Nennt die Frage etwas, das im Bestand ÜBERHAUPT NICHT vorkommt?
 *
 * Gemessen an einer Produktanfrage: der Produktname stand in 0 von 438
 * Abschnitten, „zusammensetzung" dagegen in 32 (Abschnitt 3 jedes
 * Sicherheitsdatenblatts). Über den generischen Begriff zog die Suche vier
 * Datenblätter heran, die mit der Frage nichts zu tun haben.
 *
 * Fehlt der bezeichnende Begriff vollständig, lautet die richtige Antwort
 * „dazu liegt nichts vor" — und nicht das Nächstbeste.
 */
function nenntUnbekanntes(query: string): boolean {
  const kandidaten = kandidatenBegriffe(query);
  return kandidaten.length > 0 && kandidaten.some((w) => haeufigkeit(w) === 0);
}

export async function retrieveKb(
  query: string,
  viewer: Viewer,
  k = KB_TOP_K,
  /**
   * Strengere Schwelle für Fälle, in denen das Vault nur Beiwerk ist — etwa
   * wenn der Nutzer Dateien angehängt hat und nach DIESEN fragt. Gemessen:
   * „kannst du diese Datei lesen?" liefert Treffer bei 0,51–0,54 — also im
   * selben Bereich wie eine echte Fachfrage. Über die Distanz allein ist das
   * nicht trennbar; über den Kontext der Anfrage schon.
   */
  maxDistance = KB_MAX_DISTANCE,
): Promise<KbHit[]> {
  const levels = visibleLevels(viewer.userId, viewer.role);
  const count = (sqlite.prepare('SELECT count(*) c FROM kb_chunks').get() as { c: number }).c;
  if (count === 0) return [];

  // Zulässige Quellen-IDs vorab bestimmen (Notizen + Dokumente).
  // Zusätzlich zur Sichtbarkeit greift `ai_use`: ungeprüft gesammeltes Wissen
  // bleibt aus den Antworten heraus, bleibt aber in der Oberfläche durchsuchbar.
  const ph = levels.map(() => '?').join(',');
  const erlaubt = new Set<string>([
    ...(sqlite.prepare(`SELECT id FROM vault_notes WHERE visibility IN (${ph}) AND ai_use = 1`).all(...levels) as { id: string }[]).map((r) => r.id),
    ...(sqlite.prepare(`SELECT id FROM kb_documents WHERE visibility IN (${ph}) AND ai_use = 1`).all(...levels) as { id: string }[]).map((r) => r.id),
  ]);
  if (erlaubt.size === 0) return [];

  // 1) Semantisch: mehr Kandidaten holen als am Ende gebraucht werden.
  const pool = Math.max(k * 3, 12);
  const qvec = toBlob(await embed(query));
  const vecRows = sqlite
    .prepare(
      `SELECT doc_id AS docId, content, distance
         FROM kb_chunks
        WHERE embedding MATCH ? AND k = ?
        ORDER BY distance`,
    )
    .all(qvec, pool) as { docId: string; content: string; distance: number }[];
  const vecErlaubt = vecRows.filter((r) => erlaubt.has(r.docId));

  // 2) Stichwortbasiert (fängt exakte Bezeichner ab, die Vektoren verwischen).
  const kwRows = keywordHits(query, pool, count).filter((r) => erlaubt.has(r.docId));

  // 3) Zusammenführen per Reciprocal Rank Fusion.
  const merged = new Map<string, Scored>();
  const key = (docId: string, content: string) => `${docId}::${content.slice(0, 60)}`;

  vecErlaubt.forEach((r, i) => {
    merged.set(key(r.docId, r.content), { docId: r.docId, content: r.content, distance: r.distance, rrf: W_VEC / (RRF_K + i + 1) });
  });
  kwRows.forEach((r, i) => {
    const kk = key(r.docId, r.content);
    const ex = merged.get(kk);
    if (ex) ex.rrf += W_KW / (RRF_K + i + 1);
    // Stichworttreffer ohne Vektortreffer: aufnehmen, Distanz unbekannt → neutral.
    else merged.set(kk, { docId: r.docId, content: r.content, distance: 0.5, rrf: W_KW / (RRF_K + i + 1) });
  });

  // 4) Auswahl. Eine reine Distanzschwelle reicht NICHT mehr, seit das Vault
  //    von 80 auf über 400 Abschnitte gewachsen ist: Gemessen liegt „Wie
  //    repariere ich mein Fahrrad" bei 0,518 und „Blauer Engel UZ 102" bei
  //    0,517 — die Bänder überlappen. Je größer der Bestand, desto sicherer
  //    findet sich zu jeder Frage irgendetwas vage Ähnliches.
  //
  //    Deshalb zweistufig: Klar ähnliche Treffer kommen durch. Im Graubereich
  //    muss der Abschnitt zusätzlich einen SPEZIFISCHEN Begriff der Frage
  //    wörtlich enthalten — sonst ist die Ähnlichkeit bloß thematisches
  //    Grundrauschen.
  const spezifisch = spezifischeBegriffe(query, count);
  // Kommt ein bezeichnender Begriff der Frage im Bestand gar nicht vor, dürfen
  // nur noch eindeutig ähnliche Treffer durch — generische Begriffe sollen
  // nichts herbeiziehen.
  const unbekannt = nenntUnbekanntes(query);
  const belegt = (inhalt: string): boolean => {
    if (spezifisch.length === 0) return false;
    const c = inhalt.toLowerCase();
    return spezifisch.some((w) => c.includes(w));
  };
  const ranked = [...merged.values()]
    .filter((r) => {
      if (r.distance <= KB_SICHER) return true;                     // eindeutig ähnlich
      if (unbekannt) return false;                                  // Frage nennt Unbekanntes
      if (kwRows.some((w) => w.content === r.content)) return true; // Stichworttreffer
      if (r.distance > maxDistance) return false;                   // zu weit weg
      return belegt(r.content);                                     // Graubereich: Beleg nötig
    })
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, k);
  if (ranked.length === 0) return [];

  // Titel auflösen — Quelle kann ein Dokument ODER eine Vault-Notiz sein.
  const titles = new Map<string, { title: string; kind: 'note' | 'document' }>();
  for (const d of sqlite.prepare(`SELECT id, title FROM kb_documents WHERE visibility IN (${ph}) AND ai_use = 1`).all(...levels) as { id: string; title: string }[]) {
    titles.set(d.id, { title: d.title, kind: 'document' });
  }
  for (const n of sqlite.prepare(`SELECT id, title FROM vault_notes WHERE visibility IN (${ph}) AND ai_use = 1`).all(...levels) as { id: string; title: string }[]) {
    titles.set(n.id, { title: n.title, kind: 'note' });
  }
  return ranked.map((r) => {
    const meta = titles.get(r.docId);
    return { docId: r.docId, title: meta?.title ?? 'Wissens-Vault', content: r.content, distance: r.distance, kind: meta?.kind ?? 'document' };
  });
}

/** Kontextblock aus Vault-Treffern für den Prompt. */
export function buildKbContext(hits: KbHit[]): string {
  if (hits.length === 0) return '';
  const parts = hits.map((h) => `### ${h.title} (${h.kind === 'note' ? 'Notiz' : 'Dokument'})\n${h.content}`);
  return (
    `Möglicherweise relevante Auszüge aus dem internen Wissens-Vault (automatisch per Ähnlichkeitssuche gefunden, ` +
    `NICHT von einem Menschen geprüft):\n\n${parts.join('\n\n---\n\n')}\n\n` +
    `WICHTIG: Prüfe zuerst, ob diese Auszüge die Frage überhaupt betreffen. Wenn sie thematisch nicht passen, ` +
    `IGNORIERE sie vollständig und erwähne sie nicht — sage in dem Fall, dass im Wissens-Vault nichts Passendes ` +
    `hinterlegt ist. Passen sie, dann stütze dich darauf. Eine Quellenliste am Ende brauchst du NICHT — ` +
    `die Oberfläche zeigt die Quellen bereits automatisch an.`
  );
}

/** Volltext eines Dokuments aus seinen indexierten Abschnitten (für den Viewer). */
export function getKbDocumentText(id: string): string {
  const rows = sqlite.prepare('SELECT content FROM kb_chunks WHERE doc_id = ? ORDER BY rowid').all(id) as { content: string }[];
  return rows.map((r) => r.content).join('\n\n');
}
