import { Hono } from 'hono';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.ts';
import { listUserMemories, addUserMemory, deleteUserMemory } from '../lib/memory.ts';
import { logAudit, requestMeta } from '../lib/audit.ts';
import type { AppEnv } from '../types.ts';

export const memoryRoutes = new Hono<AppEnv>();
memoryRoutes.use('*', authenticate);

// Eigene Memories anzeigen.
memoryRoutes.get('/memory', (c) => {
  const user = c.get('user');
  return c.json({ memories: listUserMemories(user.id) });
});

// Memory manuell hinzufügen.
const addSchema = z.object({ text: z.string().min(3), importance: z.number().int().min(1).max(3).optional() });
memoryRoutes.post('/memory', async (c) => {
  const user = c.get('user');
  const parsed = addSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'text erforderlich' }, 400);
  addUserMemory(user.id, parsed.data.text, parsed.data.importance ?? 2);
  logAudit({ ...requestMeta(c), userId: user.id, username: user.username, action: 'MEMORY_ADDED', resourceType: 'memory', details: { text: parsed.data.text } });
  return c.json({ ok: true }, 201);
});

// Eigenes Memory löschen.
memoryRoutes.delete('/memory/:id', (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  if (!deleteUserMemory(user.id, id)) return c.json({ error: 'Nicht gefunden' }, 404);
  logAudit({ ...requestMeta(c), userId: user.id, username: user.username, action: 'MEMORY_DELETED', resourceType: 'memory', resourceId: id });
  return c.json({ ok: true });
});
