import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { env, isAdConfigured } from './config/env.ts';
import { testAdConnection } from './auth/ad.ts';
import { listModels } from './llm/ollama.ts';
import { authRoutes } from './routes/auth.ts';
import { chatRoutes } from './routes/chat.ts';
import { fileRoutes } from './routes/files.ts';
import { memoryRoutes } from './routes/memory.ts';
import { kbRoutes } from './routes/kb.ts';
import { exportRoutes } from './routes/export.ts';
import { imageRoutes } from './routes/image.ts';
import { labelRoutes } from './routes/labels.ts';
import { feedbackRoutes } from './routes/feedback.ts';
import { projectRoutes } from './routes/projects.ts';
import { adminRoutes } from './routes/admin.ts';
import { configRoutes } from './routes/config.ts';
import { getMaintenance } from './lib/settings.ts';
import { verarbeiteAltbestand } from './lib/ocr-queue.ts';
import type { AppEnv } from './types.ts';

// Hono-App-Aufbau, getrennt vom Server-Bootstrap (index.ts). Wird von index.ts
// ERST NACH dem Privilege-Drop dynamisch importiert, damit die DB-Verbindung
// (db/client.ts, via Routen) als unprivilegierter Nutzer geöffnet wird.

export const app = new Hono<AppEnv>();

app.use('/api/*', cors());

// --- Health / Diagnose -------------------------------------------------------
app.get('/api/health', (c) =>
  c.json({ status: 'ok', service: 'enterpriseai', adConfigured: isAdConfigured, model: env.OLLAMA_MODEL, time: new Date().toISOString() }),
);
app.get('/api/health/ad', async (c) => {
  const result = await testAdConnection();
  return c.json(result, result.ok ? 200 : 503);
});
app.get('/api/models', async (c) => c.json({ models: await listModels(), default: env.OLLAMA_MODEL }));
app.get('/api/maintenance', (c) => c.json(getMaintenance()));

// --- API-Routen --------------------------------------------------------------
// ZUERST: Erscheinungsbild und Modulzustand. Muss vor den übrigen /api-Routern
// stehen — chatRoutes legt ein authenticate auf '*', das sonst auch den
// Anmeldebildschirm abweisen würde, der das Logo noch ohne Token braucht.
app.route('/api', configRoutes);
app.route('/api/auth', authRoutes);
app.route('/api', chatRoutes);
app.route('/api', fileRoutes);
app.route('/api', memoryRoutes);
app.route('/api', kbRoutes);
app.route('/api', exportRoutes);
app.route('/api', imageRoutes);
app.route('/api', labelRoutes);
app.route('/api', feedbackRoutes);
app.route('/api', projectRoutes);
app.route('/api/admin', adminRoutes);

// Dateien ohne Textebene nach und nach lesbar machen (verzögert, seriell,
// im Hintergrund) — der Nutzer soll sich darum nicht kümmern müssen.
verarbeiteAltbestand();

// --- SPA-Auslieferung (gebautes React-Frontend, apps/web/dist) --------------
const WEB_DIST = '../web/dist';
app.use('/assets/*', serveStatic({ root: WEB_DIST }));
app.use('/*', serveStatic({ root: WEB_DIST }));
app.get('*', serveStatic({ path: `${WEB_DIST}/index.html` }));
