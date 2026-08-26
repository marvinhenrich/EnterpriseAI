import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { userMemory, globalMemory } from '../db/schema.ts';
import { generateJSON, type ChatMessage } from '../llm/ollama.ts';
import { log } from './logger.ts';
import { darfInsGedaechtnis } from './classification.ts';

// =============================================================================
// Memory: Die KI lernt über den Nutzer.
//   user_memory — privat pro Nutzer (alles erlaubt).
//
// ORGANISATIONSWEITES WISSEN läuft seit 2026-08-11 NICHT mehr über
// `global_memory`, sondern ausschließlich über das Wissens-Vault:
//   - Die alte Lösung spielte die „Top 12 nach Wichtigkeit" in JEDEN Prompt,
//     unabhängig von der Frage → nachweislich eine Quelle für Falschaussagen
//     (2693 ungeprüfte, teils aus Gesprächen abgeleitete „Fakten").
//   - Neu: Fakten landen als Vault-Notiz und werden RELEVANZBASIERT gefunden
//     (semantische Suche) — oder eben gar nicht.
// `global_memory` wird nur noch beschrieben/archiviert, aber nie mehr injiziert.
// Importance: 1 = 7 Tage, 2 = 30 Tage, 3 = dauerhaft.
// =============================================================================

// Stichwort-Backstop: globale Fakten mit diesen Begriffen werden NIE gespeichert.
const SENSITIVE_PATTERNS = [
  /gehalt|lohn|verdien|gehälter|salär/i,
  /passwor[dt]|kennwort|login|zugangsdaten|api[- ]?key|token/i,
  /personalnummer|sozialversicherung|steuer-?id|iban|kontonummer|kreditkart/i,
  /krank|diagnose|gesundheit|schwanger|kündigung|abmahnung|disziplinar/i,
  /privat(adresse|telefon|nummer)|geburtsdatum|home[- ]?address/i,
];

function isSensitive(text: string): boolean {
  return SENSITIVE_PATTERNS.some((p) => p.test(text));
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

// --- Abruf für Kontext-Injektion --------------------------------------------
export function getTopUserMemories(userId: number, limit = 12): string[] {
  return db
    .select({ t: userMemory.memoryText })
    .from(userMemory)
    .where(eq(userMemory.userId, userId))
    .orderBy(desc(userMemory.importance), desc(userMemory.updatedAt))
    .limit(limit)
    .all()
    .map((r) => r.t);
}

/** Baut den Memory-Kontextblock für den System-Prompt. */
export function buildMemoryContext(userId: number): string {
  // BEWUSST nur persönliches Memory. Unternehmenswissen kommt relevanzbasiert
  // aus dem Wissens-Vault (siehe lib/kb.ts retrieveKb) — nicht mehr pauschal.
  const u = getTopUserMemories(userId);
  if (u.length === 0) return '';
  return 'Was du über diesen Nutzer weißt (nur Kontext, keine belegte Quelle):\n' + u.map((m) => `- ${m}`).join('\n');
}

// --- Manuelle Verwaltung (für /api/memory) ----------------------------------
export function listUserMemories(userId: number) {
  return db.select().from(userMemory).where(eq(userMemory.userId, userId)).orderBy(desc(userMemory.updatedAt)).all();
}

export function addUserMemory(userId: number, text: string, importance = 2): void {
  const norm = normalize(text);
  const existing = listUserMemories(userId).find((m) => normalize(m.memoryText) === norm);
  if (existing) return;
  db.insert(userMemory).values({ userId, memoryText: text.trim(), importance }).run();
}

export function deleteUserMemory(userId: number, id: number): boolean {
  return db.delete(userMemory).where(and(eq(userMemory.id, id), eq(userMemory.userId, userId))).run().changes > 0;
}

/**
 * Unternehmensweite Fakten ins Wissens-Vault schreiben (Sammel-Notiz pro Tag).
 * Bewusst als „ungeprüft" markiert: die Fakten sind maschinell aus Gesprächen
 * abgeleitet. Über das Vault werden sie relevanzbasiert gefunden statt pauschal
 * in jeden Prompt gespielt.
 */
async function appendGlobalFactsToVault(facts: string[], userId: number): Promise<void> {
  const { getNoteByTitle, createNote, updateNote } = await import('./vault.ts');
  const day = new Date().toISOString().slice(0, 10);
  const title = `Automatisch gesammelt ${day}`;
  const existing = getNoteByTitle(title);

  // Bereits vorhandene Punkte nicht doppelt aufnehmen.
  const known = new Set(
    (existing?.content ?? '')
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).toLowerCase().replace(/\s+/g, ' ').trim()),
  );
  const fresh = facts.filter((f) => !known.has(f.toLowerCase().replace(/\s+/g, ' ').trim()));
  if (fresh.length === 0) return;

  const header =
    '> **Automatisch aus Gesprächen gesammelt — NICHT von einem Menschen geprüft.**\n' +
    '> Bitte prüfen: Falsches löschen, Bestätigtes in eine saubere Notiz überführen.\n';

  if (existing) {
    await updateNote(existing.id, { content: `${existing.content.trimEnd()}\n${fresh.map((f) => `- ${f}`).join('\n')}\n` }, 'System');
  } else {
    await createNote({
      title,
      content: `${header}\n${fresh.map((f) => `- ${f}`).join('\n')}\n`,
      folder: 'Automatisch gesammelt',
      tags: ['ungeprüft', 'aus-gespräch'],
      userId,
      userName: 'System (Memory)',
    });
  }
  log.info('[Memory] Globale Fakten ins Vault übernommen', { count: fresh.length, title });
}

// --- Extraktion (zweiter LLM-Aufruf, asynchron, nicht-blockierend) ----------
interface ExtractedFacts {
  userFacts?: { text: string; importance?: number }[];
  globalFacts?: { text: string; category?: string; importance?: number }[];
}

const EXTRACT_SYSTEM =
  'Du extrahierst dauerhaft merkenswerte Fakten aus einem Gesprächsabschnitt einer EnterpriseAI. ' +
  'Antworte AUSSCHLIESSLICH mit gültigem JSON, keine Erklärungen.';

/**
 * Extrahiert Fakten aus der letzten Frage+Antwort und speichert sie.
 * Läuft im Hintergrund (await nicht erforderlich). Fehler werden geschluckt.
 */
export async function extractAndSaveMemory(
  userId: number,
  userText: string,
  assistantText: string,
  allowGlobal = true,
  /** Gehört der Chat zu einem Projekt, landen die Fakten DORT — nicht im
   *  firmenweiten Vault. So bleibt jedes Thema für sich (Rückmeldung E&F). */
  projectId?: string | null,
  /** Höchste Einstufung der Unterlagen, die in diesem Gespräch gelesen wurden. */
  klasse: unknown = 'intern',
): Promise<void> {
  if (userText.length < 12) return; // triviale Eingaben überspringen

  // Eingestufte Daten erzeugen ÜBERHAUPT KEINE dauerhaften Fakten — weder
  // firmenweit noch als „Wissen über den Nutzer". Ein aus eines Fachdokuments
  // abgeleiteter Merksatz („arbeitet mit 70 kg Ti-Pure R706") würde sonst in
  // jedem weiteren Gespräch dieses Nutzers auftauchen, auch außerhalb des
  // Projekts. Genau das war die gemeldete Kontamination.
  if (!darfInsGedaechtnis(klasse)) {
    log.info('[Memory] Übersprungen — eingestufte Daten im Gespräch', { userId, klasse: String(klasse) });
    return;
  }
  const prompt = `Gesprächsabschnitt:
[Nutzer]: ${userText.slice(0, 4000)}
[KI]: ${assistantText.slice(0, 4000)}

Extrahiere als JSON mit zwei Arrays:
1. "userFacts": Fakten über DIESEN Nutzer (Rolle, Vorlieben, laufende Projekte, Arbeitsweise, Zuständigkeiten). Format: {"text": "...", "importance": 1-3}. importance 1=kurzfristig, 2=mittelfristig, 3=dauerhaft.
2. "globalFacts": NUR nicht-sensible, unternehmensweite Fakten (Prozesse, Standard-Lieferzeiten, Produktdefinitionen, Abteilungsstruktur, Zuständigkeiten von Abteilungen). Format: {"text": "...", "category": "...", "importance": 1-3}.
   NIEMALS aufnehmen: Gehälter, Personaldaten/Privatdaten Einzelner, Kundendetails, Passwörter, Gesundheitsdaten. Im Zweifel weglassen.
Wenn nichts Merkenswertes: leere Arrays. Antworte nur mit dem JSON-Objekt {"userFacts":[],"globalFacts":[]}.`;

  const messages: ChatMessage[] = [
    { role: 'system', content: EXTRACT_SYSTEM },
    { role: 'user', content: prompt },
  ];

  try {
    const result = await generateJSON<ExtractedFacts>(messages);
    if (!result) return;
    let saved = 0;
    for (const f of result.userFacts ?? []) {
      if (f?.text && f.text.trim().length > 3) {
        addUserMemory(userId, f.text, clampImportance(f.importance, 2));
        saved++;
      }
    }
    const facts = (result.globalFacts ?? [])
      .map((f) => f?.text?.trim())
      .filter((t): t is string => !!t && t.length > 3 && !isSensitive(t));

    if (projectId) {
      // Projekt-Chat: Fakten bleiben im Projekt-Kontext, sichtbar für den Nutzer.
      const { addProjectMemory } = await import('./projects.ts');
      for (const f of facts) if (addProjectMemory(projectId, f, { source: 'auto' })) saved++;
    } else if (allowGlobal && facts.length > 0) {
      // Ohne Projekt: unternehmensweite Fakten ins Wissens-Vault (ungeprüft markiert).
      await appendGlobalFactsToVault(facts, userId);
      saved += facts.length;
    }
    if (saved > 0) log.info('[Memory] Fakten gespeichert', { userId, saved });
  } catch (err) {
    log.warn('[Memory] Extraktion fehlgeschlagen', { error: (err as Error).message });
  }
}

function clampImportance(v: unknown, def: number): number {
  const n = Number(v);
  return n === 1 || n === 2 || n === 3 ? n : def;
}

// --- Cleanup (abgelaufene Einträge) -----------------------------------------
/** Löscht importance-1 (>7 Tage) und importance-2 (>30 Tage). importance 3 bleibt. */
export function cleanupExpiredMemories(): { user: number; global: number } {
  const r1 = db
    .delete(userMemory)
    .where(sql`(importance = 1 AND created_at < datetime('now','-7 days')) OR (importance = 2 AND created_at < datetime('now','-30 days'))`)
    .run();
  // global_memory wird nicht mehr genutzt (Archiv) → kein Cleanup.
  const res = { user: r1.changes, global: 0 };
  if (res.user || res.global) log.info('[Memory] Cleanup', res);
  return res;
}
