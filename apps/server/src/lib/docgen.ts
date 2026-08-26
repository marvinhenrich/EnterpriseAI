import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, ImageRun, Header, Footer, PageNumber, ShadingType, BorderStyle } from 'docx';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { marked, type Token, type Tokens } from 'marked';
import pptxgenDefault from 'pptxgenjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { branding } from '../config/branding.ts';
import { serverPfad } from '../config/pfade.ts';

// --- Erscheinungsbild ---------------------------------------------------------
// Markenfarbe, Logo und Fußzeile kommen aus der Konfiguration (BRAND_COLOR,
// BRAND_LOGO_PATH, ORG_NAME, DOC_FOOTER). Der Code kennt keinen Firmennamen —
// dieselbe Programmfassung läuft so in beliebig vielen Betrieben.
const BRAND = branding.farbe.replace('#', '').toUpperCase(); // docx-Hex (ohne #)
// Aus der Konfiguration, nicht fest verdrahtet — siehe config/branding.ts.
const BRAND_HEX = branding.farbe;   // pdfkit
const INK_HEX = '#1a1d23';
const MUTED = '98A2B3';
const COMPANY = branding.organisation || branding.appName;
const FOOTER_NOTE = branding.vertraulichkeit;

const HERE = dirname(fileURLToPath(import.meta.url)); // apps/server/src/lib
let _logo: Buffer | null | undefined;
function logoBuffer(): Buffer | null {
  // Pfad aus der Konfiguration; fehlt er, wird nur der Name gesetzt.
  if (_logo !== undefined) return _logo;
  // Erst der konfigurierte Pfad, dann die üblichen Ablageorte im Web-Ordner.
  const kandidaten = [
    ...(branding.logoPfad ? [serverPfad(branding.logoPfad)] : []),
    resolve(HERE, '../../../web/public/logo.png'),
    resolve(HERE, '../../../web/dist/logo.png'),
  ];
  for (const p of kandidaten) {
    try { _logo = readFileSync(p); return _logo; } catch { /* weiter */ }
  }
  _logo = null;
  return _logo;
}

// pptxgenjs (CommonJS): Konstruktor liegt je nach Interop unter .default.
const PptxGenJS = ((pptxgenDefault as unknown as { default?: unknown }).default ?? pptxgenDefault) as new () => {
  addSlide: () => { addText: (t: unknown, o: Record<string, unknown>) => void; background?: unknown };
  defineLayout?: unknown;
  layout?: string;
  write: (o: { outputType: string }) => Promise<Buffer | ArrayBuffer | Uint8Array>;
};

// =============================================================================
// Dokument-Generierung: Markdown (KI-Antwort) → Word/PDF/Excel/PowerPoint/
// HTML/CSV/Text. Rein lokal, keine externen Aufrufe/Fonts.
// =============================================================================

export type ExportFormat = 'docx' | 'pdf' | 'xlsx' | 'pptx' | 'html' | 'csv' | 'txt';

function lex(md: string): Token[] {
  return marked.lexer(md);
}

/** Inline-Tokens zu reinem Text (für PDF/Excel). */
function inlineText(tokens: Tokens.Generic[] | undefined): string {
  if (!tokens) return '';
  return tokens
    .map((t) => {
      if (t.type === 'codespan' || t.type === 'text' || t.type === 'escape') return String(t.text ?? '');
      if (t.type === 'link') return inlineText(t.tokens) + (t.href ? ` (${t.href})` : '');
      if (t.tokens) return inlineText(t.tokens);
      return String(t.text ?? '');
    })
    .join('');
}

// --- Word (.docx) -----------------------------------------------------------
function inlineRuns(tokens: Tokens.Generic[] | undefined): TextRun[] {
  const out: TextRun[] = [];
  for (const t of tokens ?? []) {
    if (t.type === 'strong') out.push(new TextRun({ text: inlineText(t.tokens), bold: true }));
    else if (t.type === 'em') out.push(new TextRun({ text: inlineText(t.tokens), italics: true }));
    else if (t.type === 'codespan') out.push(new TextRun({ text: String(t.text ?? ''), font: 'Courier New' }));
    else if (t.type === 'link') out.push(new TextRun({ text: inlineText(t.tokens), color: '2563EB' }));
    else out.push(new TextRun({ text: t.tokens ? inlineText(t.tokens) : String(t.text ?? '') }));
  }
  return out.length ? out : [new TextRun('')];
}

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

// Kopfzeile: Logo und Organisationsname auf markenfarbenem Band (als Header
// auf jeder Seite). Weißes Logo braucht farbigen Hintergrund → blau hinterlegte Zelle.
function ciHeader(): Header {
  const lg = logoBuffer();
  const cellChildren: Paragraph[] = [
    new Paragraph({
      children: [
        ...(lg ? [new ImageRun({ type: 'png', data: lg, transformation: { width: 26, height: 29 } })] : []),
        new TextRun({ text: lg ? `   ${COMPANY}` : COMPANY, bold: true, color: 'FFFFFF', size: 24 }),
      ],
    }),
  ];
  return new Header({
    children: [
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
          top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE },
          right: { style: BorderStyle.NONE }, insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE },
        },
        rows: [new TableRow({
          children: [new TableCell({
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: BRAND },
            margins: { top: 90, bottom: 90, left: 140, right: 140 },
            children: cellChildren,
          })],
        })],
      }),
      new Paragraph({ spacing: { after: 120 }, children: [] }),
    ],
  });
}

function ciFooter(): Footer {
  return new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'D0D5DD', space: 6 } },
      children: [
        new TextRun({ text: `${COMPANY} — ${FOOTER_NOTE}      `, color: MUTED, size: 15 }),
        new TextRun({ children: ['Seite ', PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES], color: MUTED, size: 15 }),
      ],
    })],
  });
}

// Überschrift-Runs in Markenfarbe.
function headingRuns(tokens: Tokens.Generic[] | undefined): TextRun[] {
  return [new TextRun({ text: inlineText(tokens), bold: true, color: BRAND })];
}

export async function markdownToDocx(md: string, title: string): Promise<Buffer> {
  const tokens = lex(md);
  const children: (Paragraph | Table)[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, spacing: { after: 80 }, children: [new TextRun({ text: title, bold: true, color: BRAND })] }),
    new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: BRAND, space: 1 } }, spacing: { after: 160 }, children: [] }),
  ];

  for (const tk of tokens) {
    if (tk.type === 'heading') {
      children.push(new Paragraph({ heading: HEADINGS[Math.min(tk.depth - 1, 5)], children: headingRuns(tk.tokens) }));
    } else if (tk.type === 'paragraph') {
      children.push(new Paragraph({ children: inlineRuns(tk.tokens) }));
    } else if (tk.type === 'list') {
      (tk as Tokens.List).items.forEach((it, i) => {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: (tk as Tokens.List).ordered ? `${i + 1}. ` : '• ' }), ...inlineRuns(it.tokens)],
            indent: { left: 360 },
          }),
        );
      });
    } else if (tk.type === 'code') {
      for (const line of String(tk.text).split('\n')) {
        children.push(new Paragraph({ children: [new TextRun({ text: line, font: 'Courier New', size: 18 })] }));
      }
    } else if (tk.type === 'blockquote') {
      children.push(new Paragraph({ children: [new TextRun({ text: inlineText((tk as Tokens.Blockquote).tokens), italics: true })], indent: { left: 360 } }));
    } else if (tk.type === 'table') {
      const t = tk as Tokens.Table;
      const rows: TableRow[] = [];
      rows.push(new TableRow({ children: t.header.map((h) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: inlineText(h.tokens), bold: true })] })] })) }));
      for (const r of t.rows) {
        rows.push(new TableRow({ children: r.map((cell) => new TableCell({ children: [new Paragraph({ children: inlineRuns(cell.tokens) })] })) }));
      }
      children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
      children.push(new Paragraph({ children: [] }));
    }
  }

  const doc = new Document({
    sections: [{
      properties: { page: { margin: { top: 1100, bottom: 1000, left: 1000, right: 1000 } } },
      headers: { default: ciHeader() },
      footers: { default: ciFooter() },
      children,
    }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

// --- PDF (.pdf) -------------------------------------------------------------
export function markdownToPdf(md: string, title: string): Promise<Buffer> {
  return new Promise((done, reject) => {
    try {
      const M = 54;
      const doc = new PDFDocument({ size: 'A4', margins: { top: 94, bottom: 74, left: M, right: M }, bufferPages: true, info: { Title: title, Author: COMPANY } });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => done(Buffer.concat(chunks)));
      const W = doc.page.width;

      // Kopfband (Logo + Organisationsname auf Markenfarbe) — auf JEDER Seite.
      const drawBand = () => {
        doc.save();
        doc.rect(0, 0, W, 74).fill(BRAND_HEX);
        const lg = logoBuffer();
        let tx = M;
        if (lg) { doc.image(lg, M, 19, { height: 36 }); tx = M + 46; }
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(15).text(COMPANY, tx, 30, { lineBreak: false });
        doc.restore();
        doc.fillColor(INK_HEX);
        doc.x = M; doc.y = doc.page.margins.top; // Inhalt beginnt unter dem Band
      };
      doc.on('pageAdded', drawBand);
      drawBand(); // Seite 1

      // Titel (erster Inhalt auf Seite 1) + Markenlinie.
      doc.fillColor(BRAND_HEX).font('Helvetica-Bold').fontSize(20).text(title, { width: W - 2 * M });
      doc.moveTo(M, doc.y + 4).lineTo(W - M, doc.y + 4).lineWidth(2).strokeColor(BRAND_HEX).stroke();
      doc.moveDown(1).fillColor(INK_HEX);

      for (const tk of lex(md)) {
        if (tk.type === 'heading') {
          doc.moveDown(0.3).fillColor(BRAND_HEX).font('Helvetica-Bold').fontSize(15 - Math.min(tk.depth, 4)).text(inlineText(tk.tokens)).fillColor(INK_HEX).moveDown(0.2);
        } else if (tk.type === 'paragraph') {
          doc.font('Helvetica').fontSize(11).fillColor(INK_HEX).text(inlineText(tk.tokens), { align: 'left' }).moveDown(0.4);
        } else if (tk.type === 'list') {
          doc.font('Helvetica').fontSize(11).fillColor(INK_HEX);
          (tk as Tokens.List).items.forEach((it, i) => {
            doc.text(`${(tk as Tokens.List).ordered ? i + 1 + '.' : '•'}  ${inlineText(it.tokens)}`, { indent: 14 });
          });
          doc.moveDown(0.4);
        } else if (tk.type === 'code') {
          doc.font('Courier').fontSize(9.5).fillColor('#334155').text(String(tk.text), { indent: 10 }).fillColor(INK_HEX).moveDown(0.4);
        } else if (tk.type === 'blockquote') {
          doc.font('Helvetica-Oblique').fontSize(11).fillColor('#555555').text(inlineText((tk as Tokens.Blockquote).tokens), { indent: 14 }).fillColor(INK_HEX).moveDown(0.4);
        } else if (tk.type === 'table') {
          const t = tk as Tokens.Table;
          doc.font('Courier').fontSize(9.5).fillColor(INK_HEX);
          const widths = t.header.map((h, i) => Math.max(inlineText(h.tokens).length, ...t.rows.map((r) => inlineText(r[i]?.tokens).length)));
          const fmt = (cells: { tokens?: Tokens.Generic[] }[]) => cells.map((c, i) => inlineText(c.tokens).padEnd(widths[i]! + 2)).join('');
          doc.font('Courier-Bold').fillColor(BRAND_HEX).text(fmt(t.header)).fillColor(INK_HEX);
          doc.font('Courier');
          for (const r of t.rows) doc.text(fmt(r));
          doc.font('Helvetica').moveDown(0.4);
        } else if (tk.type === 'hr') {
          doc.moveDown(0.2);
        }
      }

      // Footer (Markenlinie + Hinweis + Seitenzahl) auf allen Seiten.
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.page.margins.bottom = 0; // verhindert Auto-Seitenumbruch durch Footer-Text
        const fy = doc.page.height - 52;
        doc.save();
        doc.moveTo(M, fy).lineTo(W - M, fy).lineWidth(0.5).strokeColor('#d0d5dd').stroke();
        doc.font('Helvetica').fontSize(8).fillColor('#98a2b3');
        doc.text(`${COMPANY} — ${FOOTER_NOTE}`, M, fy + 6, { lineBreak: false });
        doc.text(`Seite ${i - range.start + 1} / ${range.count}`, W - M - 140, fy + 6, { width: 140, align: 'right' });
        doc.restore();
      }
      doc.flushPages();
      doc.end();
    } catch (err) {
      reject(err as Error);
    }
  });
}

// --- Excel (.xlsx) ----------------------------------------------------------
export async function markdownToXlsx(md: string, title: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const tokens = lex(md);
  const tables = tokens.filter((t): t is Tokens.Table => t.type === 'table');

  if (tables.length > 0) {
    tables.forEach((t, idx) => {
      const ws = wb.addWorksheet(`Tabelle ${idx + 1}`);
      ws.addRow(t.header.map((h) => inlineText(h.tokens)));
      ws.getRow(1).font = { bold: true };
      for (const r of t.rows) ws.addRow(r.map((c) => inlineText(c.tokens)));
      ws.columns.forEach((col) => {
        let max = 10;
        col.eachCell?.({ includeEmpty: true }, (cell) => { max = Math.max(max, String(cell.value ?? '').length + 2); });
        col.width = Math.min(max, 60);
      });
    });
  } else {
    // Keine Tabelle → Text zeilenweise.
    const ws = wb.addWorksheet('Inhalt');
    ws.addRow([title]).font = { bold: true };
    for (const tk of tokens) {
      if (tk.type === 'paragraph' || tk.type === 'heading') ws.addRow([inlineText(tk.tokens)]);
      else if (tk.type === 'list') (tk as Tokens.List).items.forEach((it) => ws.addRow([`• ${inlineText(it.tokens)}`]));
      else if (tk.type === 'code') ws.addRow([String(tk.text)]);
    }
    ws.getColumn(1).width = 100;
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// --- CSV (.csv) -------------------------------------------------------------
function csvCell(s: string): string {
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function markdownToCsv(md: string): Buffer {
  const tokens = lex(md);
  const tables = tokens.filter((t): t is Tokens.Table => t.type === 'table');
  const lines: string[] = [];
  if (tables.length > 0) {
    for (const t of tables) {
      lines.push(t.header.map((h) => csvCell(inlineText(h.tokens))).join(';'));
      for (const r of t.rows) lines.push(r.map((c) => csvCell(inlineText(c.tokens))).join(';'));
      lines.push('');
    }
  } else {
    for (const tk of tokens) {
      if (tk.type === 'paragraph' || tk.type === 'heading') lines.push(csvCell(inlineText(tk.tokens)));
      else if (tk.type === 'list') (tk as Tokens.List).items.forEach((it) => lines.push(csvCell(inlineText(it.tokens))));
    }
  }
  return Buffer.from('﻿' + lines.join('\n'), 'utf8'); // BOM für Excel-Umlaute
}

// --- HTML (.html) -----------------------------------------------------------
export function markdownToHtml(md: string, title: string): Buffer {
  const body = marked.parse(md, { async: false }) as string;
  const esc = title.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${esc}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;color:#1a1d23;line-height:1.6}
h1,h2,h3{line-height:1.25}code{background:#f2f4f7;padding:.1em .3em;border-radius:4px;font-size:.9em}
pre{background:#0f1320;color:#e6e9f0;padding:14px;border-radius:8px;overflow:auto}pre code{background:none;color:inherit}
table{border-collapse:collapse;margin:1em 0}th,td{border:1px solid #e5e7eb;padding:6px 10px;text-align:left}th{background:#f2f4f7}
blockquote{border-left:3px solid #d6dae1;margin:0;padding-left:1em;color:#667085}</style></head>
<body><h1>${esc}</h1>${body}</body></html>`;
  return Buffer.from(html, 'utf8');
}

// --- Text (.txt) ------------------------------------------------------------
export function markdownToTxt(md: string, title: string): Buffer {
  const out: string[] = [title, '='.repeat(title.length), ''];
  for (const tk of lex(md)) {
    if (tk.type === 'heading') out.push('', inlineText(tk.tokens), '-'.repeat(inlineText(tk.tokens).length));
    else if (tk.type === 'paragraph') out.push(inlineText(tk.tokens), '');
    else if (tk.type === 'list') {
      (tk as Tokens.List).items.forEach((it, i) => out.push(`${(tk as Tokens.List).ordered ? i + 1 + '.' : '-'} ${inlineText(it.tokens)}`));
      out.push('');
    } else if (tk.type === 'code') out.push(String(tk.text), '');
    else if (tk.type === 'blockquote') out.push('> ' + inlineText((tk as Tokens.Blockquote).tokens), '');
    else if (tk.type === 'table') {
      const t = tk as Tokens.Table;
      out.push(t.header.map((h) => inlineText(h.tokens)).join('\t'));
      for (const r of t.rows) out.push(r.map((c) => inlineText(c.tokens)).join('\t'));
      out.push('');
    }
  }
  return Buffer.from(out.join('\n'), 'utf8');
}

// --- PowerPoint (.pptx) -----------------------------------------------------
export async function markdownToPptx(md: string, title: string): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  const tokens = lex(md);

  // Titelfolie
  const title0 = pptx.addSlide();
  title0.addText(title, { x: 0.5, y: 2.4, w: 12.3, h: 1.2, fontSize: 32, bold: true, color: '1A1D23', align: 'center' });

  // Inhalt: pro Überschrift eine Folie; dazwischenliegende Blöcke als Bullets.
  let cur: { title: string; bullets: string[] } | null = null;
  const slides: { title: string; bullets: string[] }[] = [];
  const flush = () => { if (cur) slides.push(cur); };

  for (const tk of tokens) {
    if (tk.type === 'heading') {
      flush();
      cur = { title: inlineText(tk.tokens), bullets: [] };
    } else if (tk.type === 'paragraph') {
      cur ??= { title: title, bullets: [] };
      cur.bullets.push(inlineText(tk.tokens));
    } else if (tk.type === 'list') {
      cur ??= { title: title, bullets: [] };
      (tk as Tokens.List).items.forEach((it) => cur!.bullets.push(inlineText(it.tokens)));
    } else if (tk.type === 'table') {
      cur ??= { title: title, bullets: [] };
      const t = tk as Tokens.Table;
      cur.bullets.push(t.header.map((h) => inlineText(h.tokens)).join(' | '));
      for (const r of t.rows) cur.bullets.push(r.map((c) => inlineText(c.tokens)).join(' | '));
    }
  }
  flush();

  for (const s of slides) {
    const slide = pptx.addSlide();
    slide.addText(s.title, { x: 0.5, y: 0.4, w: 12.3, h: 0.9, fontSize: 24, bold: true, color: '2563EB' });
    if (s.bullets.length > 0) {
      slide.addText(s.bullets.map((b) => ({ text: b, options: { bullet: true, fontSize: 16, color: '1A1D23', breakLine: true } })), { x: 0.7, y: 1.4, w: 12, h: 5.5, valign: 'top' });
    }
  }

  const out = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
}

export async function generateDocument(md: string, title: string, format: ExportFormat): Promise<{ buffer: Buffer; mime: string; ext: string }> {
  switch (format) {
    case 'docx':
      return { buffer: await markdownToDocx(md, title), mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' };
    case 'xlsx':
      return { buffer: await markdownToXlsx(md, title), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
    case 'pptx':
      return { buffer: await markdownToPptx(md, title), mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' };
    case 'html':
      return { buffer: markdownToHtml(md, title), mime: 'text/html; charset=utf-8', ext: 'html' };
    case 'csv':
      return { buffer: markdownToCsv(md), mime: 'text/csv; charset=utf-8', ext: 'csv' };
    case 'txt':
      return { buffer: markdownToTxt(md, title), mime: 'text/plain; charset=utf-8', ext: 'txt' };
    default:
      return { buffer: await markdownToPdf(md, title), mime: 'application/pdf', ext: 'pdf' };
  }
}
