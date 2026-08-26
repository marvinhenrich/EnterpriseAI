import { tokenStore } from './api';
// =============================================================================
// Erscheinungsbild der Installation.
//
// Der Quelltext enthält KEINEN Firmennamen. Beim Start fragt die Oberfläche
// beim Server nach, wie diese Installation heißt und welche Bereiche aktiv
// sind. Bis die Antwort da ist, gelten neutrale Vorgaben.
// =============================================================================

export interface Branding {
  appName: string;
  appShort: string;
  organisation: string;
  farbe: string;
  hatLogo: boolean;
  /** Sprache der gesamten Installation. Siehe src/i18n. */
  sprache: 'de' | 'en';
}

const VORGABE: Branding = {
  appName: 'EnterpriseAI',
  appShort: 'EnterpriseAI',
  organisation: '',
  farbe: '#2563eb',
  hatLogo: false,
  sprache: 'de',
};

let aktuell: Branding = VORGABE;
const horcher = new Set<(b: Branding) => void>();

export function branding(): Branding {
  return aktuell;
}

/** Beim Start einmal laden. Ohne Anmeldung erreichbar (Anmeldebildschirm). */
export async function ladeBranding(): Promise<Branding> {
  try {
    const r = await fetch('/api/branding');
    if (r.ok) {
      aktuell = { ...VORGABE, ...(await r.json()) };
      // Markenfarbe als CSS-Variable, damit sie überall gilt.
      document.documentElement.style.setProperty('--color-accent', aktuell.farbe);
      // Sprache am Dokument setzen: Vorlesehilfen, Rechtschreibpruefung und
      // Silbentrennung des Browsers richten sich danach.
      document.documentElement.lang = aktuell.sprache;
      document.title = aktuell.appName;
      horcher.forEach((h) => h(aktuell));
    }
  } catch {
    // Netzfehler: neutrale Vorgaben behalten, nicht scheitern.
  }
  return aktuell;
}

export function aufBranding(fn: (b: Branding) => void): () => void {
  horcher.add(fn);
  fn(aktuell);
  return () => horcher.delete(fn);
}

// --- Aktive Module -----------------------------------------------------------
let module = new Set<string>();

export async function ladeModule(): Promise<Set<string>> {
  try {
    const t = tokenStore.get();
    const r = await fetch('/api/modules', { headers: t ? { Authorization: `Bearer ${t}` } : {} });
    if (r.ok) module = new Set(((await r.json()) as { aktiv: string[] }).aktiv);
  } catch {
    // Im Zweifel alles zeigen — ein Netzfehler soll keine Bereiche verstecken.
    module = new Set();
  }
  return module;
}

/** Unbekannt oder nicht geladen = anzeigen. Verstecken nur bei klarem Nein. */
export function modulAn(id: string): boolean {
  return module.size === 0 || module.has(id);
}

/** Dateinamen-tauglicher Kurzname für Downloads: „Muster GmbH" -> „muster-gmbh". */
export function dateiPraefix(): string {
  return (aktuell.appShort || 'ki')
    .toLowerCase()
    .replace(/[äöüß]/g, (m) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' })[m] ?? m)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'ki';
}
