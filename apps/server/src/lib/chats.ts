import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, sqliteConnection as sqlite } from '../db/client.ts';
import { chats, messages, chatShares, users } from '../db/schema.ts';

export type ChatRow = typeof chats.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type ChatAccess = 'owner' | 'shared';

export function createChat(userId: number, title = 'Neuer Chat', model?: string, projectId?: string | null): ChatRow {
  return db
    .insert(chats)
    .values({ id: randomUUID(), userId, title, model: model ?? null, projectId: projectId ?? null })
    .returning()
    .get();
}

export function listChats(userId: number): ChatRow[] {
  return db.select().from(chats).where(eq(chats.userId, userId)).orderBy(desc(chats.updatedAt)).all();
}

/** Chat nur zurückgeben, wenn er dem User gehört (Zugriffsschutz). */
export function getOwnedChat(userId: number, chatId: string): ChatRow | undefined {
  return db
    .select()
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    .get();
}

export function getMessages(chatId: string): MessageRow[] {
  return db.select().from(messages).where(eq(messages.chatId, chatId)).orderBy(asc(messages.createdAt), asc(messages.id)).all();
}

export function addMessage(
  chatId: string,
  role: 'system' | 'user' | 'assistant',
  content: string,
  attachments?: unknown[],
  senderId?: number,
): MessageRow {
  const row = db
    .insert(messages)
    .values({ chatId, role, content, attachments: attachments ?? null, senderId: senderId ?? null })
    .returning()
    .get();
  db.update(chats).set({ updatedAt: sql`CURRENT_TIMESTAMP` }).where(eq(chats.id, chatId)).run();
  return row;
}

export function renameChat(userId: number, chatId: string, title: string): boolean {
  const res = db
    .update(chats)
    .set({ title, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    .run();
  return res.changes > 0;
}

export function deleteChat(userId: number, chatId: string): boolean {
  const res = db.delete(chats).where(and(eq(chats.id, chatId), eq(chats.userId, userId))).run();
  return res.changes > 0;
}

/**
 * Behält die ersten `keep` Nachrichten (chronologisch) und löscht den Rest.
 * Für „Nachricht bearbeiten" (ab User-Nachricht abschneiden) und „Neu generieren"
 * (alte Antwort verwerfen). Nur für eigene Chats.
 */
export function truncateChatMessages(userId: number, chatId: string, keep: number): boolean {
  if (!getOwnedChat(userId, chatId)) return false;
  const ids = db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .all()
    .map((r) => r.id);
  const toDelete = ids.slice(Math.max(0, keep));
  if (toDelete.length > 0) {
    db.delete(messages).where(and(eq(messages.chatId, chatId), inArray(messages.id, toDelete))).run();
  }
  return true;
}

/** Chat anheften/lösen bzw. archivieren/wiederherstellen (nur eigener Chat). */
export function setChatFlags(userId: number, chatId: string, flags: { pinned?: boolean; archived?: boolean }): boolean {
  const patch: Partial<{ pinned: boolean; archived: boolean }> = {};
  if (typeof flags.pinned === 'boolean') patch.pinned = flags.pinned;
  if (typeof flags.archived === 'boolean') patch.archived = flags.archived;
  if (Object.keys(patch).length === 0) return false;
  const res = db.update(chats).set(patch).where(and(eq(chats.id, chatId), eq(chats.userId, userId))).run();
  return res.changes > 0;
}

/** Erste User-Nachricht → automatischer Chat-Titel (gekürzt). */
export function autoTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 48 ? clean.slice(0, 47) + '…' : clean || 'Neuer Chat';
}

// --- Suche über eigene Chats -------------------------------------------------

export interface ChatSearchHit {
  chatId: string;
  title: string;
  updatedAt: string | null;
  snippet: string; // Textausschnitt rund um den ersten Treffer
  matches: number; // Anzahl passender Nachrichten in diesem Chat
  titleMatch: boolean;
}

/** Baut einen kurzen Ausschnitt rund um die erste Fundstelle (case-insensitiv). */
function buildSnippet(content: string, query: string, radius = 60): string {
  const text = content.replace(/\s+/g, ' ').trim();
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return text.slice(0, radius * 2) + (text.length > radius * 2 ? '…' : '');
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + query.length + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

/** Durchsucht die eigenen Chats (Titel + Nachrichten) nach einem Suchbegriff. */
export function searchOwnChats(userId: number, query: string, limit = 40): ChatSearchHit[] {
  const q = query.trim();
  if (!q) return [];
  // LIKE-Sonderzeichen maskieren, damit % und _ wörtlich gesucht werden.
  const like = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';

  // Passende Nachrichten der eigenen Chats, neueste Chats zuerst.
  const rows = sqlite
    .prepare(
      `SELECT c.id AS chatId, c.title AS title, c.updated_at AS updatedAt, m.content AS content
         FROM messages m
         JOIN chats c ON c.id = m.chat_id
        WHERE c.user_id = ? AND m.role IN ('user','assistant') AND m.content LIKE ? ESCAPE '\\'
        ORDER BY c.updated_at DESC, m.id ASC`,
    )
    .all(userId, like) as Array<{ chatId: string; title: string; updatedAt: string | null; content: string }>;

  const byChat = new Map<string, ChatSearchHit>();
  for (const r of rows) {
    const existing = byChat.get(r.chatId);
    if (existing) {
      existing.matches += 1;
    } else {
      byChat.set(r.chatId, {
        chatId: r.chatId,
        title: r.title,
        updatedAt: r.updatedAt,
        snippet: buildSnippet(r.content, q),
        matches: 1,
        titleMatch: false,
      });
    }
  }

  // Chats, deren Titel passt (auch ohne Nachrichten-Treffer).
  const titleRows = sqlite
    .prepare(
      `SELECT id AS chatId, title, updated_at AS updatedAt
         FROM chats
        WHERE user_id = ? AND title LIKE ? ESCAPE '\\'
        ORDER BY updated_at DESC`,
    )
    .all(userId, like) as Array<{ chatId: string; title: string; updatedAt: string | null }>;

  for (const r of titleRows) {
    const existing = byChat.get(r.chatId);
    if (existing) existing.titleMatch = true;
    else byChat.set(r.chatId, { chatId: r.chatId, title: r.title, updatedAt: r.updatedAt, snippet: '', matches: 0, titleMatch: true });
  }

  return [...byChat.values()]
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, limit);
}

// --- Geteilte Chats (Mehrbenutzer-Threads) ----------------------------------

export interface AccessibleChat {
  chat: ChatRow;
  access: ChatAccess;
  canWrite: boolean;
}

/** Chat, wenn der User Eigentümer ODER Empfänger einer Freigabe ist. */
export function getAccessibleChat(userId: number, chatId: string): AccessibleChat | undefined {
  const chat = db.select().from(chats).where(eq(chats.id, chatId)).get();
  if (!chat) return undefined;
  if (chat.userId === userId) return { chat, access: 'owner', canWrite: true };
  const share = db
    .select()
    .from(chatShares)
    .where(and(eq(chatShares.chatId, chatId), eq(chatShares.userId, userId)))
    .get();
  if (share) return { chat, access: 'shared', canWrite: share.canWrite };
  return undefined;
}

export interface ChatListItem extends ChatRow {
  access: ChatAccess;
  sharedByName: string | null;
}

/** Eigene Chats + mit mir geteilte, nach Aktualität sortiert. */
export function listChatsForUser(userId: number): ChatListItem[] {
  const own: ChatListItem[] = listChats(userId).map((c) => ({ ...c, access: 'owner', sharedByName: null }));

  const shared = db
    .select({ chat: chats, ownerName: users.username })
    .from(chatShares)
    .innerJoin(chats, eq(chats.id, chatShares.chatId))
    .leftJoin(users, eq(users.id, chats.userId))
    .where(eq(chatShares.userId, userId))
    .all()
    .map((r): ChatListItem => ({ ...r.chat, access: 'shared', sharedByName: r.ownerName ?? null }));

  // Angeheftete zuerst, dann nach Aktualität.
  return [...own, ...shared].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
}

/** Teilt einen Chat mit einem Nutzer (nur der Eigentümer darf). */
export function shareChat(ownerId: number, chatId: string, targetUserId: number, canWrite: boolean): boolean {
  const owned = getOwnedChat(ownerId, chatId);
  if (!owned) return false;
  if (targetUserId === ownerId) return false;
  db.insert(chatShares)
    .values({ chatId, userId: targetUserId, canWrite, sharedBy: ownerId })
    .onConflictDoUpdate({ target: [chatShares.chatId, chatShares.userId], set: { canWrite } })
    .run();
  return true;
}

export function unshareChat(ownerId: number, chatId: string, targetUserId: number): boolean {
  const owned = getOwnedChat(ownerId, chatId);
  if (!owned) return false;
  db.delete(chatShares).where(and(eq(chatShares.chatId, chatId), eq(chatShares.userId, targetUserId))).run();
  return true;
}

/** Mit wem ein Chat geteilt ist (für den Eigentümer). */
export function listChatShares(chatId: string): { userId: number; username: string | null; canWrite: boolean }[] {
  return db
    .select({ userId: chatShares.userId, username: users.username, canWrite: chatShares.canWrite })
    .from(chatShares)
    .leftJoin(users, eq(users.id, chatShares.userId))
    .where(eq(chatShares.chatId, chatId))
    .all();
}

/** Sender-Namen für Nachrichten auflösen (Anzeige in geteilten Chats). */
export function resolveSenderNames(rows: MessageRow[]): Map<number, string> {
  const ids = [...new Set(rows.map((m) => m.senderId).filter((x): x is number => x != null))];
  const map = new Map<number, string>();
  for (const id of ids) {
    const u = db.select({ username: users.username }).from(users).where(eq(users.id, id)).get();
    if (u) map.set(id, u.username);
  }
  return map;
}
