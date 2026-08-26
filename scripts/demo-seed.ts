/**
 * Demo-Datenbestand — ausschließlich erfundene Inhalte.
 *
 *   CONFIG_DIR=./demo npx tsx scripts/demo-seed.ts
 *
 * Füllt eine FRISCHE Datenbank mit einer erfundenen Firma („Muster GmbH"),
 * erfundenen Personen und erfundenen Vorgängen. Gedacht für
 *
 *   * Screenshots und Vorführungen ohne echte Daten,
 *   * das Ausprobieren des Systems vor der ersten eigenen Einrichtung.
 *
 * Bricht ab, wenn die Datenbank bereits Nutzer enthält. Damit lässt sich das
 * Skript nicht versehentlich auf einen Echtbetrieb loslassen.
 */
import { sqliteConnection as sqlite } from '../apps/server/src/db/client.ts';
import { hashPassword } from '../apps/server/src/auth/password.ts';

const vorhanden = (sqlite.prepare('SELECT count(*) c FROM users').get() as { c: number }).c;
if (vorhanden > 0) {
  console.error(`Abbruch: Die Datenbank enthält bereits ${vorhanden} Nutzer.`);
  console.error('Der Demo-Bestand gehört in eine frische Datenbank, nicht in einen laufenden Betrieb.');
  process.exit(1);
}

/**
 * Zeitstempel „vor n Tagen" — relativ zum heutigen Tag.
 *
 * Absolute Daten wären nach wenigen Wochen veraltet: Die Auswertungen zeigen
 * die letzten 14 bzw. 30 Tage, und ein Demo-Bestand aus dem Vorjahr sähe darin
 * schlicht leer aus.
 */
const vorTagen = (n: number, stunde = 9): string => {
  const d = new Date();
  d.setUTCHours(stunde, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().replace('T', ' ').slice(0, 19);
};

const PERSONEN = [
  { username: 'a.mustermann', email: 'a.mustermann@muster-gmbh.example', abt: 'Entwicklung', rolle: 'admin' },
  { username: 'b.beispiel', email: 'b.beispiel@muster-gmbh.example', abt: 'Entwicklung', rolle: 'user' },
  { username: 'c.demo', email: 'c.demo@muster-gmbh.example', abt: 'Qualitätssicherung', rolle: 'manager' },
  { username: 'd.testfall', email: 'd.testfall@muster-gmbh.example', abt: 'Produktion', rolle: 'user' },
  { username: 'e.probe', email: 'e.probe@muster-gmbh.example', abt: 'Vertrieb', rolle: 'user' },
];

const pw = await hashPassword('demo1234!');
const einfuegenNutzer = sqlite.prepare(
  `INSERT INTO users (username, email, password_hash, role, department, is_active, auth_provider, last_login, created_at)
   VALUES (?, ?, ?, ?, ?, 1, 'local', ?, ?)`,
);
PERSONEN.forEach((p, i) =>
  einfuegenNutzer.run(p.username, p.email, pw, p.rolle, p.abt, vorTagen(i), vorTagen(60 + i)),
);

// --- Projekte ----------------------------------------------------------------
// Eines davon vertraulich — damit im Bild sichtbar wird, dass die
// Klassifizierung nicht nur eine Beschriftung ist.
const PROJEKTE = [
  { id: 'prj-demo-1', user: 1, name: 'Produktreihe Nord', klasse: 'intern',
    beschreibung: 'Sammelstelle für Unterlagen und Fragen rund um die Produktreihe Nord.',
    anweisung: 'Antworte knapp und belege jede Aussage mit der Quelle aus den Projektdateien.' },
  { id: 'prj-demo-2', user: 3, name: 'Versuchsreihe 2026', klasse: 'vertraulich',
    beschreibung: 'Laufende Versuche. Zugriff nur für die benannten Personen.',
    anweisung: 'Nenne Messwerte immer mit Einheit und Datum der Messung.' },
];
const einfuegenProjekt = sqlite.prepare(
  `INSERT INTO projects (id, user_id, name, description, instructions, classification, vault_scope, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, 'all', ?, ?)`,
);
PROJEKTE.forEach((p, i) =>
  einfuegenProjekt.run(p.id, p.user, p.name, p.beschreibung, p.anweisung, p.klasse, vorTagen(40 - i), vorTagen(2)),
);

// --- Chats und Nachrichten ---------------------------------------------------
const GESPRAECHE: { titel: string; user: number; projekt?: string; verlauf: [string, string][] }[] = [
  {
    titel: 'Unterschied zwischen den Prüfverfahren',
    user: 1,
    verlauf: [
      ['Worin unterscheiden sich die beiden Prüfverfahren in unserer Hausnorm?',
       'Die Hausnorm beschreibt zwei Verfahren, die sich in Vorbereitung und Dauer unterscheiden:\n\n**Verfahren A** prüft am unbehandelten Muster über 24 Stunden. Es zeigt, wie sich das Material im Auslieferungszustand verhält.\n\n**Verfahren B** setzt eine Vorbehandlung von 48 Stunden voraus und prüft anschließend über 72 Stunden. Es bildet die Alterung ab.\n\nFür die Freigabe genügt Verfahren A; Verfahren B ist bei Reklamationen vorgeschrieben.\n\n*Quelle: Hausnorm HN-014, Abschnitt 3.2*'],
    ],
  },
  {
    titel: 'Zusammenfassung des Prüfberichts',
    user: 3,
    projekt: 'prj-demo-2',
    verlauf: [
      ['Fasse den angehängten Prüfbericht in fünf Sätzen zusammen.',
       'Der Bericht dokumentiert acht Muster aus der Versuchsreihe im Zeitraum November bis Dezember. Sieben Muster liegen innerhalb der Toleranz, eines überschreitet den oberen Grenzwert um 4 %. Die Abweichung tritt ausschließlich bei der höchsten geprüften Temperatur auf. Der Verfasser empfiehlt eine Wiederholung dieses einen Musters unter geänderter Vorbehandlung. Eine Freigabe der Reihe wird bis zum Vorliegen der Wiederholung zurückgestellt.'],
      ['Welches Muster war das?',
       'Muster 6. Es ist im Bericht auf Seite 4 in der Tabelle als einziges mit einem Sternchen gekennzeichnet; die Fußnote nennt den gemessenen Wert und den Grenzwert.'],
    ],
  },
  {
    titel: 'Formulierung für ein Anschreiben',
    user: 1,
    verlauf: [
      ['Ich brauche eine höfliche Formulierung, um eine Lieferverzögerung von zwei Wochen mitzuteilen.',
       'Ein Vorschlag:\n\n> Sehr geehrte Damen und Herren,\n>\n> zu Ihrer Bestellung vom [Datum] müssen wir Ihnen eine Verzögerung mitteilen: Die Lieferung wird sich um rund zwei Wochen auf voraussichtlich den [Datum] verschieben.\n>\n> Wir bedauern das und haben die Position bereits vorgezogen, sobald das Material verfügbar ist. Sollte der Termin für Sie nicht tragbar sein, melden Sie sich bitte — wir suchen dann gemeinsam nach einer Lösung.\n\nSoll ich eine kürzere Fassung für eine E-Mail daraus machen?'],
    ],
  },
  {
    titel: 'Auswertung der Messreihe',
    user: 1,
    projekt: 'prj-demo-1',
    verlauf: [
      ['In der angehängten Tabelle stehen 1.200 Messwerte. Welcher Monat hat den höchsten Mittelwert?',
       'Der höchste Mittelwert liegt im **September** bei 42,7 (n = 103). Am niedrigsten liegt der Februar mit 31,2 (n = 98).\n\nDie Spannweite über alle zwölf Monate beträgt 11,5 — deutlich mehr als die Streuung innerhalb eines Monats (Standardabweichung 2,1 bis 3,4). Das spricht für einen jahreszeitlichen Einfluss und nicht für Messrauschen.'],
    ],
  },
];

const einfuegenChat = sqlite.prepare(
  `INSERT INTO chats (id, user_id, title, model, project_id, classification, created_at, updated_at)
   VALUES (?, ?, ?, 'demo-modell', ?, ?, ?, ?)`,
);
const einfuegenNachricht = sqlite.prepare(
  `INSERT INTO messages (chat_id, role, content, sender_id, created_at) VALUES (?, ?, ?, ?, ?)`,
);

GESPRAECHE.forEach((g, gi) => {
  const chatId = `chat-demo-${gi + 1}`;
  const klasse = g.projekt === 'prj-demo-2' ? 'vertraulich' : 'intern';
  const tag = 20 - gi * 4;
  einfuegenChat.run(chatId, g.user, g.titel, g.projekt ?? null, klasse, vorTagen(tag), vorTagen(tag));
  g.verlauf.forEach(([frage, antwort], i) => {
    einfuegenNachricht.run(chatId, 'user', frage, g.user, vorTagen(tag, 9 + i));
    einfuegenNachricht.run(chatId, 'assistant', antwort, null, vorTagen(tag, 9 + i));
  });
});

// Zusätzliche Nachrichten über den Zeitraum, damit die Auswertung eine
// erkennbare Kurve zeigt statt vier einzelner Punkte.
const streu = sqlite.prepare(
  `INSERT INTO messages (chat_id, role, content, sender_id, created_at) VALUES ('chat-demo-1', ?, ?, ?, ?)`,
);
for (let t = 29; t >= 0; t--) {
  const anzahl = 3 + ((t * 7) % 9); // gleichmäßig verteilt, aber nicht monoton
  for (let k = 0; k < anzahl; k++) {
    const nutzer = 1 + ((t + k) % PERSONEN.length);
    streu.run('user', 'Beispielanfrage aus dem Demo-Bestand.', nutzer, vorTagen(t, 8 + (k % 9)));
  }
}

// --- Wissens-Vault -----------------------------------------------------------
const NOTIZEN = [
  { t: 'Hausnorm HN-014 — Prüfverfahren', o: 'Normen',
    c: '# Hausnorm HN-014\n\nBeschreibt die beiden hausinternen Prüfverfahren.\n\n## Verfahren A\nUnbehandeltes Muster, 24 Stunden. Genügt für die Freigabe.\n\n## Verfahren B\nVorbehandlung 48 Stunden, Prüfung 72 Stunden. Vorgeschrieben bei Reklamationen.\n\nSiehe auch [[Ablauf einer Reklamation]].' },
  { t: 'Ablauf einer Reklamation', o: 'Abläufe',
    c: '# Ablauf einer Reklamation\n\n1. Eingang erfassen, Rückstellmuster ziehen\n2. Prüfung nach [[Hausnorm HN-014 — Prüfverfahren]], Verfahren B\n3. Ergebnis der Qualitätssicherung vorlegen\n4. Rückmeldung an den Kunden innerhalb von zehn Werktagen' },
  { t: 'Urlaubsantrag stellen', o: 'Personal',
    c: '# Urlaubsantrag\n\nAnträge laufen über das Personalportal. Vorlauf: zwei Wochen, bei mehr als zehn Tagen am Stück vier Wochen. Die Freigabe erteilt die direkte Führungskraft.' },
  { t: 'Zugriff auf Netzlaufwerke', o: 'IT',
    c: '# Netzlaufwerke\n\nZugriff wird über Gruppen vergeben, nicht personenbezogen. Anträge über die IT-Sammeladresse mit Angabe von Laufwerk und Begründung.' },
];
const einfuegenNotiz = sqlite.prepare(
  `INSERT INTO vault_notes (id, title, content, folder, tags, visibility, ai_use, chunks, created_by, created_by_name, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, '', 1, ?, 1, 'a.mustermann', ?, ?)`,
);
NOTIZEN.forEach((n, i) =>
  einfuegenNotiz.run(`note-demo-${i + 1}`, n.t, n.c, n.o, null, Math.ceil(n.c.length / 400), vorTagen(50 - i * 3), vorTagen(10 - i)),
);

// --- Rückmeldungen -----------------------------------------------------------
const RUECKMELDUNGEN: [string, string, number, string, string][] = [
  ['b.beispiel', 'quality', 5, 'Die Zusammenfassung langer Berichte spart mir jede Woche mehrere Stunden.', 'closed'],
  ['d.testfall', 'bug', 2, 'Beim Hochladen einer sehr großen Tabelle bricht die Auswertung ohne Meldung ab.', 'in_progress'],
  ['e.probe', 'feature', 4, 'Könnte man Antworten direkt als Word-Datei herunterladen?', 'open'],
  ['c.demo', 'quality', 3, 'Bei Fachbegriffen aus unserem Bereich kommen manchmal Quellen, die nicht passen.', 'in_progress'],
];
const einfuegenRueck = sqlite.prepare(
  `INSERT INTO feedback (user_id, username, category, rating, message, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
RUECKMELDUNGEN.forEach(([u, k, r, m, s], i) =>
  einfuegenRueck.run(2 + (i % 4), u, k, r, m, s, vorTagen(15 - i * 3)),
);

// --- Audit-Log ---------------------------------------------------------------
const EREIGNISSE: [string, string, string][] = [
  ['LOGIN_SUCCESS', 'auth', 'a.mustermann'],
  ['USER_CREATED', 'user', 'a.mustermann'],
  ['PERMISSION_CHANGED', 'user', 'a.mustermann'],
  ['MODULE_TOGGLED', 'system', 'a.mustermann'],
  ['KB_DOCUMENT_ADDED', 'kb', 'c.demo'],
  ['CLASSIFICATION_RAISED', 'project', 'c.demo'],
  ['REPORT_EXPORTED', 'system', 'a.mustermann'],
];
const einfuegenAudit = sqlite.prepare(
  `INSERT INTO audit_logs (user_id, username, action, resource_type, ip_address, created_at) VALUES (?, ?, ?, ?, '198.51.100.2', ?)`,
);
EREIGNISSE.forEach(([a, rt, u], i) => einfuegenAudit.run(1, u, a, rt, vorTagen(12 - i)));

// --- Leistungsmessung --------------------------------------------------------
const einfuegenPerf = sqlite.prepare(
  `INSERT INTO perf_log (user_id, model, prompt_chars, context_sources, ttfb_ms, total_ms, eval_count, had_error, streamed, created_at)
   VALUES (?, 'demo-modell', ?, ?, ?, ?, ?, 0, 1, ?)`,
);
for (let t = 29; t >= 0; t--) {
  for (let k = 0; k < 6; k++) {
    const ttfb = 900 + ((t * 137 + k * 53) % 1400);
    einfuegenPerf.run(1 + ((t + k) % 5), 4000 + ((t * 311) % 9000), (t + k) % 5, ttfb, ttfb + 4000 + ((t * 97) % 9000), 200 + ((t * 41) % 700), vorTagen(t, 8 + k));
  }
}

const zahl = (t: string): number => (sqlite.prepare(`SELECT count(*) c FROM ${t}`).get() as { c: number }).c;
console.log('Demo-Bestand angelegt:');
for (const t of ['users', 'projects', 'chats', 'messages', 'vault_notes', 'feedback', 'audit_logs', 'perf_log']) {
  console.log(`  ${t.padEnd(12)} ${zahl(t)}`);
}
console.log('\nAnmeldung: a.mustermann / demo1234!');
sqlite.close();
