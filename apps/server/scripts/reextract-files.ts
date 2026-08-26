/**
 * Bestandsdateien erneut einlesen.
 *
 * Dateien werden mit den Lesern verarbeitet, die zum Zeitpunkt des Uploads
 * vorhanden waren. Kommt ein Format später dazu (.py, .doc/WordprocessingML,
 * Binär-.xls, ZIP, inhaltsbasierte Erkennung), bleiben ältere Uploads unlesbar,
 * obwohl die Datei vollständig auf der Platte liegt. Dieses Skript holt das nach.
 *
 * Aufruf:
 *   node --import tsx --env-file=../../.env scripts/reextract-files.ts [--alle] [--dry]
 *
 *   ohne Flag  nur Dateien ohne oder mit sehr wenig Text (Standard)
 *   --alle     jede Dokumentdatei erneut einlesen (z. B. nach Parser-Änderung)
 *   --dry      nur anzeigen, nichts schreiben
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.ts';
import { files } from '../src/db/schema.ts';
import { extractFileText } from '../src/lib/files.ts';
import { indexFile } from '../src/lib/rag.ts';
import { env } from '../src/config/env.ts';

const alle = process.argv.includes('--alle');
const dry = process.argv.includes('--dry');
const MIN_ZEICHEN = 20; // darunter gilt eine Datei als nicht gelesen

const rows = db.select().from(files).all().filter((f) => f.kind === 'document');
const kandidaten = alle ? rows : rows.filter((f) => (f.extractedText?.trim().length ?? 0) < MIN_ZEICHEN);

console.log(`${rows.length} Dokumente gesamt, ${kandidaten.length} werden neu eingelesen${dry ? ' (Probelauf)' : ''}.\n`);

let besser = 0;
let unveraendert = 0;
let fehlt = 0;
let fehler = 0;

for (const f of kandidaten) {
  const vorher = f.extractedText?.length ?? 0;
  if (!existsSync(f.storedPath)) {
    console.log(`  fehlt auf Platte   ${f.filename}`);
    fehlt++;
    continue;
  }
  try {
    const text = (await extractFileText(await readFile(f.storedPath), f.filename)).slice(0, env.MAX_FILE_STORED_CHARS);
    const nachher = text.trim().length;
    if (nachher <= vorher) {
      unveraendert++;
      if (nachher === 0) console.log(`  weiterhin leer     ${f.filename}`);
      continue;
    }
    if (!dry) {
      db.update(files).set({ extractedText: text }).where(eq(files.id, f.id)).run();
      // Auch für die Suche neu zerlegen, sonst bleibt der Text im Chat auffindbar,
      // aber nicht über das Wissens-Retrieval.
      await indexFile(f.id, text).catch((err) => console.log(`    (Index fehlgeschlagen: ${(err as Error).message})`));
    }
    console.log(`  ${String(vorher).padStart(7)} -> ${String(nachher).padStart(8)} Zeichen   ${f.filename}`);
    besser++;
  } catch (err) {
    console.log(`  FEHLER             ${f.filename}: ${(err as Error).message.slice(0, 90)}`);
    fehler++;
  }
}

console.log(`\nVerbessert: ${besser} | unverändert: ${unveraendert} | Datei fehlt: ${fehlt} | Fehler: ${fehler}`);
process.exit(0);
