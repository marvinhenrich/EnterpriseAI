import { Children, isValidElement, memo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { copyText, downloadCodeFile, singleFileName } from '../lib/code';

// LaTeX-Delimiter der KI (\(…\) / \[…\]) zu remark-math-Dollar normalisieren —
// sonst frisst Markdown das „\(" als escaptes „(" und die Formel bleibt roh.
function normalizeMath(s: string): string {
  return s
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, x) => '$$' + x + '$$')
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, x) => '$' + x + '$');
}

// Markdown-Renderer für Assistant-Antworten. memo, damit beim Token-Streaming
// nicht der ganze Baum unnötig neu gerendert wird, wenn sich der Text nicht ändert.

// Reinen Text aus dem (von rehype-highlight mit <span> durchsetzten) Code-Baum ziehen.
function textOf(node: ReactNode): string {
  if (node == null || node === false) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

// Eigener <pre>-Renderer: Sprach-Label + Kopieren + Herunterladen über jedem Block.
function CodePre({ children }: { children?: ReactNode }) {
  const codeEl = Children.toArray(children).find((c) => isValidElement(c) && (c as { type?: string }).type === 'code');
  const codeProps = (isValidElement(codeEl) ? codeEl.props : {}) as { className?: string; children?: ReactNode };
  const lang = /language-([\w+-]+)/.exec(codeProps.className ?? '')?.[1] ?? '';
  const raw = textOf(codeProps.children).replace(/\n$/, '');
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    if (await copyText(raw)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  }

  return (
    <div className="code-card my-3 overflow-hidden rounded-xl border border-border bg-surface-2">
      <div className="flex items-center justify-between border-b border-border bg-surface px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-faint">{lang || 'code'}</span>
        <div className="flex items-center gap-1">
          <button
            onClick={onCopy}
            className="rounded-md px-2 py-0.5 text-[11.5px] text-muted transition hover:bg-surface-2 hover:text-accent"
            title="Code kopieren"
          >
            {copied ? 'Kopiert' : 'Kopieren'}
          </button>
          <button
            onClick={() => downloadCodeFile({ name: singleFileName(lang, raw), lang, code: raw })}
            className="rounded-md px-2 py-0.5 text-[11.5px] text-muted transition hover:bg-surface-2 hover:text-accent"
            title="Als Datei herunterladen"
          >
            Download
          </button>
        </div>
      </div>
      <pre className="!my-0 overflow-x-auto px-3 py-3 text-[13px] leading-relaxed">{children}</pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ content }: { content: string }) {
  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, errorColor: '#cc0000' }], rehypeHighlight]}
        components={{ pre: CodePre }}
      >
        {normalizeMath(content)}
      </ReactMarkdown>
    </div>
  );
});
