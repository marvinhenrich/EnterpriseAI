import { mkdirSync, createReadStream, existsSync } from 'node:fs';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { extractText, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { db } from '../db/client.ts';
import { files } from '../db/schema.ts';
import { env } from '../config/env.ts';
import { log } from './logger.ts';

export type FileRow = typeof files.$inferSelect;

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

function uploadRoot(): string {
  const dir = resolve(process.cwd(), env.UPLOAD_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}


/**
 * Excel-2003-XML („SpreadsheetML") in eine lesbare Tabelle wandeln.
 *
 * Solche Dateien kommen z. B. aus ERP-Exporten (Fertigungsunterlagen,
 * Fachdokumenten). Roh betrachtet bestehen sie zu rund 90 % aus Markup — die
 * eigentlichen Werte gehen darin unter, und die KI liest sie faktisch nicht.
 * Hier wird daraus dasselbe Tab-Format erzeugt wie bei echten Excel-Dateien.
 *
 * Gibt null zurück, wenn es sich nicht um SpreadsheetML handelt.
 */
/** XML-Entities auflösen — von SpreadsheetML und WordprocessingML genutzt. */
const entity = (v: string): string =>
  v
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

export function parseSpreadsheetML(xml: string): string | null {
  if (!/urn:schemas-microsoft-com:office:spreadsheet/.test(xml)) return null;

  const lines: string[] = [];
  // Namensraum-Präfix ist nicht festgelegt (<Worksheet> oder <ss:Worksheet>).
  const sheetRe = /<(?:\w+:)?Worksheet[^>]*?(?:ss:)?Name="([^"]*)"[^>]*>([\s\S]*?)<\/(?:\w+:)?Worksheet>/g;
  let sheet: RegExpExecArray | null;
  let gefunden = 0;

  while ((sheet = sheetRe.exec(xml)) !== null) {
    gefunden++;
    lines.push(`# Tabelle: ${entity(sheet[1] ?? '')}`);
    const rowRe = /<(?:\w+:)?Row[^>]*>([\s\S]*?)<\/(?:\w+:)?Row>/g;
    let row: RegExpExecArray | null;
    while ((row = rowRe.exec(sheet[2] ?? '')) !== null) {
      const zellen: string[] = [];
      const cellRe = /<(?:\w+:)?Cell([^>]*)>([\s\S]*?)<\/(?:\w+:)?Cell>|<(?:\w+:)?Cell([^>]*)\/>/g;
      let cell: RegExpExecArray | null;
      let spalte = 0;
      while ((cell = cellRe.exec(row[1] ?? '')) !== null) {
        const attrs = cell[1] ?? cell[3] ?? '';
        // ss:Index überspringt leere Spalten — sonst verrutscht die Tabelle.
        const idx = /(?:ss:)?Index="(\d+)"/.exec(attrs);
        if (idx) {
          const ziel = Number(idx[1]) - 1;
          while (spalte < ziel) { zellen.push(''); spalte++; }
        }
        const data = /<(?:\w+:)?Data[^>]*>([\s\S]*?)<\/(?:\w+:)?Data>/.exec(cell[2] ?? '');
        zellen.push(data ? entity(data[1] ?? '').replace(/\s+/g, ' ').trim() : '');
        spalte++;
        // Verbundene Zellen als Leerspalten mitführen.
        const merge = /(?:ss:)?MergeAcross="(\d+)"/.exec(attrs);
        if (merge) for (let i = 0; i < Number(merge[1]); i++) { zellen.push(''); spalte++; }
      }
      // Komplett leere Zeilen weglassen — sie blähen den Kontext nur auf.
      if (zellen.some((z) => z !== '')) lines.push(zellen.join('\t').replace(/\t+$/, ''));
    }
  }
  return gefunden > 0 ? lines.join('\n') : null;
}

/**
 * WordprocessingML (Word-2003-XML) in Text wandeln.
 *
 * Diese Dateien tragen die Endung .doc, sind aber kein Binär-Word, sondern XML —
 * so exportieren ERP-Systeme ihre Ansichten (z. B. Fertigungsunterlagen). mammoth
 * kann damit nichts anfangen, also lag der Text bisher unerreichbar herum.
 *
 * Sequenzieller Scan statt verschachtelter Regex: <w:p> steckt in <w:tc>, und
 * ineinandergreifende Muster vertragen sich nicht mit non-greedy Ausdrücken.
 */
export function parseWordML(xml: string): string | null {
  if (!/<w:(?:wordDocument|body)\b/.test(xml)) return null;
  const body = /<w:body[^>]*>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;

  const tok = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(?:br|tab)\b[^>]*\/?>|<\/w:(p|tc|tr)>/g;
  const puffer: string[] = []; // Text der laufenden Zelle/des laufenden Absatzes
  const zellen: string[] = []; // Zellen der laufenden Tabellenzeile
  const zeilen: string[] = [];

  const zelleAbschliessen = (): void => {
    const s = puffer.join('').trim();
    puffer.length = 0;
    if (s) zellen.push(s);
  };

  let m: RegExpExecArray | null;
  while ((m = tok.exec(body)) !== null) {
    if (m[1] !== undefined) { puffer.push(entity(m[1])); continue; }
    switch (m[2]) {
      case 'tc':
        zelleAbschliessen();
        break;
      case 'tr':
        zelleAbschliessen();
        if (zellen.length) { zeilen.push(zellen.join('\t')); zellen.length = 0; }
        break;
      case 'p':
        // Absatzende außerhalb einer Tabelle beendet die Zeile, innerhalb
        // einer Zelle trennt es nur die Textteile.
        if (zellen.length === 0) {
          const s = puffer.join('').trim();
          puffer.length = 0;
          if (s) zeilen.push(s);
        } else if (puffer.length) puffer.push(' ');
        break;
      default:
        puffer.push(' '); // <w:br/> oder <w:tab/>
    }
  }
  zelleAbschliessen();
  if (zellen.length) zeilen.push(zellen.join('\t'));

  const text = zeilen.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > 0 ? text : null;
}

/**
 * Echtes Binär-Word (.doc, OLE-Container) über textutil lesen — macOS-Bordmittel,
 * offline, ohne zusätzliche Abhängigkeit.
 */
async function extractBinaryDoc(buffer: Buffer, ext: string): Promise<string> {
  // textutil braucht einen Pfad und richtet sich nach der Endung.
  return mitTempDatei(buffer, ext, (pfad) => laufe('/usr/bin/textutil', ['-convert', 'txt', '-stdout', pfad], 30_000));
}

// Klartext-Formate inkl. Quellcode und Formelsatz. Rückmeldung aus der
// Forschung: .py ließ sich nicht hochladen, LaTeX für Formeln fehlte.
const TEXT_EXTS = [
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.xml', '.html', '.htm', '.yaml', '.yml', '.ini', '.cfg', '.toml',
  '.py', '.ipynb', '.r', '.m', '.jl', '.sql', '.js', '.ts', '.tsx', '.jsx', '.sh', '.ps1', '.bat',
  '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.go', '.rs', '.php', '.rb', '.vba', '.bas', '.cls', '.frm',
  '.tex', '.bib', '.mol', '.sdf', '.cif',
];

/**
 * Dateityp am INHALT erkennen, nicht am Namen.
 *
 * Die Endung lügt in der Praxis regelmäßig: Das ERP exportiert SpreadsheetML
 * als „.xls" und WordprocessingML als „.doc", beides ist in Wahrheit XML. Sechs
 * Dateien im Bestand galten allein deshalb als unlesbar — sie landeten im
 * ExcelJS-Zweig, der an XML scheitert. Umgekehrt kommen Exporte ganz ohne
 * Endung vor. Die Signatur ist die verlässlichere Auskunft.
 */
type Signatur = 'pdf' | 'zip' | 'ole' | 'spreadsheetml' | 'wordml' | 'xml' | 'text' | 'unbekannt';

function erkenneSignatur(buffer: Buffer): Signatur {
  if (buffer.length < 4) return 'unbekannt';
  const magic = buffer.subarray(0, 8);
  if (magic.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  // OLE2/CFB — altes Word, Excel, PowerPoint (D0 CF 11 E0 A1 B1 1A E1).
  if (magic.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1') return 'ole';
  // ZIP — auch xlsx/docx/pptx sind ZIP-Container.
  if (magic[0] === 0x50 && magic[1] === 0x4b && (magic[2] === 0x03 || magic[2] === 0x05 || magic[2] === 0x07)) return 'zip';

  const kopf = buffer.subarray(0, 8192).toString('utf8');
  if (/^﻿?\s*<\?xml/.test(kopf) || kopf.trimStart().startsWith('<?xml')) {
    if (/urn:schemas-microsoft-com:office:spreadsheet/.test(kopf)) return 'spreadsheetml';
    if (/<w:wordDocument|progid="Word\.Document"/.test(kopf)) return 'wordml';
    return 'xml';
  }
  // Binär oder Text? Nullbytes im Kopf sprechen für binär.
  return buffer.subarray(0, 2048).includes(0) ? 'unbekannt' : 'text';
}

/** Kurzlebige Kopie im Temp-Verzeichnis — für Werkzeuge, die einen Pfad brauchen. */
async function mitTempDatei<T>(buffer: Buffer, ext: string, fn: (pfad: string) => Promise<T>): Promise<T> {
  const { tmpdir } = await import('node:os');
  const tmp = join(tmpdir(), `ki-${randomUUID()}${ext}`);
  await writeFile(tmp, buffer);
  try {
    return await fn(tmp);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

async function laufe(cmd: string, args: string[], timeout = 60_000): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { stdout } = await promisify(execFile)(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout });
  return stdout;
}

/**
 * Altes Binär-Excel (.xls, BIFF/OLE) über das Python-venv lesen.
 * ExcelJS beherrscht nur das ZIP-basierte .xlsx.
 */
async function extractLegacyXls(buffer: Buffer): Promise<string> {
  return mitTempDatei(buffer, '.xls', (pfad) =>
    laufe(resolve(process.cwd(), '../../services/imagegen/venv/bin/python'), [
      resolve(process.cwd(), '../../scripts/xls-to-text.py'),
      pfad,
    ], 120_000),
  );
}

/** Textdateien aus einem ZIP-Archiv zusammenführen (z. B. exportierter VBA-Code). */
async function extractZip(buffer: Buffer, filename: string): Promise<string> {
  return mitTempDatei(buffer, '.zip', async (pfad) => {
    // unzip als Bordmittel — kein zusätzliches Paket im Server.
    const liste = (await laufe('/usr/bin/unzip', ['-Z1', pfad]))
      .split('\n')
      .map((z) => z.trim())
      .filter((z) => z && !z.endsWith('/'));

    const teile: string[] = [];
    let laenge = 0;
    let uebersprungen = 0;
    for (const eintrag of liste) {
      if (!TEXT_EXTS.includes(extname(eintrag).toLowerCase())) { uebersprungen++; continue; }
      const inhalt = await laufe('/usr/bin/unzip', ['-p', pfad, eintrag]).catch(() => '');
      if (!inhalt.trim()) continue;
      teile.push(`# ${eintrag}\n${inhalt}`);
      laenge += inhalt.length;
      if (laenge > 400_000) { teile.push('# … weitere Einträge abgeschnitten'); break; }
    }
    if (teile.length === 0) {
      log.info('[Files] ZIP ohne lesbare Textdateien', { filename, eintraege: liste.length });
      return '';
    }
    if (uebersprungen) teile.push(`# ${uebersprungen} weitere Einträge ohne Textformat übersprungen`);
    return teile.join('\n\n');
  });
}

/** Extrahiert Text je nach Dateityp. Bei Bildern/Unbekanntem: leerer String. */
export async function extractFileText(buffer: Buffer, filename: string): Promise<string> {
  const ext = extname(filename).toLowerCase();
  const sig = erkenneSignatur(buffer);
  try {
    // --- Inhaltsbasiert, hat Vorrang vor der Endung ---------------------------
    if (sig === 'spreadsheetml') {
      const t = parseSpreadsheetML(buffer.toString('utf8'));
      if (t) return t;
    }
    if (sig === 'wordml') {
      const t = parseWordML(buffer.toString('utf8'));
      if (t) return t;
    }
    if (sig === 'ole') {
      // Altes Binär-Office. Word/RTF kann textutil, für .xls gibt es den
      // Python-Leser; die Endung entscheidet hier ausnahmsweise mit, weil
      // der OLE-Container selbst beides sein kann.
      if (ext === '.xls' || ext === '.xlt') return await extractLegacyXls(buffer);
      return await extractBinaryDoc(buffer, ext === '.doc' ? '.doc' : '.doc');
    }
    if (sig === 'pdf') {
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const { text } = await extractText(pdf, { mergePages: true });
      return Array.isArray(text) ? text.join('\n') : text;
    }

    // --- Endungsbasiert -------------------------------------------------------
    if (ext === '.pdf') {
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const { text } = await extractText(pdf, { mergePages: true });
      return Array.isArray(text) ? text.join('\n') : text;
    }
    if (ext === '.docx') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Buffer-Generik-Konflikt @types/node v25 vs. mammoth
      const { value } = await mammoth.extractRawText({ buffer } as any);
      return value;
    }
    // Altes Word und verwandte Formate ohne erkennbare Signatur.
    if (ext === '.doc' || ext === '.rtf' || ext === '.odt' || ext === '.wps') {
      return await extractBinaryDoc(buffer, ext);
    }
    if (ext === '.xlsx' || ext === '.xls') {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
      const lines: string[] = [];
      wb.eachSheet((sheet) => {
        lines.push(`# Tabelle: ${sheet.name}`);
        sheet.eachRow((row) => {
          const vals = (row.values as unknown[]).slice(1).map((v) => (v == null ? '' : String(typeof v === 'object' && 'text' in (v as object) ? (v as { text: string }).text : v)));
          lines.push(vals.join('\t'));
        });
      });
      return lines.join('\n');
    }
    // Reine ZIP-Archive (kein Office-Container) auf Textdateien durchsehen.
    if (sig === 'zip' && ext !== '.xlsx' && ext !== '.docx' && ext !== '.pptx') {
      return await extractZip(buffer, filename);
    }
    if (TEXT_EXTS.includes(ext) || sig === 'xml' || sig === 'text') {
      const roh = buffer.toString('utf8');
      // Excel-2003-XML: erst in eine echte Tabelle wandeln (sonst 90 % Markup).
      if (ext === '.xml') {
        const tabelle = parseSpreadsheetML(roh);
        if (tabelle) return tabelle;
      }
      return roh;
    }
  } catch (err) {
    log.warn('[Files] Textextraktion fehlgeschlagen', { filename, error: (err as Error).message });
  }
  return '';
}

/** Speichert eine hochgeladene Datei, extrahiert Text (ggf. OCR) und legt einen DB-Eintrag an. */
export async function saveUpload(userId: number, file: File, chatId?: string, ocr = false): Promise<FileRow> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const ext = extname(file.name).toLowerCase();
  const kind = IMAGE_EXTS.has(ext) ? 'image' : 'document';
  const id = randomUUID();
  const storedName = `${id}${ext}`;
  const dir = join(uploadRoot(), String(userId));
  mkdirSync(dir, { recursive: true });
  const storedPath = join(dir, storedName);
  await writeFile(storedPath, buffer);

  let extractedText: string | null = kind === 'document' ? (await extractFileText(buffer, file.name)).slice(0, env.MAX_FILE_STORED_CHARS) : null;
  // Bilder: bei aktivierter OCR Text erkennen (offline). tesseract lazy laden.
  if (kind === 'image' && ocr) {
    try {
      const { ocrImage } = await import('./ocr.ts');
      const text = await ocrImage(buffer);
      extractedText = text ? text.slice(0, env.MAX_FILE_STORED_CHARS) : null;
    } catch (err) {
      log.warn('[Files] OCR fehlgeschlagen', { filename: file.name, error: (err as Error).message });
    }
  }

  return db
    .insert(files)
    .values({
      id,
      userId,
      chatId: chatId ?? null,
      filename: file.name,
      storedPath,
      mime: file.type || null,
      size: buffer.length,
      kind,
      extractedText,
    })
    .returning()
    .get();
}

export function getOwnedFiles(userId: number, ids: string[]): FileRow[] {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(files)
    .where(and(eq(files.userId, userId), inArray(files.id, ids)))
    .all();
}

export function getOwnedFile(userId: number, id: string): FileRow | undefined {
  return db.select().from(files).where(and(eq(files.userId, userId), eq(files.id, id))).get();
}

/**
 * Führt OCR (offline) auf einem eigenen Bild aus und gibt den erkannten Text
 * zurück. Ergebnis wird am File gespeichert, damit es künftig auch in den Chat-
 * Kontext einfließt. Bereits vorhandener Text wird direkt zurückgegeben.
 */
export async function ocrFile(userId: number, id: string): Promise<{ ok: boolean; text: string; error?: string }> {
  const file = getOwnedFile(userId, id);
  if (!file) return { ok: false, text: '', error: 'Datei nicht gefunden' };
  const istPdf = extname(file.filename).toLowerCase() === '.pdf';
  if (file.kind !== 'image' && !istPdf) return { ok: false, text: '', error: 'Nur für Bilder und PDFs verfügbar' };
  if (file.extractedText && file.extractedText.trim().length > 100) return { ok: true, text: file.extractedText };
  if (!existsSync(file.storedPath)) return { ok: false, text: '', error: 'Datei nicht mehr vorhanden' };
  try {
    const { ocrImage, ocrPdf } = await import('./ocr.ts');
    // Gescanntes PDF: Seiten rendern und einzeln lesen. Bild: direkt lesen.
    const text = (istPdf ? await ocrPdf(file.storedPath) : await ocrImage(await readFile(file.storedPath))).slice(
      0,
      env.MAX_FILE_STORED_CHARS,
    );
    if (text.trim()) {
      db.update(files).set({ extractedText: text }).where(eq(files.id, id)).run();
    }
    return { ok: true, text };
  } catch (err) {
    log.warn('[Files] On-demand-OCR fehlgeschlagen', { id, error: (err as Error).message });
    return { ok: false, text: '', error: 'OCR fehlgeschlagen' };
  }
}

export async function deleteFile(userId: number, id: string): Promise<boolean> {
  const row = getOwnedFile(userId, id);
  if (!row) return false;
  await unlink(row.storedPath).catch(() => {});
  // Den Suchindex mit aufräumen. Hing bisher nur an den beiden Routen — wer
  // deleteFile direkt aufrief, hinterließ Waisen. Im Bestand waren es vier
  // Dateien mit 356 Abschnitten.
  const { deleteFileIndex } = await import('./rag.ts');
  deleteFileIndex(id);
  db.delete(files).where(eq(files.id, id)).run();
  return true;
}

/**
 * Baut einen Kontext-Textblock aus den Dokumenten (für den Prompt).
 *
 * KLEINE DATEIEN ZUERST: Ein Fachdokument mit 300 Zeichen ist meist der Kern der
 * Frage, ein 200.000-Zeichen-Sicherheitsdatenblatt nur Nachschlagewerk. In
 * ursprünglicher Reihenfolge hätte das große Dokument das kleine verdrängt.
 * `budget` begrenzt die Gesamtlänge — Kontext kostet Wartezeit (~590 Token/s).
 */
export function buildFileContext(rows: FileRow[], budget = env.MAX_FILE_CONTEXT_CHARS): string {
  const docs = rows
    .filter((r) => r.extractedText && r.extractedText.trim())
    .sort((a, b) => (a.extractedText?.length ?? 0) - (b.extractedText?.length ?? 0));
  if (docs.length === 0) return '';
  let rest = budget;
  const parts: string[] = [];
  const gekuerzt: string[] = [];
  for (const d of docs) {
    if (rest <= 0) { gekuerzt.push(d.filename); continue; }
    const voll = d.extractedText ?? '';
    const text = voll.slice(0, rest);
    if (text.length < voll.length) gekuerzt.push(d.filename);
    rest -= text.length;
    parts.push(`### Datei: ${d.filename}\n${text}`);
  }
  const hinweis = gekuerzt.length
    ? `\n\nHinweis: Diese Datei(en) sind aus Platzgründen gekürzt oder fehlen: ${gekuerzt.join(', ')}. ` +
      'Weise darauf hin, wenn die Antwort davon abhängt.'
    : '';
  return `Der Nutzer hat folgende Datei(en) bereitgestellt. Nutze sie zur Beantwortung:\n\n${parts.join('\n\n---\n\n')}${hinweis}`;
}

/** Liest Bilder als base64 (für multimodale Modelle). */
export async function readImagesBase64(rows: FileRow[]): Promise<string[]> {
  const images = rows.filter((r) => r.kind === 'image' && existsSync(r.storedPath));
  const out: string[] = [];
  for (const img of images) {
    try {
      const buf = await readFile(img.storedPath);
      out.push(buf.toString('base64'));
    } catch {
      /* ignorieren */
    }
  }
  return out;
}

export { createReadStream };
