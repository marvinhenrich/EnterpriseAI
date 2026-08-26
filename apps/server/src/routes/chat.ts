import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { env } from '../config/env.ts';
import { authenticate } from '../middleware/auth.ts';
import { streamChat, chatWithTools, type ChatMessage } from '../llm/ollama.ts';
import { TOOL_DEFS, SHEET_TOOL_DEFS, DOC_TOOL_DEFS, TOOL_LABELS, executeTool, type DocumentDescriptor } from '../lib/tools.ts';
import { hoechste, darfInsGedaechtnis, promptHinweis, darfGeteiltWerden, chatKlasse, hebeChatKlasse, KLASSEN } from '../lib/classification.ts';
import { modulAktiv } from '../lib/module.ts';
import { isSpreadsheet } from '../lib/spreadsheet.ts';
import {
  createChat,
  getOwnedChat,
  getAccessibleChat,
  listChatsForUser,
  getMessages,
  addMessage,
  renameChat,
  deleteChat,
  setChatFlags,
  truncateChatMessages,
  searchOwnChats,
  autoTitle,
  shareChat,
  unshareChat,
  listChatShares,
  resolveSenderNames,
} from '../lib/chats.ts';
import { getUserByUsername } from '../lib/users.ts';
import { getOwnedProject, listProjectFiles, listReferenceFiles, buildProjectInstructions, buildProjectMemory } from '../lib/projects.ts';
import { getOwnedFiles, buildFileContext, readImagesBase64, ocrFile } from '../lib/files.ts';
import { retrieve, buildRagContext, indexFile } from '../lib/rag.ts';
import { retrieveKb, buildKbContext } from '../lib/kb.ts';
import { buildMemoryContext, extractAndSaveMemory } from '../lib/memory.ts';
import { hasPermission } from '../lib/permissions.ts';
import { logAudit, logChange, requestMeta } from '../lib/audit.ts';
import { recordPerf } from '../lib/perf.ts';
import { log } from '../lib/logger.ts';
import type { AppEnv } from '../types.ts';

import { maintenanceGate } from '../middleware/maintenance.ts';
import { branding } from '../config/branding.ts';

export const chatRoutes = new Hono<AppEnv>();
chatRoutes.use('*', authenticate, maintenanceGate);

const SYSTEM_PROMPT =
  `Du bist die interne KI-Assistenz${branding.organisation ? ' von ' + branding.organisation : ''}. Antworte präzise, sachlich und auf Deutsch, ` + +
  'außer der Nutzer schreibt in einer anderen Sprache. Du arbeitest ausschließlich im Firmen-Intranet; ' +
  'gib keine vertraulichen Daten an Dritte weiter. Formatiere längere Antworten mit Markdown.\n\n' +
  'VERBINDLICHE REGELN ZUR RICHTIGKEIT (wichtiger als Ausführlichkeit):\n' +
  '- Erfinde NICHTS. Keine erfundenen Zahlen, Artikelnummern, Chargen, Normen, Paragraphen, Preise, Termine, ' +
  'Namen, Dateinamen oder Zitate. Lieber eine kurze Antwort als eine ausgedachte.\n' +
  '- Wenn dir Informationen fehlen oder du unsicher bist, sage das ausdrücklich („Das geht aus den mir ' +
  'vorliegenden Unterlagen nicht hervor") und nenne, was du bräuchtest. Rate nicht.\n' +
  '- „Ich weiß es nicht" ist eine vollwertige, erwünschte Antwort. Es ist AUSDRÜCKLICH besser, das Nichtwissen ' +
  'zuzugeben, als eine plausibel klingende Vermutung zu liefern. Rate niemals — auch nicht, wenn du dich der ' +
  'Antwort nahe fühlst.\n' +
  '- Fragt jemand nach firmeninternen Dingen (Artikel, Chargen, Kunden, Abläufe, Zuständigkeiten, interne Systeme) ' +
  'und du hast dazu KEINE bereitgestellte Quelle, dann antworte sinngemäß: „Dazu liegt mir nichts vor" — und ' +
  `erfinde auf keinen Fall Details. Dein allgemeines Modellwissen enthält KEINE Interna${branding.organisation ? ' von ' + branding.organisation : ' dieses Unternehmens'}.\n` +
  '- Stütze dich vorrangig auf die bereitgestellten Quellen (Wissens-Vault, angehängte Dateien, Gesprächsverlauf). ' +
  'Passen die Auszüge thematisch nicht zur Frage, ignoriere sie und sage das — verbiege sie nicht, damit sie passen. ' +
  'Widersprechen sich Quellen, weise darauf hin.\n' +
  '- Die Oberfläche zeigt die verwendeten Quellen bereits automatisch unter jeder Antwort an. Hänge deshalb ' +
  'KEINEN eigenen Quellen-Abschnitt an (kein „Quelle:", keine Quellenliste am Ende) — das stünde doppelt da. ' +
  'Beziehe dich stattdessen im Fließtext auf den Titel, wenn es dem Verständnis hilft ' +
  '(z. B. „Laut der Notiz Fachbegriffe … gilt …").\n' +
  '- Trenne klar zwischen Beleg und Einschätzung. Kennzeichne Eigenes als „Einschätzung:".\n' +
  '- Werkzeuge werden AUSGEFÜHRT, nicht angekündigt. Kündige niemals an, ein Werkzeug „gleich aufzurufen", ' +
  'und frage nicht um Erlaubnis dafür — rufe es auf. Und gib niemals ein Ergebnis aus, das du nicht ' +
  'tatsächlich vom Werkzeug erhalten hast.\n' +
  '- Angehängte und Projektdateien stehen dir bereits im Text zur Verfügung. Sage nicht, du habest eine ' +
  'Datei „nicht ausgewertet", wenn ihr Inhalt oben steht — nutze ihn und benenne die Datei.\n' +
  '- Erfinde KEINE Literaturangaben. Nenne Studien, Normen, Fachartikel oder Jahreszahlen nur, wenn sie ' +
  'in den Unterlagen stehen. Fehlt ein Beleg, schreibe „aus allgemeinem Fachwissen, nicht belegt".\n' +
  '- Übertrage niemals Daten eines ÄHNLICHEN Produkts auf ein anderes. „Ecodis 40" und „Ecodis P 50" sind ' +
  'verschiedene Produkte, ebenso „NTC 61" und „NTC 62". Liegt das Datenblatt zum gefragten Produkt nicht ' +
  'vor, sage das — statt das Datenblatt des Nachbarprodukts zu verwenden.\n' +
  '- Empfiehlst du ein konkretes Handelsprodukt, das nicht in den Unterlagen steht, kennzeichne es als ' +
  'unbelegten Vorschlag und behaupte nichts über seine Zusammensetzung.';

// Zusatz, sobald der Fachrechner aktiv ist. Ohne diese Regel schreibt das
// Modell Python-Code, führt ihn nicht aus (es kann es nicht) und gibt danach
// erfundene Zahlen als „Ergebnis des Skript-Durchlaufs" aus. Genau so entstanden
// PVK 86,25 % statt 61,14 % und Lambda 1,10 statt 0,925.

// Programmiermodus (opt-in via Permission code.assist). Erweitert den Basis-Prompt
// zu einem Coding-Assistenten „wie Claude Code". WICHTIG: rein generierend, KEINE
// Ausführung — der Server hat kein Terminal/keine Sandbox.
const CODING_ADDENDUM =
  'Programmiermodus aktiv: Verhalte dich wie ein erfahrener Senior-Software-Entwickler (vergleichbar mit Claude Code).\n' +
  '- Schreibe vollständigen, lauffähigen, idiomatischen Code mit sinnvollen, knappen Kommentaren.\n' +
  '- Gib jede Datei in einem EIGENEN Code-Block mit Sprachkennzeichnung aus und beginne den Block mit einer ersten ' +
  'Kommentarzeile, die den Dateipfad nennt — z. B. „// src/app.ts", „# main.py", „<!-- index.html -->" oder „-- schema.sql". ' +
  'So lassen sich die Dateien als Projekt herunterladen.\n' +
  '- Erkläre Aufbau/Änderungen knapp VOR oder NACH dem Code, nicht mitten im Block.\n' +
  '- Du führst KEINEN Code aus und hast keinen Terminal-, Netz- oder Dateisystemzugriff; behaupte niemals, Code ausgeführt, ' +
  'getestet oder Pakete installiert zu haben. Beschreibe stattdessen, wie der Nutzer es selbst ausführt.\n' +
  '- Bleib strikt im Firmen-Intranet; rufe keine externen Dienste oder Paketregister im Namen des Nutzers auf.';

/**
 * Sieht der Text aus wie ein missglückter Werkzeugaufruf statt einer Antwort?
 * Bewusst eng gefasst: kurzes JSON-Fragment ohne Fließtext. Eine echte Antwort,
 * die zufällig mit einer Klammer beginnt, ist länger und enthält Sätze.
 */
function istWerkzeugFragment(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 240) return false;
  if (!/^[{[]/.test(t)) return false;
  return /"\s*:\s*"/.test(t) || /^\{\s*"\w+/.test(t);
}

// --- Chats CRUD --------------------------------------------------------------
chatRoutes.get('/chats', (c) => {
  const user = c.get('user');
  return c.json({ chats: listChatsForUser(user.id) });
});

// Volltextsuche über die eigenen Chats (Titel + Nachrichten).
chatRoutes.get('/chats/search', (c) => {
  const user = c.get('user');
  const q = (c.req.query('q') ?? '').trim();
  if (q.length < 2) return c.json({ query: q, hits: [] });
  return c.json({ query: q, hits: searchOwnChats(user.id, q) });
});

chatRoutes.post('/chats', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const title = typeof body?.title === 'string' && body.title.trim() ? body.title.trim() : 'Neuer Chat';
  // Optional direkt einem Projekt zuordnen (nur eigene Projekte).
  const projectId = typeof body?.projectId === 'string' && getOwnedProject(user.id, body.projectId) ? body.projectId : null;
  const chat = createChat(user.id, title, undefined, projectId);
  logAudit({ ...requestMeta(c), userId: user.id, username: user.username, action: 'CHAT_CREATED', resourceType: 'chat', resourceId: chat.id, resourceLabel: chat.title, details: { projectId } });
  return c.json({ chat }, 201);
});

chatRoutes.get('/chat/:id', (c) => {
  const user = c.get('user');
  const acc = getAccessibleChat(user.id, c.req.param('id'));
  if (!acc) return c.json({ error: 'Chat nicht gefunden' }, 404);
  const msgs = getMessages(acc.chat.id);
  // In geteilten Chats: Sender-Namen für User-Nachrichten mitgeben.
  const names = acc.access === 'shared' || msgs.some((m) => m.senderId) ? resolveSenderNames(msgs) : new Map();
  const messages = msgs.map((m) => ({ ...m, senderName: m.senderId ? (names.get(m.senderId) ?? null) : null }));
  return c.json({ chat: acc.chat, messages, access: acc.access, canWrite: acc.canWrite });
});

chatRoutes.patch('/chat/:id', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const title = String(body?.title ?? '').trim();
  if (!title) return c.json({ error: 'Titel erforderlich' }, 400);
  const id = c.req.param('id');
  const before = getOwnedChat(user.id, id);
  if (!renameChat(user.id, id, title)) return c.json({ error: 'Chat nicht gefunden' }, 404);
  logChange({ c, userId: user.id, username: user.username, action: 'CHAT_RENAMED', resourceType: 'chat', resourceId: id, resourceLabel: title, before: { titel: before?.title }, after: { titel: title } });
  return c.json({ ok: true });
});

chatRoutes.delete('/chat/:id', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const before = getOwnedChat(user.id, id);
  if (!deleteChat(user.id, id)) return c.json({ error: 'Chat nicht gefunden' }, 404);
  logAudit({ ...requestMeta(c), userId: user.id, username: user.username, action: 'CHAT_DELETED', resourceType: 'chat', resourceId: id, resourceLabel: before?.title ?? null });
  return c.json({ ok: true });
});

// Chat anheften/archivieren (Teil-Update von pinned/archived).
chatRoutes.post('/chat/:id/flags', async (c) => {
  const user = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as { pinned?: boolean; archived?: boolean };
  const flags: { pinned?: boolean; archived?: boolean } = {};
  if (typeof body.pinned === 'boolean') flags.pinned = body.pinned;
  if (typeof body.archived === 'boolean') flags.archived = body.archived;
  const id = c.req.param('id');
  const before = getOwnedChat(user.id, id);
  if (!setChatFlags(user.id, id, flags)) return c.json({ error: 'Chat nicht gefunden' }, 404);
  logChange({ c, userId: user.id, username: user.username, action: 'CHAT_FLAGS', resourceType: 'chat', resourceId: id, resourceLabel: before?.title ?? null,
    before: { angeheftet: !!before?.pinned, archiviert: !!before?.archived },
    after: { angeheftet: flags.pinned ?? !!before?.pinned, archiviert: flags.archived ?? !!before?.archived } });
  return c.json({ ok: true });
});

// Nachrichten ab Position abschneiden (für „Bearbeiten" und „Neu generieren").
// keep = Anzahl der zu behaltenden ersten Nachrichten.
chatRoutes.post('/chat/:id/truncate', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const keep = Number(body?.keep);
  if (!Number.isFinite(keep) || keep < 0) return c.json({ error: 'keep (>=0) erforderlich' }, 400);
  const id = c.req.param('id');
  // Eigentum ZUERST prüfen. Vorher wurden die Nachrichten eines fremden Chats
  // erst vollständig geladen und dann verworfen — unnötige Arbeit und ein
  // messbarer Unterschied in der Antwortzeit, an dem sich fremde Chat-IDs
  // erraten ließen.
  const eigen = getOwnedChat(user.id, id);
  if (!eigen) return c.json({ error: 'Chat nicht gefunden' }, 404);
  const vorher = getMessages(id).length;
  if (!truncateChatMessages(user.id, id, keep)) return c.json({ error: 'Chat nicht gefunden' }, 404);
  logAudit({ ...requestMeta(c), userId: user.id, username: user.username, action: 'CHAT_MESSAGES_TRUNCATED', resourceType: 'chat', resourceId: id,
    resourceLabel: getOwnedChat(user.id, id)?.title ?? null, details: { nachrichtenVorher: vorher, behalten: keep, geloescht: Math.max(0, vorher - keep) } });
  return c.json({ ok: true });
});

// --- Teilen (Mehrbenutzer-Threads) ------------------------------------------
chatRoutes.get('/chat/:id/shares', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!getOwnedChat(user.id, id)) return c.json({ error: 'Chat nicht gefunden' }, 404);
  return c.json({ shares: listChatShares(id) });
});

chatRoutes.post('/chat/:id/share', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user.id, user.role, 'chat.share')) return c.json({ error: 'Keine Berechtigung zum Teilen' }, 403);
  const id = c.req.param('id');
  if (!getOwnedChat(user.id, id)) return c.json({ error: 'Chat nicht gefunden' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { username?: string; canWrite?: boolean };
  const target = body.username ? getUserByUsername(body.username.trim()) : undefined;
  if (!target) return c.json({ error: 'Benutzer nicht gefunden' }, 404);
  if (target.id === user.id) return c.json({ error: 'Chat gehört dir bereits' }, 400);

  // Eingestufte Gespräche lassen sich nicht weitergeben. Ein Chat über eine
  // Fachdokument enthält die Fachdokument — teilen hieße, die Einstufung auszuhebeln.
  const kl = chatKlasse(id);
  if (!darfGeteiltWerden(kl)) {
    logAudit({ ...requestMeta(c), userId: user.id, username: user.username, action: 'CHAT_SHARE_BLOCKED',
      resourceType: 'chat', resourceId: id, details: { empfaenger: target.username, klasse: kl } });
    return c.json({
      error: `Dieser Chat ist als „${KLASSEN[kl].label}" eingestuft und kann nicht geteilt werden. ` +
        'Stufe die zugrunde liegenden Unterlagen herab oder gib die Erkenntnisse ohne die eingestuften Daten weiter.',
    }, 403);
  }

  shareChat(user.id, id, target.id, body.canWrite !== false);
  logAudit({ ...requestMeta(c), userId: user.id, username: user.username, action: 'CHAT_SHARED', resourceType: 'chat', resourceId: id,
    resourceLabel: getOwnedChat(user.id, id)?.title ?? null, details: { empfaenger: target.username, schreibrecht: body.canWrite !== false } });
  return c.json({ ok: true, shares: listChatShares(id) }, 201);
});

chatRoutes.delete('/chat/:id/share/:userId', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const targetId = Number(c.req.param('userId'));
  if (!unshareChat(user.id, id, targetId)) return c.json({ error: 'Chat nicht gefunden' }, 404);
  logAudit({ ...requestMeta(c), userId: user.id, username: user.username, action: 'CHAT_UNSHARED', resourceType: 'chat', resourceId: id, details: { empfaengerId: targetId } });
  return c.json({ ok: true, shares: listChatShares(id) });
});

// --- Streaming-Query (SSE) ---------------------------------------------------
const querySchema = z.object({
  content: z.string().min(1),
  model: z.string().optional(),
  think: z.boolean().optional(),
  tools: z.boolean().optional(),
  code: z.boolean().optional(), // Coding-Assistent (Programmiermodus)
  fullContext: z.boolean().optional(), // ganzes Dokument statt RAG-Schnipsel
  fileIds: z.array(z.string()).optional(),
  regenerate: z.boolean().optional(), // Antwort neu erzeugen: keine neue User-Nachricht anlegen
});

// Klingt die Anfrage nach einem herunterladbaren Dokument? (nur dann das Dokument-
// Werkzeug anbieten → normaler Chat bleibt echtes Token-Streaming).
const DOC_HINT = /\b(dokument|pdf|word|docx|datei|angebot|schreiben|brief|bericht|protokoll|datenblatt|exportier|herunterladen|download|ausdruck|erstell\w*\s+(ein|mir|uns)?\s*(ein\w*\s+)?(dokument|pdf|word|datei|angebot|schreiben|brief|bericht)|rechnung|urkunde|zertifikat|vertrag|deckblatt|als\s+(pdf|word|docx|dokument))\b/i;
function mightWantDocument(s: string): boolean {
  return DOC_HINT.test(s);
}

chatRoutes.post('/chat/:id/query', async (c) => {
  const user = c.get('user');
  const acc = getAccessibleChat(user.id, c.req.param('id'));
  if (!acc) return c.json({ error: 'Chat nicht gefunden' }, 404);
  if (!acc.canWrite) return c.json({ error: 'Nur Lesezugriff auf diesen geteilten Chat' }, 403);
  const chat = acc.chat;

  const parsed = querySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'content erforderlich' }, 400);
  const { content, model, think, tools, code, fullContext, fileIds, regenerate } = parsed.data;

  // Quellen für die Quellenangaben-Chips (RAG-Dateien + Wissens-Vault).
  // Quellen tragen ihre ID mit, damit sie in der Oberfläche anklickbar sind
  // und direkt zum Ursprung führen (Vault-Notiz, Vault-Dokument, Datei).
  type SourceKind = 'file' | 'note' | 'document' | 'model';
  const sources: { label: string; kind: SourceKind; id?: string }[] = [];
  const addSource = (label: string, kind: SourceKind, id?: string) => {
    if (label && !sources.some((s) => s.label === label && s.kind === kind)) sources.push({ label, kind, id });
  };
  // Feedback „Immer Quellenangabe": auch ohne Beleg eine Angabe liefern — dann
  // transparent als reines Modellwissen gekennzeichnet (statt gar keiner Quelle).
  const sourcesOrFallback = (): { label: string; kind: SourceKind; id?: string }[] =>
    sources.length > 0 ? sources : [{ label: 'Allgemeines Modellwissen — nicht aus Firmenunterlagen belegt', kind: 'model' }];

  // Server-seitige Durchsetzung (UI-Gate allein reicht nicht):
  const effectiveModel = hasPermission(user.id, user.role, 'chat.select_model') ? model : undefined;
  const effectiveThink = hasPermission(user.id, user.role, 'chat.think_mode') ? think : false;
  const useTools = !!tools && hasPermission(user.id, user.role, 'chat.use_tools');
  const useCode = !!code && hasPermission(user.id, user.role, 'code.assist');
  const canGlobalMemory = hasPermission(user.id, user.role, 'memory.global.contribute');

  // Projektkontext: Anweisungen + Projektdateien gelten in JEDEM Chat des Projekts.
  const project = chat.projectId ? getOwnedProject(user.id, chat.projectId) : undefined;
  const projectInstructions = project ? buildProjectInstructions(project) : '';
  const projectMemoryContext = project ? buildProjectMemory(project.id) : '';

  // Angehängte Dateien laden (nur eigene): Dokumenttext + Bilder.
  // Projektdateien kommen automatisch dazu (ohne dass der Nutzer sie anhängt).
  const attachedRows = fileIds && fileIds.length > 0 ? getOwnedFiles(user.id, fileIds) : [];
  const projectRows = project ? listProjectFiles(user.id, project.id) : [];
  // Referenzdateien gelten in ALLEN Projekten des Nutzers — die fachliche
  // Grundlage soll nicht davon abhängen, in welchem Projekt sie hochgeladen
  // wurde. Nur in Projektchats, nicht in freien Unterhaltungen.
  const refRows = project ? listReferenceFiles(user.id) : [];
  const vorhanden = new Set([...attachedRows, ...projectRows].map((f) => f.id));
  const fileRows = [
    ...attachedRows,
    ...projectRows.filter((p) => !attachedRows.some((a) => a.id === p.id)),
    ...refRows.filter((r) => !vorhanden.has(r.id)),
  ];
  const images = env.OLLAMA_MULTIMODAL ? await readImagesBase64(fileRows) : [];

  // Höchste Einstufung aller Unterlagen, die in dieses Gespräch eingehen —
  // einschließlich der Projektvorgabe. Maßgeblich ist immer die schützendste
  // Stufe: Eine einzige Fachdatei stuft das ganze Gespräch hoch.
  // Mit der am Chat festgeschriebenen Stufe ZUSAMMENFÜHREN, nicht ersetzen.
  // Sonst fällt eine Folgefrage ohne Anhang auf 'intern' zurück, obwohl die
  // Fachdokument aus Runde 1 noch im Verlauf steht.
  let klasse = hoechste(chatKlasse(chat.id), project?.classification, ...fileRows.map((f) => f.classification));
  const eingestuft = !darfInsGedaechtnis(klasse);

  // Tabellen-Tools: aktiv, wenn eine Excel/CSV angehängt ist + Permission docs.sheet.
  // Dann die Tabelle NICHT in den Kontext kippen — die KI fragt sie per Tool ab.
  // Dateien, die ein Spezialwerkzeug vollständig abdeckt, aus der generischen
  // Tabellensuche heraushalten. Sonst greift das Modell zur Allzwecksuche, die
  // an der Kopfzeile scheitert, und meldet „kein Datensatz" — obwohl das
  // Spezialwerkzeug den Wert kennt.
  // Referenzdateien lösen die Tabellen-Werkzeuge NICHT aus: Eine als Referenz
  // markierte Excel würde sonst in jedem Projekt die Tabellensuche aktivieren.
  const refIds = new Set(refRows.map((f) => f.id));
  const hasSheet = fileRows.some((f) => isSpreadsheet(f.filename) && !refIds.has(f.id));
  const useSheetTools = hasSheet && modulAktiv('sheets') && hasPermission(user.id, user.role, 'docs.sheet');
  // Dokument-Werkzeug (docs.export): aktiv, wenn die Anfrage nach einem Dokument
  // klingt ODER ohnehin Werkzeuge laufen — so bleibt normaler Chat echtes Streaming.
  const canExport = modulAktiv('docexport') && hasPermission(user.id, user.role, 'docs.export');
  const wantsDoc = canExport && (mightWantDocument(content) || useTools || useSheetTools);
  // Fachrechner: aktiv, sobald eine Rohstofftabelle (Spalte PVK_Zuordnung)
  // im Kontext liegt. Das Modell rechnet PVK/CPVK/Lambda nachweislich falsch —
  // gemessen 86,25 % statt 61,14 %, Lambda 1,10 statt 0,925 — und gibt die
  // erfundenen Zahlen als „Ergebnis des Skript-Durchlaufs" aus. Darum rechnet
  // hier Code, nicht das Modell.
  const activeTools = [
    ...(useTools ? TOOL_DEFS : []),
    ...(useSheetTools ? SHEET_TOOL_DEFS : []),
    ...(wantsDoc ? DOC_TOOL_DEFS : []),
  ];
  const runTools = activeTools.length > 0;
  // Tabellen nur dann aus dem Kontext nehmen, wenn sie WIRKLICH groß sind.
  // Ein Fachdokument mit 276 Zeichen auszublenden und auf einen Werkzeugaufruf zu
  // hoffen, ist absurd: ruft das Modell das Werkzeug nicht auf, hat es nichts
  // und beginnt zu erzählen. Kleine Tabellen also direkt mitgeben.
  const SHEET_INLINE_MAX = 8000; // Zeichen
  const contextRows = useSheetTools
    ? fileRows.filter((f) => !isSpreadsheet(f.filename) || (f.extractedText?.length ?? 0) <= SHEET_INLINE_MAX)
    : fileRows;


  // Angehängte Bilder OHNE erkannten Text automatisch per OCR auslesen (offline),
  // damit die KI den Bildinhalt je nach Anfrage direkt nutzen kann — ohne extra
  // Klick. Bereits ausgelesene Bilder (extractedText vorhanden) werden übersprungen.
  // Entfällt, wenn das Modell die Bilder ohnehin multimodal sieht.
  {
    for (const f of contextRows) {
      // Bilder (sofern das Modell sie nicht ohnehin sieht) UND gescannte PDFs.
      const istScanPdf = /\.pdf$/i.test(f.filename) && !(f.extractedText && f.extractedText.trim().length > 100);
      const istBildOhneText = !env.OLLAMA_MULTIMODAL && f.kind === 'image' && !(f.extractedText && f.extractedText.trim());
      if (istBildOhneText || istScanPdf) {
        try {
          const r = await ocrFile(user.id, f.id);
          if (r.ok && r.text.trim()) {
            f.extractedText = r.text; // lokale Kopie für Kontext
            // Auch für die gezielte Suche zerlegen. Ohne das bekommt die Datei
            // Text, aber keine Chunks — und ist damit unauffindbar, sobald der
            // Volltext nicht mehr pauschal mitgeschickt wird.
            void indexFile(f.id, r.text).catch((e) =>
              log.warn('[Chat] Nachindexierung fehlgeschlagen', { id: f.id, error: (e as Error).message }));
          }
        } catch (err) {
          log.warn('[Chat] Auto-OCR fehlgeschlagen', { id: f.id, error: (err as Error).message });
        }
      }
    }
  }
  // NUR echte Bilder. Der frühere Filter fing über die Endung auch jedes PDF —
  // und weiter unten wurde deren Volltext OHNE Budget angehängt, also mit
  // 200.000 Zeichen. Gemessen im Projekt „Optimierung bestehender Verfahren":
  // 208.110 Zeichen ≈ 52.028 Token allein für Dateien, 79 % des Fensters.
  // Quellen werden hier NICHT mehr gesetzt — erst dort, wo Text tatsächlich in
  // den Prompt geht. Sonst weist die Oberfläche Quellen aus, die gar nicht
  // beigetragen haben.
  const imageRows = contextRows.filter((f) => f.kind === 'image' && f.extractedText && f.extractedText.trim());

  // Datei-Kontext: Schnell-Aktionen (fullContext) nutzen den GANZEN Dokumenttext
  // (z.B. Zusammenfassen/Übersetzen); normale Fragen nutzen RAG (relevante Chunks).
  let fileContext = '';
  // Verarbeitungsdauer des Prompts ist der Engpass (~590 Token/s gemessen):
  // 36.000 Token Kontext = gut eine Minute Wartezeit. Deshalb den Volltext nur
  // nutzen, solange er in einem vertretbaren Rahmen bleibt — sonst gezielt suchen.
  const FULLTEXT_LIMIT = 60_000; // Zeichen ≈ 15.000 Token ≈ 25 s Wartezeit
  // Grenze zwischen „vollständig mitgeben" und „gezielt durchsuchen". Aus der
  // Größenverteilung im Bestand: pvk_rechner.py 10.174, Umweltzeichen 10.586 —
  // dann eine Lücke bis 18.916 (erstes Sicherheitsdatenblatt).
  const SMALL_FILE_MAX = 12_000;
  const REF_BUDGET = 40_000;  // Obergrenze für den Volltextanteil
  const BILD_BUDGET = 20_000; // Obergrenze für Bild-Texterkennung
  const gesamtZeichen = contextRows.reduce((n, f) => n + (f.extractedText?.length ?? 0), 0);
  const fullContextMachbar = fullContext && gesamtZeichen <= FULLTEXT_LIMIT;
  if (fullContext && !fullContextMachbar) {
    log.info('[Chat] Volltext zu groß → gezielte Suche', { zeichen: gesamtZeichen, grenze: FULLTEXT_LIMIT });
  }

  if (contextRows.length > 0) {
    if (fullContextMachbar) {
      fileContext = buildFileContext(contextRows);
      // Was inhaltlich einfließt, MUSS auch als Quelle erscheinen — sonst
      // nutzt die KI eine Datei, ohne sie auszuweisen.
      for (const f of contextRows) if (f.extractedText?.trim()) addSource(f.filename, 'file', f.id);
    } else {
      // Zweistufig statt entweder/oder:
      //
      // Kleine Dateien kommen IMMER vollständig in den Prompt. Gemessen: Der
      // entscheidende Absatz aus Rechenlogik.md steht bei der Frage „Warum
      // erreicht der Nassabrieb nur Klasse 3?" auf Rang 10 bis 21 von 60 — die
      // Chunk-Suche findet ihn nicht, weil dort „Nassabriebeinbruch" steht und
      // nicht „Nassabrieb". Eine 4.663-Zeichen-Referenz vollständig mitzugeben
      // kostet ~1.166 Token und ist billiger als sechs Lärm-Chunks.
      //
      // Große Dateien (Sicherheitsdatenblätter) nur über gezielte Suche.
      const klein = contextRows.filter((f) => {
        const n = f.extractedText?.trim().length ?? 0;
        return n > 0 && n <= SMALL_FILE_MAX;
      });
      const gross = contextRows.filter((f) => (f.extractedText?.trim().length ?? 0) > SMALL_FILE_MAX);

      const kleinCtx = buildFileContext(klein, REF_BUDGET);
      if (kleinCtx) for (const f of klein) if (f.extractedText?.trim()) addSource(f.filename, 'file', f.id);

      let ragCtx = '';
      try {
        const docIds = gross.filter((f) => f.kind === 'document').map((f) => f.id);
        if (docIds.length > 0) {
          const hits = await retrieve(content, docIds, 6);
          if (hits.length > 0) {
            const names = new Map(contextRows.map((f) => [f.id, f.filename]));
            ragCtx = buildRagContext(hits, names);
            for (const h of hits) addSource(names.get(h.fileId) ?? 'Dokument', 'file', h.fileId);
          }
        }
      } catch (err) {
        log.warn('[Chat] Gezielte Suche fehlgeschlagen', { error: (err as Error).message });
      }

      // Findet die Suche in den großen Dokumenten nichts, wird NICHT der
      // Volltext hineingekippt. Ein Satz ist ehrlicher als 60.000 Zeichen, in
      // denen sich die KI etwas Passendes zusammensucht.
      const keinTreffer = !ragCtx && gross.length > 0
        ? `\n\nHinweis: In den umfangreichen Dokumenten (${gross.map((f) => f.filename).join(', ')}) ` +
          'wurde zu dieser Frage keine passende Stelle gefunden. Sage das ausdrücklich, statt daraus etwas zu konstruieren.'
        : '';

      // OCR-Text echter Bilder, mit eigenem Budget.
      const bildCtx = imageRows.length > 0 ? buildFileContext(imageRows, BILD_BUDGET) : '';
      if (bildCtx) for (const f of imageRows) addSource(f.filename, 'file', f.id);

      fileContext = [kleinCtx, ragCtx, bildCtx].filter(Boolean).join('\n\n') + keinTreffer;
    }
  }
  // Nur wenn tatsächlich eine große Tabelle ausgelagert wurde, ist der Hinweis sinnvoll.
  const grosseTabellen = fileRows.filter((f) => isSpreadsheet(f.filename) && (f.extractedText?.length ?? 0) > SHEET_INLINE_MAX);
  const sheetHint =
    useSheetTools && grosseTabellen.length > 0
      ? `Folgende Tabelle(n) sind zu groß für den Kontext und NICHT im Text enthalten: ${grosseTabellen.map((f) => f.filename).join(', ')}. ` +
        'Werte sie mit den Werkzeugen spreadsheet_info (zuerst, für die Struktur) und spreadsheet_query (Filtern/Aggregieren) aus. ' +
        'Rufe die Werkzeuge WIRKLICH auf — kündige sie nicht nur an und erfinde keine Werte. Kleinere Tabellen stehen bereits vollständig im Text.'
      : '';

  // Firmenweites Wissens-Vault automatisch einspeisen (nur mit kb.query, nur
  // wenn semantisch relevant). Intern, kein Outbound.
  // Projekte können sich abschotten: „nur Projektdateien" verhindert, dass
  // allgemeines Vault-Wissen in ein abgegrenztes Thema (z. B. Forschung) einsickert.
  const vaultGesperrt = project?.vaultScope === 'project';
  let kbContext = '';
  if (!vaultGesperrt && hasPermission(user.id, user.role, 'kb.query')) {
    try {
      // Hat der Nutzer Dateien dabei, dreht sich die Frage meist um DIESE.
      // Dann nur noch klar einschlägiges Vault-Wissen zulassen — sonst hängen
      // an „kannst du diese Datei lesen?" plötzlich Etiketten- und
      // Homeoffice-Notizen als vermeintliche Quellen.
      const mitDateien = contextRows.length > 0;
      const kbHits = await retrieveKb(
        content,
        { userId: user.id, role: user.role },
        mitDateien ? 4 : 6,
        mitDateien ? 0.45 : undefined,
      );
      kbContext = buildKbContext(kbHits);
      for (const h of kbHits) addSource(h.title, h.kind === 'note' ? 'note' : 'document', h.docId);
    } catch (err) {
      log.warn('[Chat] KB-Retrieval fehlgeschlagen', { error: (err as Error).message });
    }
  }

  // User-Nachricht speichern; bei erster Nachricht den Chat automatisch betiteln.
  // Bei Regenerate existiert die User-Nachricht bereits → nicht erneut anlegen.
  const history = getMessages(chat.id);
  if (!regenerate) {
    if (history.length === 0) renameChat(user.id, chat.id, autoTitle(content));
    addMessage(chat.id, 'user', content, fileRows.length > 0 ? fileRows.map((f) => ({ id: f.id, name: f.filename, kind: f.kind })) : undefined, user.id);
  }

  // Kontext bauen: System-Prompt (+ Memory + Datei-Kontext) + letzte N Nachrichten.
  const recent = getMessages(chat.id).slice(-env.MAX_CONTEXT_MESSAGES);
  const memoryContext = buildMemoryContext(user.id);
  const baseSystem = [
    SYSTEM_PROMPT,
    useCode ? CODING_ADDENDUM : '',
    promptHinweis(klasse),
  ]
    .filter(Boolean)
    .join('\n\n');
  const systemContent = [baseSystem, projectInstructions, projectMemoryContext, memoryContext, kbContext, fileContext, sheetHint].filter(Boolean).join('\n\n');
  const llmMessages: ChatMessage[] = [
    { role: 'system', content: systemContent },
    ...recent.map((m, i) => {
      const base: ChatMessage = { role: m.role as ChatMessage['role'], content: m.content };
      // Bilder nur an die letzte (aktuelle) User-Nachricht hängen.
      if (images.length > 0 && i === recent.length - 1 && m.role === 'user') base.images = images;
      return base;
    }),
  ];

  return streamSSE(c, async (stream) => {
    const ac = new AbortController();
    stream.onAbort(() => ac.abort()); // Client trennt → Ollama-Request abbrechen

    // Leistungsmessung: Startzeit, Zeit bis zum ersten Token, Gesamtdauer.
    const startedAt = Date.now();
    let firstTokenAt: number | null = null;
    // Werkzeugrunden werden im Loop hochgezählt und hier mitgeschrieben.
    let werkzeugRunden = 0;
    const werkzeugDefLaenge = runTools ? JSON.stringify(activeTools).length : 0;
    const verlaufLaenge = llmMessages.reduce((n, m) => n + (m.content?.length ?? 0), 0) - systemContent.length;

    const messen = (fehler: boolean, evalCount?: number) =>
      recordPerf({
        userId: user.id,
        model: effectiveModel ?? env.OLLAMA_MODEL,
        // Vollständige Promptlänge: System-Prompt + Verlauf + Werkzeugdefinitionen.
        // Vorher wurde nur „System + letzte Frage" gezählt und als Promptlänge
        // ausgewiesen — der Verlauf und die inzwischen zehn Werkzeugbeschreibungen
        // fehlten darin völlig.
        promptChars: systemContent.length + verlaufLaenge + werkzeugDefLaenge,
        systemChars: systemContent.length,
        historyChars: Math.max(0, verlaufLaenge),
        toolDefChars: werkzeugDefLaenge,
        toolRounds: werkzeugRunden,
        streamed: !runTools,
        contextSources: sources.length,
        ttfbMs: firstTokenAt ? firstTokenAt - startedAt : null,
        totalMs: Date.now() - startedAt,
        evalCount: evalCount ?? null,
        hadError: fehler,
      });

    let full = '';
    try {
      if (runTools) {
        // --- Tool-Loop (rein interne Werkzeuge) -------------------------------
        const attachedIds = fileRows.map((f) => f.id);
        const convo: ChatMessage[] = [...llmMessages];
        // Wiederholte Aufrufe erkennen. Beobachtet: Das Modell ruft dasselbe
        // Werkzeug mit denselben Argumenten mehrfach auf und dreht sich fest,
        // weil es jedes Mal dieselbe Antwort bekommt. Statt sie erneut zu
        // liefern, bekommt es beim zweiten Mal eine klare Anweisung.
        const gesehen = new Map<string, number>();
        const generatedDocs: DocumentDescriptor[] = [];
        let emittedDocs = 0;
        const MAX_RUNDEN = 8;
        for (let round = 0; round < MAX_RUNDEN; round++) {
          werkzeugRunden = round + 1;
          const { content: c2, toolCalls } = await chatWithTools(convo, activeTools as unknown as unknown[], { model: effectiveModel, signal: ac.signal });
          if (!toolCalls || toolCalls.length === 0) {
            full = c2;
            break;
          }
          convo.push({ role: 'assistant', content: c2 || '', tool_calls: toolCalls });
          for (const tc of toolCalls) {
            const tname = tc.function?.name ?? '';
            await stream.writeSSE({ event: 'tool', data: JSON.stringify({ name: tname, label: TOOL_LABELS[tname] ?? tname }) });
            const signatur = `${tname}:${JSON.stringify(tc.function?.arguments ?? {})}`;
            const wievielt = (gesehen.get(signatur) ?? 0) + 1;
            gesehen.set(signatur, wievielt);

            let result: string;
            if (wievielt > 1) {
              log.warn('[Chat] Werkzeug wiederholt aufgerufen', { chatId: chat.id, werkzeug: tname, mal: wievielt });
              result =
                `Dieser Aufruf von „${tname}" ist identisch mit einem vorherigen — das Ergebnis steht bereits weiter oben ` +
                'im Verlauf. Wiederhole ihn nicht. Beantworte die Frage jetzt aus den vorliegenden Ergebnissen, oder ' +
                'rufe ein ANDERES Werkzeug bzw. dasselbe mit ANDEREN Argumenten auf. Fehlt etwas, sage welches Argument.';
            } else {
              result = await executeTool(tname, tc.function?.arguments ?? {}, {
                userId: user.id, role: user.role, fileIds: attachedIds,
                canCreateDocument: canExport,
                onDocument: (d) => generatedDocs.push(d),
              });
            }
            convo.push({ role: 'tool', content: result, tool_name: tname });
            // Neu erzeugte Dokumente sofort als Download-Karte an die UI.
            while (emittedDocs < generatedDocs.length) {
              const d = generatedDocs[emittedDocs++]!;
              await stream.writeSSE({ event: 'document', data: JSON.stringify({ title: d.title, format: d.format, content: d.content }) });
            }
          }
        }

        // Rundenlimit erschöpft, ohne dass eine Antwort entstand: Das Modell hat
        // sich in Werkzeugaufrufen verfangen. Dann eine letzte Runde OHNE
        // Werkzeuge — die Ergebnisse liegen ja bereits im Verlauf. Ohne diesen
        // Ausweg bekäme der Nutzer eine leere Nachricht.
        // Manchmal verunglückt ein Werkzeugaufruf und das Bruchstück landet als
        // Text in der Antwort — beobachtet: `{"suibe":"AMP..."}` statt eines
        // Aufrufs von lookup_material. Solche Fragmente dürfen den Nutzer nicht
        // erreichen; sie zählen wie eine leere Antwort.
        if (istWerkzeugFragment(full)) {
          log.warn('[Chat] Verunglückter Werkzeugaufruf als Text verworfen', { chatId: chat.id, text: full.slice(0, 80) });
          full = '';
        }

        if (!full.trim()) {
          log.warn('[Chat] Werkzeugschleife ohne Antwort beendet — erzwinge Abschluss', { chatId: chat.id });
          convo.push({
            role: 'user',
            content:
              'Beende jetzt. Formuliere die Antwort ausschließlich aus den bereits vorliegenden ' +
              'Werkzeugergebnissen. Rufe kein weiteres Werkzeug auf und rechne nichts selbst nach. ' +
              'Fehlen Angaben, benenne die Lücke.',
          });
          const { content: schluss } = await chatWithTools(convo, [], { model: effectiveModel, signal: ac.signal });
          full = schluss;
        }

        // Fertige Antwort progressiv in Stücken senden (UI bleibt konsistent).
        // KEIN firstTokenAt hier: Die Antwort ist zu diesem Zeitpunkt längst
        // fertig, das Nachreichen in Häppchen ist reine Darstellung. Sie hier zu
        // setzen hieße, die Gesamtzeit als „Zeit bis zum ersten Wort" auszugeben.
        for (let i = 0; i < full.length; i += 18) {
          const piece = full.slice(i, i + 18);
          await stream.writeSSE({ event: 'delta', data: JSON.stringify({ t: piece }) });
        }
        if (full.trim() || generatedDocs.length > 0) {
          const atts: unknown[] = generatedDocs.map((d) => ({ kind: 'document' as const, title: d.title, format: d.format, content: d.content }));
          atts.push({ kind: 'sources' as const, items: sourcesOrFallback() });
          addMessage(chat.id, 'assistant', full, atts.length ? atts : undefined);
          if (full.trim()) void extractAndSaveMemory(user.id, content, full, canGlobalMemory, chat.projectId, hebeChatKlasse(chat.id, klasse));
        }
        await stream.writeSSE({ event: 'sources', data: JSON.stringify({ sources: sourcesOrFallback() }) });
        messen(false);
        await stream.writeSSE({ event: 'done', data: JSON.stringify({ evalCount: 0, totalMs: 0 }) });
        return;
      }

      const gen = streamChat(llmMessages, { model: effectiveModel, think: effectiveThink, signal: ac.signal });
      let res = await gen.next();
      while (!res.done) {
        if (firstTokenAt === null) firstTokenAt = Date.now();
        full += res.value;
        await stream.writeSSE({ event: 'delta', data: JSON.stringify({ t: res.value }) });
        res = await gen.next();
      }
      // Assistant-Antwort persistieren (inkl. Quellen als Attachment für Reload).
      if (full.trim()) {
        const atts = [{ kind: 'sources' as const, items: sourcesOrFallback() }];
        addMessage(chat.id, 'assistant', full, atts);
        // Fakten-Extraktion im Hintergrund (blockiert die Antwort nicht).
        void extractAndSaveMemory(user.id, content, full, canGlobalMemory, chat.projectId, hebeChatKlasse(chat.id, klasse));
      }
      await stream.writeSSE({ event: 'sources', data: JSON.stringify({ sources: sourcesOrFallback() }) });
      messen(false, res.value?.evalCount);
      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({ evalCount: res.value?.evalCount ?? 0, totalMs: res.value?.totalMs ?? 0 }),
      });
    } catch (err) {
      if (ac.signal.aborted) {
        // vom Client abgebrochen — Teilantwort sichern, als regulär werten
        if (full.trim()) addMessage(chat.id, 'assistant', full);
        messen(false);
        return;
      }
      messen(true);
      log.error('[Chat] Streaming-Fehler', { chatId: chat.id, error: (err as Error).message });
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: 'Die KI ist gerade nicht erreichbar. Bitte erneut versuchen.' }) });
    }
  });
});
