import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { labelsApi, downloadLabelsExcel, ApiError, type LabelRow, type LabelStats, type ScanView, type LabelTerm } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Logo } from '../components/Logo';
import { Spinner } from '../components/Spinner';
import { Icon, Badge } from '../components/ui';
import { branding } from '../lib/branding';

function fmtTime(ts: string | null): string {
  if (!ts) return '';
  try { return new Date(ts.replace(' ', 'T') + 'Z').toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return ts; }
}
function fmtEta(sec: number | null): string {
  if (sec == null) return '–';
  if (sec < 60) return `~${sec} s`;
  if (sec < 3600) return `~${Math.round(sec / 60)} Min`;
  return `~${(sec / 3600).toFixed(1)} h`;
}

export function Etiketten() {
  const nav = useNavigate();
  const { user } = useAuth();
  const canRead = !!user?.permissions?.includes('labels.read');
  const canWrite = !!user?.permissions?.includes('labels.write');
  const canDelete = !!user?.permissions?.includes('labels.delete');

  const [labels, setLabels] = useState<LabelRow[]>([]);
  const [stats, setStats] = useState<LabelStats | null>(null);
  const [scan, setScan] = useState<ScanView | null>(null);
  const [terms, setTerms] = useState<LabelTerm[]>([]);
  const [termInput, setTermInput] = useState('');
  const [uploading, setUploading] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const prevStatus = useRef<string | null>(null);

  async function refresh() {
    try {
      const r = await labelsApi.list();
      setLabels(r.labels); setStats(r.stats); setScan(r.scan);
      prevStatus.current = r.scan?.status ?? null;
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Laden fehlgeschlagen'); }
  }
  async function refreshTerms() { try { setTerms((await labelsApi.terms()).terms); } catch { /* */ } }

  useEffect(() => { if (canRead) { refresh(); refreshTerms(); } }, [canRead]);

  // Live-Polling: Scan-Status alle 2,5 s; Liste bei laufendem Scan + bei Übergang.
  useEffect(() => {
    if (!canRead) return;
    let tick = 0;
    const iv = setInterval(async () => {
      tick++;
      try {
        const { scan: s } = await labelsApi.scan();
        setScan(s);
        const running = s?.status === 'running';
        const was = prevStatus.current;
        // Banner bleibt live (2,5s); große Liste nur alle ~15s während Lauf → leicht bei vielen Labels.
        if (running && tick % 6 === 0) await refresh();
        else if (was === 'running' && s?.status !== 'running') { await refresh(); await refreshTerms(); } // fertig → Endstand
        prevStatus.current = s?.status ?? null;
      } catch { /* still */ }
    }, 2500);
    return () => clearInterval(iv);
  }, [canRead]);

  // Während Begriffe noch übersetzt werden: Status live nachladen.
  const pendingTerms = terms.some((t) => t.variants === null);
  useEffect(() => {
    if (!pendingTerms) return;
    const iv = setInterval(refreshTerms, 3000);
    return () => clearInterval(iv);
  }, [pendingTerms]);

  async function onUpload(list: FileList | null) {
    if (!list || !list.length) return;
    setError(''); setInfo('');
    const arr = Array.from(list);
    // Es gibt KEINE Größenbeschränkung mehr — aber eine Anfrage wird vollständig
    // im Arbeitsspeicher gehalten. Deshalb wird nicht nur nach Anzahl, sondern
    // auch nach SUMME aufgeteilt: 20 Dateien à 500 MB wären sonst 10 GB in einem
    // Zug. Für den Nutzer ändert das nichts, es werden nur mehr Anfragen.
    const MAX_STUECK = 20;
    const MAX_SUMME = 400 * 1024 * 1024;
    const pakete: File[][] = [];
    let aktuell: File[] = [];
    let summe = 0;
    for (const f of arr) {
      if (aktuell.length > 0 && (aktuell.length >= MAX_STUECK || summe + f.size > MAX_SUMME)) {
        pakete.push(aktuell); aktuell = []; summe = 0;
      }
      aktuell.push(f); summe += f.size;
    }
    if (aktuell.length > 0) pakete.push(aktuell);

    let added = 0;
    let erledigt = 0;
    for (const part of pakete) {
      erledigt += part.length;
      setUploading(`${erledigt}/${arr.length}`);
      try { added += (await labelsApi.upload(part)).added; } catch (e) { setError(e instanceof Error ? e.message : 'Upload fehlgeschlagen'); }
    }
    setUploading(''); if (fileRef.current) fileRef.current.value = '';
    setInfo(`${added} Etikett(en) hinzugefügt.`);
    refresh();
  }

  async function addTermsNow() {
    if (!termInput.trim()) return;
    try { await labelsApi.addTerms(termInput); setTermInput(''); refreshTerms(); refresh(); } catch (e) { setError(e instanceof ApiError ? e.message : 'Fehler'); }
  }
  async function start() {
    setError('');
    try { const r = await labelsApi.startScan(); setScan(r.scan); prevStatus.current = 'running'; } catch (e) { setError(e instanceof ApiError ? e.message : 'Scan fehlgeschlagen'); }
  }

  if (!canRead) return null;
  const running = scan?.status === 'running';
  const pct = scan && scan.total > 0 ? Math.round((scan.done / scan.total) * 100) : 0;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-surface px-6 py-3">
        <div className="flex items-center gap-3"><Logo size={28} /><span className="text-[15px] font-semibold">{branding().appShort} · Etiketten-Datenbank</span></div>
        <button onClick={() => nav('/')} className="rounded-lg px-3 py-1.5 text-[13px] text-muted transition hover:bg-surface-2 hover:text-accent">← Zum Chat</button>
      </header>

      <div className="flex-1 overflow-y-auto bg-bg p-6">
        <div className="mx-auto max-w-5xl">
          {/* ---- Scan-Banner (der „Topf", live für alle) ---- */}
          <div className={`mb-5 rounded-card border p-4 shadow-soft ${running ? 'border-accent bg-accent-soft' : 'border-border bg-surface'}`}>
            {running ? (
              <>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5 text-[14px] font-medium text-accent">
                    <Spinner size={16} className="text-accent" /> Scan läuft …
                  </div>
                  <div className="flex items-center gap-3 text-[12.5px] text-muted">
                    <span>{scan!.done}/{scan!.total} · {scan!.hits} Treffer · ETA {fmtEta(scan!.etaSec)}</span>
                    {canWrite && <button onClick={() => labelsApi.cancelScan().then(() => labelsApi.scan().then((x) => setScan(x.scan)))} className="rounded-lg border border-border px-2.5 py-1 text-[12px] text-muted transition hover:border-danger hover:text-danger">Abbrechen</button>}
                  </div>
                </div>
                <div className="mt-2.5 h-2.5 overflow-hidden rounded-full bg-surface-2">
                  <motion.div className="h-full rounded-full bg-accent" animate={{ width: `${pct}%` }} transition={{ duration: 0.4 }} />
                </div>
                <div className="mt-2 text-[12px] text-muted">Gestartet von <strong className="text-fg">{scan!.startedByName}</strong> · {fmtTime(scan!.startedAt)} · {scan!.termCount} Begriffe</div>
              </>
            ) : (
              <div className="flex items-center justify-between">
                <div className="text-[13.5px]">
                  {scan ? (
                    <>Letzter Scan: <strong className={scan.status === 'done' ? 'text-accent' : 'text-muted'}>{scan.status === 'done' ? 'abgeschlossen' : scan.status === 'canceled' ? 'abgebrochen' : 'fehlgeschlagen'}</strong>
                      {' '}· {scan.done}/{scan.total} · {scan.hits} Treffer · von {scan.startedByName} · {fmtTime(scan.finishedAt ?? scan.startedAt)}</>
                  ) : <span className="text-muted">Noch kein Scan durchgeführt.</span>}
                </div>
                {canWrite && (
                  <motion.button whileTap={{ scale: 0.97 }} onClick={start} disabled={!stats?.total || !stats?.terms}
                    className="rounded-xl bg-accent px-5 py-2.5 text-[14px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-40">
                    Scan starten
                  </motion.button>
                )}
              </div>
            )}
          </div>

          {/* ---- Statistik ---- */}
          <div className="mb-5 grid grid-cols-4 gap-3">
            {[['Etiketten', stats?.total ?? 0], ['OCR fertig', stats?.ocrDone ?? 0], ['mit Treffer', stats?.hits ?? 0], ['Begriffe', stats?.terms ?? 0]].map(([k, v]) => (
              <div key={k} className="rounded-card border border-border bg-surface p-3 text-center">
                <div className="text-[20px] font-semibold text-fg">{v as number}</div>
                <div className="text-[11.5px] text-faint">{k as string}</div>
              </div>
            ))}
          </div>

          {error && <div className="mb-3 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
          {info && <div className="mb-3 text-[12.5px] text-accent">{info}</div>}

          <div className="flex items-center justify-end gap-2">
            <button onClick={() => downloadLabelsExcel().catch(() => {})} className="rounded-lg border border-border px-3 py-1.5 text-[12.5px] text-muted transition hover:border-accent hover:text-accent">Excel exportieren</button>
          </div>

          <div className="mt-3 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
            {/* ---- Etiketten ---- */}
            <div className="rounded-card border border-border bg-surface shadow-soft">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <span className="text-[13.5px] font-medium">Etiketten ({labels.length})</span>
                {canWrite && (
                  <>
                    <input ref={fileRef} type="file" hidden multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff" onChange={(e) => onUpload(e.target.files)} />
                    <button onClick={() => fileRef.current?.click()} disabled={!!uploading} className="rounded-lg border border-border px-3 py-1.5 text-[12px] text-muted transition hover:border-accent hover:text-accent disabled:opacity-50">
                      {uploading ? `Lädt ${uploading} …` : '+ PDFs / Bilder'}
                    </button>
                  </>
                )}
              </div>
              <div className="max-h-[440px] overflow-y-auto">
                {labels.length === 0 ? <div className="px-4 py-8 text-center text-[13px] text-faint">Noch keine Etiketten in der Datenbank.</div> : (
                  <table className="w-full text-[12px]">
                    <tbody>
                      {labels.map((l) => (
                        <tr key={l.id} className="border-b border-border/50">
                          <td className="max-w-[220px] truncate px-4 py-2" title={l.filename}>{l.filename}</td>
                          <td className="px-2 py-2">
                            {l.status === 'treffer' ? <Badge tone="warn" icon="warnung">{l.found.length}</Badge>
                              : l.status === 'ok' ? <Badge tone="ok">OK</Badge>
                              : l.status === 'fehler' ? <Badge tone="danger">Fehler</Badge>
                              : <span className="text-faint">offen</span>}
                          </td>
                          <td className="max-w-[200px] truncate px-2 py-2 text-fg/70" title={l.found.join(', ')}>{l.found.join(', ')}</td>
                          {canDelete && <td className="px-2 py-2 text-right"><button onClick={() => labelsApi.remove(l.id).then(refresh)} className="text-faint hover:text-danger" title="Entfernen"><Icon name="schliessen" size={12} /></button></td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* ---- Begriffe (Richtlinie) ---- */}
            <div className="rounded-card border border-border bg-surface shadow-soft">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <span className="text-[13.5px] font-medium">Richtlinie · Begriffe ({terms.length})</span>
                <div className="flex items-center gap-2.5">
                  {canWrite && terms.length > 0 && <button onClick={() => labelsApi.translate().then(() => { setTimeout(refreshTerms, 1200); })} className="text-[11.5px] text-faint hover:text-accent">neu übersetzen</button>}
                  {canDelete && terms.length > 0 && <button onClick={() => { if (confirm('Alle Begriffe löschen?')) labelsApi.clearTerms().then(() => { refreshTerms(); refresh(); }); }} className="text-[11.5px] text-faint hover:text-danger">alle löschen</button>}
                </div>
              </div>
              {canWrite && (
                <div className="border-b border-border p-3">
                  <textarea value={termInput} onChange={(e) => setTermInput(e.target.value)} rows={3} placeholder={'Begriffe — einer pro Zeile\nz. B. benzol'} className="w-full resize-none rounded-lg border border-border bg-bg px-2.5 py-2 font-mono text-[12px] outline-none focus:border-accent" />
                  <button onClick={addTermsNow} className="mt-2 w-full rounded-lg bg-accent/90 px-3 py-1.5 text-[12.5px] font-medium text-white transition hover:bg-accent">Begriffe hinzufügen</button>
                </div>
              )}
              <div className="max-h-[300px] overflow-y-auto p-2">
                {terms.length === 0 ? <div className="px-2 py-6 text-center text-[12.5px] text-faint">Keine Begriffe.</div> :
                  terms.map((t) => (
                    <div key={t.id} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1 text-[12.5px] hover:bg-surface-2">
                      <span className="truncate font-mono">{t.term}</span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {t.variants === null
                          ? <span className="flex items-center gap-1 text-[10.5px] text-faint"><Spinner size={9} /> übersetzt…</span>
                          : t.variants.length > 0
                            ? <span className="cursor-help rounded bg-accent-soft px-1.5 py-0.5 text-[10.5px] text-accent" title={`Wird auch gesucht als:\n${t.variants.join(', ')}`}>+{t.variants.length} Spr.</span>
                            : <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10.5px] text-faint" title="Keine Übersetzung gefunden — nur Deutsch">DE</span>}
                        {canDelete && <button onClick={() => labelsApi.removeTerm(t.id).then(refreshTerms)} className="text-faint hover:text-danger" title="Entfernen"><Icon name="schliessen" size={12} /></button>}
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          </div>

          <p className="mt-5 text-[11.5px] leading-relaxed text-faint">
            Begriffe gibst du auf <strong className="text-fg">Deutsch</strong> ein — sie werden automatisch in alle Sprachen (EN/Serbisch/Chinesisch) inkl. Synonyme übersetzt und <strong className="text-fg">inhaltsgleich in jedem Etikett</strong> gesucht (Treffer wird mit dem deutschen Begriff benannt). „+N Spr." zeigt die Varianten. Geteilte Datenbank: alle Berechtigten sehen denselben Stand und Scan. OCR wird je Etikett gespeichert → Re-Scans schnell. Alles lokal/intern. Finale Entscheidung beim Menschen.
          </p>
        </div>
      </div>
    </div>
  );
}
