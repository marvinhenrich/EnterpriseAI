import { extname } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, sqliteConnection as sqlite } from '../db/client.ts';
import { files } from '../db/schema.ts';
import { ocrFile } from './files.ts';
import { indexFile } from './rag.ts';
import { log } from './logger.ts';

// =============================================================================
// Texterkennung im Hintergrund.
//
// Ziel: Der Nutzer soll sich um nichts kümmern. Hochgeladene Scans und Bilder
// werden von selbst lesbar gemacht — ohne dass der Upload darauf wartet
// (eine PDF-Seite kostet mehrere Sekunden, ein 8-Seiter ~20 s).
//
// Bewusst STRENG SERIELL: OCR ist rechenintensiv, und die GPU gehört dem
// Sprachmodell. Ein Nebenlauf würde den Chat spürbar ausbremsen.
// =============================================================================

const OCR_EXTS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff']);

let läuft = false;
const wartend: string[] = [];

/** Kommt für diese Datei überhaupt eine Texterkennung infrage? */
export function istOcrFähig(filename: string, extracted: string | null | undefined): boolean {
  if (!OCR_EXTS.has(extname(filename).toLowerCase())) return false;
  // Textebene bereits vorhanden → nichts zu tun.
  return (extracted ?? '').trim().length < 100;
}

/** Datei zur Verarbeitung vormerken (kehrt sofort zurück). */
export function enqueueOcr(fileId: string): void {
  if (wartend.includes(fileId)) return;
  wartend.push(fileId);
  db.update(files).set({ ocrState: 'pending' }).where(eq(files.id, fileId)).run();
  void arbeite();
}

async function arbeite(): Promise<void> {
  if (läuft) return;
  läuft = true;
  try {
    while (wartend.length > 0) {
      const id = wartend.shift()!;
      const row = db.select().from(files).where(eq(files.id, id)).get();
      if (!row) continue;
      try {
        const res = await ocrFile(row.userId, id);
        if (res.ok && res.text.trim()) {
          db.update(files).set({ ocrState: 'done' }).where(eq(files.id, id)).run();
          await indexFile(id, res.text).catch((err) => log.warn('[OCR-Queue] Indexierung fehlgeschlagen', { id, error: (err as Error).message }));
          log.info('[OCR-Queue] Datei lesbar gemacht', { datei: row.filename, zeichen: res.text.length });
        } else {
          // Kein Text gefunden — nicht endlos erneut versuchen.
          db.update(files).set({ ocrState: 'skipped' }).where(eq(files.id, id)).run();
        }
      } catch (err) {
        db.update(files).set({ ocrState: 'failed' }).where(eq(files.id, id)).run();
        log.warn('[OCR-Queue] Verarbeitung fehlgeschlagen', { id, error: (err as Error).message });
      }
    }
  } finally {
    läuft = false;
  }
}

/**
 * Altbestand nachziehen: alles, was bisher ohne Text liegt, nach und nach lesbar
 * machen. Läuft verzögert und seriell im Hintergrund, damit der Start und der
 * laufende Betrieb nicht darunter leiden.
 */
export function verarbeiteAltbestand(verzögerungMs = 60_000): void {
  setTimeout(() => {
    try {
      const rows = sqlite
        .prepare(
          `SELECT id, filename, extracted_text FROM files
            WHERE (ocr_state IS NULL OR ocr_state = 'pending')
              AND (extracted_text IS NULL OR length(extracted_text) < 100)
            ORDER BY created_at DESC
            LIMIT 200`,
        )
        .all() as { id: string; filename: string; extracted_text: string | null }[];
      const offen = rows.filter((r) => istOcrFähig(r.filename, r.extracted_text));
      // Nicht verarbeitbare Typen einmalig abhaken, damit sie nicht erneut auftauchen.
      for (const r of rows) {
        if (!istOcrFähig(r.filename, r.extracted_text)) {
          db.update(files).set({ ocrState: 'skipped' }).where(eq(files.id, r.id)).run();
        }
      }
      if (offen.length === 0) return;
      log.info('[OCR-Queue] Altbestand wird nachgearbeitet', { dateien: offen.length });
      for (const r of offen) enqueueOcr(r.id);
    } catch (err) {
      log.warn('[OCR-Queue] Altbestand-Prüfung fehlgeschlagen', { error: (err as Error).message });
    }
  }, verzögerungMs);
}

/** Wie viele Dateien warten gerade? (für die Anzeige) */
export function ocrQueueStatus(): { wartend: number; läuft: boolean } {
  return { wartend: wartend.length, läuft };
}
