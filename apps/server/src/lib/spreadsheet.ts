import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';

// =============================================================================
// Programmatische Tabellen-Auswertung (für große Excel/CSV, die nicht in den
// LLM-Kontext passen). Wird von den Spreadsheet-Tools genutzt. Rein lokal.
// =============================================================================

type Cell = string | number;
interface Sheet {
  name: string;
  headers: string[];
  rows: Record<string, Cell>[];
}

function cellVal(v: unknown): Cell {
  if (v == null) return '';
  if (typeof v === 'number') return v;
  if (typeof v === 'object') {
    const o = v as { text?: string; result?: unknown; hyperlink?: string };
    if (o.result != null) return cellVal(o.result);
    if (o.text != null) return o.text;
    return String(v);
  }
  const s = String(v).trim();
  return s;
}

async function loadWorkbook(path: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  if (path.toLowerCase().endsWith('.csv')) {
    // Trennzeichen erkennen (; deutsch vs , englisch) anhand der ersten Zeile.
    const firstLine = (await readFile(path, 'utf8')).split(/\r?\n/, 1)[0] ?? '';
    const delimiter = firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';
    await wb.csv.readFile(path, { parserOptions: { delimiter } });
  } else {
    await wb.xlsx.readFile(path);
  }
  return wb;
}

function readSheet(ws: ExcelJS.Worksheet): Sheet {
  const headerVals = ((ws.getRow(1).values as unknown[]) ?? []).slice(1).map((v) => String(cellVal(v) || '').trim());
  const headers = headerVals.map((h, i) => h || `Spalte${i + 1}`);
  const rows: Record<string, Cell>[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const vals = ((row.values as unknown[]) ?? []).slice(1);
    const obj: Record<string, Cell> = {};
    headers.forEach((h, i) => (obj[h] = cellVal(vals[i])));
    rows.push(obj);
  });
  return { name: ws.name, headers, rows };
}

/** Struktur einer Tabellen-Datei: Blätter, Spalten, Zeilenzahl. */
export async function spreadsheetInfo(path: string): Promise<string> {
  const wb = await loadWorkbook(path);
  const parts: string[] = [];
  wb.worksheets.forEach((ws) => {
    const s = readSheet(ws);
    parts.push(`Blatt "${s.name}": ${s.rows.length} Zeilen, Spalten: ${s.headers.join(', ')}`);
    if (s.rows.length > 0) {
      const sample = s.headers.map((h) => `${h}=${s.rows[0]![h]}`).join('; ');
      parts.push(`  Beispielzeile: ${sample}`);
    }
  });
  return parts.join('\n');
}

interface Filter {
  column: string;
  op: '=' | '!=' | '>' | '<' | '>=' | '<=' | 'contains';
  value: string | number;
}

const AGG_FUNCS = ['sum', 'avg', 'count', 'min', 'max'] as const;
type AggFunc = (typeof AGG_FUNCS)[number];

// Modelle weichen oft vom Schema ab → tolerant normalisieren.
function normalizeFilter(f: Record<string, unknown>): Filter {
  const opRaw = String(f.op ?? f.operator ?? f.comparator ?? f.comparison ?? '=').toLowerCase();
  const map: Record<string, Filter['op']> = { eq: '=', equals: '=', ne: '!=', neq: '!=', gt: '>', lt: '<', gte: '>=', ge: '>=', lte: '<=', le: '<=', includes: 'contains', contains: 'contains' };
  const op = (map[opRaw] ?? (['=', '!=', '>', '<', '>=', '<=', 'contains'].includes(opRaw) ? opRaw : '=')) as Filter['op'];
  return { column: String(f.column ?? f.field ?? f.name ?? ''), op, value: (f.value ?? f.val ?? '') as string | number };
}
function normalizeAggregate(agg: unknown): { func: AggFunc; column?: string } | null {
  if (!agg || typeof agg !== 'object') return null;
  const a = agg as Record<string, unknown>;
  if (typeof a.func === 'string' && (AGG_FUNCS as readonly string[]).includes(a.func)) return { func: a.func as AggFunc, column: a.column as string | undefined };
  if (typeof a.function === 'string' && (AGG_FUNCS as readonly string[]).includes(a.function)) return { func: a.function as AggFunc, column: (a.column ?? a.field) as string | undefined };
  // Stil {count:"Artikel"} / {sum:"Menge"}
  for (const f of AGG_FUNCS) if (f in a) return { func: f, column: typeof a[f] === 'string' ? (a[f] as string) : (a.column as string | undefined) };
  return null;
}
interface QueryArgs {
  sheet?: string;
  filters?: Filter[];
  columns?: string[];
  aggregate?: { func: 'sum' | 'avg' | 'count' | 'min' | 'max'; column?: string };
  groupBy?: string;
  sortBy?: { column: string; desc?: boolean };
  limit?: number;
}

function num(v: Cell | undefined): number | null {
  if (v === undefined) return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/\./g, '').replace(',', '.').replace(/[^0-9.\-]/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function matches(row: Record<string, Cell>, f: Filter): boolean {
  const cell = row[f.column];
  if (cell === undefined) return false;
  if (f.op === 'contains') return String(cell).toLowerCase().includes(String(f.value).toLowerCase());
  const a = num(cell);
  const b = num(f.value as Cell);
  if (a !== null && b !== null) {
    switch (f.op) { case '=': return a === b; case '!=': return a !== b; case '>': return a > b; case '<': return a < b; case '>=': return a >= b; case '<=': return a <= b; }
  }
  const sa = String(cell).toLowerCase();
  const sb = String(f.value).toLowerCase();
  return f.op === '=' ? sa === sb : f.op === '!=' ? sa !== sb : false;
}

function mdTable(headers: string[], rows: Record<string, Cell>[]): string {
  const head = '| ' + headers.join(' | ') + ' |';
  const sep = '| ' + headers.map(() => '---').join(' | ') + ' |';
  const body = rows.map((r) => '| ' + headers.map((h) => String(r[h] ?? '')).join(' | ') + ' |').join('\n');
  return [head, sep, body].filter(Boolean).join('\n');
}

// Manche Modelle übergeben verschachtelte Argumente als JSON-String → parsen.
function coerceArgs(raw: unknown): QueryArgs {
  let a: Record<string, unknown> = typeof raw === 'string' ? safeJson(raw) : { ...(raw as Record<string, unknown>) };
  for (const k of ['filters', 'columns', 'aggregate', 'sortBy'] as const) {
    if (typeof a[k] === 'string') a[k] = safeJson(a[k] as string);
  }
  return a as QueryArgs;
}
function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/** Filtert/aggregiert eine Tabelle und gibt das Ergebnis als Markdown zurück. */
export async function spreadsheetQuery(path: string, rawArgs: unknown): Promise<string> {
  const args = coerceArgs(rawArgs);
  const wb = await loadWorkbook(path);
  const ws = args.sheet ? wb.getWorksheet(args.sheet) : wb.worksheets[0];
  if (!ws) return 'Blatt nicht gefunden.';
  const sheet = readSheet(ws);

  let rows = sheet.rows;
  const filters = (args.filters ?? []).map((f) => normalizeFilter(f as unknown as Record<string, unknown>)).filter((f) => f.column);
  for (const f of filters) rows = rows.filter((r) => matches(r, f));

  // Aggregation (tolerant ggü. Modell-Varianten)
  const aggregate = normalizeAggregate(args.aggregate);
  if (aggregate) {
    const { func, column } = aggregate;
    const agg = (subset: Record<string, Cell>[]): number => {
      if (func === 'count') return subset.length;
      const nums = subset.map((r) => num(r[column ?? ''])).filter((n): n is number => n !== null);
      if (nums.length === 0) return 0;
      if (func === 'sum') return nums.reduce((a, b) => a + b, 0);
      if (func === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length;
      if (func === 'min') return Math.min(...nums);
      return Math.max(...nums);
    };
    if (args.groupBy) {
      const groups = new Map<string, Record<string, Cell>[]>();
      for (const r of rows) {
        const k = String(r[args.groupBy] ?? '');
        (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
      }
      const out = [...groups.entries()].map(([k, v]) => ({ [args.groupBy!]: k, [`${func}(${column ?? ''})`]: Math.round(agg(v) * 100) / 100 }));
      return mdTable([args.groupBy, `${func}(${column ?? ''})`], out as Record<string, Cell>[]);
    }
    return `${func}(${column ?? ''}) = ${Math.round(agg(rows) * 100) / 100} (über ${rows.length} Zeilen)`;
  }

  // Sortierung
  if (args.sortBy?.column) {
    const col = args.sortBy.column;
    rows = [...rows].sort((a, b) => {
      const na = num(a[col]); const nb = num(b[col]);
      const cmp = na !== null && nb !== null ? na - nb : String(a[col]).localeCompare(String(b[col]));
      return args.sortBy!.desc ? -cmp : cmp;
    });
  }

  const cols = args.columns?.length ? args.columns.filter((c) => sheet.headers.includes(c)) : sheet.headers;
  const limit = Math.min(args.limit ?? 50, 200);
  const shown = rows.slice(0, limit);
  const projected = shown.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? ''])));
  const note = rows.length > limit ? `\n\n(${rows.length} Treffer, ${limit} angezeigt)` : `\n\n(${rows.length} Treffer)`;
  return mdTable(cols, projected as Record<string, Cell>[]) + note;
}

export function isSpreadsheet(filename: string): boolean {
  return /\.(xlsx|xls|csv)$/i.test(filename);
}
