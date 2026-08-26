// Bausteine der Zweisprachigkeit. Bewusst eigen und klein gehalten: eine
// Fremdbibliothek brächte Ladezeit und eigene Begriffswelt für eine Aufgabe,
// die aus einem Nachschlagewerk und einem Platzhalter-Ersatz besteht.

export type Sprache = 'de' | 'en';

/** Werte für Platzhalter, z. B. t('chat.treffer', { anzahl: 3 }). */
export type Vars = Record<string, string | number>;

/**
 * Ein Wörterbuch je Bereich.
 *
 * Deutsch ist vollständig und die Referenz; Englisch darf Lücken haben. Fehlt
 * ein englischer Text, erscheint der deutsche — nie ein leerer Kasten und nie
 * ein roher Schlüssel. Eine Lücke soll auffallen, aber nichts zerstören.
 */
export function defineDict<T extends Record<string, string>>(
  de: T,
  en: Partial<Record<keyof T, string>>,
): { de: T; en: Partial<Record<keyof T, string>> } {
  return { de, en };
}
