import { getSetting, setSetting } from './settings.ts';
import { branding } from '../config/branding.ts';

// =============================================================================
// Unternehmens-Konfiguration.
//
// Name, Betreiber, Farbe und Sprache einer Installation gehören dem Betrieb,
// nicht dem Quelltext. Bisher standen sie ausschließlich in Umgebungsvariablen
// — eine Änderung hieß: Datei bearbeiten, Dienst neu starten, also ein Termin
// mit der IT. Jetzt darf ein Administrator sie in der Oberfläche setzen.
//
// VORRANG: Was in der Datenbank steht, gewinnt. Ist dort nichts gesetzt, gilt
// die Umgebungsvariable. So verhält sich eine bestehende Installation nach dem
// Einbau exakt wie vorher, und niemand muss etwas nachtragen.
//
// Die Sprache ist bewusst eine Einstellung der INSTALLATION, nicht des Nutzers
// und nicht des Browsers: In einem Betrieb sprechen alle dieselbe Sprache, und
// Beschriftungen, über die man sich verständigt, sollen bei allen gleich heißen.
// =============================================================================

/** Unterstützte Sprachen. Muss zu `apps/web/src/i18n` passen. */
export const SPRACHEN = ['de', 'en'] as const;
export type Sprache = (typeof SPRACHEN)[number];

/** Deutsch ist Vorgabe und Referenz: englische Lücken fallen darauf zurück. */
export const STANDARD_SPRACHE: Sprache = 'de';

export interface Unternehmen {
  appName: string;
  appShort: string;
  organisation: string;
  farbe: string;
  sprache: Sprache;
}

const SCHLUESSEL = {
  appName: 'org_app_name',
  appShort: 'org_app_short',
  organisation: 'org_name',
  farbe: 'org_farbe',
  sprache: 'org_sprache',
} as const;

/** Eine per Hand verdrehte Zeile in der Tabelle darf die Oberfläche nicht lahmlegen. */
function istSprache(v: unknown): v is Sprache {
  return typeof v === 'string' && (SPRACHEN as readonly string[]).includes(v);
}

function istFarbe(v: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(v);
}

/** Gespeicherter Wert, sonst der Wert aus der Umgebung. */
function wert(key: string, vorgabe: string): string {
  const v = getSetting(key);
  return v === null || v.trim() === '' ? vorgabe : v.trim();
}

export function unternehmen(): Unternehmen {
  const gespeicherteSprache = getSetting(SCHLUESSEL.sprache);
  const farbe = wert(SCHLUESSEL.farbe, branding.farbe);
  const appName = wert(SCHLUESSEL.appName, branding.appName);
  return {
    appName,
    // Kurzform leer lassen ist erlaubt und heißt „wie der volle Name".
    appShort: wert(SCHLUESSEL.appShort, branding.appShort) || appName,
    organisation: wert(SCHLUESSEL.organisation, branding.organisation),
    farbe: istFarbe(farbe) ? farbe : branding.farbe,
    sprache: istSprache(gespeicherteSprache) ? gespeicherteSprache : STANDARD_SPRACHE,
  };
}

export interface UnternehmenPatch {
  appName?: string;
  appShort?: string;
  organisation?: string;
  farbe?: string;
  sprache?: string;
}

/**
 * Setzt einzelne Felder. Gibt die abgelehnten Felder mit Begründung zurück,
 * statt sie still zu verwerfen — sonst klickt jemand auf Speichern, sieht kein
 * Ergebnis und sucht den Fehler an der falschen Stelle.
 */
export function setzeUnternehmen(patch: UnternehmenPatch): { ok: true } | { ok: false; fehler: string } {
  if (patch.farbe !== undefined) {
    const f = patch.farbe.trim();
    // Leer heißt „zurück auf die Vorgabe", ein Wert muss aber gültig sein.
    if (f !== '' && !istFarbe(f)) {
      return { ok: false, fehler: 'Die Farbe muss als Hex-Wert angegeben werden, z. B. #2563eb.' };
    }
  }
  if (patch.sprache !== undefined && !istSprache(patch.sprache)) {
    return { ok: false, fehler: `Unbekannte Sprache. Möglich sind: ${SPRACHEN.join(', ')}.` };
  }
  if (patch.appName !== undefined && patch.appName.trim() === '') {
    return { ok: false, fehler: 'Der Name der Anwendung darf nicht leer sein.' };
  }

  const feld = (k: keyof typeof SCHLUESSEL, v: string | undefined) => {
    if (v === undefined) return;
    setSetting(SCHLUESSEL[k], v.trim().slice(0, 200));
  };
  feld('appName', patch.appName);
  feld('appShort', patch.appShort);
  feld('organisation', patch.organisation);
  feld('farbe', patch.farbe);
  feld('sprache', patch.sprache);
  return { ok: true };
}

/** Nur die Sprache — der häufigste Zugriff. */
export function sprache(): Sprache {
  return unternehmen().sprache;
}
