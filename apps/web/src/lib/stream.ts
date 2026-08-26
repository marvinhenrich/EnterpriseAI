import { tokenStore } from './api';

// Konsumiert den SSE-Stream von POST /api/chat/:id/query. EventSource kann kein
// POST, daher fetch + manuelles Parsen der SSE-Blöcke (durch \n\n getrennt).

export interface DocumentInfo {
  title: string;
  format: string;
  content: string;
}

export interface SourceInfo {
  label: string;
  // 'model' = ohne Beleg aus Firmenunterlagen · 'kb' = Altbestand vor 08/2026
  kind: 'file' | 'note' | 'document' | 'kb' | 'model';
  id?: string; // vorhanden → Quelle ist anklickbar
}

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onTool?: (info: { name: string; label: string }) => void;
  onDocument?: (doc: DocumentInfo) => void;
  onSources?: (sources: SourceInfo[]) => void;
  onDone?: (meta: { evalCount: number; totalMs: number }) => void;
  onError?: (message: string) => void;
}

export async function streamQuery(
  chatId: string,
  content: string,
  opts: { model?: string; think?: boolean; tools?: boolean; code?: boolean; fullContext?: boolean; regenerate?: boolean; signal?: AbortSignal; fileIds?: string[] },
  h: StreamHandlers,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/chat/${chatId}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenStore.get()}` },
      body: JSON.stringify({ content, model: opts.model, think: opts.think, tools: opts.tools, code: opts.code, fullContext: opts.fullContext, regenerate: opts.regenerate, fileIds: opts.fileIds }),
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name !== 'AbortError') h.onError?.('Netzwerkfehler: ' + (err as Error).message);
    return;
  }

  if (!res.ok || !res.body) {
    const d = (await res.json().catch(() => ({}))) as { error?: string };
    h.onError?.(d.error ?? `Fehler ${res.status}`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);

        let event = 'message';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;

        let parsed: { t?: string; error?: string; evalCount?: number; totalMs?: number; name?: string; label?: string; title?: string; format?: string; content?: string; sources?: SourceInfo[] };
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        if (event === 'delta') h.onDelta(parsed.t ?? '');
        else if (event === 'tool') h.onTool?.({ name: parsed.name ?? '', label: parsed.label ?? parsed.name ?? '' });
        else if (event === 'document') h.onDocument?.({ title: parsed.title ?? 'Dokument', format: parsed.format ?? 'pdf', content: parsed.content ?? '' });
        else if (event === 'sources') h.onSources?.(parsed.sources ?? []);
        else if (event === 'done') h.onDone?.({ evalCount: parsed.evalCount ?? 0, totalMs: parsed.totalMs ?? 0 });
        else if (event === 'error') h.onError?.(parsed.error ?? 'Fehler');
      }
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') h.onError?.('Verbindung unterbrochen');
  }
}
