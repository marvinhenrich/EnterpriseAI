import { sqliteConnection as sqlite } from '../db/client.ts';
import { log } from './logger.ts';

// =============================================================================
// Leistungsmessung je KI-Anfrage. Bewusst ohne Inhalte — nur Kennzahlen, damit
// sichtbar wird, wenn Antworten langsamer werden (z. B. weil Kontexte wachsen
// oder ein Dienst klemmt). Fehler hier dürfen nie den Request kippen.
// =============================================================================

export interface PerfEntry {
  userId?: number | null;
  model?: string | null;
  promptChars: number;
  contextSources: number;
  ttfbMs?: number | null; // bis zum ersten Token
  totalMs: number;
  evalCount?: number | null;
  hadError?: boolean;
  /** Länge des System-Prompts allein (Kontext, Regeln, Vorgaben). */
  systemChars?: number;
  /** Länge des mitgeschickten Gesprächsverlaufs. */
  historyChars?: number;
  /** Länge der Werkzeugbeschreibungen — wächst mit jedem neuen Werkzeug. */
  toolDefChars?: number;
  /** Wie viele Werkzeugrunden tatsächlich gelaufen sind. */
  toolRounds?: number;
  /** Echtes Streaming? Nur dann ist ttfbMs aussagekräftig. */
  streamed?: boolean;
}

export function recordPerf(e: PerfEntry): void {
  try {
    sqlite
      .prepare(
        `INSERT INTO perf_log (user_id, model, prompt_chars, context_sources, ttfb_ms, total_ms,
                               eval_count, had_error, system_chars, history_chars, tool_def_chars,
                               tool_rounds, streamed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.userId ?? null, e.model ?? null, e.promptChars, e.contextSources,
        // Nur im Streaming-Pfad ist „Zeit bis zum ersten Wort" das, was sie
        // behauptet. Im Werkzeugpfad entsteht die Antwort vollständig, bevor
        // das erste Zeichen rausgeht — dort wurde bisher die GESAMTZEIT unter
        // diesem Namen gespeichert. 71 von 116 Messungen waren so verfälscht.
        e.streamed ? (e.ttfbMs ?? null) : null,
        e.totalMs, e.evalCount ?? null, e.hadError ? 1 : 0,
        e.systemChars ?? 0, e.historyChars ?? 0, e.toolDefChars ?? 0,
        e.toolRounds ?? 0, e.streamed ? 1 : 0,
      );
  } catch (err) {
    log.warn('[Perf] Messung nicht gespeichert', { error: (err as Error).message });
  }
}

export interface PerfSummary {
  tage: { d: string; anfragen: number; ttfbMedian: number; totalMedian: number; fehler: number }[];
  gesamt: { anfragen: number; ttfbMedian: number; ttfbP90: number; totalMedian: number; fehlerquote: number };
  langsamste: { created_at: string; prompt_chars: number; ttfb_ms: number; total_ms: number }[];
}

function quantil(werte: number[], q: number): number {
  if (werte.length === 0) return 0;
  const s = [...werte].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0);
}

/** Kennzahlen der letzten `tage` Tage fürs Admin-Panel. */
export function perfSummary(tage = 14): PerfSummary {
  const rows = sqlite
    .prepare(`SELECT * FROM perf_log WHERE created_at >= datetime('now', ?) ORDER BY id DESC`)
    .all(`-${tage} days`) as { created_at: string; ttfb_ms: number | null; total_ms: number; had_error: number; prompt_chars: number }[];

  const proTag = new Map<string, { ttfb: number[]; total: number[]; fehler: number }>();
  for (const r of rows) {
    const d = (r.created_at ?? '').slice(0, 10);
    if (!proTag.has(d)) proTag.set(d, { ttfb: [], total: [], fehler: 0 });
    const e = proTag.get(d)!;
    if (r.ttfb_ms != null) e.ttfb.push(r.ttfb_ms);
    e.total.push(r.total_ms);
    if (r.had_error) e.fehler++;
  }

  const alleTtfb = rows.map((r) => r.ttfb_ms).filter((x): x is number => x != null);
  const alleTotal = rows.map((r) => r.total_ms);

  return {
    tage: [...proTag.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([d, e]) => ({ d, anfragen: e.total.length, ttfbMedian: quantil(e.ttfb, 0.5), totalMedian: quantil(e.total, 0.5), fehler: e.fehler })),
    gesamt: {
      anfragen: rows.length,
      ttfbMedian: quantil(alleTtfb, 0.5),
      ttfbP90: quantil(alleTtfb, 0.9),
      totalMedian: quantil(alleTotal, 0.5),
      fehlerquote: rows.length ? Math.round((rows.filter((r) => r.had_error).length / rows.length) * 100) : 0,
    },
    langsamste: sqlite
      .prepare(`SELECT created_at, prompt_chars, ttfb_ms, total_ms FROM perf_log WHERE created_at >= datetime('now', ?) ORDER BY total_ms DESC LIMIT 5`)
      .all(`-${tage} days`) as PerfSummary['langsamste'],
  };
}
