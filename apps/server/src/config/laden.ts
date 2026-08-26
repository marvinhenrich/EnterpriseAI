import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// =============================================================================
// Konfiguration aus dem Installationsordner nachladen.
//
// Der Quellbaum enthält keine Konfiguration. Wo die Installation liegt, sagt
// CONFIG_DIR; ohne Angabe wird ein Ordner „config" neben dem Projekt gesucht.
//
// MUSS vor jedem Zugriff auf env laufen — deshalb ein eigenes Modul ohne
// Abhängigkeiten, das ganz am Anfang importiert wird.
//
// Bereits gesetzte Umgebungsvariablen haben VORRANG. So kann eine
// Container-Umgebung oder ein Dienstmanager einzelne Werte überschreiben,
// ohne die Datei zu ändern.
// =============================================================================

const HIER = dirname(fileURLToPath(import.meta.url)); // apps/server/src/config

function projektWurzel(): string {
  return resolve(HIER, '../../../..'); // .../<Projekt>
}

/** Zeilen der Form KEY=VALUE lesen. Kommentare und leere Zeilen überspringen. */
function leseEnvDatei(pfad: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const zeile of readFileSync(pfad, 'utf8').split(/\r?\n/)) {
    const t = zeile.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const key = t.slice(0, i).trim();
    let wert = t.slice(i + 1).trim();
    // Anführungszeichen entfernen. Nötig für Werte mit „#", das Node sonst
    // als Kommentarbeginn liest — etwa BRAND_COLOR="#1E3C7B".
    if ((wert.startsWith('"') && wert.endsWith('"')) || (wert.startsWith("'") && wert.endsWith("'"))) {
      wert = wert.slice(1, -1);
    } else {
      const k = wert.indexOf(' #');
      if (k >= 0) wert = wert.slice(0, k).trim();
    }
    out[key] = wert;
  }
  return out;
}

/** Gibt den benutzten Konfigurationsordner zurück (oder null). */
export function ladeKonfiguration(): string | null {
  const angegeben = process.env.CONFIG_DIR;
  const kandidaten = angegeben
    ? [isAbsolute(angegeben) ? angegeben : resolve(process.cwd(), angegeben)]
    : [join(projektWurzel(), 'config'), resolve(process.cwd(), '../config'), '/etc/enterpriseai'];

  for (const ordner of kandidaten) {
    const datei = join(ordner, '.env');
    if (!existsSync(datei)) continue;
    try {
      for (const [k, v] of Object.entries(leseEnvDatei(datei))) {
        // Vorrang für bereits Gesetztes (Container, Dienstmanager, Shell).
        if (process.env[k] === undefined || process.env[k] === '') process.env[k] = v;
      }
      process.env.CONFIG_DIR = ordner;
      return ordner;
    } catch {
      // Unlesbare Datei überspringen und den nächsten Kandidaten versuchen.
    }
  }
  return null;
}
