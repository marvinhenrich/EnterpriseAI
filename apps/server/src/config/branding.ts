import { env } from './env.ts';

// =============================================================================
// Erscheinungsbild und Bezeichnungen einer Installation.
//
// Der Code kennt keinen Firmennamen. Was hier steht, kommt aus der
// Konfiguration; die Vorgaben sind bewusst neutral, damit eine frische
// Installation ohne jede Anpassung sinnvoll aussieht.
//
// Alles über Umgebungsvariablen, damit dieselbe Programmfassung in mehreren
// Betrieben laufen kann, ohne dass jemand Quelltext ändert.
// =============================================================================

const STANDARD_FARBE = '#2563eb';

function normalisiereFarbe(v: string): string {
  const t = (v ?? '').trim().replace(/^["']|["']$/g, '');
  if (!t) return STANDARD_FARBE;
  const hex = t.startsWith('#') ? t : `#${t}`;
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : STANDARD_FARBE;
}

export const branding = {
  /** Voller Name der Anwendung, z. B. in Titeln und Dokumentkopf. */
  appName: env.APP_NAME,
  /** Kurzform für enge Stellen (Kopfzeile, Tab-Titel). */
  appShort: env.APP_SHORT || env.APP_NAME,
  /** Betreiber — erscheint auf erzeugten Dokumenten. */
  organisation: env.ORG_NAME,
  /**
   * Markenfarbe als Hex mit führender Raute.
   *
   * Achtung: Node behandelt „#" in .env als Kommentarbeginn — BRAND_COLOR=#1E3C7B
   * kommt als LEERER String an und der Dokumentkopf verliert seine Farbe. Der
   * Wert muss dort in Anführungszeichen stehen. Hier wird beides abgefangen:
   * mit und ohne Raute, und ein leerer Wert fällt auf die Vorgabe zurück.
   */
  farbe: normalisiereFarbe(env.BRAND_COLOR),
  /** Logo für erzeugte Dokumente. Fehlt es, wird nur der Name gesetzt. */
  logoPfad: env.BRAND_LOGO_PATH,
  /** Fußzeile auf erzeugten Dokumenten. */
  vertraulichkeit: env.DOC_FOOTER,
} as const;

/** Dateinamen-tauglicher Kurzname: „Muster GmbH" -> „muster-gmbh". */
export function dateiPraefix(): string {
  return (branding.appShort || 'ki')
    .toLowerCase()
    .replace(/[äöüß]/g, (m) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' })[m] ?? m)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'ki';
}
