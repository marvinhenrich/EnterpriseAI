import { sqliteConnection as sqlite } from '../db/client.ts';
import { log } from './logger.ts';

// =============================================================================
// Modulverwaltung.
//
// Das System ist generisch; was eine konkrete Installation davon nutzt,
// entscheidet der Administrator. Ein Betrieb ohne Etikettenprüfung schaltet sie
// ab und sieht sie nirgends mehr — weder im Menü, noch als Route, noch als
// Werkzeug der KI.
//
// GRUNDSATZ: Standard ist AN. Eine bestehende Installation verhält sich nach
// dem Einbau exakt wie vorher; erst ein bewusstes Abschalten ändert etwas.
//
// Der Kern (Anmeldung, Chat, Berechtigungen) ist KEIN Modul. Er lässt sich
// nicht abschalten, weil ohne ihn nichts übrig bliebe.
// =============================================================================

export interface ModulDef {
  id: string;
  name: string;
  /** Ein Satz: was der Nutzer bekommt, wenn das Modul an ist. */
  zweck: string;
  /** Fachlich zusammengehörige Module stehen in der Oberfläche beieinander. */
  gruppe: 'Wissen' | 'Dokumente' | 'Fachanwendungen' | 'Betrieb';
  /** Ohne diese Module ergibt dieses hier keinen Sinn. */
  braucht?: string[];
  /** Externe Voraussetzung, die der Betreiber selbst stellen muss. */
  voraussetzung?: string;
}

export const MODULE: ModulDef[] = [
  // --- Wissen ---------------------------------------------------------------
  { id: 'vault', name: 'Wissens-Vault', gruppe: 'Wissen',
    zweck: 'Firmenwissen als durchsuchbare Notizen und Dokumente, aus denen die KI belegt antwortet.' },
  { id: 'projects', name: 'Projekte', gruppe: 'Wissen',
    zweck: 'Bündelt Chats, Dateien und Vorgaben zu einem Thema; Projektdateien fließen automatisch in jeden Chat des Projekts.' },
  { id: 'memory', name: 'Gedächtnis', gruppe: 'Wissen',
    zweck: 'Merkt sich wiederkehrende Fakten über Nutzer und Projekte.' },

  // --- Dokumente ------------------------------------------------------------
  { id: 'files', name: 'Dateien', gruppe: 'Dokumente',
    zweck: 'Hochladen und Auswerten von Dokumenten, Tabellen und Bildern.' },
  { id: 'ocr', name: 'Texterkennung', gruppe: 'Dokumente', braucht: ['files'],
    zweck: 'Liest Text aus Scans und Fotos, damit auch nicht durchsuchbare PDFs nutzbar werden.',
    voraussetzung: 'Tesseract (offline, wird mitgeliefert)' },
  { id: 'docexport', name: 'Dokumenterstellung', gruppe: 'Dokumente',
    zweck: 'Erzeugt gestaltete PDF- und Word-Dokumente im eigenen Erscheinungsbild.' },
  { id: 'sheets', name: 'Tabellenauswertung', gruppe: 'Dokumente', braucht: ['files'],
    zweck: 'Wertet große Excel- und CSV-Dateien programmatisch aus, statt sie in den Kontext zu kippen.' },

  // --- Fachanwendungen ------------------------------------------------------
  { id: 'labels', name: 'Etikettenprüfung', gruppe: 'Fachanwendungen',
    zweck: 'Prüft Druckdaten von Etiketten gegen eine Liste unzulässiger Werbeaussagen.' },
  { id: 'imagegen', name: 'Bildgenerierung', gruppe: 'Fachanwendungen',
    zweck: 'Erzeugt Bilder lokal.', voraussetzung: 'Eigener Bilddienst' },

  // --- Betrieb --------------------------------------------------------------
  { id: 'audit', name: 'Änderungsprotokoll', gruppe: 'Betrieb',
    zweck: 'Hält fest, wer was wann geändert hat — mit Werten vorher und nachher.' },
  { id: 'reports', name: 'Betriebsbericht', gruppe: 'Betrieb', braucht: ['audit'],
    zweck: 'Nutzung, Antwortzeiten und offene Rückmeldungen als druckbares Dokument.' },
  { id: 'feedback', name: 'Rückmeldungen', gruppe: 'Betrieb',
    zweck: 'Nutzer melden Fehler und Wünsche direkt aus der Oberfläche.' },
  { id: 'classification', name: 'Datenklassifizierung', gruppe: 'Betrieb',
    zweck: 'Stuft Dateien und Projekte ein; ab „vertraulich" fließt nichts mehr in gemeinsames Wissen.' },
  { id: 'sharing', name: 'Chats teilen', gruppe: 'Betrieb',
    zweck: 'Gespräche mit Kolleginnen und Kollegen gemeinsam nutzen.' },
];

const NACH_ID = new Map(MODULE.map((m) => [m.id, m]));

/** Zwischenspeicher, damit nicht jede Anfrage die Tabelle liest. */
let cache: Map<string, boolean> | null = null;

function laden(): Map<string, boolean> {
  if (cache) return cache;
  const m = new Map<string, boolean>();
  for (const def of MODULE) m.set(def.id, true); // Standard: AN
  try {
    for (const r of sqlite.prepare('SELECT id, aktiv FROM module WHERE id IS NOT NULL').all() as { id: string; aktiv: number }[]) {
      if (NACH_ID.has(r.id)) m.set(r.id, r.aktiv === 1);
    }
  } catch (err) {
    log.warn('[Module] Tabelle nicht lesbar, alles aktiv', { error: (err as Error).message });
  }
  cache = m;
  return m;
}

export function modulAktiv(id: string): boolean {
  // Unbekannte Kennung: nicht blockieren. Ein Tippfehler soll kein Feature
  // stillschweigend abschalten.
  if (!NACH_ID.has(id)) return true;
  const m = laden();
  if (!m.get(id)) return false;
  // Abhängigkeiten mitprüfen: Texterkennung ohne Dateien ergibt keinen Sinn.
  const def = NACH_ID.get(id)!;
  return (def.braucht ?? []).every((b) => modulAktiv(b));
}

export function setzeModul(id: string, aktiv: boolean): void {
  if (!NACH_ID.has(id)) throw new Error(`Unbekanntes Modul: ${id}`);
  sqlite
    .prepare('INSERT INTO module (id, aktiv, geaendert_am) VALUES (?, ?, datetime(\'now\')) ON CONFLICT(id) DO UPDATE SET aktiv = excluded.aktiv, geaendert_am = excluded.geaendert_am')
    .run(id, aktiv ? 1 : 0);
  cache = null;
  log.info('[Module] Umgeschaltet', { modul: id, aktiv });
}

/** Übersicht für das Adminpanel, samt abhängiger Module. */
export function modulListe(): (ModulDef & { aktiv: boolean; blockiertDurch: string[] })[] {
  const m = laden();
  return MODULE.map((def) => ({
    ...def,
    aktiv: m.get(def.id) ?? true,
    blockiertDurch: (def.braucht ?? []).filter((b) => !(m.get(b) ?? true)),
  }));
}

/** Was hängt an diesem Modul? Vor dem Abschalten anzeigen. */
export function abhaengigeVon(id: string): ModulDef[] {
  return MODULE.filter((m) => (m.braucht ?? []).includes(id));
}
