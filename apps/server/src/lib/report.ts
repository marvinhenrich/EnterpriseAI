import { sqliteConnection as sqlite } from '../db/client.ts';
import { branding } from '../config/branding.ts';

// =============================================================================
// Monatsbericht über den Betrieb der Anwendung.
//
// Zweck: eine ausdruckbare Zusammenfassung für Geschäftsführung und IT — was
// wurde genutzt, von wem, wie zuverlässig lief es, was ist offen. Alle Zahlen
// stammen aus der Datenbank; nichts wird geschätzt oder fortgeschrieben.
// =============================================================================

export interface Zeitraum {
  von: string; // YYYY-MM-DD, einschließlich
  bis: string; // YYYY-MM-DD, einschließlich
}

const MONATE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

/** Zeitraum für einen Kalendermonat, z. B. „2026-07". */
export function monatsZeitraum(monat: string): Zeitraum {
  const [j, m] = monat.split('-').map(Number);
  const jahr = j ?? new Date().getFullYear();
  const nr = m ?? 1;
  const letzter = new Date(Date.UTC(jahr, nr, 0)).getUTCDate();
  return { von: `${jahr}-${String(nr).padStart(2, '0')}-01`, bis: `${jahr}-${String(nr).padStart(2, '0')}-${letzter}` };
}

export function zeitraumTitel(z: Zeitraum): string {
  const [j, m] = z.von.split('-').map(Number);
  const istGanzerMonat = z.von.endsWith('-01') && new Date(Date.UTC(j!, m!, 0)).getUTCDate() === Number(z.bis.slice(-2));
  if (istGanzerMonat) return `${MONATE[m! - 1]} ${j}`;
  return `${datum(z.von)} bis ${datum(z.bis)}`;
}

const datum = (iso: string): string => {
  const [j, m, t] = iso.split('-');
  return `${t}.${m}.${j}`;
};

/** Anzeigetexte statt technischer Schlüssel — der Bericht geht auch an die Geschäftsführung. */
const STAND: Record<string, string> = { open: 'offen', in_progress: 'in Arbeit', resolved: 'erledigt', declined: 'abgelehnt' };
const ART: Record<string, string> = { bug: 'Fehler', idea: 'Idee', question: 'Frage', other: 'Sonstiges' };

const zahl = (n: number, stellen = 0): string =>
  n.toLocaleString('de-DE', { minimumFractionDigits: stellen, maximumFractionDigits: stellen });

/** Eine Skalarabfrage, immer als Zahl. */
function wert(sql: string, ...p: unknown[]): number {
  const r = sqlite.prepare(sql).get(...(p as [])) as Record<string, unknown> | undefined;
  const v = r ? Object.values(r)[0] : 0;
  return typeof v === 'number' ? v : Number(v ?? 0);
}

function zeilen<T = Record<string, unknown>>(sql: string, ...p: unknown[]): T[] {
  return sqlite.prepare(sql).all(...(p as [])) as T[];
}

/**
 * Balken aus reinem ASCII. Die Standardschrift im PDF (Helvetica) kennt keine
 * Blockzeichen — U+2588 kam im Druck als „%°%°" heraus. Punkt und Gleichheits-
 * zeichen sind überall vorhanden und in der Monospace-Darstellung gut lesbar.
 */
function balken(anteil: number, breite = 20): string {
  const n = Math.max(0, Math.min(breite, Math.round(anteil * breite)));
  return '='.repeat(n) + '.'.repeat(breite - n);
}

/**
 * Erzeugt den Bericht als Markdown. Die Umwandlung in PDF/Word übernimmt
 * anschließend lib/docgen.ts, damit das Firmenlayout einheitlich bleibt.
 */
export function bauMonatsbericht(z: Zeitraum): { titel: string; markdown: string } {
  const T = zeitraumTitel(z);
  const P: [string, string] = [z.von, z.bis];
  const m: string[] = [];

  // --- Kopf -----------------------------------------------------------------
  // Keine eigene Überschrift: docgen setzt den Titel bereits als Kopfzeile,
  // eine zweite stünde doppelt auf Seite 1.
  m.push(`Berichtszeitraum ${datum(z.von)} bis ${datum(z.bis)}. Erstellt am ${datum(new Date().toISOString().slice(0, 10))}.`);
  m.push('Alle Angaben stammen unmittelbar aus dem Betriebssystem der KI. Es wurde nichts hochgerechnet.');
  m.push('');

  // --- 1 Nutzung ------------------------------------------------------------
  const anfragen = wert(`SELECT count(*) FROM messages WHERE role='user' AND date(created_at) BETWEEN ? AND ?`, ...P);
  const antworten = wert(`SELECT count(*) FROM messages WHERE role='assistant' AND date(created_at) BETWEEN ? AND ?`, ...P);
  const aktive = wert(
    `SELECT count(DISTINCT c.user_id) FROM messages m JOIN chats c ON c.id=m.chat_id
      WHERE date(m.created_at) BETWEEN ? AND ?`, ...P);
  const konten = wert('SELECT count(*) FROM users WHERE is_active=1');
  const neueChats = wert('SELECT count(*) FROM chats WHERE date(created_at) BETWEEN ? AND ?', ...P);
  const neueProjekte = wert('SELECT count(*) FROM projects WHERE date(created_at) BETWEEN ? AND ?', ...P);
  const neueDateien = wert('SELECT count(*) FROM files WHERE date(created_at) BETWEEN ? AND ?', ...P);
  const aktiveTage = wert(
    `SELECT count(DISTINCT date(created_at)) FROM messages WHERE role='user' AND date(created_at) BETWEEN ? AND ?`, ...P);

  m.push('## 1. Nutzung');
  m.push('');
  m.push('| Kennzahl | Wert |');
  m.push('|---|---|');
  m.push(`| Anfragen von Nutzern | ${zahl(anfragen)} |`);
  m.push(`| Antworten der KI | ${zahl(antworten)} |`);
  m.push(`| Aktive Nutzer | ${zahl(aktive)} von ${zahl(konten)} freigeschalteten Konten |`);
  m.push(`| Tage mit Nutzung | ${zahl(aktiveTage)} |`);
  m.push(`| Anfragen je aktivem Tag | ${aktiveTage ? zahl(anfragen / aktiveTage, 1) : '—'} |`);
  m.push(`| Neue Unterhaltungen | ${zahl(neueChats)} |`);
  m.push(`| Neue Projekte | ${zahl(neueProjekte)} |`);
  m.push(`| Hochgeladene Dateien | ${zahl(neueDateien)} |`);
  m.push('');

  // --- 2 Wer nutzt es -------------------------------------------------------
  const top = zeilen<{ username: string; department: string | null; n: number; chats: number }>(
    `SELECT u.username, u.department, count(*) AS n, count(DISTINCT c.id) AS chats
       FROM messages m JOIN chats c ON c.id=m.chat_id JOIN users u ON u.id=c.user_id
      WHERE m.role='user' AND date(m.created_at) BETWEEN ? AND ?
      GROUP BY u.id ORDER BY n DESC LIMIT 10`, ...P);

  m.push('## 2. Wer die KI genutzt hat');
  m.push('');
  if (top.length === 0) {
    m.push('Im Berichtszeitraum wurden keine Anfragen gestellt.');
  } else {
    const max = top[0]!.n;
    m.push('| Nutzer | Abteilung | Anfragen | Unterhaltungen | Anteil |');
    m.push('|---|---|---|---|---|');
    for (const r of top) {
      m.push(`| ${r.username} | ${r.department || '—'} | ${zahl(r.n)} | ${zahl(r.chats)} | ${balken(r.n / max, 20)} |`);
    }
    m.push('');
    const anteilTop3 = top.slice(0, 3).reduce((s, r) => s + r.n, 0) / Math.max(anfragen, 1);
    m.push(`Die drei aktivsten Nutzer stellen ${zahl(anteilTop3 * 100, 0)} % aller Anfragen. ` +
      `${aktive} von ${konten} freigeschalteten Konten waren aktiv — die Verbreitung im Haus ist die wesentliche offene Aufgabe.`);
  }
  m.push('');

  // --- 3 Abteilungen --------------------------------------------------------
  const abt = zeilen<{ department: string | null; nutzer: number; n: number }>(
    `SELECT u.department, count(DISTINCT u.id) AS nutzer, count(*) AS n
       FROM messages m JOIN chats c ON c.id=m.chat_id JOIN users u ON u.id=c.user_id
      WHERE m.role='user' AND date(m.created_at) BETWEEN ? AND ?
      GROUP BY nullif(trim(coalesce(u.department,'')),'') ORDER BY n DESC`, ...P);
  if (abt.length > 0) {
    m.push('## 3. Nach Abteilung');
    m.push('');
    m.push('| Abteilung | Nutzer | Anfragen |');
    m.push('|---|---|---|');
    for (const r of abt) m.push(`| ${(r.department || '').trim() || 'nicht gepflegt'} | ${zahl(r.nutzer)} | ${zahl(r.n)} |`);
    m.push('');
    if (abt.some((r) => !(r.department || '').trim())) {
      m.push('*Hinweis: Bei einem Teil der Konten ist im Verzeichnisdienst keine Abteilung hinterlegt. ' +
        'Eine Auswertung nach Bereichen bleibt deshalb unvollständig.*');
      m.push('');
    }
  }

  // --- 4 Betrieb ------------------------------------------------------------
  const perf = zeilen<{ total_ms: number; ttfb_ms: number | null; had_error: number }>(
    'SELECT total_ms, ttfb_ms, had_error FROM perf_log WHERE date(created_at) BETWEEN ? AND ?', ...P);
  m.push('## 4. Betrieb und Antwortzeiten');
  m.push('');
  if (perf.length === 0) {
    m.push('Für diesen Zeitraum liegen keine Messwerte vor. Die Leistungsmessung wurde erst später eingeführt.');
  } else {
    const ok = perf.filter((p) => !p.had_error);
    const sortiert = ok.map((p) => p.total_ms).sort((a, b) => a - b);
    const ttfb = ok.map((p) => p.ttfb_ms).filter((x): x is number => x != null).sort((a, b) => a - b);
    const q = (arr: number[], p: number) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))]! : 0);
    const fehler = perf.filter((p) => p.had_error).length;
    m.push('| Kennzahl | Wert |');
    m.push('|---|---|');
    m.push(`| Gemessene Anfragen | ${zahl(perf.length)} |`);
    m.push(`| Antwortzeit Median | ${zahl(q(sortiert, 0.5) / 1000, 1)} s |`);
    m.push(`| Antwortzeit P90 | ${zahl(q(sortiert, 0.9) / 1000, 1)} s |`);
    if (ttfb.length) m.push(`| Zeit bis zum ersten Wort (Median) | ${zahl(q(ttfb, 0.5) / 1000, 1)} s |`);
    m.push(`| Fehlgeschlagene Anfragen | ${zahl(fehler)} (${zahl((fehler / perf.length) * 100, 1)} %) |`);
    m.push('');
    m.push('Die Wartezeit bis zum ersten Wort entsteht überwiegend durch die Menge an Unterlagen, die vor ' +
      'jeder Antwort mitgelesen wird — nicht durch die Rechenleistung des Servers.');
  }
  m.push('');

  // --- 5 Rückmeldungen ------------------------------------------------------
  const fb = zeilen<{ id: number; category: string; status: string; message: string; username: string; created_at: string }>(
    `SELECT id, category, status, message, username, created_at FROM feedback
      WHERE date(created_at) BETWEEN ? AND ? ORDER BY id`, ...P);
  // Nur wirklich Unerledigtes. Zulässige Stände sind open / in_progress /
  // resolved / declined — „erledigt" heißt hier resolved oder declined.
  const fbOffen = zeilen<{ id: number; category: string; status: string; message: string; username: string; created_at: string }>(
    `SELECT id, category, status, message, username, created_at FROM feedback
      WHERE status IN ('open','in_progress') ORDER BY id`);
  m.push('## 5. Rückmeldungen aus dem Haus');
  m.push('');
  if (fb.length === 0) {
    m.push('Im Berichtszeitraum sind keine neuen Rückmeldungen eingegangen.');
  } else {
    m.push(`${fb.length} neue Rückmeldung(en):`);
    m.push('');
    m.push('| Nr. | Datum | Von | Art | Stand | Inhalt |');
    m.push('|---|---|---|---|---|---|');
    for (const r of fb) {
      const txt = r.message.replace(/\s+/g, ' ').slice(0, 90);
      m.push(`| ${r.id} | ${datum(r.created_at.slice(0, 10))} | ${r.username} | ${ART[r.category] ?? r.category} | ${STAND[r.status] ?? r.status} | ${txt}${r.message.length > 90 ? '…' : ''} |`);
    }
  }
  if (fbOffen.length > 0) {
    m.push('');
    m.push(`**Noch offen (auch aus früheren Zeiträumen): ${fbOffen.length}**`);
    m.push('');
    for (const r of fbOffen) {
      const stand = r.status === 'in_progress' ? 'in Arbeit' : 'offen';
      m.push(`- **Nr. ${r.id}** (${stand}) vom ${datum(r.created_at.slice(0, 10))}, ${r.username}: ${r.message.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  }
  m.push('');

  // --- 6 Wissensbestand -----------------------------------------------------
  const dateienGesamt = wert('SELECT count(*) FROM files');
  const zeichen = wert(`SELECT coalesce(sum(length(extracted_text)),0) FROM files WHERE extracted_text IS NOT NULL`);
  const unlesbar = wert(
    `SELECT count(*) FROM files WHERE kind='document' AND (coalesce(extracted_text,'')='' OR length(extracted_text)<20)`);
  const notizen = wert('SELECT count(*) FROM vault_notes');
  const projekte = wert('SELECT count(*) FROM projects');
  m.push('## 6. Wissensbestand');
  m.push('');
  m.push('| Kennzahl | Wert |');
  m.push('|---|---|');
  m.push(`| Dateien im System | ${zahl(dateienGesamt)} |`);
  m.push(`| davon maschinell nicht lesbar | ${zahl(unlesbar)} |`);
  m.push(`| Erfasster Text | ${zahl(zeichen / 1_000_000, 1)} Mio. Zeichen (entspricht etwa ${zahl(zeichen / 1800)} Textabschnitten) |`);
  m.push(`| Notizen im Wissens-Vault | ${zahl(notizen)} |`);
  m.push(`| Projekte | ${zahl(projekte)} |`);
  m.push('');

  // --- 7 Änderungen am System ----------------------------------------------
  const aend = zeilen<{ action: string; n: number }>(
    `SELECT action, count(*) AS n FROM audit_logs WHERE date(created_at) BETWEEN ? AND ?
      GROUP BY action ORDER BY n DESC LIMIT 12`, ...P);
  m.push('## 7. Nachvollziehbare Änderungen');
  m.push('');
  if (aend.length === 0) {
    m.push('Im Berichtszeitraum wurden keine protokollpflichtigen Änderungen vorgenommen.');
  } else {
    m.push('| Vorgang | Anzahl |');
    m.push('|---|---|');
    for (const r of aend) m.push(`| ${r.action} | ${zahl(r.n)} |`);
    m.push('');
    m.push('Jede Änderung ist im Adminbereich unter „Protokoll" mit Nutzer, Zeitpunkt und vorherigem Wert einsehbar.');
  }
  m.push('');

  return { titel: `Betriebsbericht ${branding.appShort} — ${T}`, markdown: m.join('\n') };
}
