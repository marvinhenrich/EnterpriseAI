import { env } from '../config/env.ts';
import { log } from '../lib/logger.ts';

// =============================================================================
// Ollama-Client — Streaming-Chat + Embeddings.
// Auf niedrige Time-to-first-token getrimmt: Wir streamen die NDJSON-Antwort
// von Ollama Token für Token weiter, sobald das erste Delta kommt.
// =============================================================================

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[]; // base64, nur für multimodale Modelle
  tool_calls?: unknown[]; // assistant-Nachricht mit Tool-Aufrufen
  tool_name?: string; // bei role 'tool': welches Werkzeug
}

export interface ToolCallResult {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ChatOptions {
  model?: string;
  think?: boolean | string;
  signal?: AbortSignal;
}

interface OllamaChatChunk {
  message?: { role: string; content: string };
  done?: boolean;
  total_duration?: number;
  eval_count?: number;
  prompt_eval_count?: number;
}

/**
 * Denkstufe für gpt-oss. „off" schaltet nur die STEUERUNG ab — das Modell denkt
 * trotzdem, dann aber ungesteuert und ausführlicher. Messwerte in config/env.ts.
 */
function denkstufe(override?: boolean | string): boolean | string {
  const v = override ?? env.OLLAMA_THINK;
  if (v === false || v === 'off') return false;
  if (v === true) return 'medium';
  return v;
}

const baseOptions = () => ({
  num_ctx: env.OLLAMA_NUM_CTX,
  num_predict: env.OLLAMA_NUM_PREDICT,
  temperature: env.OLLAMA_TEMPERATURE,
});

/**
 * Streamt eine Chat-Antwort von Ollama. Liefert einen AsyncGenerator von
 * Text-Deltas. Wirft bei HTTP-/Netzwerkfehlern.
 */
export async function* streamChat(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): AsyncGenerator<string, { evalCount: number; totalMs: number }, void> {
  const res = await fetch(`${env.OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model ?? env.OLLAMA_MODEL,
      messages,
      stream: true,
      think: denkstufe(opts.think),
      keep_alive: env.OLLAMA_KEEP_ALIVE,
      options: baseOptions(),
    }),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama-Fehler ${res.status}: ${text.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let evalCount = 0;
  let totalMs = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // NDJSON: pro Zeile ein JSON-Objekt.
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let chunk: OllamaChatChunk;
      try {
        chunk = JSON.parse(line);
      } catch {
        continue; // unvollständige/fehlerhafte Zeile überspringen
      }
      const delta = chunk.message?.content;
      if (delta) yield delta;
      if (chunk.done) {
        evalCount = chunk.eval_count ?? 0;
        totalMs = chunk.total_duration ? Math.round(chunk.total_duration / 1e6) : 0;
      }
    }
  }

  return { evalCount, totalMs };
}

/**
 * Non-Streaming-Aufruf mit erzwungenem JSON-Output. Für interne Aufgaben wie
 * die Memory-Extraktion. Gibt das geparste Objekt zurück (oder null bei Fehler).
 */
export async function generateJSON<T = unknown>(messages: ChatMessage[], opts: ChatOptions = {}): Promise<T | null> {
  try {
    const res = await fetch(`${env.OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model ?? env.OLLAMA_MODEL,
        messages,
        stream: false,
        think: false,
        format: 'json',
        keep_alive: env.OLLAMA_KEEP_ALIVE,
        options: { ...baseOptions(), temperature: 0.1 },
      }),
      signal: opts.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { message?: { content?: string } };
    const content = data.message?.content?.trim();
    if (!content) return null;
    return JSON.parse(content) as T;
  } catch (err) {
    log.warn('[Ollama] generateJSON fehlgeschlagen', { error: (err as Error).message });
    return null;
  }
}

/**
 * Non-Streaming-Chat mit Tools. Gibt Antworttext + ggf. Tool-Aufrufe zurück.
 * Für den Tool-Loop (chat.use_tools). Tools selbst sind rein intern (siehe tools.ts).
 */
export async function chatWithTools(
  messages: ChatMessage[],
  tools: unknown[],
  opts: ChatOptions = {},
): Promise<{ content: string; toolCalls: ToolCallResult[] }> {
  const res = await fetch(`${env.OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model ?? env.OLLAMA_MODEL,
      messages,
      tools,
      stream: false,
      // War fest auf false — ausgerechnet im Werkzeugpfad, wo die
      // Entwicklungsarbeit läuft. Gemessen ist „aus" die schlechteste Stufe.
      think: denkstufe(opts.think),
      keep_alive: env.OLLAMA_KEEP_ALIVE,
      options: baseOptions(),
    }),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`Ollama-Tools-Fehler ${res.status}`);
  const data = (await res.json()) as { message?: { content?: string; tool_calls?: ToolCallResult[] } };
  return { content: data.message?.content ?? '', toolCalls: data.message?.tool_calls ?? [] };
}

/** Embeddings für RAG (neuer /api/embed-Endpoint). Gibt einen Vektor zurück. */
export async function embed(text: string, model?: string): Promise<number[]> {
  const res = await fetch(`${env.OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model ?? env.OLLAMA_EMBED_MODEL, input: text }),
  });
  if (!res.ok) throw new Error(`Ollama-Embeddings-Fehler ${res.status}`);
  const data = (await res.json()) as { embeddings?: number[][] };
  const v = data.embeddings?.[0];
  if (!v) throw new Error('Ollama-Embeddings: leere Antwort');
  return v;
}

/** Liste der installierten Modelle. */
export async function listModels(): Promise<string[]> {
  try {
    const res = await fetch(`${env.OLLAMA_URL}/api/tags`);
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

/**
 * Wärmt das Default-Modell beim Start vor, damit der erste echte Request nicht
 * auf den Kaltstart (65 GB laden) warten muss. Läuft im Hintergrund, blockiert
 * den Serverstart nicht.
 */
export function warmupModel(): void {
  if (!env.OLLAMA_WARMUP) return;
  const started = Date.now();
  log.info('🔥 Ollama-Warmup gestartet', { model: env.OLLAMA_MODEL });
  fetch(`${env.OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env.OLLAMA_MODEL,
      messages: [{ role: 'user', content: 'Antworte nur mit "OK".' }],
      stream: false,
      think: false,
      keep_alive: env.OLLAMA_KEEP_ALIVE,
      // num_ctx muss zum Query-Pfad passen, sonst lädt Ollama beim 1. echten
      // Request neu. Gleicher Wert wie streamChat → Modell bleibt warm.
      options: { num_ctx: env.OLLAMA_NUM_CTX, num_predict: 4 },
    }),
  })
    .then((r) => {
      if (r.ok) log.info('✅ Ollama-Warmup fertig', { ms: Date.now() - started });
      else log.warn('Ollama-Warmup non-200', { status: r.status });
    })
    .catch((err) => log.warn('Ollama-Warmup fehlgeschlagen', { error: (err as Error).message }));
}
