// =============================================================================
// Einheitliches Lesen von Werkzeug-Argumenten.
//
// WARUM ES DAS GIBT: Das Modell trifft Feldnamen nicht zuverlässig. Beobachtet
// wurden `rohstoff` statt `name`, `menge_kg` statt `kg`, `artikel` statt
// `rohstoff`, `menge_prozent` statt `anteil`. Jedes Mal hat das Werkzeug den
// unbekannten Schlüssel STILL verworfen und ein Ergebnis geliefert, das wie
// „kein Effekt" aussah — obwohl gar nichts gerechnet wurde. Genau diese Klasse
// von Fehlern ist die gefährlichste, weil sie plausibel wirkt.
//
// Die Regel lautet deshalb: Was nicht verstanden wurde, wird GEMELDET. Lieber
// eine sichtbare Rückfrage als ein stilles Falschergebnis.
// =============================================================================

export interface FeldSpec {
  /** Weitere akzeptierte Schreibweisen. Der Feldname selbst zählt immer mit. */
  aliase?: string[];
  /** Fehlt das Feld, ist der Aufruf unbrauchbar. */
  pflicht?: boolean;
  /** Für die Fehlermeldung: wie ein gültiger Wert aussieht. */
  beispiel?: string;
}

export type Spec = Record<string, FeldSpec>;

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export class Argumente {
  private werte = new Map<string, unknown>();
  private nichtErkannt: string[] = [];
  private fehlend: string[] = [];
  private unsauber: string[] = [];
  private unlesbar: string[] = [];

  constructor(
    roh: Record<string, unknown> | undefined,
    private spec: Spec,
  ) {
    const eingang = roh ?? {};
    // Suchtabelle: normalisierter Alias -> Feldname
    const tabelle = new Map<string, string>();
    for (const [feld, s] of Object.entries(spec)) {
      tabelle.set(norm(feld), feld);
      for (const a of s.aliase ?? []) tabelle.set(norm(a), feld);
    }

    for (const [schluessel, wert] of Object.entries(eingang)) {
      if (wert === undefined || wert === null || wert === '') continue;
      const feld = tabelle.get(norm(schluessel));
      if (!feld) {
        this.nichtErkannt.push(schluessel);
        continue;
      }
      // Erstes gefülltes Vorkommen gewinnt — sonst überschreibt ein Alias das
      // korrekt benannte Feld.
      if (!this.werte.has(feld)) this.werte.set(feld, wert);
    }

    for (const [feld, s] of Object.entries(spec)) {
      if (s.pflicht && !this.werte.has(feld)) this.fehlend.push(feld);
    }
  }

  hat(feld: string): boolean {
    return this.werte.has(feld);
  }

  text(feld: string, standard = ''): string {
    const v = this.werte.get(feld);
    return v === undefined ? standard : String(v).trim();
  }

  /**
   * Zahl lesen. Nimmt auch „180 kg", „2,1 %" oder „ 3.5 " an — das Modell
   * schreibt Einheiten mit, und ein stilles Zurückfallen auf 0 hat eine ganze
   * Listenposition unbemerkt aus der Berechnung geworfen.
   */
  zahl(feld: string, standard = 0): number {
    const v = this.werte.get(feld);
    if (v === undefined) return standard;
    if (typeof v === 'number') return Number.isFinite(v) ? v : standard;
    const roh = String(v).trim().replace(',', '.');
    const direkt = Number(roh);
    if (Number.isFinite(direkt)) return direkt;
    // Führende Zahl herausziehen: „180 kg" -> 180
    const m = /^[^0-9-]*(-?\d+(?:\.\d+)?)/.exec(roh);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) {
        this.unsauber.push(`${feld}="${String(v)}" als ${n} gelesen`);
        return n;
      }
    }
    this.unlesbar.push(`${feld}="${String(v)}"`);
    return standard;
  }

  /** Werte, die nur mit Mühe lesbar waren oder gar nicht. */
  get hinweise(): { unsauber: string[]; unlesbar: string[] } {
    return { unsauber: [...this.unsauber], unlesbar: [...this.unlesbar] };
  }

  liste(feld: string): Record<string, unknown>[] {
    const v = this.werte.get(feld);
    return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]) : [];
  }

  /** Wurde etwas übergeben, das der Aufruf nicht verwerten konnte? */
  get sauber(): boolean {
    return this.nichtErkannt.length === 0 && this.fehlend.length === 0;
  }

  get fehltPflicht(): boolean {
    return this.fehlend.length > 0;
  }

  /**
   * Klartextmeldung für die Werkzeugausgabe. Nennt sowohl das Problem als auch
   * den korrekten Feldnamen — sonst rät das Modell beim nächsten Versuch neu.
   */
  bericht(): string {
    if (this.sauber) return '';
    const z: string[] = [];
    if (this.fehlend.length) {
      z.push(`FEHLENDE ANGABEN: ${this.fehlend.join(', ')}.`);
    }
    if (this.nichtErkannt.length) {
      z.push(`NICHT VERSTANDEN und daher IGNORIERT: ${this.nichtErkannt.join(', ')}.`);
    }
    const erwartet = Object.entries(this.spec)
      .map(([f, s]) => `${f}${s.pflicht ? ' (Pflicht)' : ''}${s.beispiel ? ` z. B. ${s.beispiel}` : ''}`)
      .join(', ');
    z.push(`Erwartete Felder: ${erwartet}.`);
    z.push('Rufe das Werkzeug mit den richtigen Feldnamen erneut auf. Nimm das Ergebnis unten NICHT als vollständig an.');
    return z.join('\n');
  }
}

/**
 * Einträge einer Liste einheitlich lesen — z. B. Listenpositionen. Meldet
 * ebenfalls, welche Schlüssel unbekannt waren.
 */
export function lesePositionen(
  eintraege: Record<string, unknown>[],
  spec: Spec,
): { werte: Record<string, unknown>[]; unbekannt: string[] } {
  const unbekannt = new Set<string>();
  const werte = eintraege.map((e) => {
    const a = new Argumente(e, spec);
    for (const k of Object.keys(e)) {
      const probe = new Argumente({ [k]: 'x' }, spec);
      if (!probe.sauber && !probe.fehltPflicht) unbekannt.add(k);
    }
    const out: Record<string, unknown> = {};
    for (const feld of Object.keys(spec)) if (a.hat(feld)) out[feld] = a.text(feld);
    return { ...out, __args: a };
  });
  return { werte, unbekannt: [...unbekannt] };
}
