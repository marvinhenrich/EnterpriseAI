import { useEffect, useRef, useState, forwardRef, useImperativeHandle, type PointerEvent as ReactPointerEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { imageApi, fetchImageBlobUrl, ApiError, type ImageModelMeta, type ImageItem, type ImageJobActive, type ImageQueue } from '../lib/api';
import { Logo } from '../components/Logo';
import { Spinner } from '../components/Spinner';
import { Icon } from '../components/ui';
import { branding, dateiPraefix } from '../lib/branding';

const SIZES: { label: string; w: number; h: number }[] = [
  { label: 'Standard', w: 768, h: 768 },
  { label: 'Quadrat groß', w: 1024, h: 1024 },
  { label: 'Quer 16:9', w: 1024, h: 576 },
  { label: 'Hoch 3:4', w: 768, h: 1024 },
];

function saveBlobUrl(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res((r.result as string).split(',')[1] ?? '');
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

const round16 = (v: number) => Math.max(256, Math.min(1024, Math.round(v / 16) * 16));

interface MaskHandle { exportMaskBase64: () => string | null; getGenSize: () => { w: number; h: number }; undo: () => void }

// Masken-Editor: zeigt das Original und lässt den zu ändernden Bereich übermalen.
// Exportiert eine Schwarz-Weiß-Maske (weiß = ändern). Außerhalb bleibt garantiert alles gleich.
const MaskEditor = forwardRef<MaskHandle, { imageUrl: string; brush: number; erase: boolean; onPaintedChange: (b: boolean) => void; clearSignal: number }>(
  function MaskEditor({ imageUrl, brush, erase, onPaintedChange, clearSignal }, ref) {
    const imgRef = useRef<HTMLImageElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const drawing = useRef(false);
    const last = useRef<{ x: number; y: number } | null>(null);
    const undoStack = useRef<ImageData[]>([]);
    const nat = useRef<{ w: number; h: number }>({ w: 1, h: 1 });
    const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

    function onLoad() {
      const im = imgRef.current; if (!im) return;
      nat.current = { w: im.naturalWidth, h: im.naturalHeight };
      const cap = 460;
      const scale = Math.min(1, cap / Math.max(im.naturalWidth, im.naturalHeight));
      setBox({ w: Math.round(im.naturalWidth * scale), h: Math.round(im.naturalHeight * scale) });
    }

    useEffect(() => {
      const c = canvasRef.current; if (!c || !box.w) return;
      c.width = box.w; c.height = box.h;
      c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
      onPaintedChange(false);
    }, [box]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
      if (!clearSignal) return;
      const c = canvasRef.current; const ctx = c?.getContext('2d');
      if (c && ctx) { ctx.clearRect(0, 0, c.width, c.height); onPaintedChange(false); }
    }, [clearSignal]); // eslint-disable-line react-hooks/exhaustive-deps

    function pos(e: ReactPointerEvent) {
      const c = canvasRef.current!; const r = c.getBoundingClientRect();
      return { x: (e.clientX - r.left) * (c.width / r.width), y: (e.clientY - r.top) * (c.height / r.height) };
    }
    function stroke(a: { x: number; y: number }, b: { x: number; y: number }) {
      const ctx = canvasRef.current!.getContext('2d')!;
      ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
      ctx.strokeStyle = 'rgba(37,99,235,1)'; ctx.fillStyle = 'rgba(37,99,235,1)';
      ctx.lineWidth = brush; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.beginPath(); ctx.arc(b.x, b.y, brush / 2, 0, Math.PI * 2); ctx.fill();
    }
    function down(e: ReactPointerEvent) {
      e.preventDefault();
      // Vor jedem Strich den Stand sichern, damit „Rückgängig" strichweise arbeitet.
      const cv = canvasRef.current!;
      const cx = cv.getContext('2d')!;
      undoStack.current.push(cx.getImageData(0, 0, cv.width, cv.height));
      if (undoStack.current.length > 25) undoStack.current.shift();
      drawing.current = true; const p = pos(e); last.current = p; stroke(p, p);
      if (!erase) onPaintedChange(true);
      (e.target as Element).setPointerCapture(e.pointerId);
    }
    function move(e: ReactPointerEvent) { if (!drawing.current) return; const p = pos(e); stroke(last.current ?? p, p); last.current = p; }
    function up() { drawing.current = false; last.current = null; }

    useImperativeHandle(ref, () => ({
      getGenSize: () => ({ w: round16(nat.current.w), h: round16(nat.current.h) }),
      undo: () => {
        const prev = undoStack.current.pop();
        const c = canvasRef.current; const ctx = c?.getContext('2d');
        if (!prev || !c || !ctx) return;
        ctx.putImageData(prev, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let any = false;
        for (let i = 3; i < d.length; i += 4) if (d[i]! > 10) { any = true; break; }
        onPaintedChange(any);
      },
      exportMaskBase64: () => {
        const c = canvasRef.current; if (!c) return null;
        // WICHTIG: Die Maske muss exakt die Größe haben, in der auch generiert wird.
        // Wird sie in Anzeigegröße (max. 460 px) exportiert, skaliert der Dienst sie
        // hoch — die Kanten sitzen dann sichtbar daneben.
        const gw = round16(nat.current.w);
        const gh = round16(nat.current.h);
        const up = document.createElement('canvas');
        up.width = gw; up.height = gh;
        const uctx = up.getContext('2d')!;
        uctx.drawImage(c, 0, 0, gw, gh);

        // Nach dem Hochskalieren hart schwellwerten → saubere Schwarz/Weiß-Maske.
        const src = uctx.getImageData(0, 0, gw, gh);
        let any = false;
        for (let i = 0; i < src.data.length; i += 4) {
          const on = src.data[i + 3]! > 60;
          if (on) any = true;
          src.data[i] = src.data[i + 1] = src.data[i + 2] = on ? 255 : 0;
          src.data[i + 3] = 255;
        }
        if (!any) return null;
        uctx.putImageData(src, 0, 0);
        return up.toDataURL('image/png').split(',')[1] ?? null;
      },
    }), []);

    return (
      <div className="relative inline-block select-none overflow-hidden rounded-lg border border-border" style={{ width: box.w || undefined }}>
        <img ref={imgRef} src={imageUrl} onLoad={onLoad} alt="Original" draggable={false}
          className="block" style={{ width: box.w || undefined, height: box.h || undefined }} />
        <canvas ref={canvasRef} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up}
          className="absolute inset-0 cursor-crosshair touch-none opacity-50"
          style={{ width: box.w || undefined, height: box.h || undefined }} />
      </div>
    );
  },
);

export function ImageStudio() {
  const nav = useNavigate();
  const [models, setModels] = useState<ImageModelMeta[]>([]);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [model, setModel] = useState('turbo');
  const [prompt, setPrompt] = useState('');
  const [negative, setNegative] = useState('');
  const [size, setSize] = useState(SIZES[0]!);
  const [advanced, setAdvanced] = useState(false);
  const [steps, setSteps] = useState('');
  const [seed, setSeed] = useState('');
  const [reference, setReference] = useState<string | null>(null); // base64 (Inpainting-Original)
  const [refThumb, setRefThumb] = useState<string | null>(null);
  const [brush, setBrush] = useState(34);
  const [erase, setErase] = useState(false);
  const [painted, setPainted] = useState(false);
  const [clearSignal, setClearSignal] = useState(0);
  const maskRef = useRef<MaskHandle>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const refInputRef = useRef<HTMLInputElement>(null);

  const [images, setImages] = useState<ImageItem[]>([]);
  const [active, setActive] = useState<ImageJobActive[]>([]);
  const [queue, setQueue] = useState<ImageQueue | null>(null);
  const [blobs, setBlobs] = useState<Record<string, string>>({});
  const blobsRef = useRef<Record<string, string>>({});
  const prevActive = useRef(0);

  useEffect(() => {
    imageApi.models().then((r) => { setEnabled(r.enabled); setModels(r.models); if (r.models[0]) setModel((m) => r.models.some((x) => x.key === m) ? m : r.models[0]!.key); }).catch(() => setEnabled(false));
    refreshList();
    return () => { Object.values(blobsRef.current).forEach((u) => URL.revokeObjectURL(u)); };
  }, []);

  async function refreshList() {
    try { const r = await imageApi.list(); setImages(r.images); setActive(r.active); setQueue(r.queue); prevActive.current = r.active.filter((a) => a.status !== 'failed').length; } catch { /* */ }
  }

  // Live-Polling: Queue/Status alle 2,5s; Galerie nachladen, wenn ein eigener Job fertig wurde.
  useEffect(() => {
    if (enabled === false) return;
    const iv = setInterval(async () => {
      try {
        const r = await imageApi.queue();
        setActive(r.active); setQueue(r.queue);
        const act = r.active.filter((a) => a.status !== 'failed').length;
        if (act < prevActive.current) await refreshList(); // ein Job wurde fertig → Galerie aktualisieren
        prevActive.current = act;
      } catch { /* */ }
    }, 2500);
    return () => clearInterval(iv);
  }, [enabled]);

  // Blob-URLs für Galeriebilder laden (auth-geschützt → nicht direkt als src nutzbar).
  useEffect(() => {
    for (const img of images) {
      if (blobsRef.current[img.id]) continue;
      fetchImageBlobUrl(img.id).then((url) => { blobsRef.current[img.id] = url; setBlobs((b) => ({ ...b, [img.id]: url })); }).catch(() => {});
    }
  }, [images]);

  function resetMask() { setPainted(false); setErase(false); setClearSignal((n) => n + 1); }

  async function onRefFile(file: File | null | undefined) {
    if (!file) return;
    setError('');
    try { setReference(await blobToBase64(file)); setRefThumb(URL.createObjectURL(file)); resetMask(); } catch { setError('Bild konnte nicht gelesen werden'); }
  }
  async function useAsReference(id: string) {
    const url = blobs[id]; if (!url) return;
    try { const blob = await (await fetch(url)).blob(); setReference(await blobToBase64(blob)); setRefThumb(url); resetMask(); window.scrollTo({ top: 0, behavior: 'smooth' }); } catch { /* */ }
  }
  function clearRef() { setReference(null); setRefThumb(null); resetMask(); if (refInputRef.current) refInputRef.current.value = ''; }

  async function submit() {
    if (!prompt.trim() || submitting) return;
    const base = { prompt: prompt.trim(), model, steps: steps ? Number(steps) : undefined, seed: seed ? Number(seed) : undefined, negative_prompt: negative.trim() || undefined };
    let body: Parameters<typeof imageApi.generate>[0];
    if (reference) {
      const mask = maskRef.current?.exportMaskBase64();
      if (!mask) { setError('Bitte markiere zuerst den Bereich, der geändert werden soll.'); return; }
      const gs = maskRef.current?.getGenSize() ?? { w: size.w, h: size.h };
      body = { ...base, width: gs.w, height: gs.h, reference, mask };
    } else {
      body = { ...base, width: size.w, height: size.h };
    }
    setSubmitting(true); setError('');
    try {
      await imageApi.generate(body);
      const r = await imageApi.queue(); setActive(r.active); setQueue(r.queue);
      prevActive.current = r.active.filter((a) => a.status !== 'failed').length;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Einreihen fehlgeschlagen');
    } finally { setSubmitting(false); }
  }

  async function remove(id: string) {
    await imageApi.remove(id).catch(() => {});
    if (blobsRef.current[id]) { URL.revokeObjectURL(blobsRef.current[id]!); delete blobsRef.current[id]; }
    setImages((x) => x.filter((i) => i.id !== id));
  }

  const myFailed = active.filter((a) => a.status === 'failed');
  const myPending = active.filter((a) => a.status !== 'failed');
  const run = queue?.running;
  const editing = !!reference;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-surface px-6 py-3">
        <div className="flex items-center gap-3"><Logo size={28} /><span className="text-[15px] font-semibold">{branding().appShort} · Bildgenerierung</span></div>
        <button onClick={() => nav('/')} className="rounded-lg px-3 py-1.5 text-[13px] text-muted transition hover:bg-surface-2 hover:text-accent">← Zum Chat</button>
      </header>

      <div className="flex-1 overflow-y-auto bg-bg p-6">
        <div className="mx-auto max-w-5xl">
          <p className="mb-1 text-[13.5px] leading-relaxed text-muted">
            Bilder aus Text — <strong className="text-fg">vollständig lokal</strong> auf dem Firmenserver. Deine Bilder werden gespeichert (Galerie unten, bleibt erhalten).
          </p>
          <p className="mb-4 text-[12px] leading-relaxed text-faint">
            Eine GPU → es wird <strong className="text-fg">eins nach dem anderen</strong> gerechnet (alle sehen die Warteschlange). Während ein Bild läuft, kann der Chat kurz langsamer sein.
          </p>

          {enabled === false && (
            <div className="mb-5 rounded-card border border-warn/40 bg-warn/5 p-4 text-[13.5px]">Der Bild-Dienst ist gerade nicht erreichbar.</div>
          )}

          {/* Eingabe */}
          <div className="rounded-card border border-border bg-surface p-5 shadow-soft">
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); }}
              rows={3} placeholder={editing ? 'Was soll im markierten Bereich sein? z. B. „ein roter Eimer" oder „leerer Boden" (zum Entfernen)' : 'z. B. Modernes Bürogebäude bei Sonnenaufgang, fotorealistisch, weiches Licht …'}
              className="w-full resize-none rounded-xl border border-border bg-bg px-3.5 py-3 text-[14.5px] outline-none transition placeholder:text-faint focus:border-accent" />
            {models.length > 1 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {models.map((m) => (
                  <button key={m.key} onClick={() => setModel(m.key)}
                    className={`rounded-lg border px-3 py-2 text-left text-[12.5px] transition ${model === m.key ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted hover:border-border-strong'}`}>
                    <div className="font-medium">{m.label}</div><div className="text-[11px] text-faint">~{m.steps} Schritte</div>
                  </button>
                ))}
              </div>
            )}
            {!editing && (
              <div className="mt-4">
                <div className="mb-1.5 text-[11.5px] font-medium text-faint">Format</div>
                <div className="flex flex-wrap gap-2">
                  {SIZES.map((s) => (
                    <button key={s.label} onClick={() => setSize(s)}
                      className={`rounded-lg border px-3 py-1.5 text-[12.5px] transition ${size.label === s.label ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted hover:border-border-strong'}`}>
                      {s.label} <span className="text-[10.5px] text-faint">{s.w}×{s.h}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Bild bearbeiten (Inpainting): Original hochladen + Bereich markieren */}
            <div className="mt-4">
              <div className="mb-1.5 text-[11.5px] font-medium text-faint">Bestehendes Bild ändern <span className="text-faint/70">(optional — Bereich markieren, Rest bleibt 1:1 erhalten)</span></div>
              <input ref={refInputRef} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={(e) => onRefFile(e.target.files?.[0])} />
              {!editing ? (
                <button onClick={() => refInputRef.current?.click()} className="rounded-lg border border-dashed border-border-strong px-3 py-2 text-[12.5px] text-muted transition hover:border-accent hover:text-accent">+ Bild zum Bearbeiten hochladen</button>
              ) : (
                <div className="rounded-xl border border-border bg-bg p-3.5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                    <MaskEditor ref={maskRef} imageUrl={refThumb!} brush={brush} erase={erase} onPaintedChange={setPainted} clearSignal={clearSignal} />
                    <div className="min-w-0 flex-1 text-[12px]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-fg">Bereich übermalen, der sich ändern soll</span>
                        <button onClick={clearRef} className="shrink-0 text-[11.5px] text-faint hover:text-danger">Bild entfernen</button>
                      </div>
                      <p className="mt-1 leading-relaxed text-muted">Alles, was du <span className="text-accent">blau markierst</span>, wird neu erzeugt. Der Rest bleibt <strong className="text-fg">pixelgenau gleich</strong> (Personen erhalten).</p>

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button onClick={() => setErase(false)} className={`rounded-lg border px-2.5 py-1.5 text-[12px] transition ${!erase ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted hover:border-border-strong'}`}><Icon name="stift" size={12} /> Malen</button>
                        <button onClick={() => setErase(true)} className={`rounded-lg border px-2.5 py-1.5 text-[12px] transition ${erase ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted hover:border-border-strong'}`}><Icon name="radierer" size={12} /> Radieren</button>
                        <button onClick={() => maskRef.current?.undo()} title="Letzten Strich zurücknehmen" className="rounded-lg border border-border px-2.5 py-1.5 text-[12px] text-muted transition hover:border-accent hover:text-accent"><Icon name="zurueck" size={12} /> Rückgängig</button>
                        <button onClick={() => setClearSignal((n) => n + 1)} className="rounded-lg border border-border px-2.5 py-1.5 text-[12px] text-muted transition hover:border-border-strong">Maske leeren</button>
                      </div>
                      <label className="mt-3 block text-[11.5px] text-faint">Pinselgröße
                        <input type="range" min={10} max={90} step={2} value={brush} onChange={(e) => setBrush(Number(e.target.value))} className="mt-1 w-full accent-accent" />
                      </label>
                      {!painted && <p className="mt-2 text-[11.5px] text-warn">Noch nichts markiert — übermale den zu ändernden Bereich.</p>}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <button onClick={() => setAdvanced((a) => !a)} className="mt-4 flex items-center gap-1.5 text-[12px] text-muted transition hover:text-accent">
              <Icon name={advanced ? 'chevronUnten' : 'chevronRechts'} size={12} /> Erweiterte Optionen
            </button>
            <AnimatePresence>
              {advanced && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <label className="text-[12px] text-muted">Schritte (Qualität↑, langsamer)
                      <input value={steps} onChange={(e) => setSteps(e.target.value.replace(/\D/g, ''))} placeholder="auto" className="mt-1 w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-accent" /></label>
                    <label className="text-[12px] text-muted">Seed (Reproduzierbarkeit)
                      <input value={seed} onChange={(e) => setSeed(e.target.value.replace(/\D/g, ''))} placeholder="zufällig" className="mt-1 w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-accent" /></label>
                    <label className="text-[12px] text-muted">Negativ-Prompt
                      <input value={negative} onChange={(e) => setNegative(e.target.value)} placeholder="z. B. Text, Wasserzeichen" className="mt-1 w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-accent" /></label>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            <div className="mt-4 flex items-center gap-3">
              <motion.button whileTap={{ scale: 0.97 }} onClick={submit} disabled={!prompt.trim() || submitting || enabled === false || (editing && !painted)}
                className="flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-[14px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-40">
                {submitting ? <Spinner size={15} className="text-white" /> : null}{submitting ? 'Einreihen …' : editing ? 'Änderung erzeugen' : 'Bild erzeugen'}
              </motion.button>
              <span className="text-[11.5px] text-faint">⌘/Strg + Enter</span>
              {error && <span className="text-[12.5px] text-danger">{error}</span>}
            </div>
          </div>

          {/* Live-Status (der „Topf") */}
          {(run || myPending.length > 0) && (
            <div className="mt-4 rounded-card border border-accent bg-accent-soft p-4">
              {run && (
                <div className="flex items-center gap-2.5 text-[13.5px] font-medium text-accent">
                  <Spinner size={15} className="text-accent" />
                  {run.mine ? 'Dein Bild wird erzeugt' : `${run.userName ?? 'Jemand'} erzeugt gerade ein Bild`} · {run.elapsedSec ?? 0}s
                </div>
              )}
              <div className="mt-1 text-[12px] text-muted">
                {queue && queue.queuedCount > 0 && <span>{queue.queuedCount} in der Warteschlange{queue.myQueued > 0 ? ` (davon ${queue.myQueued} von dir)` : ''}. </span>}
                {myPending.length > 0 && !run?.mine && <span>Dein Auftrag ist eingereiht.</span>}
              </div>
            </div>
          )}
          {myFailed.length > 0 && (
            <div className="mt-3 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[12.5px] text-danger">
              {myFailed.length} Auftrag/Aufträge fehlgeschlagen{myFailed[0]?.error ? `: ${myFailed[0].error}` : ''}.
            </div>
          )}

          {/* Galerie (persistent) */}
          <div className="mt-6 mb-2 flex items-center justify-between">
            <span className="text-[13.5px] font-medium">Galerie ({images.length})</span>
          </div>
          {images.length === 0 ? (
            <div className="rounded-card border border-dashed border-border bg-surface py-12 text-center text-[13px] text-faint">Noch keine Bilder. Erstelle dein erstes.</div>
          ) : (
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              <AnimatePresence>
                {images.map((s) => (
                  <motion.div key={s.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}
                    className="overflow-hidden rounded-card border border-border bg-surface shadow-soft">
                    <div className="grid place-items-center bg-bg" style={{ aspectRatio: `${s.width ?? 1} / ${s.height ?? 1}` }}>
                      {blobs[s.id] ? <img src={blobs[s.id]} alt={s.prompt} className="h-full w-full object-cover" /> : <Spinner size={20} className="text-muted" />}
                    </div>
                    <div className="p-3.5">
                      <p className="line-clamp-2 text-[12.5px] text-fg/85">{s.prompt}</p>
                      <div className="mt-2 flex items-center justify-between text-[11px] text-faint">
                        <span>{models.find((m) => m.key === s.model)?.label ?? s.model} · Seed {s.seed}</span>
                        <div className="flex items-center gap-2">
                          <button disabled={!blobs[s.id]} onClick={() => useAsReference(s.id)} className="text-muted transition hover:text-accent disabled:opacity-40" title="Dieses Bild bearbeiten (Bereich markieren)">Bearbeiten</button>
                          <button disabled={!blobs[s.id]} onClick={() => blobs[s.id] && saveBlobUrl(blobs[s.id]!, `${dateiPraefix()}-${s.seed}.png`)} className="text-muted transition hover:text-accent disabled:opacity-40">Download</button>
                          <button onClick={() => remove(s.id)} className="text-faint transition hover:text-danger">Löschen</button>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
