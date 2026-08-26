import { Hono } from 'hono';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.ts';
import { createFeedback, listOwnFeedback, FEEDBACK_CATEGORIES } from '../lib/feedback.ts';
import { logAudit, requestMeta } from '../lib/audit.ts';
import type { AppEnv } from '../types.ts';
import { modulAktiv } from '../lib/module.ts';

export const feedbackRoutes = new Hono<AppEnv>();
feedbackRoutes.use('*', authenticate);

// Modul abgeschaltet -> Bereich existiert für den Nutzer nicht. Die Route
// antwortet dann einheitlich mit 404, statt halb zu funktionieren.
feedbackRoutes.use('*', async (c, next) => {
  if (!modulAktiv('feedback')) return c.json({ error: 'Dieser Bereich ist in dieser Installation nicht aktiv.' }, 404);
  await next();
});

const schema = z.object({
  category: z.enum(FEEDBACK_CATEGORIES).default('other'),
  message: z.string().trim().min(1, 'Nachricht erforderlich').max(4000),
  context: z.string().trim().max(200).optional(),
});

// Eigene Rückmeldungen mit Bearbeitungsstand und Antwort.
feedbackRoutes.get('/feedback/mine', (c) => {
  const user = c.get('user');
  return c.json({
    feedback: listOwnFeedback(user.id).map((f) => ({
      id: f.id, category: f.category, message: f.message, status: f.status,
      response: f.response, handledAt: f.handledAt, createdAt: f.createdAt, context: f.context,
    })),
  });
});

// Feedback abgeben — für jeden eingeloggten Nutzer.
feedbackRoutes.post('/feedback', async (c) => {
  const user = c.get('user');
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Ungültige Eingabe' }, 400);
  }
  const { category, message, context } = parsed.data;
  const row = createFeedback({ userId: user.id, username: user.username, category, message, context });
  logAudit({ ...requestMeta(c), action: 'FEEDBACK_SUBMITTED', userId: user.id, username: user.username, resourceType: 'feedback', resourceId: row.id, details: { category } });
  return c.json({ ok: true, feedback: row }, 201);
});
