import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api, projectApi, type Project, type ProjectFile, type ProjectMemoryEntry, type Chat, type Klasse, type KlassenInfo } from '../lib/api';
import { Logo } from '../components/Logo';
import { Spinner } from '../components/Spinner';
import { Badge } from '../components/ui';
import { Icon } from '../components/ui';
import { branding } from '../lib/branding';

// =============================================================================
// Projekte: eigene Seite statt gedrängter Seitenleisten-Liste.
// Übersicht = Kacheln · Detail = Vorgaben, Dateien und die Chats des Projekts.
// =============================================================================

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export function Projects() {
  const nav = useNavigate();
  const { id } = useParams();
  return id ? <ProjectDetail id={id} nav={nav} /> : <ProjectList nav={nav} />;
}

// --- Übersicht ---------------------------------------------------------------
function ProjectList({ nav }: { nav: ReturnType<typeof useNavigate> }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => projectApi.list().then((r) => setProjects(r.projects)).catch(() => setProjects([])), []);
  useEffect(() => { load(); }, [load]);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const r = await projectApi.create({ name: name.trim() });
      setName('');
      setCreating(false);
      nav(`/projekte/${r.project.id}`);
    } catch { /* still */ } finally { setBusy(false); }
  }

  return (
    <div className="flex h-full flex-col">
      <Header title="Projekte" nav={nav} />
      <div className="flex-1 overflow-y-auto bg-bg p-6">
        <div className="mx-auto max-w-4xl">
          <p className="mb-5 text-[13.5px] leading-relaxed text-muted">
            Ein Projekt bündelt zusammengehörige Chats, eigene Dateien und Vorgaben an die KI.
            Alles davon gilt automatisch in jedem Chat des Projekts.
          </p>

          {creating ? (
            <div className="mb-5 rounded-card border border-border bg-surface p-4">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') create(); if (e.key === 'Escape') setCreating(false); }}
                placeholder="Name des Projekts, z. B. Umstellung Prüfpläne 2026"
                className="w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-[14px] outline-none focus:border-accent"
              />
              <div className="mt-2 flex justify-end gap-2">
                <button onClick={() => setCreating(false)} className="rounded-lg px-3 py-1.5 text-[13px] text-muted transition hover:bg-surface-2">Abbrechen</button>
                <button onClick={create} disabled={busy || !name.trim()} className="flex items-center gap-2 rounded-lg bg-accent px-4 py-1.5 text-[13px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-50">
                  {busy && <Spinner size={13} />} Anlegen
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="mb-5 flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-[14px] font-medium text-white transition hover:bg-accent-hover"
            >
              <PlusIcon /> Neues Projekt
            </button>
          )}

          {projects === null ? (
            <Spinner />
          ) : projects.length === 0 ? (
            <div className="mt-10 text-center text-muted">
              <p className="text-[15px]">Noch keine Projekte.</p>
              <p className="mt-1 text-[13px] text-faint">Lege oben das erste an.</p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {projects.map((p) => (
                <motion.button
                  key={p.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  onClick={() => nav(`/projekte/${p.id}`)}
                  className="rounded-card border border-border bg-surface p-4 text-left shadow-soft transition hover:border-accent"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-accent"><ProjectIcon /></span>
                    <span className="min-w-0 flex-1 truncate text-[14.5px] font-medium">{p.name}</span>
                  </div>
                  {p.description && <p className="mt-1.5 line-clamp-2 text-[12.5px] text-muted">{p.description}</p>}
                  <div className="mt-3 flex gap-3 text-[11.5px] text-faint">
                    <span>{p.chatCount} {p.chatCount === 1 ? 'Chat' : 'Chats'}</span>
                    <span>{p.fileCount} {p.fileCount === 1 ? 'Datei' : 'Dateien'}</span>
                    {p.instructions && <span className="text-accent">Vorgaben hinterlegt</span>}
                  </div>
                </motion.button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Detail ------------------------------------------------------------------
function ProjectDetail({ id, nav }: { id: string; nav: ReturnType<typeof useNavigate> }) {
  const [project, setProject] = useState<Project | null>(null);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [memory, setMemory] = useState<ProjectMemoryEntry[]>([]);
  const [memDraft, setMemDraft] = useState('');
  const [memEdit, setMemEdit] = useState<{ id: number; text: string } | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [form, setForm] = useState<{ name: string; description: string; instructions: string; vaultScope: 'all' | 'project' }>({ name: '', description: '', instructions: '', vaultScope: 'all' });
  const [klasse, setKlasse] = useState<Klasse>('intern');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await projectApi.get(id);
      setProject(r.project);
      setFiles(r.files);
      setMemory(r.memory ?? []);
      setForm({ name: r.project.name, description: r.project.description ?? '', instructions: r.project.instructions ?? '', vaultScope: r.project.vaultScope ?? 'all' });
      setKlasse(r.project.classification ?? 'intern');
      const cs = await api.listChats();
      setChats(cs.chats.filter((c) => c.projectId === id));
    } catch {
      setError('Projekt konnte nicht geladen werden.');
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function save() {
    setBusy(true);
    try {
      await projectApi.update(id, form);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Speichern fehlgeschlagen'); }
    finally { setBusy(false); }
  }

  async function upload(list: FileList | null) {
    if (!list?.length) return;
    setBusy(true);
    try { await projectApi.uploadFiles(id, Array.from(list)); load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Upload fehlgeschlagen'); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  }

  async function newChat() {
    const r = await api.createChat(undefined, id).catch(() => null);
    if (r) nav(`/?chat=${r.chat.id}`);
  }

  async function remove() {
    if (!confirm('Projekt löschen? Die Chats und Dateien bleiben erhalten und werden nur aus dem Projekt gelöst.')) return;
    await projectApi.remove(id).catch(() => {});
    nav('/projekte');
  }

  if (!project) return <div className="flex h-full flex-col"><Header title="Projekt" nav={nav} /><div className="p-8">{error || <Spinner />}</div></div>;

  return (
    <div className="flex h-full flex-col">
      <Header title={project.name} nav={nav} back={() => nav('/projekte')} />
      <div className="flex-1 overflow-y-auto bg-bg p-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {error && <div className="text-[12.5px] text-danger">{error}</div>}

          {/* Chats des Projekts */}
          <section className="rounded-card border border-border bg-surface p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[14px] font-medium">Chats ({chats.length})</h2>
              <button onClick={newChat} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white transition hover:bg-accent-hover">
                <PlusIcon /> Neuer Chat
              </button>
            </div>
            {chats.length === 0 ? (
              <p className="text-[12.5px] text-faint">Noch keine Chats. Starte oben einen — Vorgaben und Dateien dieses Projekts gelten dort automatisch.</p>
            ) : (
              <div className="space-y-0.5">
                {chats.map((ch) => (
                  <button key={ch.id} onClick={() => nav(`/?chat=${ch.id}`)} className="block w-full truncate rounded-lg px-2.5 py-2 text-left text-[13px] text-fg/85 transition hover:bg-surface-2">
                    {ch.title}
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* Projekt-Kontext */}
          <section className="rounded-card border border-border bg-surface p-5">
            <div className="mb-1 flex items-center justify-between">
              <h2 className="text-[14px] font-medium">Projekt-Kontext ({memory.length})</h2>
              {memory.length > 0 && (
                <button
                  onClick={async () => {
                    if (!confirm('Wirklich den gesamten Projekt-Kontext löschen?')) return;
                    for (const m of memory) await projectApi.removeMemory(id, m.id).catch(() => {});
                    load();
                  }}
                  className="text-[12px] text-muted transition hover:text-danger"
                >
                  Alles löschen
                </button>
              )}
            </div>
            <p className="mb-3 text-[12px] leading-relaxed text-muted">
              Was die KI sich in <strong className="text-fg">diesem</strong> Projekt gemerkt hat. Nur hier gültig —
              andere Projekte sehen es nicht. Du kannst jeden Punkt ändern oder löschen; Falsches wirkt sonst weiter.
            </p>

            <div className="mb-2 flex gap-2">
              <input
                value={memDraft}
                onChange={(e) => setMemDraft(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key !== 'Enter' || !memDraft.trim()) return;
                  await projectApi.addMemory(id, memDraft.trim()).catch(() => {});
                  setMemDraft('');
                  load();
                }}
                placeholder="Eigenen Punkt festhalten, z. B. Einheiten immer mit Datum nennen …"
                className="flex-1 rounded-lg border border-border-strong bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent"
              />
              <button
                onClick={async () => {
                  if (!memDraft.trim()) return;
                  await projectApi.addMemory(id, memDraft.trim()).catch(() => {});
                  setMemDraft('');
                  load();
                }}
                disabled={!memDraft.trim()}
                className="rounded-lg border border-border px-3 py-2 text-[12.5px] text-muted transition hover:border-accent hover:text-accent disabled:opacity-50"
              >
                Hinzufügen
              </button>
            </div>

            {memory.length === 0 ? (
              <p className="text-[12.5px] text-faint">
                Noch nichts gemerkt. Die KI hält hier künftig fest, was in diesem Projekt wichtig ist — oder du trägst es selbst ein.
              </p>
            ) : (
              <div className="space-y-1">
                {memory.map((m) => (
                  <div key={m.id} className="group flex items-start gap-2 rounded-lg border border-border px-2.5 py-1.5">
                    <span
                      className={`mt-0.5 shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${
                        m.source === 'manual' ? 'border-accent/25 bg-accent-soft text-accent' : 'border-border bg-surface-2 text-muted'
                      }`}
                      title={m.source === 'manual' ? 'Von dir eingetragen' : 'Von der KI aus einem Chat abgeleitet'}
                    >
                      {m.source === 'manual' ? 'selbst' : 'gelernt'}
                    </span>
                    {memEdit?.id === m.id ? (
                      <>
                        <input
                          autoFocus
                          value={memEdit.text}
                          onChange={(e) => setMemEdit({ id: m.id, text: e.target.value })}
                          onKeyDown={async (e) => {
                            if (e.key === 'Escape') setMemEdit(null);
                            if (e.key === 'Enter' && memEdit.text.trim()) {
                              await projectApi.updateMemory(id, m.id, memEdit.text.trim()).catch(() => {});
                              setMemEdit(null);
                              load();
                            }
                          }}
                          className="min-w-0 flex-1 rounded border border-accent bg-surface px-2 py-0.5 text-[12.5px] outline-none"
                        />
                        <button onClick={() => setMemEdit(null)} className="shrink-0 text-[11.5px] text-faint hover:text-fg">Abbrechen</button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => setMemEdit({ id: m.id, text: m.text })}
                          className="min-w-0 flex-1 text-left text-[12.5px] leading-snug text-fg/90"
                          title="Zum Bearbeiten klicken"
                        >
                          {m.text}
                        </button>
                        <button
                          onClick={async () => { await projectApi.removeMemory(id, m.id).catch(() => {}); load(); }}
                          title="Entfernen"
                          className="shrink-0 text-faint opacity-0 transition group-hover:opacity-100 hover:text-danger"
                        >
                          <Icon name="schliessen" size={12} />
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Vorgaben */}
          <section className="rounded-card border border-border bg-surface p-5">
            <h2 className="mb-3 text-[14px] font-medium">Vorgaben an die KI</h2>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-faint">Name</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="mb-3 w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-[14px] outline-none focus:border-accent" />
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-faint">Worum geht es?</label>
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="z. B. Umstellung der Prüfpläne 2026" className="mb-3 w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-accent" />
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-faint">Anweisungen</label>
            <textarea
              value={form.instructions}
              onChange={(e) => setForm({ ...form, instructions: e.target.value })}
              rows={5}
              placeholder={'z. B.\n- Antworte immer auf Deutsch und nenne die Norm-Referenz\n- Nutze unsere Bezeichnungen: Lagercharge statt Batch'}
              className="w-full resize-y rounded-lg border border-border-strong bg-surface px-3 py-2 text-[13px] leading-relaxed outline-none focus:border-accent"
            />
            <div className="mt-3 rounded-lg border border-border bg-surface-2/40 p-3">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">Wissensquellen</div>
              {([
                { v: 'all' as const, t: 'Ganzes Wissens-Vault mitnutzen', h: 'Standard — die KI zieht firmenweites Wissen heran.' },
                { v: 'project' as const, t: 'Nur Projektdateien verwenden', h: 'Abgeschottet: kein allgemeines Vault-Wissen. Sinnvoll für Forschung, damit fremde Inhalte die Antworten nicht verfälschen.' },
              ]).map((o) => (
                <label key={o.v} className="mb-1 flex cursor-pointer items-start gap-2 text-[12.5px]">
                  <input
                    type="radio"
                    checked={form.vaultScope === o.v}
                    onChange={() => setForm({ ...form, vaultScope: o.v })}
                    className="mt-0.5 accent-accent"
                  />
                  <span>
                    <span className="block font-medium">{o.t}</span>
                    <span className="block text-[11.5px] text-muted">{o.h}</span>
                  </span>
                </label>
              ))}
            </div>
            <Einstufung projektId={id!} aktuell={klasse} onGesetzt={setKlasse} />

            <div className="mt-2 flex items-center justify-between">
              <span className="text-[11.5px] text-faint">Vorgaben werden dem System-Prompt jedes Chats vorangestellt.</span>
              <div className="flex items-center gap-2">
                {saved && <span className="flex items-center gap-1 text-[12px] text-success"><Icon name="haken" size={12} /> Gespeichert</span>}
                <button onClick={save} disabled={busy} className="flex items-center gap-2 rounded-lg bg-accent px-4 py-1.5 text-[13px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-60">
                  {busy && <Spinner size={13} />} Speichern
                </button>
              </div>
            </div>
          </section>

          {/* Dateien */}
          <section className="rounded-card border border-border bg-surface p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[14px] font-medium">Projektdateien ({files.length})</h2>
              <input ref={fileRef} type="file" multiple hidden onChange={(e) => upload(e.target.files)} accept=".pdf,.docx,.xlsx,.xls,.txt,.md,.csv,.tsv,.json,.xml,.html,.yaml,.yml,.tex,.bib,.py,.ipynb,.r,.m,.jl,.sql,.js,.ts,.sh,.ps1,.java,.c,.cpp,.cs,.go,.rs,.php,.rb,.vba,.bas,.mol,.sdf,.cif,.png,.jpg,.jpeg,.webp" />
              <button onClick={() => fileRef.current?.click()} disabled={busy} className="rounded-lg border border-border px-2.5 py-1.5 text-[12.5px] text-muted transition hover:border-accent hover:text-accent disabled:opacity-50">
                + Datei
              </button>
            </div>
            {files.length === 0 ? (
              <p className="text-[12.5px] text-faint">Projektdateien stehen in jedem Chat des Projekts zur Verfügung — ohne sie erneut anzuhängen.</p>
            ) : (
              <div className="space-y-1">
                {files.map((f) => (
                  <div key={f.id} className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-[12.5px]">
                    <span className="min-w-0 flex-1 truncate">{f.filename}</span>
                    <span className="shrink-0 text-[11px] text-faint">{fmtSize(f.size)}</span>
                    {!f.hasText && <Icon name="warnung" size={12} className="text-warn" />}
                    <button onClick={async () => { await projectApi.removeFile(id, f.id).catch(() => {}); load(); }} className="shrink-0 text-faint hover:text-danger" title="Entfernen"><Icon name="schliessen" size={12} /></button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <button onClick={remove} className="text-[12.5px] text-muted transition hover:text-danger">Projekt löschen</button>
        </div>
      </div>
    </div>
  );
}

function Header({ title, nav, back }: { title: string; nav: ReturnType<typeof useNavigate>; back?: () => void }) {
  return (
    <header className="flex items-center justify-between border-b border-border bg-surface px-6 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <Logo size={28} />
        <span className="truncate text-[15px] font-semibold">{branding().appShort} · {title}</span>
      </div>
      <div className="flex shrink-0 gap-2">
        {back && <button onClick={back} className="rounded-lg px-3 py-1.5 text-[13px] text-muted transition hover:bg-surface-2 hover:text-accent">← Projekte</button>}
        <button onClick={() => nav('/')} className="rounded-lg px-3 py-1.5 text-[13px] text-muted transition hover:bg-surface-2 hover:text-accent">← Zum Chat</button>
      </div>
    </header>
  );
}

function PlusIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>;
}
function ProjectIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M3 11h18" />
    </svg>
  );
}


/**
 * Datenklassifizierung eines Projekts.
 *
 * Ab „Vertraulich" fließt nichts aus dem Projekt in das firmenweite Wissen der
 * KI — keine gemerkten Fakten, keine Vault-Einträge, kein Teilen des Chats.
 * Heraufstufen darf jeder Eigentümer; Herabstufen verlangt ein eigenes Recht.
 */
function Einstufung({ projektId, aktuell, onGesetzt }: { projektId: string; aktuell: Klasse; onGesetzt: (k: Klasse) => void }) {
  const [klassen, setKlassen] = useState<KlassenInfo[]>([]);
  const [darfRunter, setDarfRunter] = useState(false);
  const [laeuft, setLaeuft] = useState(false);
  const [hinweis, setHinweis] = useState('');

  useEffect(() => {
    projectApi.klassen().then((r) => { setKlassen(r.klassen); setDarfRunter(r.darfHerabstufen); }).catch(() => {});
  }, []);

  const rangVon = (k: Klasse) => klassen.find((x) => x.key === k)?.rang ?? 1;

  async function setze(k: Klasse) {
    if (k === aktuell) return;
    const runter = rangVon(k) < rangVon(aktuell);
    if (runter && !darfRunter) { setHinweis('Herabstufen erfordert das Recht „Einstufung herabsetzen".'); return; }
    if (runter && !confirm(`Einstufung wirklich herabsetzen? Damit dürfen Inhalte dieses Projekts wieder in das firmenweite Wissen der KI einfließen.`)) return;
    setLaeuft(true); setHinweis('');
    try {
      const r = await projectApi.setProjectClassification(projektId, k, true);
      onGesetzt(r.classification);
      setHinweis(r.dateien > 0 ? `${r.dateien} Datei(en) mitgestuft.` : 'Gesetzt.');
    } catch (e) {
      setHinweis(e instanceof Error ? e.message : 'Fehlgeschlagen');
    } finally { setLaeuft(false); }
  }

  const geschuetzt = rangVon(aktuell) >= 2;
  return (
    <div className={`mt-3 rounded-lg border p-3 ${geschuetzt ? 'border-warn/40 bg-warn/5' : 'border-border bg-surface-2/40'}`}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">Datenklassifizierung</span>
        {geschuetzt && <Badge tone="warn">geschützt</Badge>}
      </div>
      <div className="space-y-1">
        {klassen.map((k) => (
          <label key={k.key} className="flex cursor-pointer items-start gap-2 text-[12.5px]">
            <input
              type="radio"
              checked={aktuell === k.key}
              disabled={laeuft}
              onChange={() => setze(k.key)}
              className="mt-0.5 accent-accent"
            />
            <span>
              <span className="block font-medium">{k.label}</span>
              <span className="block text-[11.5px] text-muted">{k.kurz}</span>
            </span>
          </label>
        ))}
      </div>
      {geschuetzt && (
        <div className="mt-2 border-t border-border pt-2 text-[11.5px] leading-relaxed text-muted">
          Aus diesem Projekt entstehen <strong>keine dauerhaften Merksätze</strong>, nichts gelangt ins firmenweite
          Wissens-Vault, und Chats dazu lassen sich <strong>nicht teilen</strong>. Neue Dateien werden automatisch
          mit eingestuft.
        </div>
      )}
      {hinweis && <div className="mt-2 text-[11.5px] text-muted">{hinweis}</div>}
    </div>
  );
}
