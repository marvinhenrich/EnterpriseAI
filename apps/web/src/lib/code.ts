import JSZip from 'jszip';

// Hilfen für das Code-Feature: Code-Blöcke aus Markdown extrahieren,
// Dateinamen ableiten, einzelne Dateien speichern und ganze „Projekte" als ZIP.
// Alles rein clientseitig/offline — kein Outbound.

export interface CodeFile {
  name: string; // abgeleiteter Dateiname (z.B. src/app.ts)
  lang: string; // Sprach-Kennung aus dem Fence (z.B. ts)
  code: string; // reiner Quelltext ohne umschließende ```
}

// Sprache → Datei-Endung (Fallback, wenn kein Dateiname im Block steht).
const EXT: Record<string, string> = {
  ts: 'ts', typescript: 'ts', tsx: 'tsx', js: 'js', javascript: 'js', jsx: 'jsx',
  py: 'py', python: 'py', rb: 'rb', ruby: 'rb', php: 'php', go: 'go', rust: 'rs', rs: 'rs',
  java: 'java', kotlin: 'kt', kt: 'kt', swift: 'swift', c: 'c', h: 'h', cpp: 'cpp', 'c++': 'cpp',
  cs: 'cs', csharp: 'cs', sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', ps1: 'ps1', powershell: 'ps1',
  sql: 'sql', html: 'html', xml: 'xml', css: 'css', scss: 'scss', less: 'less',
  json: 'json', yaml: 'yml', yml: 'yml', toml: 'toml', ini: 'ini', md: 'md', markdown: 'md',
  dockerfile: 'Dockerfile', makefile: 'Makefile', vue: 'vue', svelte: 'svelte', r: 'r', lua: 'lua', dart: 'dart',
};

function extFor(lang: string): string {
  return EXT[lang.toLowerCase()] ?? (lang ? lang.toLowerCase() : 'txt');
}

// Erste Code-Zeile auf einen Dateipfad-Kommentar prüfen:
//   // src/app.ts   |   # main.py   |   -- schema.sql   |   <!-- index.html -->   |   /* style.css */
function filenameFromFirstLine(code: string): string | null {
  const first = (code.split('\n')[0] ?? '').trim();
  const m = first.match(/^(?:\/\/|#|--|;|<!--|\/\*)\s*([\w./@-]+\.[\w]+)\s*(?:-->|\*\/)?$/);
  if (m && m[1] && !m[1].startsWith('http')) return m[1].replace(/^\.?\//, '');
  return null;
}

// Info-String hinter ``` kann einen Dateinamen tragen: ```ts src/app.ts  /  ```ts title="app.ts"
function filenameFromInfo(info: string): string | null {
  const rest = info.trim().split(/\s+/).slice(1).join(' ').trim();
  if (!rest) return null;
  const titled = rest.match(/(?:title|file|name)\s*=\s*["']?([^"']+)["']?/i);
  const cand = (titled?.[1] ?? rest).replace(/^["']|["']$/g, '').trim();
  if (/^[\w./@-]+\.[\w]+$/.test(cand) && !cand.startsWith('http')) return cand.replace(/^\.?\//, '');
  return null;
}

// Letzte nicht-leere Zeile VOR dem Block auf einen Dateinamen prüfen — Modelle
// nennen die Datei oft als Überschrift/Fettung direkt darüber:
//   ### `README.md`   |   **src/app.ts**   |   Datei: schema.sql
function filenameFromContext(before: string): string | null {
  const lines = before.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last || last.length > 80) return null;
  const cleaned = last.replace(/^\s*\d+[.)]\s*/, '').replace(/[#*>`_]/g, ' ').replace(/^(datei|file)\s*:?\s*/i, '').trim();
  const m = cleaned.match(/([\w./@-]+\.[\w]+)/);
  if (!m || !m[1] || m[1].startsWith('http')) return null;
  const ext = m[1].split('.').pop() ?? '';
  if (!/[a-zA-Z]/.test(ext)) return null; // „Python 3.8" o.ä. ausschließen
  return m[1].replace(/^\.?\//, '');
}

const FENCE_RE = /```([^\n`]*)\n([\s\S]*?)```/g;

/** Alle Code-Blöcke aus einem Markdown-Text als Dateien. */
export function extractCodeFiles(markdown: string): CodeFile[] {
  const out: CodeFile[] = [];
  const used = new Set<string>();
  let m: RegExpExecArray | null;
  let idx = 0;
  let prevEnd = 0;
  FENCE_RE.lastIndex = 0;
  while ((m = FENCE_RE.exec(markdown)) !== null) {
    const info = m[1] ?? '';
    const code = (m[2] ?? '').replace(/\n$/, '');
    const before = markdown.slice(prevEnd, m.index);
    prevEnd = m.index + m[0].length;
    if (!code.trim()) continue;
    const lang = (info.trim().split(/\s+/)[0] ?? '').toLowerCase();
    idx++;
    let name = filenameFromInfo(info) ?? filenameFromFirstLine(code) ?? filenameFromContext(before) ?? `snippet-${idx}.${extFor(lang)}`;
    // Eindeutigkeit sichern (gleiche Namen → -2, -3 …)
    if (used.has(name)) {
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let n = 2;
      while (used.has(`${base}-${n}${ext}`)) n++;
      name = `${base}-${n}${ext}`;
    }
    used.add(name);
    out.push({ name, lang, code });
  }
  return out;
}

/** Dateiname für einen EINZELNEN Block (für den Block-Download im Chat). */
export function singleFileName(lang: string, code: string): string {
  return filenameFromFirstLine(code) ?? `code.${extFor(lang)}`;
}

export function hasCode(markdown: string): boolean {
  FENCE_RE.lastIndex = 0;
  const m = FENCE_RE.exec(markdown);
  return !!m && !!(m[2] ?? '').trim();
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function downloadCodeFile(file: CodeFile) {
  const base = file.name.split('/').pop() || file.name;
  saveBlob(new Blob([file.code], { type: 'text/plain;charset=utf-8' }), base);
}

/** Alle Dateien als ZIP (Verzeichnisstruktur aus den Dateinamen bleibt erhalten). */
export async function downloadProjectZip(files: CodeFile[], zipName = 'projekt.zip') {
  const zip = new JSZip();
  for (const f of files) zip.file(f.name, f.code);
  const blob = await zip.generateAsync({ type: 'blob' });
  saveBlob(blob, zipName);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
