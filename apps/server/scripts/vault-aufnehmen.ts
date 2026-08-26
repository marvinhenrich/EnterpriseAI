/**
 * Vorhandene Dateien ins firmenweite Wissens-Vault übernehmen.
 *
 * Hintergrund: Gemessen am 17.08.2026 waren 7,9 Mio. Zeichen Firmenwissen im
 * System, aber nur 80 Abschnitte (1,8 %) firmenweit auffindbar. Der Rest lag in
 * persönlichen Dateien und war nur erreichbar, wenn jemand sie zufällig anhängt.
 *
 * HARTE SPERRE: Eingestufte Dateien (ab „vertraulich") werden NIE übernommen —
 * geprüft wird jede einzelne, nicht nur die Auswahl. Ein Arbeitsdokument gehört nicht
 * ins Allgemeinwissen, auch nicht versehentlich.
 *
 * Aufruf:
 *   scripts/vault-aufnehmen.ts --liste            zeigt Kandidaten, ändert nichts
 *   scripts/vault-aufnehmen.ts --datei <id> …     bestimmte Dateien übernehmen
 *   scripts/vault-aufnehmen.ts --gruppe sdb       ganze Kandidatengruppe
 */
import { randomUUID } from 'node:crypto';
import { db, sqliteConnection as sqlite } from '../src/db/client.ts';
import { kbDocuments } from '../src/db/schema.ts';
import { darfInsVault, normalisiereKlasse, KLASSEN } from '../src/lib/classification.ts';
import { chunkText } from '../src/lib/rag.ts';
import { embed } from '../src/llm/ollama.ts';

/** Float-Vektor in das Blob-Format von sqlite-vec — wie in lib/kb.ts. */
function toBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}
import { log } from '../src/lib/logger.ts';

interface Kandidat {
  id: string; filename: string; classification: string; username: string | null;
  zeichen: number; gruppe: string;
}

/** Grobe Einordnung nach Dateiname — nur als Vorschlag, entschieden wird bewusst. */
function gruppiere(name: string): string {
  const f = name.toLowerCase();
  if (/_sd|_sdb|sicherheitsdatenblatt|_tds|_tm\.|datenblatt|_spe|sds/.test(f)) return 'sdb';
  if (/verfahrensanweisung|anweisung|richtlinie|vorschrift|norm|iso|din/.test(f)) return 'anweisung';
  if (/umweltzeichen|ecolabel|uz\d|zertifik|compliance|annex/.test(f)) return 'compliance';
  if (/protokoll|transkript|mailverkehr|besprech|transskript/.test(f)) return 'protokoll';
  if (/\.xlsx?$|\.csv$|abfrage|werteliste|tabellen|artikel/.test(f)) return 'tabelle';
  return 'sonstiges';
}

const kandidaten = (
  sqlite
    .prepare(
      `SELECT f.id, f.filename, f.classification, u.username,
              length(coalesce(f.extracted_text,'')) AS zeichen
         FROM files f LEFT JOIN users u ON u.id = f.user_id
        WHERE f.kind = 'document' AND length(coalesce(f.extracted_text,'')) > 400
        ORDER BY f.filename`,
    )
    .all() as Omit<Kandidat, 'gruppe'>[]
).map((k) => ({ ...k, gruppe: gruppiere(k.filename) }));

const bereitsDrin = new Set(
  (sqlite.prepare('SELECT filename FROM kb_documents').all() as { filename: string }[]).map((r) => r.filename),
);

const args = process.argv.slice(2);
const nurListe = args.includes('--liste') || args.length === 0;
const gruppe = args[args.indexOf('--gruppe') + 1];
const dateiIds = args.includes('--datei') ? args.slice(args.indexOf('--datei') + 1).filter((a) => !a.startsWith('--')) : [];

if (nurListe) {
  const nachGruppe = new Map<string, Kandidat[]>();
  for (const k of kandidaten) {
    if (!nachGruppe.has(k.gruppe)) nachGruppe.set(k.gruppe, []);
    nachGruppe.get(k.gruppe)!.push(k);
  }
  console.log('Kandidaten für das firmenweite Wissens-Vault\n');
  for (const [g, liste] of [...nachGruppe].sort((a, b) => b[1].length - a[1].length)) {
    const frei = liste.filter((k) => darfInsVault(k.classification));
    const gesperrt = liste.length - frei.length;
    const neu = frei.filter((k) => !bereitsDrin.has(k.filename));
    console.log(`  ${g.padEnd(12)} ${String(liste.length).padStart(3)} Dateien | ${String(neu.length).padStart(3)} übernehmbar` +
      (gesperrt ? ` | ${gesperrt} eingestuft und gesperrt` : ''));
  }
  console.log('\nMit --gruppe <name> übernehmen. Eingestufte Dateien werden immer übersprungen.');
  process.exit(0);
}

const auswahl = dateiIds.length
  ? kandidaten.filter((k) => dateiIds.includes(k.id))
  : kandidaten.filter((k) => k.gruppe === gruppe);

if (auswahl.length === 0) {
  console.log('Keine passenden Dateien gefunden.');
  process.exit(1);
}

let uebernommen = 0, gesperrt = 0, uebersprungen = 0;
for (const k of auswahl) {
  // Die Sperre gilt je Datei — nicht je Auswahl.
  if (!darfInsVault(k.classification)) {
    console.log(`  gesperrt      ${k.filename.slice(0, 54).padEnd(54)} (${KLASSEN[normalisiereKlasse(k.classification)].label})`);
    gesperrt++;
    continue;
  }
  if (bereitsDrin.has(k.filename)) {
    uebersprungen++;
    continue;
  }
  const row = sqlite.prepare('SELECT extracted_text, stored_path, mime, size FROM files WHERE id = ?').get(k.id) as
    | { extracted_text: string; stored_path: string; mime: string | null; size: number }
    | undefined;
  if (!row?.extracted_text?.trim()) { uebersprungen++; continue; }

  const id = randomUUID();
  const teile = chunkText(row.extracted_text);
  let n = 0;
  for (const t of teile) {
    try {
      sqlite.prepare('INSERT INTO kb_chunks(embedding, doc_id, content) VALUES (?, ?, ?)').run(toBlob(await embed(t)), id, t);
      n++;
    } catch (err) {
      log.warn('[Vault] Embedding fehlgeschlagen', { datei: k.filename, error: (err as Error).message });
    }
  }
  db.insert(kbDocuments)
    .values({
      id, title: k.filename, filename: k.filename, storedPath: row.stored_path,
      mime: row.mime, size: row.size, chunks: n, folder: 'Aus Dateien übernommen',
      tags: JSON.stringify(['übernommen', k.gruppe]), visibility: '', uploadedBy: null,
    })
    .run();
  console.log(`  übernommen    ${k.filename.slice(0, 54).padEnd(54)} ${String(n).padStart(4)} Abschnitte`);
  uebernommen++;
}

console.log(`\nÜbernommen: ${uebernommen} | gesperrt (eingestuft): ${gesperrt} | übersprungen: ${uebersprungen}`);
process.exit(0);
