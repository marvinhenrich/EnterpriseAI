import { hasPermission } from './permissions.ts';
import { sqliteConnection as sqlite } from '../db/client.ts';

// =============================================================================
// Datenklassifizierung.
//
// Anlass: Fachdaten sind Betriebsgeheimnisse. Sie dürfen weder in das
// firmenweite Wissen der KI einfließen noch über Umwege (Gedächtnis, geteilte
// Chats, Vault) an Unbeteiligte gelangen — auch nicht in verkürzter Form als
// „gemerkter Fakt".
//
// Grundsatz: Die Stufe hängt an den DATEN, nicht am Ort. Wandert eine Datei in
// ein anderes Projekt, wandert die Einstufung mit. Und die Stufe wirkt auf
// JEDEN Schreibpfad nach außen; eine einzige vergessene Stelle hebelt sie aus.
//
// Bewusst getrennt von lib/visibility.ts: Jene Stufen regeln, wer im Vault was
// LESEN darf. Hier geht es darum, was überhaupt erst in gemeinsame Bestände
// hineingelangen darf. Ein Fachdokument ist nicht „vertraulich im Vault" —
// es gehört gar nicht erst hinein.
// =============================================================================

export const KLASSEN = {
  offen: {
    rang: 0,
    label: 'Öffentlich',
    kurz: 'Darf das Haus verlassen (Prospekte, Datenblätter für Kunden).',
  },
  intern: {
    rang: 1,
    label: 'Intern',
    kurz: 'Für Beschäftigte bestimmt. Standard für alles ohne besondere Einstufung.',
  },
  vertraulich: {
    rang: 2,
    label: 'Vertraulich',
    kurz: 'Nur für benannte Personen. Fließt NICHT in das Allgemeinwissen der KI.',
  },
  geheim: {
    rang: 3,
    label: 'Streng vertraulich',
    kurz: 'Betriebsgeheimnis — Zusammensetzungen, Verfahren. Verlässt niemals den Eigentümer.',
  },
} as const;

export type Klasse = keyof typeof KLASSEN;
export const KLASSEN_LISTE = Object.keys(KLASSEN) as Klasse[];

/** Ab dieser Stufe gilt der Inhalt als schutzbedürftig. */
const SCHUTZ_AB = KLASSEN.vertraulich.rang;

export function normalisiereKlasse(v: unknown): Klasse {
  const s = String(v ?? '').trim().toLowerCase();
  return (KLASSEN_LISTE as string[]).includes(s) ? (s as Klasse) : 'intern';
}

export function rang(k: unknown): number {
  return KLASSEN[normalisiereKlasse(k)].rang;
}

/** Die höhere (schützendere) von zwei Stufen. Beim Zusammenführen maßgeblich. */
export function hoechste(...werte: unknown[]): Klasse {
  let best: Klasse = 'offen';
  for (const w of werte) if (rang(w) > rang(best)) best = normalisiereKlasse(w);
  return best;
}

/** Darf aus diesem Inhalt ein dauerhafter „Fakt" abgeleitet werden? */
export function darfInsGedaechtnis(k: unknown): boolean {
  return rang(k) < SCHUTZ_AB;
}

/** Darf dieser Inhalt in das firmenweite Wissens-Vault übernommen werden? */
export function darfInsVault(k: unknown): boolean {
  return rang(k) < SCHUTZ_AB;
}

/** Darf ein Chat mit diesem Inhalt an andere Personen weitergegeben werden? */
export function darfGeteiltWerden(k: unknown): boolean {
  return rang(k) < SCHUTZ_AB;
}

/**
 * Wer darf eine Einstufung überhaupt herabsetzen? Heraufstufen darf jeder
 * Eigentümer — vorsichtiger zu sein ist nie falsch. Herabstufen entfernt einen
 * Schutz und bleibt deshalb der Freigabeberechtigung vorbehalten.
 */
export function darfHerabstufen(userId: number, role: string): boolean {
  return hasPermission(userId, role, 'data.declassify');
}

/** Kurzer Warnhinweis für den System-Prompt, wenn eingestufte Daten im Spiel sind. */
export function promptHinweis(k: Klasse): string {
  if (rang(k) < SCHUTZ_AB) return '';
  return (
    `DATENSCHUTZSTUFE: ${KLASSEN[k].label.toUpperCase()}.\n` +
    '- Die Unterlagen in diesem Gespräch sind eingestuft. Behandle sie ausschließlich hier.\n' +
    '- Gib Zusammensetzungen, Mengen, Einkaufspreise und Verfahrensschritte NUR an diesen Nutzer aus.\n' +
    '- Formuliere KEINE allgemeingültigen Merksätze daraus („Unsere Standardzusammensetzung enthält …"). ' +
    'Was hier besprochen wird, gilt für diesen Fall, nicht als Firmenwissen.\n' +
    '- Schlage von dir aus nicht vor, diese Inhalte zu teilen, zu exportieren oder ins Wissens-Vault aufzunehmen.'
  );
}

// --- Ermittlung aus dem Bestand ---------------------------------------------

/**
 * Höchste Einstufung, die in einem Chat vorkommt: aus dem Projekt des Chats und
 * aus allen Dateien, die daran hängen oder über das Projekt einfließen.
 *
 * Wird für Weitergabe-Entscheidungen gebraucht. Bewusst großzügig gefasst —
 * lieber eine Weitergabe zu viel blockieren als ein Fachdokument zu wenig.
 */
export function chatKlasse(chatId: string): Klasse {
  const row = sqlite
    .prepare(
      `SELECT max(r) AS rang FROM (
         -- Die am Gespräch festgeschriebene Stufe. Der tragende Zweig: Sie
         -- steigt monoton mit allem, was je in den Chat gelangt ist, und
         -- überlebt Serverneustarts.
         SELECT CASE c.classification
                  WHEN 'geheim' THEN 3 WHEN 'vertraulich' THEN 2 WHEN 'intern' THEN 1 ELSE 0 END
           FROM chats c WHERE c.id = ?
         UNION ALL
         -- Dateien, die laut Nachrichtenanhang tatsächlich eingebracht wurden.
         -- files.chat_id ist in ALLEN 128 Bestandszeilen NULL — der Upload
         -- übermittelt keine chatId. Der Anhang in der Nachricht ist die
         -- einzige verlässliche Spur.
         SELECT CASE f.classification
                  WHEN 'geheim' THEN 3 WHEN 'vertraulich' THEN 2 WHEN 'intern' THEN 1 ELSE 0 END
           FROM files f JOIN messages m ON m.attachments LIKE '%' || f.id || '%'
          WHERE m.chat_id = ?
         UNION ALL
         SELECT CASE p.classification
                  WHEN 'geheim' THEN 3 WHEN 'vertraulich' THEN 2 WHEN 'intern' THEN 1 ELSE 0 END AS r
           FROM chats c LEFT JOIN projects p ON p.id = c.project_id
          WHERE c.id = ?
         UNION ALL
         SELECT CASE f.classification
                  WHEN 'geheim' THEN 3 WHEN 'vertraulich' THEN 2 WHEN 'intern' THEN 1 ELSE 0 END
           FROM files f WHERE f.chat_id = ?
         UNION ALL
         SELECT CASE f.classification
                  WHEN 'geheim' THEN 3 WHEN 'vertraulich' THEN 2 WHEN 'intern' THEN 1 ELSE 0 END
           FROM files f JOIN chats c ON c.project_id = f.project_id WHERE c.id = ?
         UNION ALL
         -- Referenzdateien (user_scope) fließen in JEDEN Projektchat des
         -- Nutzers ein. Ohne diesen Zweig wäre ein Chat mit einer als geheim
         -- eingestuften Referenz teilbar — die Sperre liefe ins Leere.
         SELECT CASE f.classification
                  WHEN 'geheim' THEN 3 WHEN 'vertraulich' THEN 2 WHEN 'intern' THEN 1 ELSE 0 END
           FROM files f JOIN chats c ON c.user_id = f.user_id
          WHERE c.id = ? AND f.user_scope = 1
       )`,
    )
    .get(chatId, chatId, chatId, chatId, chatId, chatId) as { rang: number | null } | undefined;
  // Im Zweifel SPERREN, nicht freigeben. Findet die Abfrage nichts (Chat
  // gelöscht, Race), war der bisherige Standard 'intern' — also teilbar.
  const r = row?.rang ?? 3;
  return (KLASSEN_LISTE.find((k) => KLASSEN[k].rang === r) ?? 'intern') as Klasse;
}

/**
 * Einstufung eines Chats anheben — NIEMALS senken.
 *
 * Wird nach jeder Anfrage aufgerufen, sobald feststeht, was tatsächlich in den
 * Kontext geflossen ist (Anhänge, Projektdateien, Referenzen, Werkzeugquellen).
 * Herabstufen bleibt ausschließlich der Datei-/Projektebene mit dem Recht
 * `data.declassify` vorbehalten.
 */
export function hebeChatKlasse(chatId: string, neu: unknown): Klasse {
  const k = normalisiereKlasse(neu);
  const row = sqlite.prepare('SELECT classification FROM chats WHERE id = ?').get(chatId) as
    | { classification: string }
    | undefined;
  const bisher = normalisiereKlasse(row?.classification);
  if (rang(k) <= rang(bisher)) return bisher;
  sqlite.prepare('UPDATE chats SET classification = ? WHERE id = ?').run(k, chatId);
  return k;
}
