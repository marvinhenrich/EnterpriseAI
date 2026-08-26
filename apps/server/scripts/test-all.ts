/**
 * Alle Prüfungen nacheinander. Vor jedem Deployment ausführen.
 *
 *   node --import tsx --env-file=../../.env scripts/test-all.ts
 *
 * Zweistufig, weil beide Stufen verschiedene Fehler finden:
 *   1. Rechenprüfungen — schnell, ohne Modell (Arithmetik, Grenzfälle).
 *   2. Werkzeugprüfungen — mit echtem Modell, findet Fehler an der Nahtstelle
 *      zwischen Modell und Werkzeug. Dauert einige Minuten.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const TESTS = [
  { name: 'Trefferqualität des Wissens-Vaults', datei: 'test-retrieval.ts', schnell: true },
  { name: 'Kontextaufbau und Referenzdateien', datei: 'test-kontext.ts', schnell: true },
  { name: 'Werkzeugbedienung durch das Modell', datei: 'test-tools.ts', schnell: false },
];

const nurSchnell = process.argv.includes('--schnell');

function lauf(datei: string): Promise<number> {
  return new Promise((fertig) => {
    const p = spawn(process.execPath, ['--import', 'tsx', '--env-file=../../.env', resolve(import.meta.dirname, datei)], {
      stdio: 'inherit',
      cwd: resolve(import.meta.dirname, '..'),
    });
    p.on('close', (code) => fertig(code ?? 1));
  });
}

let fehlgeschlagen = 0;
for (const t of TESTS) {
  if (nurSchnell && !t.schnell) {
    console.log(`\n— ${t.name}: übersprungen (--schnell)`);
    continue;
  }
  console.log(`\n=== ${t.name} ===`);
  const code = await lauf(t.datei);
  if (code !== 0) fehlgeschlagen++;
}

console.log(fehlgeschlagen === 0 ? '\n>>> Alle Prüfungen bestanden.' : `\n>>> ${fehlgeschlagen} Prüfgruppe(n) fehlgeschlagen.`);
process.exit(fehlgeschlagen === 0 ? 0 : 1);
