import { hasPermission } from './permissions.ts';

// =============================================================================
// Sichtbarkeitsstufen für Wissens-Vault-Inhalte.
//
// Grundsatz: Was jemand nicht sehen darf, darf ihm auch die KI nicht verraten.
// Die Stufe wirkt deshalb auf JEDEN Lesepfad — Liste, Detail, Volltextsuche,
// semantische Suche, das KI-Werkzeug und den automatisch eingespeisten
// Chat-Kontext. Eine einzige vergessene Stelle würde die Schranke aushebeln.
//
// Bewusst über das bestehende Berechtigungssystem gelöst (nicht über Gruppen):
// Gruppen sind im Bestand ungenutzt, Abteilungen nur lückenhaft gepflegt —
// Berechtigungen dagegen sind im Admin-Panel bereits verwaltbar.
// =============================================================================

export const VISIBILITY = {
  '': { label: 'Alle', help: 'Für alle sichtbar, die das Wissens-Vault nutzen dürfen.' },
  restricted: { label: 'Vertraulich', help: 'Nur mit dem Recht „Vertrauliches im Vault lesen".' },
  it: { label: 'IT-intern', help: 'Nur mit dem Recht „IT-Interna im Vault lesen" — Netze, Server, Zugänge.' },
} as const;

export type VisibilityLevel = keyof typeof VISIBILITY;

/** Stufe → benötigtes Recht. Leere Stufe = kein zusätzliches Recht nötig. */
const REQUIRED: Record<string, 'kb.read.restricted' | 'kb.read.it' | null> = {
  '': null,
  restricted: 'kb.read.restricted',
  it: 'kb.read.it',
};

export function normalizeVisibility(v: unknown): VisibilityLevel {
  const s = String(v ?? '').trim();
  return s === 'restricted' || s === 'it' ? s : '';
}

/**
 * Welche Stufen darf dieser Nutzer sehen? Ergebnis wird direkt in SQL-Filter
 * gegossen, damit gesperrte Inhalte gar nicht erst geladen werden.
 */
export function visibleLevels(userId: number, role: string): VisibilityLevel[] {
  const out: VisibilityLevel[] = [''];
  if (hasPermission(userId, role, 'kb.read.restricted')) out.push('restricted');
  if (hasPermission(userId, role, 'kb.read.it')) out.push('it');
  return out;
}

/** Darf dieser Nutzer einen konkreten Eintrag sehen? */
export function maySee(userId: number, role: string, visibility: unknown): boolean {
  const lvl = normalizeVisibility(visibility);
  const need = REQUIRED[lvl] ?? null;
  return need === null || hasPermission(userId, role, need);
}

/** SQL-Fragment `IN ('', 'it')` samt Parametern für gefilterte Abfragen. */
export function levelsSql(levels: VisibilityLevel[]): { placeholders: string; params: string[] } {
  return { placeholders: levels.map(() => '?').join(','), params: [...levels] };
}
