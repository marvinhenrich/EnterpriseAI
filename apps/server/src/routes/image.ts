import { Hono } from 'hono';
import { z } from 'zod';
import { authenticate, requirePermission } from '../middleware/auth.ts';
import { env } from '../config/env.ts';
import { log } from '../lib/logger.ts';
import { enqueue, listImages, myActiveJobs, queueState, getJob, deleteImage, readImageFile } from '../lib/imagegen.ts';
import { logAudit, requestMeta } from '../lib/audit.ts';
import type { AppEnv } from '../types.ts';
import { modulAktiv } from '../lib/module.ts';

// Bildgenerierung — persistente Job-Queue über den lokalen mflux-Dienst (127.0.0.1,
// rein intern, kein Outbound). Gegated durch 'image.generate'. Eine GPU → ein Job
// gleichzeitig; alle sehen den Queue-Status. Bilder werden gespeichert (Galerie).

export const imageRoutes = new Hono<AppEnv>();
imageRoutes.use('*', authenticate);

// Modul abgeschaltet -> Bereich existiert für den Nutzer nicht. Die Route
// antwortet dann einheitlich mit 404, statt halb zu funktionieren.
imageRoutes.use('*', async (c, next) => {
  if (!modulAktiv('imagegen')) return c.json({ error: 'Dieser Bereich ist in dieser Installation nicht aktiv.' }, 404);
  await next();
});

const genSchema = z.object({
  prompt: z.string().min(1).max(2000),
  model: z.enum(['turbo']).default('turbo'),
  width: z.coerce.number().int().min(256).max(1536).optional(),
  height: z.coerce.number().int().min(256).max(1536).optional(),
  steps: z.coerce.number().int().min(1).max(50).optional(),
  guidance: z.coerce.number().min(0).max(20).optional(),
  seed: z.coerce.number().int().optional(),
  negative_prompt: z.string().max(1000).optional(),
  reference: z.string().max(12_000_000).optional(), // base64-PNG (img2img / Inpainting-Original)
  mask: z.string().max(12_000_000).optional(), // base64-PNG (Inpainting: weiß = ändern)
  imageStrength: z.coerce.number().min(0.05).max(0.95).optional(),
});

// Verfügbarkeit + Modelle.
imageRoutes.get('/image/models', requirePermission('image.generate'), async (c) => {
  if (!env.IMAGEGEN_ENABLED) return c.json({ enabled: false, models: [] });
  try {
    const res = await fetch(`${env.IMAGEGEN_URL}/health`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return c.json({ enabled: false, models: [] });
    const data = (await res.json()) as { models?: Record<string, { label: string; steps: number }> };
    const models = Object.entries(data.models ?? {}).map(([key, v]) => ({ key, label: v.label, steps: v.steps }));
    return c.json({ enabled: true, models });
  } catch {
    return c.json({ enabled: false, models: [] });
  }
});

// Generierung in die Queue stellen (non-blocking) → jobId + Position.
imageRoutes.post('/image/generate', requirePermission('image.generate'), async (c) => {
  if (!env.IMAGEGEN_ENABLED) return c.json({ error: 'Bildgenerierung ist nicht aktiviert' }, 503);
  const parsed = genSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'prompt erforderlich' }, 400);
  const user = c.get('user');
  const { id, position } = enqueue(user.id, user.username, parsed.data);
  log.info('[Image] eingereiht', { user: user.username, model: parsed.data.model, position });
  return c.json({ id, position }, 202);
});

// Galerie (eigene fertige Bilder) + aktive Jobs + globaler Queue-Status.
imageRoutes.get('/image/list', requirePermission('image.generate'), (c) => {
  const user = c.get('user');
  return c.json({ images: listImages(user.id), active: myActiveJobs(user.id), queue: queueState(user.id) });
});

// Nur Live-Status (häufiges Polling, leicht).
imageRoutes.get('/image/queue', requirePermission('image.generate'), (c) => {
  const user = c.get('user');
  return c.json({ active: myActiveJobs(user.id), queue: queueState(user.id) });
});

// Einzelner Job (Status).
imageRoutes.get('/image/:id', requirePermission('image.generate'), (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const j = id ? getJob(user.id, id) : null;
  if (!j) return c.json({ error: 'Job nicht gefunden' }, 404);
  return c.json({ id: j.id, status: j.status, prompt: j.prompt, model: j.model, seed: j.seed, width: j.width, height: j.height, ms: j.ms, error: j.error });
});

// Bilddatei ausliefern (nur Eigentümer).
imageRoutes.get('/image/:id/file', requirePermission('image.generate'), (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const j = id ? getJob(user.id, id) : null;
  if (!j || j.status !== 'done' || !j.imagePath) return c.json({ error: 'Bild nicht gefunden' }, 404);
  const buf = readImageFile(j.imagePath);
  if (!buf) return c.json({ error: 'Bilddatei fehlt' }, 404);
  return new Response(buf, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=86400' } });
});

imageRoutes.delete('/image/:id', requirePermission('image.generate'), (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!id || !deleteImage(user.id, id)) return c.json({ error: 'Bild nicht gefunden' }, 404);
  logAudit({ ...requestMeta(c), userId: user.id, username: user.username, action: 'IMAGE_DELETED', resourceType: 'image', resourceId: id });
  return c.json({ ok: true });
});
