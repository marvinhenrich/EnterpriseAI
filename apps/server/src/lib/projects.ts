import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, sqliteConnection as sqlite } from '../db/client.ts';
import { projects, chats, files, projectMemory } from '../db/schema.ts';
import { log } from './logger.ts';
import type { FileRow } from './files.ts';

// =============================================================================
// Projekte: bündeln Chats zu einem Vorhaben, mit eigenen Dateien (in jedem Chat
// des Projekts verfügbar) und projektweiten Anweisungen (Zusatz zum System-
// Prompt). Streng pro Nutzer — kein Zugriff auf fremde Projekte.
// =============================================================================

export type ProjectRow = typeof projects.$inferSelect;

export interface ProjectView extends ProjectRow {
  chatCount: number;
  fileCount: number;
}

export function listProjects(userId: number): ProjectView[] {
  const rows = db.select().from(projects).where(eq(projects.userId, userId)).orderBy(desc(projects.updatedAt)).all();
  return rows.map((p) => ({
    ...p,
    chatCount: (sqlite.prepare('SELECT count(*) c FROM chats WHERE project_id = ?').get(p.id) as { c: number }).c,
    fileCount: (sqlite.prepare('SELECT count(*) c FROM files WHERE project_id = ?').get(p.id) as { c: number }).c,
  }));
}

/** Projekt nur zurückgeben, wenn es dem Nutzer gehört (Zugriffsschutz). */
export function getOwnedProject(userId: number, id: string): ProjectRow | undefined {
  return db.select().from(projects).where(and(eq(projects.id, id), eq(projects.userId, userId))).get();
}

export function createProject(userId: number, input: { name: string; description?: string; instructions?: string; color?: string; vaultScope?: string }): ProjectRow {
  const row = db
    .insert(projects)
    .values({
      id: randomUUID(),
      userId,
      name: input.name.trim().slice(0, 120) || 'Neues Projekt',
      description: input.description?.trim().slice(0, 500) ?? null,
      instructions: input.instructions?.trim().slice(0, 4000) ?? null,
      color: input.color ?? null,
      vaultScope: input.vaultScope === 'project' ? 'project' : 'all',
    })
    .returning()
    .get();
  log.info('[Projekte] angelegt', { id: row.id, name: row.name });
  return row;
}

export function updateProject(
  userId: number,
  id: string,
  patch: { name?: string; description?: string | null; instructions?: string | null; color?: string | null; vaultScope?: string },
): ProjectRow | undefined {
  if (!getOwnedProject(userId, id)) return undefined;
  const set: Record<string, unknown> = { updatedAt: sql`CURRENT_TIMESTAMP` };
  if (patch.name !== undefined && patch.name.trim()) set.name = patch.name.trim().slice(0, 120);
  if (patch.description !== undefined) set.description = patch.description?.trim().slice(0, 500) ?? null;
  if (patch.instructions !== undefined) set.instructions = patch.instructions?.trim().slice(0, 4000) ?? null;
  if (patch.color !== undefined) set.color = patch.color;
  if (patch.vaultScope !== undefined) set.vaultScope = patch.vaultScope === 'project' ? 'project' : 'all';
  db.update(projects).set(set).where(eq(projects.id, id)).run();
  return getOwnedProject(userId, id);
}

/**
 * Projekt löschen. Chats bleiben erhalten und werden nur gelöst — sonst wäre
 * ein versehentliches Löschen katastrophal. Projektdateien werden ebenfalls
 * nur entkoppelt (bleiben als normale Dateien bestehen).
 */
export function deleteProject(userId: number, id: string): boolean {
  if (!getOwnedProject(userId, id)) return false;
  db.update(chats).set({ projectId: null }).where(eq(chats.projectId, id)).run();
  db.update(files).set({ projectId: null }).where(eq(files.projectId, id)).run();
  db.delete(projects).where(eq(projects.id, id)).run();
  log.info('[Projekte] gelöscht (Chats/Dateien nur gelöst)', { id });
  return true;
}

/** Chat einem Projekt zuordnen oder lösen (projectId = null). */
export function assignChatToProject(userId: number, chatId: string, projectId: string | null): boolean {
  const chat = db.select().from(chats).where(and(eq(chats.id, chatId), eq(chats.userId, userId))).get();
  if (!chat) return false;
  if (projectId && !getOwnedProject(userId, projectId)) return false;
  db.update(chats).set({ projectId }).where(eq(chats.id, chatId)).run();
  return true;
}

export function listProjectFiles(userId: number, projectId: string) {
  return db.select().from(files).where(and(eq(files.projectId, projectId), eq(files.userId, userId))).all();
}

// --- Projekt-Kontext („Projekt-Memory") --------------------------------------
// Getrennt je Projekt: was in einem Thema gilt, soll ein anderes nicht
// beeinflussen. Für den Nutzer einsehbar und änderbar — kein Blackbox-Speicher.

export type ProjectMemoryRow = typeof projectMemory.$inferSelect;
const MEMORY_LIMIT = 40; // so viele Einträge fließen höchstens in den Prompt

export function listProjectMemory(projectId: string): ProjectMemoryRow[] {
  return db.select().from(projectMemory).where(eq(projectMemory.projectId, projectId)).orderBy(desc(projectMemory.createdAt)).all();
}

/** Eintrag hinzufügen. Doppelte (gleicher Text) werden übersprungen. */
export function addProjectMemory(projectId: string, text: string, opts: { source?: 'auto' | 'manual'; chatId?: string | null; createdBy?: string } = {}): ProjectMemoryRow | undefined {
  const clean = text.trim().slice(0, 1000);
  if (clean.length < 3) return undefined;
  const norm = clean.toLowerCase().replace(/\s+/g, ' ');
  const vorhanden = listProjectMemory(projectId).some((m) => m.text.toLowerCase().replace(/\s+/g, ' ') === norm);
  if (vorhanden) return undefined;
  return db
    .insert(projectMemory)
    .values({ projectId, text: clean, source: opts.source ?? 'auto', chatId: opts.chatId ?? null, createdBy: opts.createdBy ?? null })
    .returning()
    .get();
}

export function updateProjectMemory(id: number, text: string): boolean {
  const clean = text.trim().slice(0, 1000);
  if (!clean) return false;
  return db.update(projectMemory).set({ text: clean, updatedAt: sql`CURRENT_TIMESTAMP` }).where(eq(projectMemory.id, id)).run().changes > 0;
}

export function deleteProjectMemory(id: number): boolean {
  return db.delete(projectMemory).where(eq(projectMemory.id, id)).run().changes > 0;
}

export function getProjectMemoryEntry(id: number): ProjectMemoryRow | undefined {
  return db.select().from(projectMemory).where(eq(projectMemory.id, id)).get();
}

/** Kontextblock aus dem Projekt-Memory für den Prompt. */
export function buildProjectMemory(projectId: string): string {
  const rows = listProjectMemory(projectId).slice(0, MEMORY_LIMIT);
  if (rows.length === 0) return '';
  return (
    `Bisher festgehaltener Projekt-Kontext (nur für dieses Projekt, vom Nutzer einsehbar und änderbar):\n` +
    rows.map((m) => `- ${m.text}`).join('\n')
  );
}

/**
 * Projekt-Kontext für den Prompt: Anweisungen des Projekts.
 * Die Projektdateien werden separat (wie Anhänge) eingespeist.
 */
export function buildProjectInstructions(project: ProjectRow): string {
  const parts: string[] = [];
  if (project.description?.trim()) parts.push(`Worum es geht: ${project.description.trim()}`);
  if (project.instructions?.trim()) parts.push(project.instructions.trim());
  if (parts.length === 0) return '';
  return `Dieser Chat gehört zum Projekt „${project.name}". Beachte durchgehend die folgenden Projektvorgaben:\n${parts.join('\n')}`;
}

/**
 * Referenzdateien des Nutzers — gelten in ALLEN seinen Projekten.
 *
 * Gedacht für fachliche Grundlagen: Die verbindliche Rechenlogik lag nur in
 * einem von fünf Projekten und fehlte genau dort, wo sie gebraucht wurde.
 * Ausschließlich EIGENE Dateien; nichts wird firmenweit geteilt.
 */
export function listReferenceFiles(userId: number): FileRow[] {
  return db
    .select()
    .from(files)
    .where(and(eq(files.userId, userId), eq(files.userScope, 1)))
    .all();
}
