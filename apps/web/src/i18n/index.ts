import { useEffect, useState } from 'react';
import { aufBranding, branding } from '../lib/branding';
import type { Sprache, Vars } from './types';
import { common } from './dict/common';

// =============================================================================
// Zweisprachigkeit (Deutsch/Englisch).
//
// Die Sprache ist eine Einstellung der INSTALLATION, nicht des Nutzers und
// nicht des Browsers: In einem Betrieb sprechen alle dieselbe Sprache, und
// Beschriftungen, über die man sich am Telefon verständigt, sollen bei allen
// gleich heißen. Ein Administrator stellt sie unter Administration → Unternehmen.
//
// Sie reist mit `/api/branding` mit, das ohnehin VOR dem ersten Rendern geladen
// wird. Damit ist `t()` von der ersten Bildschirmausgabe an richtig — es gibt
// kein Aufblitzen der falschen Sprache und keinen zweiten Abruf.
//
// So kommt ein neuer Bereich dazu:
//   1. `i18n/dict/<bereich>.ts` anlegen:
//        export const chat = defineDict(
//          { 'chat.senden': 'Senden' },   // Deutsch: vollständig, Referenz
//          { 'chat.senden': 'Send' },     // Englisch: darf Lücken haben
//        );
//   2. Hier unten in BEIDE Sammlungen einhängen (zwei Zeilen).
//   3. In der Seite: const t = useT();  <button>{t('chat.senden')}</button>
//
// Schlüssel sind flach und tragen ihr Bereichspräfix. Platzhalter stehen in
// geschweiften Klammern; ein Platzhalter ohne Wert bleibt sichtbar stehen,
// damit die Lücke auffällt, statt still zu verschwinden.
// =============================================================================

export type { Sprache, Vars } from './types';
export { defineDict } from './types';

const DE = {
  ...common.de,
  // ...weitere Bereiche hier einhängen
};

/** Alle gültigen Schlüssel. Ein Tippfehler fällt beim Typecheck auf, nicht im Betrieb. */
export type TKey = keyof typeof DE;

const EN: Partial<Record<TKey, string>> = {
  ...common.en,
  // ...weitere Bereiche hier einhängen
};

export const SPRACHEN: readonly Sprache[] = ['de', 'en'];

/** Sprachnamen in der jeweiligen Sprache selbst — so findet sich auch jemand
 *  zurecht, der die gerade eingestellte Sprache nicht lesen kann. */
export const SPRACHNAMEN: Record<Sprache, string> = { de: 'Deutsch', en: 'English' };

/** Zahlen- und Datumsformat. Englisch bewusst en-GB: 24-Stunden-Uhr wie im Deutschen. */
export const LOCALES: Record<Sprache, string> = { de: 'de-DE', en: 'en-GB' };

const PLATZHALTER = /\{(\w+)\}/g;

function fuelle(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(PLATZHALTER, (ganz, name: string) => {
    const v = vars[name];
    return v === undefined || v === null ? ganz : String(v);
  });
}

/** Übersetzen ohne React — für Hilfsfunktionen und Fehlertexte. */
export function t(key: TKey, vars?: Vars): string {
  const de = DE[key] as string | undefined;
  const en = EN[key];
  const sprache = branding().sprache;
  // Leerer englischer Text zählt als „fehlt": sonst verschwindet die Beschriftung.
  const text = (sprache === 'en' ? (en && en.length ? en : de) : de) ?? String(key);
  return fuelle(text, vars);
}

/**
 * Übersetzen in einer Komponente. Rendert neu, wenn ein Administrator die
 * Sprache umstellt — ohne dass jemand die Seite neu laden muss.
 */
export function useT(): (key: TKey, vars?: Vars) => string {
  const [, setStand] = useState(0);
  useEffect(() => aufBranding(() => setStand((n) => n + 1)), []);
  return t;
}

/** Aktuelle Sprache und ihr Zahlenformat. */
export function useSprache(): { sprache: Sprache; locale: string } {
  const [s, setS] = useState<Sprache>(branding().sprache);
  useEffect(() => aufBranding((b) => setS(b.sprache)), []);
  return { sprache: s, locale: LOCALES[s] };
}
