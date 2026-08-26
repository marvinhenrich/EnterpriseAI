import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { feedback } from '../db/schema.ts';

export type FeedbackRow = typeof feedback.$inferSelect;
export const FEEDBACK_CATEGORIES = ['bug', 'idea', 'other'] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export function createFeedback(input: {
  userId?: number | null;
  username?: string | null;
  category: FeedbackCategory;
  rating?: number | null;
  message: string;
  context?: string | null;
}): FeedbackRow {
  return db
    .insert(feedback)
    .values({
      userId: input.userId ?? null,
      username: input.username ?? null,
      category: input.category,
      rating: input.rating ?? null,
      message: input.message,
      context: input.context ?? null,
    })
    .returning()
    .get();
}

export type FeedbackStatus = 'open' | 'in_progress' | 'resolved' | 'declined';
export const FEEDBACK_STATUS: FeedbackStatus[] = ['open', 'in_progress', 'resolved', 'declined'];

export function listFeedback(status?: FeedbackStatus): FeedbackRow[] {
  const q = db.select().from(feedback).orderBy(desc(feedback.createdAt));
  return status ? q.where(eq(feedback.status, status)).all() : q.all();
}

/** Rückmeldungen eines Nutzers — damit er den Bearbeitungsstand sieht. */
export function listOwnFeedback(userId: number): FeedbackRow[] {
  return db.select().from(feedback).where(eq(feedback.userId, userId)).orderBy(desc(feedback.createdAt)).all();
}

/** Kennzahlen fürs Admin-Panel: Anzahl je Status und je Kategorie. */
export function feedbackStats(): { byStatus: Record<string, number>; byCategory: Record<string, number>; total: number } {
  const rows = db.select().from(feedback).all();
  const byStatus: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
  }
  return { byStatus, byCategory, total: rows.length };
}

export function countOpenFeedback(): number {
  return db.select({ c: sql<number>`count(*)` }).from(feedback).where(eq(feedback.status, 'open')).get()?.c ?? 0;
}

/** Bearbeitungsstand setzen und optional eine Antwort an den Melder hinterlegen. */
export function updateFeedback(id: number, patch: { status?: FeedbackStatus; response?: string | null }, handledBy: string): boolean {
  const set: Record<string, unknown> = { handledBy, handledAt: new Date().toISOString().slice(0, 19).replace('T', ' ') };
  if (patch.status) set.status = patch.status;
  if (patch.response !== undefined) set.response = patch.response?.trim() || null;
  const res = db.update(feedback).set(set).where(eq(feedback.id, id)).run();
  return res.changes > 0;
}

export function getFeedback(id: number): FeedbackRow | undefined {
  return db.select().from(feedback).where(eq(feedback.id, id)).get();
}

export function deleteFeedback(id: number): boolean {
  return db.delete(feedback).where(and(eq(feedback.id, id))).run().changes > 0;
}
