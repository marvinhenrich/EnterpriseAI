import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWorker, type Worker } from 'tesseract.js';
import { log } from './logger.ts';
import { serverPfad, projektWurzel } from '../config/pfade.ts';

const run = promisify(execFile);

// =============================================================================
// OCR (Texterkennung) für Scans/Bilder. STRIKT OFFLINE: Sprachmodelle liegen
// lokal in apps/server/ocr-data (deu+eng), langPath/cachePath zeigen dorthin —
// tesseract.js macht KEINEN Netzwerk-Aufruf. Worker/Core kommen aus node_modules.
// =============================================================================

const LANG = 'deu+eng';
const OCR_DATA = serverPfad('ocr-data');

let workerPromise: Promise<Worker> | null = null;
let queue: Promise<unknown> = Promise.resolve(); // OCR seriell (ein Worker)

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker(LANG, 1, {
      langPath: OCR_DATA,
      cachePath: OCR_DATA,
      gzip: true,
      logger: () => {},
    }).then((w) => {
      log.info('[OCR] Worker bereit (offline, deu+eng)');
      return w;
    });
  }
  return workerPromise;
}

/** OCR auf einem Bild-Buffer. Offline, serialisiert. Gibt erkannten Text zurück. */
export async function ocrImage(buffer: Buffer): Promise<string> {
  const run = queue.then(async () => {
    try {
      const worker = await getWorker();
      const { data } = await worker.recognize(buffer);
      return (data.text ?? '').replace(/\n{3,}/g, '\n\n').trim();
    } catch (err) {
      log.warn('[OCR] Erkennung fehlgeschlagen', { error: (err as Error).message });
      return '';
    }
  });
  queue = run.catch(() => {});
  return run;
}


// --- Gescannte PDFs ----------------------------------------------------------
// Sicherheitsdatenblätter und Patente liegen oft als reiner Scan vor: PDF ohne
// Textebene. Für die KI sind sie damit unsichtbar. Deshalb Seiten rendern
// (PyMuPDF aus der vorhandenen ML-Umgebung) und per OCR lesen — rein lokal.

const PY = join(projektWurzel(), 'services/imagegen/venv/bin/python');
const RENDER_SCRIPT = join(projektWurzel(), 'scripts/pdf-to-images.py');

/** Hat das PDF überhaupt eine nutzbare Textebene? */
export function needsPdfOcr(extracted: string | null | undefined): boolean {
  return (extracted ?? '').trim().length < 100;
}

/**
 * OCR über ein gescanntes PDF. Seitenzahl bewusst begrenzt — jede Seite kostet
 * mehrere Sekunden, und für den Inhalt genügen in aller Regel die ersten Seiten.
 */
export async function ocrPdf(pdfPath: string, maxSeiten = 12): Promise<string> {
  if (!existsSync(PY) || !existsSync(RENDER_SCRIPT)) {
    log.warn('[OCR] PDF-Rendering nicht verfügbar', { py: existsSync(PY), script: existsSync(RENDER_SCRIPT) });
    return '';
  }
  const dir = mkdtempSync(join(tmpdir(), 'pdfocr-'));
  try {
    const { stdout } = await run(PY, [RENDER_SCRIPT, pdfPath, dir, String(maxSeiten), '200'], {
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const seiten = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    if (seiten.length === 0) return '';

    const teile: string[] = [];
    for (const [i, bild] of seiten.entries()) {
      const text = await ocrImage(readFileSync(bild));
      if (text.trim()) teile.push(`--- Seite ${i + 1} ---\n${text.trim()}`);
    }
    log.info('[OCR] PDF gelesen', { seiten: seiten.length, zeichen: teile.join('').length });
    return teile.join('\n\n');
  } catch (err) {
    log.warn('[OCR] PDF-Erkennung fehlgeschlagen', { pdf: pdfPath, error: (err as Error).message });
    return '';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
