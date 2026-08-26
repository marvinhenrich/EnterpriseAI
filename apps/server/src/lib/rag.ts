import { sqliteConnection as sqlite } from '../db/client.ts';
import { embed } from '../llm/ollama.ts';
import { log } from './logger.ts';

// =============================================================================
// RAG: Datei-Chunks werden bei Upload embedded (nomic-embed-text, 768 dim) und
// in der sqlite-vec-Tabelle file_chunks gespeichert. Bei einer Query mit
// angehängten Dateien werden die semantisch relevantesten Chunks per KNN
// abgerufen — statt den ganzen (ggf. riesigen) Dateitext in den Prompt zu kippen.
// =============================================================================

const CHUNK_SIZE = 1400;
const CHUNK_OVERLAP = 200;
const MAX_CHUNKS_PER_FILE = 400;

function toBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

/** Teilt Text in überlappende Chunks (an Absatz-/Satzgrenzen, wo möglich). */
export function chunkText(text: string): string[] {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length && chunks.length < MAX_CHUNKS_PER_FILE) {
    let end = Math.min(start + CHUNK_SIZE, clean.length);
    // An einer Grenze (Absatz/Satz/Zeile) brechen, wenn nicht am Ende.
    if (end < clean.length) {
      const slice = clean.slice(start, end);
      const br = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('. '), slice.lastIndexOf('\n'));
      if (br > CHUNK_SIZE * 0.5) end = start + br + 1;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks.filter((c) => c.length > 0);
}

const insChunk = sqlite.prepare('INSERT INTO rag_chunks(embedding, file_id, content) VALUES (?, ?, ?)');
const delChunks = sqlite.prepare('DELETE FROM rag_chunks WHERE file_id = ?');

/** Indexiert den Text einer Datei (Chunk → Embedding → vec-Tabelle). */
export async function indexFile(fileId: string, text: string): Promise<number> {
  const chunks = chunkText(text);
  if (chunks.length === 0) return 0;
  delChunks.run(fileId); // alte Chunks ersetzen (idempotent)
  let n = 0;
  for (let i = 0; i < chunks.length; i++) {
    try {
      const vec = await embed(chunks[i]!);
      insChunk.run(toBlob(vec), fileId, chunks[i]!);
      n++;
    } catch (err) {
      log.warn('[RAG] Embedding fehlgeschlagen', { fileId, chunk: i, error: (err as Error).message });
    }
  }
  // Ein Totalausfall meldete bisher „chunks: 0" auf info-Ebene und sah aus wie
  // ein Erfolg. Genau so blieben drei Dateien monatelang unauffindbar.
  if (n < chunks.length) {
    log.warn('[RAG] Nicht alle Abschnitte indexiert', { fileId, erwartet: chunks.length, erhalten: n });
  } else {
    log.info('[RAG] Datei indexiert', { fileId, chunks: n });
  }
  return n;
}

export function hasIndex(fileId: string): boolean {
  return (sqlite.prepare('SELECT count(*) c FROM rag_chunks WHERE file_id = ?').get(fileId) as { c: number }).c > 0;
}

export function deleteFileIndex(fileId: string): void {
  delChunks.run(fileId);
}

interface RetrievedChunk {
  fileId: string;
  content: string;
  distance: number;
}

/**
 * Holt die k relevantesten Chunks zu `query` aus den angegebenen Dateien.
 * Scoped per file_id-Metadaten-Filter (kein Leaken fremder Dokumente).
 */
const RRF_K = 60;
const W_VEC = 1.0;
const W_KW = 0.6;
const RAG_STOPWORDS = new Set(
  ('der die das den dem des ein eine einen einer eines und oder aber wie was wer wo wann warum ist sind war waren ' +
   'hat haben wird werden kann können soll sollen muss müssen für mit von zu im in am an auf bei aus nach über ' +
   'unter vor durch gibt es sich nicht auch noch nur mehr sehr bitte mir mich uns wir ich du sie ihr man').split(' '),
);

/**
 * Holt die relevantesten Chunks zu `query` aus den angegebenen Dateien.
 * Hybrid: semantische Nachbarschaft UND Stichworttreffer, zusammengeführt per
 * Reciprocal Rank Fusion. Exakte Bezeichner (Artikel-/Chargennummern) gehen bei
 * reiner Vektorsuche sonst unter.
 * Scoped per file_id-Metadaten-Filter (kein Leaken fremder Dokumente).
 */
/**
 * Ab dieser Distanz gilt ein Abschnitt als themenfremd.
 *
 * Kalibriert an echten Fragen gegen die Projektdateien: Sachfragen an ein
 * Sicherheitsdatenblatt („Flammpunkt von FoamStar?", „Lagertemperatur AMP 90?")
 * liegen bei 0,29–0,43. Eine Fachfrage, zu der in den Datenblättern nichts
 * steht, liegt bei 0,64. Dazwischen ist Luft.
 *
 * Ohne diese Schwelle lieferte die Suche IMMER sechs Treffer und überschrieb sie
 * mit „Relevante Auszüge" — gemessen waren es Frachtflugzeug-Grenzwerte und
 * Regenwurm-Toxizität zur Frage nach dem Nassabrieb.
 */
const RAG_MAX_DISTANCE = 0.50;

export async function retrieve(
  query: string,
  fileIds: string[],
  k = 6,
  maxDistance = RAG_MAX_DISTANCE,
): Promise<RetrievedChunk[]> {
  if (fileIds.length === 0) return [];
  const indexed = fileIds.filter((id) => hasIndex(id));
  if (indexed.length === 0) return [];

  const pool = Math.max(k * 3, 12);
  const placeholders = indexed.map(() => '?').join(',');

  const qvec = toBlob(await embed(query));
  const vecRows = sqlite
    .prepare(
      `SELECT file_id AS fileId, content, distance
       FROM rag_chunks
       WHERE embedding MATCH ? AND k = ? AND file_id IN (${placeholders})
       ORDER BY distance`,
    )
    .all(qvec, pool, ...indexed)
    .filter((r) => (r as RetrievedChunk).distance <= maxDistance) as RetrievedChunk[];

  // Nur spezifische Begriffe (Ziffern, Abkürzungen, lange Fachwörter) — siehe kb.ts.
  const words = [...new Set(
    query.replace(/[^\p{L}\p{N}\s.-]/gu, ' ').split(/\s+/)
      .filter((w) => w.length >= 2 && !RAG_STOPWORDS.has(w.toLowerCase()))
      .filter((w) => /\d/.test(w) || /^[A-ZÄÖÜ]{2,}/.test(w) || w.length >= 12)
      .map((w) => w.toLowerCase()),
  )].slice(0, 8);

  let kwRows: RetrievedChunk[] = [];
  if (words.length > 0) {
    try {
      // Klammern zwingend: in SQLite bindet '+' stärker als LIKE.
  const conds = words.map(() => '(lower(content) LIKE ?)').join(' + ');
      kwRows = sqlite
        .prepare(
          `SELECT file_id AS fileId, content, 0.45 AS distance, (${conds}) AS treffer
             FROM rag_chunks
            WHERE file_id IN (${placeholders}) AND treffer > 0
            ORDER BY treffer DESC
            LIMIT ?`,
        )
        .all(...words.map((w) => `%${w}%`), ...indexed, pool) as RetrievedChunk[];
    } catch (err) {
      log.warn('[RAG] Stichwortsuche fehlgeschlagen', { error: (err as Error).message });
    }
  }

  const merged = new Map<string, RetrievedChunk & { rrf: number }>();
  const key = (r: RetrievedChunk) => `${r.fileId}::${r.content.slice(0, 60)}`;
  vecRows.forEach((r, i) => merged.set(key(r), { ...r, rrf: W_VEC / (RRF_K + i + 1) }));
  kwRows.forEach((r, i) => {
    const ex = merged.get(key(r));
    if (ex) ex.rrf += W_KW / (RRF_K + i + 1);
    // W_KW, nicht W_VEC: Ein reiner Stichworttreffer ohne Vektorbeleg ist
    // schwächer als ein semantischer Treffer und darf nicht wie einer gewichtet
    // werden. Stand vorher auf W_VEC (1,0) statt W_KW (0,6) — ein Tippfehler,
    // durch den Stichworttreffer wie Spitzentreffer nach oben sortiert wurden.
    else merged.set(key(r), { ...r, rrf: W_KW / (RRF_K + i + 1) });
  });

  return [...merged.values()].sort((a, b) => b.rrf - a.rrf).slice(0, k);
}

/** Baut den RAG-Kontextblock aus abgerufenen Chunks. */
export function buildRagContext(chunks: RetrievedChunk[], fileNames: Map<string, string>): string {
  if (chunks.length === 0) return '';
  const parts = chunks.map((c, i) => `### ${fileNames.get(c.fileId) ?? 'Datei'} (Auszug ${i + 1})\n${c.content}`);
  return `Relevante Auszüge aus den angehängten Dateien:\n\n${parts.join('\n\n---\n\n')}`;
}
