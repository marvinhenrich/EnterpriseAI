/**
 * Fehlende Chunk-Indizes nachziehen und Waisen aufräumen.
 *
 * ANLASS: Drei Dateien mit Text hatten keine Chunks — darunter
 * „15.04.2025 Ecodis 40 SDB.pdf" in einem aktiven Projekt. Ursachen:
 *   - Die Auto-Texterkennung im Chat schreibt Text, ruft aber nie indexFile().
 *   - Nachträglich eingelesene Formate (.doc, PDF-OCR) wurden nicht indexiert.
 *   - deleteFile() räumt den Index nicht mit auf → Waisen.
 *
 * Ohne Chunks ist eine Datei für die gezielte Suche unsichtbar. Das fällt nicht
 * auf, solange der Volltext ohnehin mitgeschickt wird — und wird zum stillen
 * Datenverlust, sobald man auf gezielte Suche umstellt.
 *
 * Aufruf: node --import tsx --env-file=../../.env scripts/reindex.ts [--dry]
 */
import { sqliteConnection as sqlite } from '../src/db/client.ts';
import { indexFile, deleteFileIndex } from '../src/lib/rag.ts';

const dry = process.argv.includes('--dry');

const fehlend = sqlite
  .prepare(
    `SELECT f.id, f.filename, length(f.extracted_text) AS zeichen
       FROM files f
      WHERE f.kind='document' AND length(coalesce(f.extracted_text,'')) > 100
        AND f.id NOT IN (SELECT DISTINCT file_id FROM rag_chunks)
      ORDER BY zeichen DESC`,
  )
  .all() as { id: string; filename: string; zeichen: number }[];

const waisen = (
  sqlite.prepare('SELECT DISTINCT file_id AS id FROM rag_chunks WHERE file_id NOT IN (SELECT id FROM files)').all() as { id: string }[]
).map((r) => r.id);

console.log(`Nachzuindexieren: ${fehlend.length} | Waisen: ${waisen.length}${dry ? '  (Probelauf)' : ''}\n`);

for (const f of fehlend) {
  const text = (sqlite.prepare('SELECT extracted_text FROM files WHERE id = ?').get(f.id) as { extracted_text: string }).extracted_text;
  if (dry) {
    console.log(`  würde indexieren  ${f.filename.slice(0, 52).padEnd(52)} ${String(f.zeichen).padStart(8)} Zeichen`);
    continue;
  }
  try {
    const n = await indexFile(f.id, text);
    console.log(`  indexiert         ${f.filename.slice(0, 52).padEnd(52)} ${String(n).padStart(4)} Abschnitte`);
  } catch (err) {
    console.log(`  FEHLER            ${f.filename.slice(0, 52)}: ${(err as Error).message.slice(0, 60)}`);
  }
}

for (const id of waisen) {
  if (dry) { console.log(`  würde aufräumen   Waise ${id}`); continue; }
  deleteFileIndex(id);
  console.log(`  aufgeräumt        Waise ${id}`);
}

const rest = sqlite
  .prepare(
    `SELECT count(*) c FROM files f
      WHERE f.kind='document' AND length(coalesce(f.extracted_text,'')) > 100
        AND f.id NOT IN (SELECT DISTINCT file_id FROM rag_chunks)`,
  )
  .get() as { c: number };
console.log(`\nVerbleibende Lücken: ${rest.c}`);
process.exit(0);
