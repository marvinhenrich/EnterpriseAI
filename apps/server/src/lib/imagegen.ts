import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { imageJobs } from '../db/schema.ts';
import { env } from '../config/env.ts';
import { log } from './logger.ts';

// =============================================================================
// Bildgenerierung — persistente Job-Queue. Eine GPU → EIN Worker, FIFO. Jobs +
// erzeugte Bilder werden gespeichert (Galerie übersteht Reload/Neustart).
// Rein intern: spricht nur den lokalen mflux-Dienst (IMAGEGEN_URL).
// =============================================================================

const IMAGES_DIR = resolve(process.cwd(), 'data/images');
mkdirSync(IMAGES_DIR, { recursive: true });

export interface GenParams {
  prompt: string;
  model: 'turbo';
  width?: number;
  height?: number;
  steps?: number;
  guidance?: number;
  seed?: number;
  negative_prompt?: string;
  reference?: string; // base64-PNG (img2img / Inpainting-Original), optional
  mask?: string; // base64-PNG (Inpainting: weiß = ändern), optional
  imageStrength?: number; // mflux-Stärke (hoch = näher am Original)
}

let working = false;

export function enqueue(userId: number, userName: string, p: GenParams): { id: string; position: number } {
  const id = randomUUID();
  let refPath: string | undefined;
  if (p.reference) {
    refPath = join(IMAGES_DIR, `ref-${id}.png`);
    writeFileSync(refPath, Buffer.from(p.reference, 'base64'));
  }
  let maskPath: string | undefined;
  if (p.reference && p.mask) {
    maskPath = join(IMAGES_DIR, `mask-${id}.png`);
    writeFileSync(maskPath, Buffer.from(p.mask, 'base64'));
  }
  db.insert(imageJobs).values({
    id, userId, userName, prompt: p.prompt, model: p.model,
    width: p.width, height: p.height, steps: p.steps, seed: p.seed, negativePrompt: p.negative_prompt,
    refPath, maskPath,
    // Stärke nur für klassisches Bild-zu-Bild (ohne Maske); Inpainting ignoriert sie.
    imageStrength: p.reference && !p.mask ? (p.imageStrength ?? 0.45) : null,
    status: 'queued',
  }).run();
  const position = db.select({ c: sql<number>`count(*)` }).from(imageJobs).where(sql`status IN ('queued','running')`).get()?.c ?? 1;
  void runWorker();
  return { id, position };
}

async function generateOne(body: Record<string, unknown>): Promise<{ buffer: Buffer; seed?: number; ms?: number }> {
  const res = await fetch(`${env.IMAGEGEN_URL}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(env.IMAGEGEN_TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => ({}))) as { image_base64?: string; error?: string; ms?: number; seed?: number };
  if (!res.ok || !data.image_base64) throw new Error(data.error ?? 'Bildgenerierung fehlgeschlagen');
  return { buffer: Buffer.from(data.image_base64, 'base64'), seed: data.seed, ms: data.ms };
}

async function runWorker(): Promise<void> {
  if (working) return;
  working = true;
  try {
    for (;;) {
      const job = db.select().from(imageJobs).where(eq(imageJobs.status, 'queued')).orderBy(asc(imageJobs.createdAt)).limit(1).get();
      if (!job) break;
      db.update(imageJobs).set({ status: 'running', startedAt: sql`CURRENT_TIMESTAMP` }).where(eq(imageJobs.id, job.id)).run();
      try {
        const body: Record<string, unknown> = {
          prompt: job.prompt, model: job.model,
          width: job.width ?? undefined, height: job.height ?? undefined, steps: job.steps ?? undefined,
          seed: job.seed ?? undefined, negative_prompt: job.negativePrompt ?? undefined,
        };
        if (job.refPath && existsSync(job.refPath)) {
          body.reference = readFileSync(job.refPath).toString('base64');
          if (job.imageStrength != null) body.image_strength = job.imageStrength;
        }
        if (job.maskPath && existsSync(job.maskPath)) {
          body.mask = readFileSync(job.maskPath).toString('base64'); // → Inpainting im Dienst
        }
        const { buffer, seed, ms } = await generateOne(body);
        const path = join(IMAGES_DIR, `${job.id}.png`);
        writeFileSync(path, buffer);
        db.update(imageJobs).set({ status: 'done', imagePath: path, seed: seed ?? job.seed, ms, finishedAt: sql`CURRENT_TIMESTAMP` }).where(eq(imageJobs.id, job.id)).run();
        log.info('[Image] fertig', { job: job.id, user: job.userName, model: job.model, ms });
      } catch (err) {
        db.update(imageJobs).set({ status: 'failed', error: (err as Error).message, finishedAt: sql`CURRENT_TIMESTAMP` }).where(eq(imageJobs.id, job.id)).run();
        log.warn('[Image] Job fehlgeschlagen', { job: job.id, error: (err as Error).message });
      }
    }
  } finally {
    working = false;
  }
}

// Galerie: fertige Bilder eines Nutzers (neueste zuerst).
export function listImages(userId: number, limit = 60) {
  return db.select().from(imageJobs)
    .where(and(eq(imageJobs.userId, userId), eq(imageJobs.status, 'done')))
    .orderBy(desc(imageJobs.createdAt)).limit(limit).all()
    .map((j) => ({ id: j.id, prompt: j.prompt, model: j.model, seed: j.seed, width: j.width, height: j.height, ms: j.ms, createdAt: j.createdAt }));
}

// Eigene aktive/letzte Jobs (queued/running/failed) zum Verfolgen der Übermittlung.
export function myActiveJobs(userId: number) {
  return db.select().from(imageJobs)
    .where(and(eq(imageJobs.userId, userId), sql`status IN ('queued','running','failed')`))
    .orderBy(desc(imageJobs.createdAt)).limit(20).all()
    .map((j) => ({ id: j.id, status: j.status, prompt: j.prompt, model: j.model, error: j.error, createdAt: j.createdAt }));
}

function elapsed(ts: string | null): number | null {
  if (!ts) return null;
  return Math.max(0, Math.round((Date.now() - new Date(ts.replace(' ', 'T') + 'Z').getTime()) / 1000));
}

// Globaler Queue-Status (eine GPU, für alle sichtbar — „der Topf").
export function queueState(userId: number) {
  const running = db.select().from(imageJobs).where(eq(imageJobs.status, 'running')).orderBy(asc(imageJobs.startedAt)).limit(1).get();
  const queuedCount = db.select({ c: sql<number>`count(*)` }).from(imageJobs).where(eq(imageJobs.status, 'queued')).get()?.c ?? 0;
  const myQueued = db.select({ c: sql<number>`count(*)` }).from(imageJobs).where(and(eq(imageJobs.userId, userId), eq(imageJobs.status, 'queued'))).get()?.c ?? 0;
  return {
    running: running ? { id: running.id, userName: running.userName, prompt: running.prompt, model: running.model, elapsedSec: elapsed(running.startedAt), mine: running.userId === userId } : null,
    queuedCount, myQueued,
  };
}

export function getJob(userId: number, id: string) {
  const j = db.select().from(imageJobs).where(eq(imageJobs.id, id)).get();
  if (!j || j.userId !== userId) return null;
  return j;
}

export function deleteImage(userId: number, id: string): boolean {
  const j = getJob(userId, id);
  if (!j) return false;
  if (j.imagePath && existsSync(j.imagePath)) try { unlinkSync(j.imagePath); } catch { /* egal */ }
  if (j.refPath && existsSync(j.refPath)) try { unlinkSync(j.refPath); } catch { /* egal */ }
  if (j.maskPath && existsSync(j.maskPath)) try { unlinkSync(j.maskPath); } catch { /* egal */ }
  db.delete(imageJobs).where(eq(imageJobs.id, id)).run();
  return true;
}

export function readImageFile(path: string): Buffer | null {
  try { return readFileSync(path); } catch { return null; }
}

// Beim Start verbliebene queued-Jobs weiterverarbeiten (Resume).
void runWorker();
