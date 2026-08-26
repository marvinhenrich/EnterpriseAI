import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { kbApi, type KbDocument, type VaultNote, type VaultStats, type VaultSearchHit, type LinkRef, type VaultRevision, type VaultVisibility } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Logo } from '../components/Logo';
import { Markdown } from '../components/Markdown';
import { Spinner } from '../components/Spinner';
import { Icon, CloseButton } from '../components/ui';
import { branding } from '../lib/branding';

// =============================================================================
// Wissens-Vault: firmenweites Wissenssystem — Notizen (Markdown mit
// [[Wiki-Links]] und Backlinks) plus hochgeladene Dokumente. Alles wird
// indexiert und von der KI im Chat automatisch als Quelle genutzt.
// =============================================================================

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDate(s: string | null): string {
  if (!s) return '';
  return s.replace('T', ' ').replace(/\.\d+Z?$/, '').slice(0, 16);
}

/** [[Wiki-Links]] in klickbare Markdown-Links umschreiben. */
function renderWikiLinks(md: string): string {
  return md.replace(/\[\[([^\][|]+?)(?:\|([^\]]*))?\]\]/g, (_m, title: string, label?: string) => {
    const t = title.trim();
    return `[${(label ?? t).trim()}](#wiki:${encodeURIComponent(t)})`;
  });
}

const VIS_LABEL: Record<string, { label: string; tone: 'neutral' | 'warn' | 'danger' }> = {
  '': { label: 'Alle', tone: 'neutral' },
  restricted: { label: 'Vertraulich', tone: 'warn' },
  it: { label: 'IT-intern', tone: 'danger' },
};

type Selection = { type: 'note' | 'document'; id: string } | null;

export function Vault() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const canManage = !!user?.permissions?.includes('kb.manage');

  const [notes, setNotes] = useState<VaultNote[]>([]);
  const [docs, setDocs] = useState<KbDocument[]>([]);
  const [stats, setStats] = useState<VaultStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [sel, setSel] = useState<Selection>(null);
  const [noteBody, setNoteBody] = useState<{ note: VaultNote & { content: string }; backlinks: LinkRef[]; links: { title: string; id: string | null }[] } | null>(null);
  const [docBody, setDocBody] = useState<{ document: KbDocument; text: string } | null>(null);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<{ title: string; content: string; folder: string; tags: string; visibility: VaultVisibility; aiUse: boolean }>({ title: '', content: '', folder: '', tags: '', visibility: '', aiUse: true });

  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'text' | 'semantic'>('text');
  const [hits, setHits] = useState<VaultSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [showCollected, setShowCollected] = useState(false);
  const [folderFilter, setFolderFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await kbApi.overview();
      setNotes(r.notes);
      setDocs(r.documents);
      setStats(r.stats);
    } catch {
      setError('Vault konnte nicht geladen werden.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Aus dem Chat verlinkte Quelle direkt öffnen: /vault?note=… bzw. ?doc=…
  useEffect(() => {
    const noteId = searchParams.get('note');
    const docId = searchParams.get('doc');
    if (noteId) setSel({ type: 'note', id: noteId });
    else if (docId) setSel({ type: 'document', id: docId });
    if (noteId || docId) setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Auswahl laden (Notiz oder Dokument).
  useEffect(() => {
    if (!sel) { setNoteBody(null); setDocBody(null); return; }
    setEditing(false);
    if (sel.type === 'note') {
      setDocBody(null);
      kbApi.note(sel.id).then(setNoteBody).catch(() => setError('Notiz konnte nicht geladen werden.'));
    } else {
      setNoteBody(null);
      kbApi.documentContent(sel.id).then(setDocBody).catch(() => setError('Dokument konnte nicht geladen werden.'));
    }
  }, [sel]);

  // Suche (debounced).
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setHits(null); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(() => {
      kbApi.search(q, mode)
        .then((r) => setHits(r.hits))
        .catch(() => setHits([]))
        .finally(() => setSearching(false));
    }, 280);
    return () => clearTimeout(t);
  }, [query, mode]);

  // Gefilterte Listen für die Seitenleiste.
  const visibleNotes = useMemo(
    () => notes.filter((n) => (!folderFilter || n.folder === folderFilter || n.folder.startsWith(folderFilter + '/')) && (!tagFilter || n.tags.includes(tagFilter))),
    [notes, folderFilter, tagFilter],
  );
  const visibleDocs = useMemo(
    () => docs.filter((d) => (!folderFilter || d.folder === folderFilter || d.folder.startsWith(folderFilter + '/')) && (!tagFilter || d.tags.includes(tagFilter))),
    [docs, folderFilter, tagFilter],
  );

  async function newNote(title = 'Neue Notiz') {
    let name = title;
    for (let i = 2; notes.some((n) => n.title.toLowerCase() === name.toLowerCase()); i++) name = `${title} ${i}`;
    setBusy(true);
    setError('');
    try {
      const r = await kbApi.createNote({ title: name, content: '', folder: folderFilter, tags: tagFilter ? [tagFilter] : [] });
      await load();
      setSel({ type: 'note', id: r.note.id });
      setDraft({ title: r.note.title, content: '', folder: r.note.folder, tags: r.note.tags.join(', '), visibility: r.note.visibility ?? '', aiUse: r.note.aiUse !== false });
      setEditing(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Notiz konnte nicht angelegt werden.');
    } finally {
      setBusy(false);
    }
  }

  function startEdit() {
    if (!noteBody) return;
    setDraft({
      title: noteBody.note.title,
      content: noteBody.note.content,
      folder: noteBody.note.folder,
      tags: noteBody.note.tags.join(', '),
      visibility: noteBody.note.visibility ?? '',
      aiUse: noteBody.note.aiUse !== false,
    });
    setEditing(true);
  }

  async function saveNote() {
    if (!sel || sel.type !== 'note') return;
    setBusy(true);
    setError('');
    try {
      const r = await kbApi.updateNote(sel.id, {
        title: draft.title,
        content: draft.content,
        folder: draft.folder,
        tags: draft.tags.split(',').map((t) => t.trim()).filter(Boolean),
        visibility: draft.visibility,
        aiUse: draft.aiUse,
      });
      setNoteBody((b) => (b ? { ...b, note: r.note } : b));
      setEditing(false);
      await load();
      // Backlinks/Links neu holen (Titel oder Verweise könnten sich geändert haben).
      kbApi.note(sel.id).then(setNoteBody).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Speichern fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  async function removeNote(n: { id: string; title: string }) {
    if (!confirm(`Notiz „${n.title}" löschen?`)) return;
    await kbApi.deleteNote(n.id).catch(() => {});
    if (sel?.id === n.id) setSel(null);
    load();
  }

  async function removeDoc(d: KbDocument) {
    if (!confirm(`„${d.title}" aus dem Wissens-Vault entfernen?`)) return;
    await kbApi.remove(d.id).catch(() => {});
    if (sel?.id === d.id) setSel(null);
    load();
  }

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError('');
    try {
      await kbApi.upload(Array.from(files), { folder: folderFilter, tags: tagFilter ? [tagFilter] : [] });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload fehlgeschlagen');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  /** Klick auf einen [[Wiki-Link]] im gerenderten Markdown abfangen. */
  function onPreviewClick(e: React.MouseEvent<HTMLDivElement>) {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    const href = a.getAttribute('href') ?? '';
    if (!href.startsWith('#wiki:')) return;
    e.preventDefault();
    const title = decodeURIComponent(href.slice(6));
    const target = notes.find((n) => n.title.toLowerCase() === title.toLowerCase());
    if (target) setSel({ type: 'note', id: target.id });
    else if (canManage && confirm(`Notiz „${title}" existiert noch nicht. Jetzt anlegen?`)) newNote(title);
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-surface px-6 py-3">
        <div className="flex items-center gap-3">
          <Logo size={28} />
          <span className="text-[15px] font-semibold">{branding().appShort} · Wissens-Vault</span>
          {stats && (
            <span className="ml-2 text-[11.5px] text-faint">
              {stats.notes} Notizen · {stats.documents} Dokumente · {stats.chunks} Abschnitte indexiert
            </span>
          )}
        </div>
        <button onClick={() => nav('/')} className="rounded-lg px-3 py-1.5 text-[13px] text-muted transition hover:bg-surface-2 hover:text-accent">
          ← Zum Chat
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ---- Seitenleiste ---- */}
        <aside className="flex w-[290px] shrink-0 flex-col border-r border-border bg-surface">
          <div className="space-y-2 border-b border-border p-3">
            <div className="relative">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"><SearchIcon /></span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Vault durchsuchen …"
                className="w-full rounded-lg border border-border bg-surface py-2 pl-8 pr-7 text-[13px] outline-none transition focus:border-accent"
              />
              {query && (
                <CloseButton onClick={() => setQuery('')} label="Suche leeren" className="absolute right-1.5 top-1/2 -translate-y-1/2" />
              )}
            </div>
            <div className="flex gap-1">
              {(['text', 'semantic'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`flex-1 rounded-lg border px-2 py-1 text-[11.5px] transition ${mode === m ? 'border-accent text-accent' : 'border-border text-muted hover:border-border-strong'}`}
                >
                  {m === 'text' ? 'Volltext' : 'KI-Suche'}
                </button>
              ))}
            </div>
            {canManage && (
              <div className="flex gap-1.5">
                <button
                  onClick={() => newNote()}
                  disabled={busy}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-2 py-1.5 text-[12.5px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-60"
                >
                  <PlusIcon /> Notiz
                </button>
                <input ref={fileRef} type="file" multiple hidden onChange={(e) => onFiles(e.target.files)} accept=".pdf,.docx,.xlsx,.xls,.txt,.md,.csv,.tsv,.json,.xml,.html,.yaml,.yml,.tex,.bib,.py,.ipynb,.r,.m,.jl,.sql,.js,.ts,.sh,.ps1,.java,.c,.cpp,.cs,.go,.rs,.php,.rb,.vba,.bas,.mol,.sdf,.cif" />
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={busy}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border px-2 py-1.5 text-[12.5px] text-muted transition hover:border-accent hover:text-accent disabled:opacity-60"
                >
                  {busy ? <Spinner size={12} /> : <UploadIcon />} Datei
                </button>
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {hits !== null ? (
              // --- Suchergebnisse ---
              searching && hits.length === 0 ? (
                <div className="flex items-center gap-2 px-2 py-3 text-[12.5px] text-muted"><Spinner size={13} /> Suche …</div>
              ) : hits.length === 0 ? (
                <div className="px-2 py-3 text-[12.5px] text-faint">Keine Treffer.</div>
              ) : (
                <>
                  <div className="mb-1 px-2 text-[10.5px] font-semibold uppercase tracking-wide text-faint">{hits.length} Treffer</div>
                  {hits.map((h) => (
                    <button
                      key={`${h.type}-${h.id}`}
                      onClick={() => setSel({ type: h.type, id: h.id })}
                      className={`mb-0.5 block w-full rounded-lg px-2 py-1.5 text-left transition ${sel?.id === h.id ? 'bg-accent-soft' : 'hover:bg-surface-2'}`}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="shrink-0 text-faint">{h.type === 'note' ? <NoteIcon /> : <FileIcon />}</span>
                        <span className="flex-1 truncate text-[13px] font-medium">{h.title}</span>
                        {h.score !== undefined && <span className="shrink-0 rounded bg-surface-2 px-1 text-[10px] text-faint">{h.score}%</span>}
                      </div>
                      {h.snippet && <div className="mt-0.5 line-clamp-2 pl-5 text-[11px] leading-snug text-muted">{h.snippet}</div>}
                    </button>
                  ))}
                </>
              )
            ) : (
              // --- Ordner, Tags, Inhalte ---
              <>
                {(folderFilter || tagFilter) && (
                  <button onClick={() => { setFolderFilter(''); setTagFilter(''); }} className="mb-1.5 flex w-full items-center gap-1 rounded-lg bg-accent-soft px-2 py-1 text-[11.5px] text-accent">
                    <Icon name="schliessen" size={11} /> Filter: {folderFilter || `#${tagFilter}`}
                  </button>
                )}

                {stats && stats.folders.length > 0 && !folderFilter && (
                  <div className="mb-2">
                    <div className="mb-1 px-2 text-[10.5px] font-semibold uppercase tracking-wide text-faint">Ordner</div>
                    {stats.folders.map((f) => (
                      <button key={f} onClick={() => setFolderFilter(f)} className="mb-0.5 flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-[12.5px] text-fg/80 transition hover:bg-surface-2">
                        <FolderIcon /> <span className="truncate">{f}</span>
                      </button>
                    ))}
                  </div>
                )}

                {stats && stats.tags.length > 0 && !tagFilter && (
                  <div className="mb-2">
                    <div className="mb-1 px-2 text-[10.5px] font-semibold uppercase tracking-wide text-faint">Tags</div>
                    <div className="flex flex-wrap gap-1 px-1">
                      {stats.tags.slice(0, 24).map((t) => (
                        <button key={t.tag} onClick={() => setTagFilter(t.tag)} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted transition hover:border-accent hover:text-accent">
                          #{t.tag} <span className="text-faint">{t.count}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mb-1 mt-2 px-2 text-[10.5px] font-semibold uppercase tracking-wide text-faint">
                  Notizen ({visibleNotes.filter((n) => n.folder !== 'Automatisch gesammelt').length})
                </div>
                {visibleNotes.filter((n) => n.folder !== 'Automatisch gesammelt').length === 0 && <div className="px-2 pb-1 text-[12px] text-faint">Keine Notizen.</div>}
                {visibleNotes.filter((n) => n.folder !== 'Automatisch gesammelt').map((n) => (
                  <div key={n.id} className={`group mb-0.5 flex items-center gap-1.5 rounded-lg px-2 py-1.5 transition ${sel?.id === n.id ? 'bg-accent-soft text-accent' : 'text-fg/85 hover:bg-surface-2'}`}>
                    <span className="shrink-0 text-faint"><NoteIcon /></span>
                    <button onClick={() => setSel({ type: 'note', id: n.id })} className="min-w-0 flex-1 truncate text-left text-[13px]">{n.title}</button>
                    {n.visibility !== '' && (
                      <span className={`shrink-0 ${n.visibility === 'it' ? 'text-danger' : 'text-warn'}`} title={VIS_LABEL[n.visibility]?.label}>
                        <Icon name="schloss" size={11} />
                      </span>
                    )}
                    {canManage && (
                      <button onClick={() => removeNote(n)} title="Löschen" className="shrink-0 opacity-0 transition group-hover:opacity-100 hover:text-danger"><TrashIcon /></button>
                    )}
                  </div>
                ))}

                {visibleNotes.some((n) => n.folder === 'Automatisch gesammelt') && (
                  <div className="mt-3">
                    <button
                      onClick={() => setShowCollected((v) => !v)}
                      className="mb-1 flex w-full items-center gap-1.5 px-2 text-[10.5px] font-semibold uppercase tracking-wide text-faint transition hover:text-accent"
                    >
                      <Icon name={showCollected ? 'chevronUnten' : 'chevronRechts'} size={11} />
                      Automatisch gesammelt ({visibleNotes.filter((n) => n.folder === 'Automatisch gesammelt').length})
                    </button>
                    {showCollected ? (
                      visibleNotes.filter((n) => n.folder === 'Automatisch gesammelt').map((n) => (
                        <div key={n.id} className={`group mb-0.5 flex items-center gap-1.5 rounded-lg px-2 py-1.5 transition ${sel?.id === n.id ? 'bg-accent-soft text-accent' : 'text-fg/70 hover:bg-surface-2'}`}>
                          <span className="shrink-0 text-faint"><NoteIcon /></span>
                          <button onClick={() => setSel({ type: 'note', id: n.id })} className="min-w-0 flex-1 truncate text-left text-[12.5px]">{n.title}</button>
                          {canManage && (
                            <button onClick={() => removeNote(n)} title="Löschen" className="shrink-0 opacity-0 transition group-hover:opacity-100 hover:text-danger"><TrashIcon /></button>
                          )}
                        </div>
                      ))
                    ) : (
                      <p className="px-2 text-[11px] leading-snug text-faint">
                        Ungeprüft aus Gesprächen abgeleitet — fließt nicht in KI-Antworten ein.
                      </p>
                    )}
                  </div>
                )}

                <div className="mb-1 mt-3 px-2 text-[10.5px] font-semibold uppercase tracking-wide text-faint">Dokumente ({visibleDocs.length})</div>
                {visibleDocs.length === 0 && <div className="px-2 text-[12px] text-faint">Keine Dokumente.</div>}
                {visibleDocs.map((d) => (
                  <div key={d.id} className={`group mb-0.5 flex items-center gap-1.5 rounded-lg px-2 py-1.5 transition ${sel?.id === d.id ? 'bg-accent-soft text-accent' : 'text-fg/85 hover:bg-surface-2'}`}>
                    <span className="shrink-0 text-faint"><FileIcon /></span>
                    <button onClick={() => setSel({ type: 'document', id: d.id })} className="min-w-0 flex-1 truncate text-left text-[13px]">{d.title}</button>
                    {canManage && (
                      <button onClick={() => removeDoc(d)} title="Entfernen" className="shrink-0 opacity-0 transition group-hover:opacity-100 hover:text-danger"><TrashIcon /></button>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        </aside>

        {/* ---- Hauptbereich ---- */}
        <main className="min-w-0 flex-1 overflow-y-auto bg-bg">
          {error && <div className="border-b border-border bg-surface px-6 py-2 text-[12.5px] text-danger">{error}</div>}

          {loading ? (
            <div className="p-8"><Spinner /></div>
          ) : !sel ? (
            <WelcomePane stats={stats} canManage={canManage} onNew={() => newNote()} />
          ) : sel.type === 'note' ? (
            !noteBody ? (
              <div className="p-8"><Spinner /></div>
            ) : editing ? (
              <div className="mx-auto max-w-3xl p-6">
                <input
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  placeholder="Titel"
                  className="mb-3 w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-[18px] font-semibold outline-none focus:border-accent"
                />
                <div className="mb-3 flex gap-2">
                  <input
                    value={draft.folder}
                    onChange={(e) => setDraft({ ...draft, folder: e.target.value })}
                    placeholder="Ordner (z. B. QM/Prüfpläne)"
                    className="flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-[12.5px] outline-none focus:border-accent"
                  />
                  <input
                    value={draft.tags}
                    onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
                    placeholder="Tags, kommagetrennt"
                    className="flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-[12.5px] outline-none focus:border-accent"
                  />
                </div>
                <div className="mb-3 flex items-center gap-2">
                  <label className="text-[12px] text-muted">Sichtbarkeit</label>
                  <select
                    value={draft.visibility}
                    onChange={(e) => setDraft({ ...draft, visibility: e.target.value as VaultVisibility })}
                    className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent"
                  >
                    <option value="">Alle — für jeden mit Vault-Zugang</option>
                    <option value="restricted">Vertraulich — nur mit gesondertem Leserecht</option>
                    <option value="it">IT-intern — Netze, Server, Zugänge</option>
                  </select>
                  {draft.visibility !== '' && (
                    <span className="text-[11.5px] text-warn">
                      Wird für alle anderen unsichtbar — auch für die KI-Antworten.
                    </span>
                  )}
                </div>
                <label className="mb-3 flex items-center gap-2 text-[12.5px]">
                  <input
                    type="checkbox"
                    checked={draft.aiUse}
                    onChange={(e) => setDraft({ ...draft, aiUse: e.target.checked })}
                    className="accent-accent"
                  />
                  <span>Von der KI in Antworten verwenden</span>
                  {!draft.aiUse && <span className="text-[11.5px] text-faint">— bleibt durchsuchbar, fließt aber nicht in Antworten ein</span>}
                </label>
                <textarea
                  value={draft.content}
                  onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                  onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); saveNote(); } }}
                  rows={22}
                  placeholder={'Markdown schreiben …\n\nMit [[Titel einer anderen Notiz]] verlinken.'}
                  className="w-full resize-y rounded-lg border border-border-strong bg-surface px-3.5 py-3 font-mono text-[13px] leading-relaxed outline-none focus:border-accent"
                />
                <div className="mt-3 flex items-center justify-between">
                  <span className="text-[11.5px] text-faint">[[Doppelklammern]] verlinken auf andere Notizen · ⌘/Strg + Enter speichert</span>
                  <div className="flex gap-2">
                    <button onClick={() => setEditing(false)} className="rounded-lg px-3 py-1.5 text-[13px] text-muted transition hover:bg-surface-2">Abbrechen</button>
                    <button onClick={saveNote} disabled={busy} className="flex items-center gap-2 rounded-lg bg-accent px-4 py-1.5 text-[13px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-60">
                      {busy && <Spinner size={13} />} Speichern
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="mx-auto max-w-3xl p-6">
                <div className="mb-1 flex items-start justify-between gap-4">
                  <h1 className="text-[22px] font-semibold leading-tight">{noteBody.note.title}</h1>
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => setHistoryFor(noteBody.note.id)}
                      title="Änderungsverlauf ansehen"
                      className="rounded-lg border border-border px-3 py-1.5 text-[12.5px] text-muted transition hover:border-accent hover:text-accent"
                    >
                      Verlauf
                    </button>
                    {canManage && (
                      <button onClick={startEdit} className="rounded-lg border border-border px-3 py-1.5 text-[12.5px] text-muted transition hover:border-accent hover:text-accent">
                        Bearbeiten
                      </button>
                    )}
                  </div>
                </div>
                <div className="mb-4 flex flex-wrap items-center gap-2 text-[11.5px] text-faint">
                  {noteBody.note.visibility !== '' && (
                    <span className={`rounded-md border px-1.5 py-0.5 font-medium ${
                      VIS_LABEL[noteBody.note.visibility]?.tone === 'danger' ? 'border-danger/25 bg-danger/8 text-danger' : 'border-warn/25 bg-warn/8 text-warn'
                    }`} title="Eingeschränkt sichtbar — nur mit passendem Leserecht">
                      {VIS_LABEL[noteBody.note.visibility]?.label}
                    </span>
                  )}
                  {noteBody.note.folder && <button onClick={() => { setFolderFilter(noteBody.note.folder); setSel(null); }} className="flex items-center gap-1 hover:text-accent"><FolderIcon /> {noteBody.note.folder}</button>}
                  {noteBody.note.tags.map((t) => (
                    <button key={t} onClick={() => { setTagFilter(t); setSel(null); }} className="rounded-full border border-border px-2 py-0.5 hover:border-accent hover:text-accent">#{t}</button>
                  ))}
                  <span>Zuletzt: {fmtDate(noteBody.note.updatedAt)}{noteBody.note.updatedByName ? ` · ${noteBody.note.updatedByName}` : ''}</span>
                  <span className="rounded bg-surface-2 px-1.5 py-0.5">{noteBody.note.chunks} Abschnitte indexiert</span>
                  {noteBody.note.aiUse === false && (
                    <span className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-muted" title="Diese Notiz fließt nicht in KI-Antworten ein.">
                      nicht für KI-Antworten
                    </span>
                  )}
                </div>

                {noteBody.note.content.trim() ? (
                  <div onClick={onPreviewClick} className="vault-prose">
                    <Markdown content={renderWikiLinks(noteBody.note.content)} />
                  </div>
                ) : (
                  <p className="text-[13.5px] text-faint">Diese Notiz ist noch leer.{canManage && ' Klicke auf „Bearbeiten", um Inhalt zu ergänzen.'}</p>
                )}

                {(noteBody.backlinks.length > 0 || noteBody.links.length > 0) && (
                  <div className="mt-8 grid gap-4 border-t border-border pt-5 sm:grid-cols-2">
                    <div>
                      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">Verweist auf ({noteBody.links.length})</div>
                      {noteBody.links.length === 0 && <div className="text-[12.5px] text-faint">—</div>}
                      {noteBody.links.map((l) => (
                        <button
                          key={l.title}
                          onClick={() => (l.id ? setSel({ type: 'note', id: l.id }) : canManage && newNote(l.title))}
                          className={`mb-0.5 block w-full truncate rounded px-2 py-1 text-left text-[13px] transition hover:bg-surface-2 ${l.id ? 'text-accent' : 'text-faint italic'}`}
                        >
                          {l.title}{!l.id && ' (fehlt)'}
                        </button>
                      ))}
                    </div>
                    <div>
                      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">Wird erwähnt in ({noteBody.backlinks.length})</div>
                      {noteBody.backlinks.length === 0 && <div className="text-[12.5px] text-faint">—</div>}
                      {noteBody.backlinks.map((b) => (
                        <button key={b.id} onClick={() => setSel({ type: 'note', id: b.id })} className="mb-0.5 block w-full truncate rounded px-2 py-1 text-left text-[13px] text-accent transition hover:bg-surface-2">
                          {b.title}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </motion.div>
            )
          ) : !docBody ? (
            <div className="p-8"><Spinner /></div>
          ) : (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="mx-auto max-w-3xl p-6">
              <div className="mb-1 flex items-start justify-between gap-4">
                <h1 className="text-[22px] font-semibold leading-tight">{docBody.document.title}</h1>
                <button
                  onClick={() => kbApi.downloadDocument(docBody.document.id, docBody.document.filename).catch(() => setError('Download fehlgeschlagen'))}
                  className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-[12.5px] text-muted transition hover:border-accent hover:text-accent"
                >
                  Original herunterladen
                </button>
              </div>
              <div className="mb-4 flex flex-wrap items-center gap-2 text-[11.5px] text-faint">
                <span>{docBody.document.filename}</span>
                <span>{fmtSize(docBody.document.size)}</span>
                {docBody.document.folder && <span className="flex items-center gap-1"><FolderIcon /> {docBody.document.folder}</span>}
                {docBody.document.tags.map((t) => <span key={t} className="rounded-full border border-border px-2 py-0.5">#{t}</span>)}
                <span className="rounded bg-surface-2 px-1.5 py-0.5">{docBody.document.chunks} Abschnitte indexiert</span>
              </div>
              {docBody.text.trim() ? (
                <pre className="whitespace-pre-wrap rounded-card border border-border bg-surface p-4 text-[13px] leading-relaxed text-fg/90">{docBody.text}</pre>
              ) : (
                <p className="text-[13.5px] text-faint">Aus dieser Datei konnte kein Text extrahiert werden (z. B. reiner Scan ohne OCR).</p>
              )}
            </motion.div>
          )}
        </main>
      </div>

      {historyFor && (
        <HistoryPanel
          noteId={historyFor}
          canManage={canManage}
          onClose={() => setHistoryFor(null)}
          onRestored={() => { load(); if (sel?.type === 'note') kbApi.note(sel.id).then(setNoteBody).catch(() => {}); }}
        />
      )}
    </div>
  );
}

function WelcomePane({ stats, canManage, onNew }: { stats: VaultStats | null; canManage: boolean; onNew: () => void }) {
  return (
    <div className="mx-auto max-w-2xl p-8">
      <div className="mb-5 flex justify-center"><Logo size={46} /></div>
      <h2 className="text-center text-[20px] font-semibold">Wissens-Vault</h2>
      <p className="mx-auto mt-2 max-w-lg text-center text-[13.5px] leading-relaxed text-muted">
        Das firmenweite Wissenssystem: eigene <strong className="text-fg">Notizen</strong> (Markdown, mit
        <code className="mx-1 rounded bg-surface-2 px-1 text-[12px]">[[Verlinkung]]</code>) und hochgeladene
        <strong className="text-fg"> Dokumente</strong>. Alles wird indexiert — die KI zieht es im Chat automatisch als Quelle heran.
        Bleibt strikt intern.
      </p>
      {stats && (
        <div className="mt-6 grid grid-cols-3 gap-3">
          {[
            { label: 'Notizen', value: stats.notes },
            { label: 'Dokumente', value: stats.documents },
            { label: 'Abschnitte', value: stats.chunks },
          ].map((s) => (
            <div key={s.label} className="rounded-card border border-border bg-surface p-4 text-center">
              <div className="text-[22px] font-semibold tabular-nums">{s.value}</div>
              <div className="text-[12px] text-muted">{s.label}</div>
            </div>
          ))}
        </div>
      )}
      {canManage && (
        <div className="mt-6 text-center">
          <button onClick={onNew} className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-[14px] font-medium text-white transition hover:bg-accent-hover">
            <PlusIcon /> Erste Notiz anlegen
          </button>
        </div>
      )}
      <p className="mt-6 text-center text-[12px] text-faint">Links auswählen, um eine Notiz oder ein Dokument zu öffnen.</p>
    </div>
  );
}

/* --- Icons --- */
function PlusIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>;
}
function SearchIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>;
}
function NoteIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h5" /></svg>;
}
function FileIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M13 2v7h7" /></svg>;
}
function FolderIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>;
}
function TrashIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>;
}
function UploadIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M12 3v13M7 8l5-5 5 5" /></svg>;
}


// =============================================================================
// Versionshistorie im GitHub-Stil: Liste der Stände + zeilenweiser Vergleich.
// =============================================================================

interface DiffLine { type: 'add' | 'del' | 'ctx'; text: string; ln?: number; rn?: number }

/** Zeilenweiser Vergleich über die längste gemeinsame Teilfolge (LCS). */
function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // LCS-Matrix (bei sehr großen Texten begrenzt, um die UI nicht zu blockieren).
  const MAX = 1200;
  if (a.length > MAX || b.length > MAX) {
    return [
      ...a.map((t): DiffLine => ({ type: 'del', text: t })),
      ...b.map((t): DiffLine => ({ type: 'add', text: t })),
    ];
  }
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);

  const out: DiffLine[] = [];
  let i = 0, j = 0, ln = 1, rn = 1;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ type: 'ctx', text: a[i]!, ln: ln++, rn: rn++ }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { out.push({ type: 'del', text: a[i]!, ln: ln++ }); i++; }
    else { out.push({ type: 'add', text: b[j]!, rn: rn++ }); j++; }
  }
  while (i < m) out.push({ type: 'del', text: a[i++]!, ln: ln++ });
  while (j < n) out.push({ type: 'add', text: b[j++]!, rn: rn++ });
  return out;
}

/** Unveränderte Blöcke zusammenfalten (wie GitHub), Kontext drumherum zeigen. */
function collapse(lines: DiffLine[], ctx = 3): (DiffLine | { type: 'gap'; count: number })[] {
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (l.type === 'ctx') return;
    for (let k = Math.max(0, i - ctx); k <= Math.min(lines.length - 1, i + ctx); k++) keep.add(k);
  });
  const out: (DiffLine | { type: 'gap'; count: number })[] = [];
  let gap = 0;
  lines.forEach((l, i) => {
    if (keep.has(i)) {
      if (gap > 0) { out.push({ type: 'gap', count: gap }); gap = 0; }
      out.push(l);
    } else gap++;
  });
  if (gap > 0) out.push({ type: 'gap', count: gap });
  return out;
}

function DiffView({ before, after }: { before: string; after: string }) {
  const rows = collapse(diffLines(before, after));
  const added = rows.filter((r) => r.type === 'add').length;
  const removed = rows.filter((r) => r.type === 'del').length;
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center gap-3 border-b border-border bg-surface-2 px-3 py-1.5 text-[11.5px]">
        <span className="text-green-600">+{added}</span>
        <span className="text-red-600">−{removed}</span>
        <span className="text-faint">Zeilen</span>
      </div>
      <div className="max-h-[52vh] overflow-auto bg-surface font-mono text-[12px] leading-[1.5]">
        {rows.map((r, i) =>
          r.type === 'gap' ? (
            <div key={i} className="border-y border-border bg-surface-2/60 px-3 py-0.5 text-center text-[11px] text-faint">
{r.count} unveränderte Zeilen
            </div>
          ) : (
            <div
              key={i}
              className={`flex ${r.type === 'add' ? 'bg-green-500/10' : r.type === 'del' ? 'bg-red-500/10' : ''}`}
            >
              <span className="w-10 shrink-0 select-none border-r border-border px-1 text-right text-[10.5px] text-faint">{r.ln ?? ''}</span>
              <span className="w-10 shrink-0 select-none border-r border-border px-1 text-right text-[10.5px] text-faint">{r.rn ?? ''}</span>
              <span className={`w-4 shrink-0 select-none text-center ${r.type === 'add' ? 'text-green-600' : r.type === 'del' ? 'text-red-600' : 'text-faint'}`}>
                {r.type === 'add' ? '+' : r.type === 'del' ? '−' : ''}
              </span>
              <span className="whitespace-pre-wrap break-words px-2">{r.text || ' '}</span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

export function HistoryPanel({ noteId, canManage, onClose, onRestored }: {
  noteId: string; canManage: boolean; onClose: () => void; onRestored: () => void;
}) {
  const [revs, setRevs] = useState<VaultRevision[] | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [detail, setDetail] = useState<{ content: string; prev: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { kbApi.history(noteId).then((r) => { setRevs(r.revisions); setSel(r.revisions[0]?.id ?? null); }).catch(() => setRevs([])); }, [noteId]);
  useEffect(() => {
    if (sel == null) { setDetail(null); return; }
    kbApi.revision(noteId, sel).then((r) => setDetail({ content: r.revision.content, prev: r.previous?.content ?? '' })).catch(() => setDetail(null));
  }, [noteId, sel]);

  async function restore(revId: number) {
    if (!confirm('Diesen Stand wiederherstellen? Die Historie bleibt vollständig erhalten.')) return;
    setBusy(true);
    try { await kbApi.restoreRevision(noteId, revId); onRestored(); onClose(); }
    catch { /* still */ }
    finally { setBusy(false); }
  }

  const ACTION_LABEL: Record<string, string> = { create: 'angelegt', update: 'bearbeitet', restore: 'wiederhergestellt' };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}
        onClick={(e) => e.stopPropagation()}
        className="flex h-[82vh] w-[min(96vw,1000px)] flex-col overflow-hidden rounded-card border border-border bg-surface shadow-pop"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div>
            <h3 className="text-[15px] font-semibold">Änderungsverlauf</h3>
            <p className="text-[11.5px] text-faint">Wer hat wann was geändert — jeder Stand bleibt erhalten.</p>
          </div>
          <CloseButton onClick={onClose} />
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Versionsliste */}
          <div className="w-[300px] shrink-0 overflow-y-auto border-r border-border">
            {revs === null ? (
              <div className="p-4"><Spinner /></div>
            ) : revs.length === 0 ? (
              <div className="p-4 text-[12.5px] text-faint">Noch keine Versionen erfasst.</div>
            ) : (
              revs.map((r, i) => (
                <button
                  key={r.id}
                  onClick={() => setSel(r.id)}
                  className={`block w-full border-b border-border/60 px-3 py-2.5 text-left transition ${sel === r.id ? 'bg-accent-soft' : 'hover:bg-surface-2'}`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${r.action === 'create' ? 'bg-green-500' : r.action === 'restore' ? 'bg-amber-500' : 'bg-accent'}`} />
                    <span className="flex-1 truncate text-[12.5px] font-medium">{r.editedBy ?? 'unbekannt'}</span>
                    {i === 0 && <span className="shrink-0 rounded bg-surface-2 px-1 text-[10px] text-faint">aktuell</span>}
                  </div>
                  <div className="mt-0.5 pl-3.5 text-[11px] text-muted">{ACTION_LABEL[r.action] ?? r.action} · {fmtDate(r.createdAt)}</div>
                  {r.summary && <div className="pl-3.5 text-[11px] text-faint">{r.summary}</div>}
                </button>
              ))
            )}
          </div>

          {/* Vergleich */}
          <div className="min-w-0 flex-1 overflow-y-auto p-4">
            {!detail ? (
              <div className="grid h-full place-items-center text-[12.5px] text-faint">Version links auswählen</div>
            ) : (
              <>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[12px] text-muted">Vergleich mit dem vorherigen Stand</span>
                  {canManage && sel != null && revs && revs[0]?.id !== sel && (
                    <button onClick={() => restore(sel)} disabled={busy} className="rounded-lg border border-border px-2.5 py-1 text-[12px] text-muted transition hover:border-accent hover:text-accent disabled:opacity-50">
                      Diesen Stand wiederherstellen
                    </button>
                  )}
                </div>
                <DiffView before={detail.prev} after={detail.content} />
              </>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  );
}
