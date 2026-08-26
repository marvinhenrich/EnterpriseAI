import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { api, projectApi, uploadFiles, exportDocument, submitFeedback, myFeedback, ocrFile, type Chat as ChatT, type Project, type Message, type UploadedFile, type ChatShare, type ExportFormat, type FeedbackCategory, type FeedbackEntry, type ChatSearchHit } from '../lib/api';
import { streamQuery, type DocumentInfo, type SourceInfo } from '../lib/stream';
import { useAuth } from '../lib/auth';
import { Markdown } from '../components/Markdown';
import { Spinner } from '../components/Spinner';
import { Logo } from '../components/Logo';
import { Icon, Badge, CloseButton } from '../components/ui';
import { extractCodeFiles, downloadProjectZip, downloadCodeFile, copyText, type CodeFile } from '../lib/code';
import { branding, dateiPraefix } from '../lib/branding';

export function Chat() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const canSelectModel = !!user?.permissions?.includes('chat.select_model');
  const canThink = !!user?.permissions?.includes('chat.think_mode');
  const canShare = !!user?.permissions?.includes('chat.share');
  const canTools = !!user?.permissions?.includes('chat.use_tools');
  const canCode = !!user?.permissions?.includes('code.assist');
  const canActions = !!user?.permissions?.includes('docs.actions');
  const [tools, setTools] = useState(false);
  const [code, setCode] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [toolStatus, setToolStatus] = useState('');
  const [activeCanWrite, setActiveCanWrite] = useState(true);
  const [shareId, setShareId] = useState<string | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [chats, setChats] = useState<ChatT[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [streamDocs, setStreamDocs] = useState<DocumentInfo[]>([]);
  const [streamSources, setStreamSources] = useState<SourceInfo[]>([]);
  const [editMsgIdx, setEditMsgIdx] = useState<number | null>(null);
  const [editMsgText, setEditMsgText] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findActive, setFindActive] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const findRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState<string>('');
  const [think, setThink] = useState(false);
  const [error, setError] = useState('');
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [search, setSearch] = useState('');
  const [searchHits, setSearchHits] = useState<ChatSearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    // „Am Ende" mit kleiner Toleranz, damit der Pfeil nicht flackert.
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }

  function scrollToBottom() {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  useEffect(() => {
    api.listChats().then((r) => setChats(r.chats)).catch(() => {});
    api.models().then((r) => { setModels(r.models); setModel(r.default); }).catch(() => {});
    projectApi.list().then((r) => setProjects(r.projects)).catch(() => {});
    // Von der Projektseite verlinkt: ?chat=<id> direkt öffnen.
    const wanted = searchParams.get('chat');
    if (wanted) {
      openChat(wanted);
      setSearchParams({}, { replace: true });
    }
  }, []);

  const reloadProjects = () => projectApi.list().then((r) => setProjects(r.projects)).catch(() => {});

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streamText]);

  // Suche über eigene Chats (debounced).
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) { setSearchHits([]); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(() => {
      api.searchChats(q)
        .then((r) => setSearchHits(r.hits))
        .catch(() => setSearchHits([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  async function openChat(id: string) {
    if (id === activeId) return;
    setActiveId(id);
    setError('');
    try {
      const r = await api.getChat(id);
      setMessages(r.messages);
      setActiveCanWrite(r.canWrite);
    } catch {
      setMessages([]);
    }
  }

  function newChat() {
    setActiveId(null);
    setMessages([]);
    setError('');
    setActiveCanWrite(true);
    taRef.current?.focus();
  }

  async function removeChat(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    // Läuft gerade eine Antwort in genau diesem Chat, zuerst abbrechen —
    // sonst schreibt der Stream in einen Chat, den es nicht mehr gibt.
    if (id === activeId && streaming) {
      abortRef.current?.abort();
      setStreaming(false);
      setStreamText('');
      setStreamDocs([]);
      setStreamSources([]);
    }
    // Ansicht sofort schließen, damit kein gelöschter Chat sichtbar bleibt.
    if (id === activeId) newChat();
    try {
      await api.deleteChat(id);
      setChats((c) => c.filter((x) => x.id !== id));
    } catch (err) {
      // Fehler nicht verschlucken: sonst verschwindet der Chat aus der Liste,
      // obwohl er auf dem Server noch existiert, und ist nach dem Neuladen wieder da.
      setError(err instanceof Error ? err.message : 'Chat konnte nicht gelöscht werden.');
      api.listChats().then((r) => setChats(r.chats)).catch(() => {});
    }
  }

  function startRename(id: string, current: string, e: React.MouseEvent) {
    e.stopPropagation();
    setEditingId(id);
    setEditTitle(current);
  }

  async function commitRename(id: string) {
    const title = editTitle.trim();
    setEditingId(null);
    const original = chats.find((c) => c.id === id)?.title;
    if (!title || title === original) return;
    setChats((c) => c.map((x) => (x.id === id ? { ...x, title } : x)));
    try {
      await api.renameChat(id, title);
    } catch {
      if (original !== undefined) setChats((c) => c.map((x) => (x.id === id ? { ...x, title: original } : x)));
    }
  }

  function autoGrow() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }

  async function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files;
    if (!list || list.length === 0) return;
    setUploading(true);
    setError('');
    try {
      const up = await uploadFiles(Array.from(list));
      setAttachments((a) => [...a, ...up]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload fehlgeschlagen');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  // Kernroutine: schickt eine Anfrage an einen bestehenden Chat und streamt die
  // Antwort in die UI. `regenerate` = keine neue User-Nachricht anlegen.
  async function streamAnswer(chatId: string, content: string, opts: { fileIds?: string[]; fullContext?: boolean; regenerate?: boolean } = {}) {
    setStreaming(true);
    setStreamText('');
    setStreamDocs([]);
    setStreamSources([]);

    let acc = '';
    const docs: DocumentInfo[] = [];
    let srcs: SourceInfo[] = [];
    const ac = new AbortController();
    abortRef.current = ac;

    const finalize = () => {
      const atts: unknown[] = docs.map((d) => ({ kind: 'document', ...d }));
      if (srcs.length) atts.push({ kind: 'sources', items: srcs });
      setMessages((m) => [
        ...m,
        { id: Date.now() + 1, chatId, role: 'assistant', content: acc, attachments: atts.length ? atts : undefined, createdAt: new Date().toISOString() },
      ]);
      setStreamText('');
      setStreamDocs([]);
      setStreamSources([]);
      setToolStatus('');
      setStreaming(false);
    };

    await streamQuery(
      chatId,
      content,
      { model: model || undefined, think: think || undefined, tools: tools || undefined, code: code || undefined, fullContext: opts.fullContext, regenerate: opts.regenerate, signal: ac.signal, fileIds: opts.fileIds && opts.fileIds.length ? opts.fileIds : undefined },
      {
        onDelta: (t) => { acc += t; setStreamText(acc); },
        onTool: (info) => setToolStatus(info.label),
        onDocument: (d) => { docs.push(d); setStreamDocs([...docs]); },
        onSources: (s) => { srcs = s; setStreamSources(s); },
        onDone: () => {
          finalize();
          api.listChats().then((r) => setChats(r.chats)).catch(() => {}); // Titel-Update
        },
        onError: (msg) => {
          if (acc.trim() || docs.length) finalize();
          else { setStreamText(''); setStreamDocs([]); setStreamSources([]); setToolStatus(''); setStreaming(false); }
          setError(msg);
        },
      },
    );
  }

  // Bild → Text: OCR (offline) auf allen angehängten Bildern. Der erkannte Text
  // wird ins Eingabefeld eingefügt und zugleich am Bild gespeichert, sodass er
  // beim Senden auch als Kontext an die KI geht.
  async function runOcr() {
    // Bilder — und gescannte PDFs, aus denen kein Text gelesen werden konnte.
    const imgs = attachments.filter(
      (a) => a.kind === 'image' || (!a.hasText && /\.pdf$/i.test(a.filename)),
    );
    if (imgs.length === 0 || ocrBusy) return;
    setOcrBusy(true);
    setError('');
    try {
      const parts: string[] = [];
      for (const img of imgs) {
        const r = await ocrFile(img.id).catch(() => ({ text: '' }));
        const t = (r.text ?? '').trim();
        parts.push(imgs.length > 1 ? `--- ${img.filename} ---\n${t || '(kein Text erkannt)'}` : (t || '(kein Text erkannt)'));
      }
      const ocrText = parts.join('\n\n');
      setInput((prev) => (prev.trim() ? prev.trimEnd() + '\n\n' : '') + ocrText);
      setTimeout(() => { taRef.current?.focus(); autoGrow(); }, 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'OCR fehlgeschlagen');
    } finally {
      setOcrBusy(false);
    }
  }

  async function send(override?: { text?: string; fullContext?: boolean }) {
    const text = (override?.text ?? input).trim();
    if ((!text && attachments.length === 0) || streaming) return;
    setError('');
    const fileIds = attachments.map((a) => a.id);
    const sentAttachments = attachments;
    setAttachments([]);

    let chatId = activeId;
    if (!chatId) {
      try {
        const r = await api.createChat(undefined, activeProject);
        chatId = r.chat.id;
        setActiveId(chatId);
        setChats((c) => [r.chat, ...c]);
      } catch {
        setError('Chat konnte nicht angelegt werden.');
        return;
      }
    }

    const userMsg: Message = {
      id: Date.now(),
      chatId,
      role: 'user',
      content: text,
      attachments: sentAttachments.map((a) => ({ id: a.id, name: a.filename, kind: a.kind })),
      createdAt: new Date().toISOString(),
    };
    setMessages((m) => [...m, userMsg]);
    setInput('');
    if (taRef.current) taRef.current.style.height = 'auto';
    await streamAnswer(chatId, text, { fileIds, fullContext: override?.fullContext });
  }

  // Antwort neu erzeugen: alte Antwort (ab Index) verwerfen und neu generieren.
  async function regenerate(assistantIdx: number) {
    if (streaming || !activeId) return;
    const userIdx = assistantIdx - 1;
    const prompt = messages[userIdx];
    if (!prompt || prompt.role !== 'user') return;
    setError('');
    try {
      await api.truncateChat(activeId, assistantIdx); // behält 0..assistantIdx-1
    } catch {
      setError('Konnte die Antwort nicht neu erzeugen.');
      return;
    }
    setMessages((m) => m.slice(0, assistantIdx));
    await streamAnswer(activeId, prompt.content, { regenerate: true });
  }

  function startEditMsg(idx: number) {
    setEditMsgIdx(idx);
    setEditMsgText(messages[idx]?.content ?? '');
  }
  function cancelEditMsg() {
    setEditMsgIdx(null);
    setEditMsgText('');
  }
  // Eigene Nachricht bearbeiten & erneut senden (alles danach wird verworfen).
  async function saveEditMsg(idx: number) {
    const text = editMsgText.trim();
    if (!text || streaming || !activeId) { cancelEditMsg(); return; }
    setError('');
    try {
      await api.truncateChat(activeId, idx); // behält 0..idx-1
    } catch {
      setError('Konnte die Nachricht nicht bearbeiten.');
      return;
    }
    const kept = messages.slice(0, idx);
    cancelEditMsg();
    const userMsg: Message = { id: Date.now(), chatId: activeId, role: 'user', content: text, createdAt: new Date().toISOString() };
    setMessages([...kept, userMsg]);
    await streamAnswer(activeId, text, {});
  }

  // Chat anheften/lösen bzw. archivieren (optimistisch).
  async function togglePin(id: string, e?: React.MouseEvent) {
    e?.stopPropagation();
    const cur = chats.find((c) => c.id === id);
    const next = !cur?.pinned;
    setChats((cs) => cs.map((c) => (c.id === id ? { ...c, pinned: next } : c)));
    await api.setChatFlags(id, { pinned: next }).catch(() => {});
    api.listChats().then((r) => setChats(r.chats)).catch(() => {});
  }
  async function assignChatToProject(chatId: string, projectId: string | null) {
    setChats((cs) => cs.map((c) => (c.id === chatId ? { ...c, projectId } : c)));
    await projectApi.assignChat(chatId, projectId).catch(() => {});
    reloadProjects();
  }

  async function toggleArchive(id: string, e?: React.MouseEvent) {
    e?.stopPropagation();
    const cur = chats.find((c) => c.id === id);
    const next = !cur?.archived;
    setChats((cs) => cs.map((c) => (c.id === id ? { ...c, archived: next } : c)));
    await api.setChatFlags(id, { archived: next }).catch(() => {});
    if (next && id === activeId) newChat();
  }

  function stop() {
    abortRef.current?.abort();
    if (streamText.trim()) {
      setMessages((m) => [
        ...m,
        { id: Date.now() + 1, chatId: activeId!, role: 'assistant', content: streamText, createdAt: new Date().toISOString() },
      ]);
    }
    setStreamText('');
    setStreaming(false);
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  // Code-Canvas: alle Code-Dateien aus den Assistant-Antworten (benannte Dateien:
  // neueste Version gewinnt; unbenannte Snippets bleiben pro Nachricht erhalten).
  const codeFiles = useMemo<CodeFile[]>(() => {
    const sources = [...messages.filter((m) => m.role === 'assistant').map((m) => m.content), streamText].filter(Boolean);
    const map = new Map<string, CodeFile>();
    sources.forEach((md, mi) => {
      for (const f of extractCodeFiles(md)) {
        const key = /^snippet-\d+\./.test(f.name) ? `${mi}:${f.name}` : f.name;
        map.set(key, f);
      }
    });
    return [...map.values()];
  }, [messages, streamText]);
  const hasAnyCode = codeFiles.length > 0;
  useEffect(() => { if (!hasAnyCode) setCanvasOpen(false); }, [hasAnyCode]);

  const empty = messages.length === 0 && !streaming;

  // Sicherheitsnetz: Ein geöffneter Chat, der nicht mehr in der Liste steht
  // (gelöscht, Freigabe entzogen), darf auch nicht mehr angezeigt werden.
  // Als Invariante formuliert statt nur im Löschpfad — greift auch, wenn die
  // Liste vom Server neu geladen wird.
  useEffect(() => {
    if (!activeId || streaming || chats.length === 0) return;
    if (!chats.some((c) => c.id === activeId)) newChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats, activeId, streaming]);

  // --- In-Chat-Suche (Cmd+F): Treffer-Indizes der aktuellen Konversation ------
  const findMatches = useMemo<number[]>(() => {
    const q = findQuery.trim().toLowerCase();
    if (!q) return [];
    return messages.map((m, i) => (m.content.toLowerCase().includes(q) ? i : -1)).filter((i) => i >= 0);
  }, [findQuery, messages]);

  useEffect(() => { setFindActive(0); }, [findQuery]);

  // Aktiven Treffer ins Sichtfeld scrollen + kurz hervorheben.
  useEffect(() => {
    if (!findOpen || findMatches.length === 0) return;
    const idx = findMatches[Math.min(findActive, findMatches.length - 1)];
    const el = scrollRef.current?.querySelector(`[data-msg-idx="${idx}"]`) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-2', 'ring-accent', 'rounded-2xl');
      const t = setTimeout(() => el.classList.remove('ring-2', 'ring-accent', 'rounded-2xl'), 1400);
      return () => clearTimeout(t);
    }
  }, [findOpen, findActive, findMatches]);

  function openFind() { setPaletteOpen(false); setFindOpen(true); setTimeout(() => findRef.current?.focus(), 30); }
  function closeFind() { setFindOpen(false); setFindQuery(''); }
  function stepMatch(dir: 1 | -1) {
    if (findMatches.length === 0) return;
    setFindActive((a) => (a + dir + findMatches.length) % findMatches.length);
  }

  // --- Globale Tastenkürzel ---------------------------------------------------
  useEffect(() => {
    function onKeyGlobal(e: globalThis.KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen((v) => !v); setFindOpen(false); }
      else if (meta && e.key.toLowerCase() === 'f') { e.preventDefault(); if (!empty) openFind(); }
      else if (meta && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); newChat(); }
      else if (e.key === 'Escape') { setPaletteOpen(false); setFindOpen(false); }
    }
    window.addEventListener('keydown', onKeyGlobal);
    return () => window.removeEventListener('keydown', onKeyGlobal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empty]);

  return (
    <div className="flex h-full">
      {/* ---- Sidebar ---- */}
      <aside className="flex w-[264px] shrink-0 flex-col border-r border-border bg-surface">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <Logo size={28} />
          <span className="text-[15px] font-semibold tracking-tight">{branding().appShort}</span>
        </div>

        <div className="px-3">
          <button
            onClick={newChat}
            className="flex w-full items-center gap-2 rounded-[10px] border border-border bg-surface px-3 py-2.5 text-[13.5px] font-medium text-fg transition hover:border-border-strong hover:bg-surface-2"
          >
            <PlusIcon /> Neuer Chat
          </button>
        </div>

        {/* ---- Navigation (oben, wie man es kennt) ---- */}
        <nav className="mt-2 px-3">
          <Link
            to="/projekte"
            className="mb-0.5 flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-fg/85 transition hover:bg-surface-2 hover:text-accent"
          >
            <ProjectIcon /> Projekte
            {projects.length > 0 && <span className="ml-auto text-[11px] text-faint">{projects.length}</span>}
          </Link>
          {!!user?.permissions?.includes('kb.query') && (
            <Link
              to="/vault"
              className="mb-0.5 flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-fg/85 transition hover:bg-surface-2 hover:text-accent"
            >
              <BookIcon /> Wissens-Vault
            </Link>
          )}
          {!!user?.permissions?.includes('image.generate') && (
            <Link
              to="/bilder"
              className="mb-0.5 flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-fg/85 transition hover:bg-surface-2 hover:text-accent"
            >
              <ImageIcon /> Bildgenerierung
            </Link>
          )}
          {!!user?.permissions?.includes('labels.read') && (
            <Link
              to="/etiketten"
              className="mb-0.5 flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-fg/85 transition hover:bg-surface-2 hover:text-accent"
            >
              <TagIcon /> Etiketten
            </Link>
          )}
        </nav>


        <div className="mt-2 px-3">
          <div className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"><SearchIcon /></span>
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Chats durchsuchen …"
              className="w-full rounded-lg border border-border bg-surface py-2 pl-8 pr-7 text-[13px] outline-none transition focus:border-accent"
            />
            {search && (
              <CloseButton onClick={() => setSearch('')} label="Suche zurücksetzen" className="absolute right-1.5 top-1/2 -translate-y-1/2" />
            )}
          </div>
        </div>

        <nav className="mt-3 flex-1 overflow-y-auto px-2 pb-2">
          {search.trim().length >= 2 ? (
            <SearchResults
              hits={searchHits}
              searching={searching}
              query={search.trim()}
              activeId={activeId}
              onOpen={(id) => { openChat(id); }}
            />
          ) : (
          <>

          {chats.filter((c) => c.access !== 'shared' && (showArchived ? c.archived : !c.archived) && (!activeProject || c.projectId === activeProject)).map((c) => (
            <div
              key={c.id}
              className={`group mb-0.5 flex w-full items-center gap-1.5 rounded-lg px-2.5 py-2 text-[13px] transition ${
                c.id === activeId ? 'bg-accent-soft text-accent' : 'text-fg/80 hover:bg-surface-2'
              }`}
            >
              {c.pinned && editingId !== c.id && <span className="shrink-0 text-faint" title="Angeheftet"><PinIcon filled /></span>}
              {editingId === c.id ? (
                <input
                  autoFocus
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={() => commitRename(c.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commitRename(c.id); }
                    else if (e.key === 'Escape') { e.preventDefault(); setEditingId(null); }
                  }}
                  className="flex-1 min-w-0 rounded border border-border-strong bg-surface px-1.5 py-0.5 text-[13px] text-fg outline-none focus:border-accent"
                />
              ) : (
                <button
                  onClick={() => openChat(c.id)}
                  onDoubleClick={(e) => startRename(c.id, c.title, e)}
                  className="flex-1 truncate text-left"
                >
                  {c.title}
                </button>
              )}
              {editingId !== c.id && (
                <button
                  tabIndex={-1}
                  onClick={(e) => togglePin(c.id, e)}
                  title={c.pinned ? 'Lösen' : 'Anheften'}
                  className={`transition hover:text-accent ${c.pinned ? 'text-accent opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                >
                  <PinIcon filled={!!c.pinned} />
                </button>
              )}
              {editingId !== c.id && (
                <button
                  tabIndex={-1}
                  onClick={(e) => startRename(c.id, c.title, e)}
                  title="Umbenennen"
                  className="opacity-0 transition group-hover:opacity-100 hover:text-accent"
                >
                  <PencilIcon />
                </button>
              )}
              {editingId !== c.id && (
                <button
                  tabIndex={-1}
                  onClick={(e) => toggleArchive(c.id, e)}
                  title={c.archived ? 'Aus Archiv holen' : 'Archivieren'}
                  className="opacity-0 transition group-hover:opacity-100 hover:text-accent"
                >
                  <ArchiveIcon />
                </button>
              )}
              {canShare && editingId !== c.id && (
                <button
                  tabIndex={-1}
                  onClick={(e) => { e.stopPropagation(); setShareId(c.id); }}
                  title="Teilen"
                  className="opacity-0 transition group-hover:opacity-100 hover:text-accent"
                >
                  <ShareIcon />
                </button>
              )}
              {editingId !== c.id && projects.length > 0 && (
                <select
                  tabIndex={-1}
                  value={c.projectId ?? ''}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => assignChatToProject(c.id, e.target.value || null)}
                  title="Projekt zuordnen"
                  className="w-3.5 shrink-0 cursor-pointer appearance-none bg-transparent text-[11px] text-faint opacity-0 transition group-hover:opacity-100 hover:text-accent"
                >
                  <option value="">— kein Projekt —</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              )}
              {editingId !== c.id && (
                <button
                  tabIndex={-1}
                  onClick={(e) => removeChat(c.id, e)}
                  title="Löschen"
                  className="opacity-0 transition group-hover:opacity-100 hover:text-danger"
                >
                  <TrashIcon />
                </button>
              )}
            </div>
          ))}

          {showArchived && chats.filter((c) => c.access !== 'shared' && c.archived).length === 0 && (
            <div className="px-3 py-3 text-[12px] text-faint">Keine archivierten Chats.</div>
          )}

          {(chats.some((c) => c.access !== 'shared' && c.archived) || showArchived) && (
            <button
              onClick={() => setShowArchived((v) => !v)}
              className="mt-2 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[12px] text-muted transition hover:bg-surface-2 hover:text-accent"
            >
              <ArchiveIcon /> {showArchived ? 'Aktive Chats anzeigen' : `Archiv (${chats.filter((c) => c.access !== 'shared' && c.archived).length})`}
            </button>
          )}

          {!showArchived && chats.some((c) => c.access === 'shared') && (
            <>
              <div className="mb-1 mt-3 px-3 text-[10.5px] font-semibold uppercase tracking-wide text-faint">Geteilt mit mir</div>
              {chats.filter((c) => c.access === 'shared').map((c) => (
                <button
                  key={c.id}
                  onClick={() => openChat(c.id)}
                  className={`mb-0.5 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] transition ${
                    c.id === activeId ? 'bg-accent-soft text-accent' : 'text-fg/80 hover:bg-surface-2'
                  }`}
                >
                  <span className="flex-1 truncate">{c.title}</span>
                  {c.sharedByName && <span className="shrink-0 text-[10.5px] text-faint">von {c.sharedByName}</span>}
                </button>
              ))}
            </>
          )}
          </>
          )}
        </nav>

        <div className="border-t border-border px-3 py-3">
          {user?.role === 'admin' && (
            <Link
              to="/admin"
              className="mb-1 flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-muted transition hover:bg-surface-2 hover:text-accent"
            >
              <GearIcon /> Administration
            </Link>
          )}
          <button
            onClick={() => setFeedbackOpen(true)}
            className="mb-2 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-muted transition hover:bg-surface-2 hover:text-accent"
          >
            <FeedbackIcon /> Feedback geben
          </button>
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium">{user?.username}</div>
              <div className="text-[11px] text-faint">{user?.role}</div>
            </div>
            <button
              onClick={logout}
              className="rounded-lg px-2.5 py-1.5 text-[12px] text-muted transition hover:bg-surface-2 hover:text-danger"
            >
              Abmelden
            </button>
          </div>
        </div>
      </aside>

      {/* ---- Hauptbereich ---- */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border bg-surface/80 px-6 py-3 backdrop-blur">
          <div className="min-w-0">
            <div className="truncate text-[14px] font-medium">
              {chats.find((c) => c.id === activeId)?.title ?? 'Neuer Chat'}
            </div>
            {(() => {
              // Projektzugehörigkeit sichtbar machen — Vorgaben/Dateien wirken hier.
              const pid = activeId ? chats.find((c) => c.id === activeId)?.projectId : activeProject;
              const proj = pid ? projects.find((p) => p.id === pid) : undefined;
              return proj ? (
                <button onClick={() => navigate(`/projekte/${proj.id}`)} className="flex items-center gap-1 text-[11px] text-faint transition hover:text-accent">
                  <ProjectIcon /> {proj.name}
                  {proj.fileCount > 0 && <span>· {proj.fileCount} Projektdatei{proj.fileCount === 1 ? '' : 'en'}</span>}
                </button>
              ) : null;
            })()}
          </div>
        </header>

        <div className="relative min-h-0 flex-1">
          {findOpen && (
            <div className="absolute right-4 top-3 z-20 flex items-center gap-1.5 rounded-xl border border-border bg-surface px-2 py-1.5 shadow-pop">
              <SearchIcon />
              <input
                ref={findRef}
                value={findQuery}
                onChange={(e) => setFindQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); stepMatch(e.shiftKey ? -1 : 1); }
                  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
                }}
                placeholder="Im Chat suchen …"
                className="w-44 bg-transparent text-[13px] outline-none"
              />
              <span className="whitespace-nowrap text-[11.5px] tabular-nums text-faint">
                {findQuery.trim() ? (findMatches.length ? `${Math.min(findActive + 1, findMatches.length)}/${findMatches.length}` : '0/0') : ''}
              </span>
              <button onClick={() => stepMatch(-1)} title="Vorheriger" className="rounded px-1 text-muted hover:text-accent disabled:opacity-40" disabled={findMatches.length === 0}>↑</button>
              <button onClick={() => stepMatch(1)} title="Nächster" className="rounded px-1 text-muted hover:text-accent disabled:opacity-40" disabled={findMatches.length === 0}>↓</button>
              <CloseButton onClick={closeFind} />
            </div>
          )}
          <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto">
          <div className="mx-auto max-w-3xl px-6 py-6">
            {empty ? (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4 }}
                className="mt-[14vh] text-center"
              >
                <div className="mb-5 flex justify-center">
                  <Logo size={52} />
                </div>
                <h2 className="text-[20px] font-semibold">Wie kann ich helfen?</h2>
                <p className="mt-2 text-[14px] text-muted">Stellen Sie eine Frage oder beschreiben Sie Ihre Aufgabe.</p>
              </motion.div>
            ) : (
              <div className="space-y-5">
                {messages.map((m, i) => (
                  editMsgIdx === i ? (
                    <div key={m.id} className="flex justify-end" data-msg-idx={i}>
                      <div className="w-full max-w-[78%]">
                        <textarea
                          autoFocus
                          value={editMsgText}
                          onChange={(e) => setEditMsgText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEditMsg(i); }
                            else if (e.key === 'Escape') { e.preventDefault(); cancelEditMsg(); }
                          }}
                          rows={3}
                          className="w-full resize-none rounded-2xl border border-accent bg-surface px-4 py-2.5 text-[14.5px] outline-none"
                        />
                        <div className="mt-1.5 flex justify-end gap-2">
                          <button onClick={cancelEditMsg} className="rounded-lg px-3 py-1.5 text-[12.5px] text-muted transition hover:bg-surface-2">Abbrechen</button>
                          <button onClick={() => saveEditMsg(i)} className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white transition hover:bg-accent-hover">Senden</button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <MessageRow
                      key={m.id}
                      index={i}
                      role={m.role}
                      content={m.content}
                      attachments={m.attachments}
                      senderName={m.senderName}
                      onEdit={m.role === 'user' && !streaming ? () => startEditMsg(i) : undefined}
                      onRegenerate={m.role === 'assistant' && i === messages.length - 1 && !streaming ? () => regenerate(i) : undefined}
                    />
                  )
                ))}
                {toolStatus && streaming && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-2 pl-10 text-[12.5px] text-muted">
                    <Spinner size={13} /> nutzt Werkzeug: <span className="text-accent">{toolStatus}</span>
                  </motion.div>
                )}
                {streaming && (
                  <MessageRow role="assistant" content={streamText} streaming attachments={[...streamDocs.map((d) => ({ kind: 'document', ...d })), ...(streamSources.length ? [{ kind: 'sources', items: streamSources }] : [])]} />
                )}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
          </div>
          {!empty && !atBottom && (
            <button
              onClick={scrollToBottom}
              title="Zum Ende springen"
              className="absolute bottom-4 left-1/2 -translate-x-1/2 grid h-9 w-9 place-items-center rounded-full border border-border bg-surface text-muted shadow-pop transition hover:border-border-strong hover:text-accent"
            >
              <ArrowDownIcon />
            </button>
          )}
        </div>

        {/* ---- Composer ---- */}
        <div className="border-t border-border bg-surface px-6 py-4">
          <div className="mx-auto max-w-3xl">
            {error && <div className="mb-2 text-[12.5px] text-danger">{error}</div>}

            {attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {attachments.map((a) => (
                  <motion.div
                    key={a.id}
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[12.5px]"
                  >
                    <FileIcon />
                    <span className="max-w-[160px] truncate">{a.filename}</span>
                    {!a.hasText && a.kind === 'document' && <Icon name="warnung" size={12} className="text-warn" />}
                    <CloseButton onClick={() => setAttachments((x) => x.filter((f) => f.id !== a.id))} label="Anhang entfernen" className="h-5 w-5" />
                  </motion.div>
                ))}
              </div>
            )}

            {attachments.some((a) => a.kind === 'image' || (!a.hasText && /\.pdf$/i.test(a.filename))) && (
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-faint">Texterkennung:</span>
                <button
                  onClick={runOcr}
                  disabled={ocrBusy || streaming}
                  title="Text aus dem Bild erkennen (OCR, läuft offline) und ins Eingabefeld einfügen"
                  className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-[12px] text-muted transition hover:border-accent hover:text-accent disabled:opacity-50"
                >
                  {ocrBusy ? <Spinner size={12} /> : <OcrIcon />} {ocrBusy ? 'Erkenne Text …' : 'Text aus Bild (OCR)'}
                </button>
              </div>
            )}

            {canActions && attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-faint">Schnell-Aktion:</span>
                {DOC_ACTIONS.map((a) => (
                  <button
                    key={a.label}
                    onClick={() => send({ text: a.prompt, fullContext: true })}
                    disabled={streaming}
                    className="rounded-full border border-border bg-surface px-3 py-1 text-[12px] text-muted transition hover:border-accent hover:text-accent disabled:opacity-50"
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}

            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              accept=".pdf,.docx,.doc,.rtf,.odt,.xlsx,.xls,.txt,.md,.csv,.tsv,.json,.xml,.html,.yaml,.yml,.tex,.bib,.py,.ipynb,.r,.m,.jl,.sql,.js,.ts,.sh,.ps1,.java,.c,.cpp,.cs,.go,.rs,.php,.rb,.vba,.bas,.mol,.sdf,.cif,.png,.jpg,.jpeg,.webp,.gif"
              onChange={onPickFiles}
            />
            <div className="flex items-end gap-2 rounded-[14px] border border-border-strong bg-white p-2 shadow-soft transition focus-within:border-accent">
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                title="Datei anhängen"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-muted transition hover:bg-surface-2 hover:text-accent disabled:opacity-50"
              >
                {uploading ? <Spinner size={16} /> : <ClipIcon />}
              </button>
              <textarea
                ref={taRef}
                value={input}
                onChange={(e) => { setInput(e.target.value); autoGrow(); }}
                onKeyDown={onKey}
                rows={1}
                disabled={!activeCanWrite}
                placeholder={activeCanWrite ? `Nachricht an ${branding().appShort} …` : 'Nur Lesezugriff auf diesen geteilten Chat'}
                className="max-h-[200px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[14.5px] outline-none placeholder:text-faint disabled:cursor-not-allowed"
              />
              {streaming ? (
                <button
                  onClick={stop}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-surface-2 text-fg transition hover:bg-border"
                  title="Stoppen"
                >
                  <StopIcon />
                </button>
              ) : (
                <motion.button
                  whileTap={{ scale: 0.94 }}
                  onClick={() => send()}
                  disabled={!input.trim() || !activeCanWrite}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-accent text-white transition hover:bg-accent-hover disabled:opacity-40"
                  title="Senden"
                >
                  <SendIcon />
                </motion.button>
              )}
            </div>
            {/* Bedienelemente direkt an der Eingabe — kurze Wege, wie man es kennt. */}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {canThink && (
                <button
                  onClick={() => setThink((t) => !t)}
                  title="Reasoning-/Think-Modus: gründlicher, aber langsamer"
                  className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition ${
                    think ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted hover:border-border-strong'
                  }`}
                >
                  <ThinkIcon /> Think
                </button>
              )}
              {canTools && (
                <button
                  onClick={() => setTools((t) => !t)}
                  title="Werkzeuge: Wissens-Vault-Suche, Rechner, Datum (rein intern)"
                  className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition ${
                    tools ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted hover:border-border-strong'
                  }`}
                >
                  <ToolIcon /> Werkzeuge
                </button>
              )}
              {canCode && (
                <button
                  onClick={() => setCode((t) => !t)}
                  title="Programmiermodus: vollständige Code-Antworten, Kopieren/Download je Block. Keine Ausführung."
                  className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition ${
                    code ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted hover:border-border-strong'
                  }`}
                >
                  <CodeIcon /> Code
                </button>
              )}
              {canCode && hasAnyCode && (
                <button
                  onClick={() => setCanvasOpen((o) => !o)}
                  title="Code-Canvas: alle Code-Dateien dieses Chats gebündelt"
                  className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition ${
                    canvasOpen ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted hover:border-border-strong'
                  }`}
                >
                  <CanvasIcon /> Canvas
                  <span className="rounded-full bg-surface-2 px-1.5 text-[10px] text-faint">{codeFiles.length}</span>
                </button>
              )}
              {canSelectModel && models.length > 0 && (
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  title="Modell auswählen"
                  className="rounded-full border border-border bg-surface px-2.5 py-1 text-[12px] text-muted outline-none transition hover:border-border-strong"
                >
                  {models.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              )}
              <span className="ml-auto text-[11px] text-faint">
                {activeCanWrite ? 'Enter senden · Shift+Enter neue Zeile' : 'Geteilter Chat · nur Lesezugriff'}
              </span>
            </div>
          </div>
        </div>
      </main>

      <AnimatePresence>
        {canvasOpen && hasAnyCode && (
          <CodeCanvas files={codeFiles} onClose={() => setCanvasOpen(false)} />
        )}
      </AnimatePresence>

      {shareId && <ShareModal chatId={shareId} onClose={() => setShareId(null)} />}
      {feedbackOpen && <FeedbackModal onClose={() => setFeedbackOpen(false)} />}
      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          actions={[
            { label: 'Neuer Chat', hint: '⌘⇧O', run: newChat },
            { label: 'Projekte öffnen', run: () => navigate('/projekte') },
            ...projects.map((p) => ({ label: `Projekt: ${p.name}`, run: () => navigate(`/projekte/${p.id}`) })),
            ...(activeProject ? [{ label: 'Projektfilter aufheben', run: () => setActiveProject(null) }] : []),
            { label: 'Chats durchsuchen', run: () => setTimeout(() => searchRef.current?.focus(), 30) },
            ...(empty ? [] : [{ label: 'Im aktuellen Chat suchen', hint: '⌘F', run: openFind }]),
            ...(empty ? [] : [{ label: 'Zum Ende springen', run: scrollToBottom }]),
            ...(canThink ? [{ label: `Think-Modus ${think ? 'ausschalten' : 'einschalten'}`, run: () => setThink((t) => !t) }] : []),
            ...(canTools ? [{ label: `Werkzeuge ${tools ? 'ausschalten' : 'einschalten'}`, run: () => setTools((t) => !t) }] : []),
            ...(canCode ? [{ label: `Programmiermodus ${code ? 'ausschalten' : 'einschalten'}`, run: () => setCode((t) => !t) }] : []),
            ...(user?.permissions?.includes('kb.query') ? [{ label: 'Wissens-Vault öffnen', run: () => navigate('/vault') }] : []),
            ...(user?.permissions?.includes('image.generate') ? [{ label: 'Bildgenerierung öffnen', run: () => navigate('/bilder') }] : []),
            ...(user?.permissions?.includes('labels.read') ? [{ label: 'Etiketten öffnen', run: () => navigate('/etiketten') }] : []),
            ...(user?.role === 'admin' ? [{ label: 'Administration öffnen', run: () => navigate('/admin') }] : []),
            { label: 'Feedback geben', run: () => setFeedbackOpen(true) },
            { label: 'Abmelden', run: logout },
          ]}
        />
      )}
    </div>
  );
}

// Code-Canvas: Seitenpanel mit allen Code-Dateien des Chats. Datei-Navigation,
// Kopieren/Download je Datei und „Alle als ZIP". Rein clientseitig, keine Ausführung.
function CodeCanvas({ files, onClose }: { files: CodeFile[]; onClose: () => void }) {
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);
  const [zipping, setZipping] = useState(false);
  const sel = files[Math.min(active, files.length - 1)] ?? files[0]!;

  async function copySel() {
    if (await copyText(sel.code)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  }
  async function zip() {
    setZipping(true);
    try {
      await downloadProjectZip(files, `${dateiPraefix()}-code.zip`);
    } finally {
      setZipping(false);
    }
  }

  return (
    <motion.aside
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
      className="flex w-[440px] shrink-0 flex-col border-l border-border bg-surface"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-[13.5px] font-medium">
          <CanvasIcon /> Code-Canvas
          <span className="rounded bg-surface-2 px-1.5 text-[11px] text-faint">{files.length} {files.length === 1 ? 'Datei' : 'Dateien'}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={zip}
            disabled={zipping}
            className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[12px] text-muted transition hover:border-accent hover:text-accent disabled:opacity-50"
            title="Alle Dateien als ZIP herunterladen"
          >
            {zipping ? <Spinner size={12} /> : <DownloadIcon />} ZIP
          </button>
          <CloseButton onClick={onClose} />
        </div>
      </div>

      {/* Datei-Tabs */}
      <div className="flex flex-wrap gap-1 border-b border-border px-3 py-2">
        {files.map((f, i) => (
          <button
            key={`${f.name}-${i}`}
            onClick={() => setActive(i)}
            title={f.name}
            className={`max-w-[150px] truncate rounded-md px-2 py-1 font-mono text-[11.5px] transition ${
              i === Math.min(active, files.length - 1) ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2'
            }`}
          >
            {f.name.split('/').pop()}
          </button>
        ))}
      </div>

      {/* Aktive Datei */}
      <div className="flex items-center justify-between px-4 py-2 text-[12px]">
        <span className="truncate font-mono text-faint" title={sel.name}>{sel.name}</span>
        <div className="flex shrink-0 items-center gap-1">
          <button onClick={copySel} className="rounded-md px-2 py-0.5 text-muted transition hover:bg-surface-2 hover:text-accent">
            {copied ? 'Kopiert' : 'Kopieren'}
          </button>
          <button onClick={() => downloadCodeFile(sel)} className="rounded-md px-2 py-0.5 text-muted transition hover:bg-surface-2 hover:text-accent">
            Download
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 pb-4">
        <Markdown content={'```' + (sel.lang || '') + '\n' + sel.code + '\n```'} />
      </div>
    </motion.aside>
  );
}

function ShareModal({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const [shares, setShares] = useState<ChatShare[]>([]);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.chatShares(chatId).then((r) => setShares(r.shares)).catch(() => {});
  }, [chatId]);

  async function add() {
    if (!username.trim()) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.shareChat(chatId, username.trim());
      setShares(r.shares);
      setUsername('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Teilen fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }
  async function remove(userId: number) {
    const r = await api.unshareChat(chatId, userId).catch(() => null);
    if (r) setShares(r.shares);
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.2 }}
        onClick={(e) => e.stopPropagation()}
        className="w-[min(94vw,460px)] rounded-card border border-border bg-surface p-6 shadow-pop"
      >
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-[16px] font-semibold">Chat teilen</h3>
          <CloseButton onClick={onClose} />
        </div>
        <p className="mb-4 text-[12.5px] text-muted">Kolleg:innen erhalten Zugriff auf diesen Chat und können ihn fortführen. Bleibt intern.</p>

        <div className="flex gap-2">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder="Benutzername (z. B. m.mustermann)"
            className="flex-1 rounded-lg border border-border-strong bg-white px-3 py-2 text-[14px] outline-none focus:border-accent"
          />
          <button onClick={add} disabled={busy} className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-[14px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-60">
            {busy && <Spinner size={14} />} Teilen
          </button>
        </div>
        {error && <div className="mt-2 text-[12.5px] text-danger">{error}</div>}

        {shares.length > 0 && (
          <div className="mt-4">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">Geteilt mit</div>
            <div className="space-y-1">
              {shares.map((s) => (
                <div key={s.userId} className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-surface-2">
                  <span className="text-[13.5px]">{s.username ?? `#${s.userId}`}</span>
                  <button onClick={() => remove(s.userId)} className="text-[12px] text-muted hover:text-danger">Entfernen</button>
                </div>
              ))}
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}

// Hebt alle Vorkommen des Suchbegriffs im Text hervor (case-insensitiv).
function highlight(text: string, query: string): React.ReactNode[] {
  if (!query) return [text];
  const parts: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const idx = lower.indexOf(q, i);
    if (idx < 0) { parts.push(text.slice(i)); break; }
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(<mark key={k++} className="rounded bg-amber-200 text-inherit">{text.slice(idx, idx + query.length)}</mark>);
    i = idx + query.length;
  }
  return parts;
}

function SearchResults({
  hits, searching, query, activeId, onOpen,
}: {
  hits: ChatSearchHit[];
  searching: boolean;
  query: string;
  activeId: string | null;
  onOpen: (id: string) => void;
}) {
  if (searching && hits.length === 0) {
    return <div className="flex items-center gap-2 px-3 py-4 text-[12.5px] text-muted"><Spinner size={13} /> Suche …</div>;
  }
  if (hits.length === 0) {
    return <div className="px-3 py-4 text-[12.5px] text-faint">Keine Treffer für „{query}".</div>;
  }
  return (
    <>
      <div className="mb-1 px-3 text-[10.5px] font-semibold uppercase tracking-wide text-faint">
        {hits.length} {hits.length === 1 ? 'Treffer' : 'Treffer'}
      </div>
      {hits.map((h) => (
        <button
          key={h.chatId}
          onClick={() => onOpen(h.chatId)}
          className={`mb-0.5 block w-full rounded-lg px-3 py-2 text-left transition ${
            h.chatId === activeId ? 'bg-accent-soft' : 'hover:bg-surface-2'
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="flex-1 truncate text-[13px] font-medium text-fg">{highlight(h.title, query)}</span>
            {h.matches > 0 && <span className="shrink-0 rounded bg-surface-2 px-1.5 text-[10px] text-faint">{h.matches}</span>}
          </div>
          {h.snippet && <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-muted">{highlight(h.snippet, query)}</div>}
        </button>
      ))}
    </>
  );
}

const FEEDBACK_CATS: { id: FeedbackCategory; label: string }[] = [
  { id: 'bug', label: 'Fehler' },
  { id: 'idea', label: 'Idee' },
  { id: 'other', label: 'Sonstiges' },
];

const FB_STATE: Record<string, { label: string; cls: string }> = {
  open: { label: 'Offen', cls: 'bg-amber-500/15 text-amber-700' },
  in_progress: { label: 'In Bearbeitung', cls: 'bg-blue-500/15 text-blue-700' },
  resolved: { label: 'Erledigt', cls: 'bg-green-500/15 text-green-700' },
  declined: { label: 'Abgelehnt', cls: 'bg-surface-2 text-muted' },
};

function FeedbackModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'neu' | 'meine'>('neu');
  const [mine, setMine] = useState<FeedbackEntry[] | null>(null);
  const [category, setCategory] = useState<FeedbackCategory>('idea');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (tab === 'meine' && mine === null) myFeedback().then((r) => setMine(r.feedback)).catch(() => setMine([]));
  }, [tab, mine]);

  async function submit() {
    if (!message.trim()) { setError('Bitte gib eine Nachricht ein.'); return; }
    setBusy(true);
    setError('');
    try {
      // Kontext mitgeben: hilft der Administration beim Nachvollziehen.
      await submitFeedback({ category, message: message.trim(), context: window.location.pathname });
      setMine(null);
      setDone(true);
      setTimeout(onClose, 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Senden fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.2 }}
        onClick={(e) => e.stopPropagation()}
        className="w-[min(94vw,460px)] rounded-card border border-border bg-surface p-6 shadow-pop"
      >
        <div className="mb-2 flex items-center justify-between">
          <div className="flex gap-1">
            {([['neu', 'Feedback geben'], ['meine', 'Meine Rückmeldungen']] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`rounded-lg px-2.5 py-1 text-[13px] transition ${tab === id ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:bg-surface-2'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <CloseButton onClick={onClose} />
        </div>

        {tab === 'meine' ? (
          mine === null ? (
            <div className="py-8"><Spinner /></div>
          ) : mine.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-faint">Du hast noch nichts gemeldet.</p>
          ) : (
            <div className="max-h-[60vh] space-y-2 overflow-y-auto">
              {mine.map((f) => {
                const stt = FB_STATE[f.status] ?? FB_STATE.open!;
                return (
                  <div key={f.id} className="rounded-lg border border-border p-3">
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-[11.5px]">
                      <span className={`rounded-full px-2 py-0.5 font-medium ${stt.cls}`}>{stt.label}</span>
                      <span className="text-faint">{f.createdAt}</span>
                    </div>
                    <div className="whitespace-pre-wrap text-[13px] text-fg/90">{f.message}</div>
                    {f.response && (
                      <div className="mt-2 rounded-lg border-l-2 border-accent bg-accent-soft/40 px-2.5 py-1.5">
                        <div className="text-[10.5px] font-medium text-accent">Antwort der Administration</div>
                        <div className="whitespace-pre-wrap text-[12.5px] text-muted">{f.response}</div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )
        ) : done ? (
          <p className="py-6 text-center text-[14px] text-accent">Danke für dein Feedback! 🙏</p>
        ) : (
          <>
            <p className="mb-4 text-[12.5px] text-muted">{`Hilf uns, ${branding().appShort} zu verbessern.`} Dein Feedback geht an die Administration.</p>

            <div className="mb-3 flex flex-wrap gap-1.5">
              {FEEDBACK_CATS.map((cat) => (
                <button
                  key={cat.id}
                  onClick={() => setCategory(cat.id)}
                  className={`rounded-lg border px-3 py-1.5 text-[13px] transition ${category === cat.id ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted hover:border-border-strong'}`}
                >
                  {cat.label}
                </button>
              ))}
            </div>

            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              placeholder="Was möchtest du uns mitteilen?"
              className="w-full resize-none rounded-lg border border-border-strong bg-white px-3 py-2 text-[14px] outline-none focus:border-accent"
            />
            {error && <div className="mt-2 text-[12.5px] text-danger">{error}</div>}

            <div className="mt-4 flex justify-end gap-2">
              <button onClick={onClose} className="rounded-lg px-4 py-2 text-[14px] text-muted transition hover:bg-surface-2">Abbrechen</button>
              <button onClick={submit} disabled={busy} className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-[14px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-60">
                {busy && <Spinner size={14} />} Absenden
              </button>
            </div>
          </>
        )}
      </motion.div>
    </div>
  );
}

interface Command { label: string; hint?: string; run: () => void }
function CommandPalette({ actions, onClose }: { actions: Command[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const filtered = actions.filter((a) => a.label.toLowerCase().includes(q.trim().toLowerCase()));
  useEffect(() => { setSel(0); }, [q]);

  function run(a?: Command) {
    if (!a) return;
    onClose();
    setTimeout(a.run, 0);
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-start justify-center bg-black/30 p-4 pt-[12vh]" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, y: 10, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.16 }}
        onClick={(e) => e.stopPropagation()}
        className="w-[min(94vw,520px)] overflow-hidden rounded-card border border-border bg-surface shadow-pop"
      >
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, filtered.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); run(filtered[sel]); }
            else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          }}
          placeholder="Befehl suchen …"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-[14.5px] outline-none"
        />
        <div className="max-h-[46vh] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-4 py-4 text-[13px] text-faint">Kein Befehl gefunden.</div>
          ) : (
            filtered.map((a, i) => (
              <button
                key={a.label}
                onMouseEnter={() => setSel(i)}
                onClick={() => run(a)}
                className={`flex w-full items-center justify-between px-4 py-2 text-left text-[13.5px] transition ${i === sel ? 'bg-accent-soft text-accent' : 'text-fg/85 hover:bg-surface-2'}`}
              >
                <span>{a.label}</span>
                {a.hint && <span className="text-[11px] text-faint">{a.hint}</span>}
              </button>
            ))
          )}
        </div>
      </motion.div>
    </div>
  );
}

const DOC_ACTIONS: { label: string; prompt: string }[] = [
  { label: 'Zusammenfassen', prompt: 'Fasse die angehängten Dokumente strukturiert und vollständig zusammen.' },
  { label: 'Kernpunkte', prompt: 'Extrahiere die wichtigsten Kernpunkte aus den angehängten Dokumenten als übersichtliche Stichpunktliste.' },
  { label: 'Ins Englische', prompt: 'Übersetze den Inhalt der angehängten Dokumente vollständig ins Englische.' },
  { label: 'Ins Deutsche', prompt: 'Übersetze den Inhalt der angehängten Dokumente vollständig ins Deutsche.' },
  { label: 'Tabelle extrahieren', prompt: 'Extrahiere die enthaltenen Daten als saubere Markdown-Tabelle.' },
];

// Download-Karte für ein von der KI erzeugtes CI-Dokument (rendert beim Klick aus
// dem Inhalt das gestaltete PDF/Word über /api/export).
function DocCard({ doc }: { doc: { title?: string; format?: string; content?: string } }) {
  const [busy, setBusy] = useState(false);
  const fmt = (doc.format ?? 'pdf') as ExportFormat;
  const title = doc.title ?? 'Dokument';
  async function dl() {
    setBusy(true);
    try { await exportDocument(doc.content ?? '', title, fmt); } catch { /* still */ } finally { setBusy(false); }
  }
  return (
    <button onClick={dl} disabled={busy} className="mt-2 flex w-full max-w-sm items-center gap-3 rounded-xl border border-border bg-surface px-3.5 py-2.5 text-left shadow-soft transition hover:border-accent disabled:opacity-60">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
        {busy ? <Spinner size={15} className="text-accent" /> : <DownloadIcon />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium text-fg">{title}</span>
        <span className="block text-[11.5px] text-faint">{busy ? 'wird erstellt …' : `${fmt.toUpperCase()} · Corporate Design · herunterladen`}</span>
      </span>
    </button>
  );
}

function MessageRow({
  role,
  content,
  streaming,
  attachments,
  senderName,
  index,
  onEdit,
  onRegenerate,
}: {
  role: string;
  content: string;
  streaming?: boolean;
  attachments?: unknown[] | null;
  senderName?: string | null;
  index?: number;
  onEdit?: () => void;
  onRegenerate?: () => void;
}) {
  const isUser = role === 'user';
  const [copied, setCopied] = useState(false);
  const atts = (attachments ?? []) as { name?: string; kind?: string; title?: string; format?: string; content?: string; items?: { label: string; kind: string }[] }[];
  const docs = atts.filter((a) => a.kind === 'document');
  const sources = (atts.find((a) => a.kind === 'sources')?.items ?? []) as { label: string; kind: string }[];

  async function copy() {
    if (await copyText(content)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      data-msg-idx={index}
      className={`group/msg flex ${isUser ? 'justify-end' : 'justify-start'}`}
    >
      {isUser ? (
        <div className="flex max-w-[78%] flex-col items-end gap-1.5">
          {senderName && <span className="px-1 text-[11px] text-faint">{senderName}</span>}
          {atts.filter((a) => a.kind !== 'sources').length > 0 && (
            <div className="flex flex-wrap justify-end gap-1.5">
              {atts.filter((a) => a.kind !== 'sources' && a.kind !== 'document').map((a, i) => (
                <span key={i} className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1 text-[11.5px] text-muted">
                  <FileIcon /> {a.name ?? 'Datei'}
                </span>
              ))}
            </div>
          )}
          {content && (
            <div className="whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-[14.5px] text-white">
              {content}
            </div>
          )}
          {(onEdit || content) && (
            <div className="flex gap-1 opacity-0 transition group-hover/msg:opacity-100">
              <button onClick={copy} title="Kopieren" className="rounded-md px-1.5 py-0.5 text-[11px] text-muted transition hover:bg-surface-2 hover:text-accent">{copied ? 'Kopiert' : 'Kopieren'}</button>
              {onEdit && <button onClick={onEdit} title="Bearbeiten" className="rounded-md px-1.5 py-0.5 text-[11px] text-muted transition hover:bg-surface-2 hover:text-accent">Bearbeiten</button>}
            </div>
          )}
        </div>
      ) : (
        <div className="flex max-w-[88%] gap-3">
          <div className="mt-0.5">
            <Logo size={28} />
          </div>
          <div className={`min-w-0 ${streaming && !content ? 'pt-1' : ''}`}>
            {streaming && !content ? (
              <Spinner size={16} className="text-muted" />
            ) : (
              <div className={streaming ? 'cursor-blink' : ''}>
                <Markdown content={content} />
              </div>
            )}
            {docs.map((d, i) => <DocCard key={i} doc={d} />)}
            {sources.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-faint">Quellen:</span>
                {sources.map((s, i) => <SourceChip key={i} source={s} />)}
              </div>
            )}
            {!streaming && content && (
              <div className="mt-1.5 flex gap-1 opacity-0 transition group-hover/msg:opacity-100">
                <button onClick={copy} title="Antwort kopieren" className="rounded-md px-1.5 py-0.5 text-[11px] text-muted transition hover:bg-surface-2 hover:text-accent">{copied ? 'Kopiert' : 'Kopieren'}</button>
                {onRegenerate && <button onClick={onRegenerate} title="Neu generieren" className="rounded-md px-1.5 py-0.5 text-[11px] text-muted transition hover:bg-surface-2 hover:text-accent">Neu generieren</button>}
              </div>
            )}
          </div>
        </div>
      )}
    </motion.div>
  );
}

// Quellenangabe als Chip. Mit ID führt ein Klick direkt zum Ursprung:
// Vault-Notiz/-Dokument im Vault, Datei als Download.
function SourceChip({ source }: { source: { label: string; kind: string; id?: string } }) {
  const nav = useNavigate();
  const { kind, id, label } = source;

  if (kind === 'model') {
    return (
      <Badge tone="warn" icon="warnung" title="Diese Antwort stützt sich nicht auf das Wissens-Vault oder angehängte Dateien — bitte kritisch prüfen.">
        {label}
      </Badge>
    );
  }

  const isVault = kind === 'note' || kind === 'document' || kind === 'kb';
  const icon = isVault ? <BookIcon /> : <FileIcon />;
  const base = 'inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] font-medium transition';

  function open() {
    if (!id) return;
    if (kind === 'note') nav(`/vault?note=${id}`);
    else if (kind === 'document' || kind === 'kb') nav(`/vault?doc=${id}`);
    else window.open(`/api/files/${id}`, '_blank', 'noopener');
  }

  // Ohne ID (Altbestand) bleibt die Angabe sichtbar, aber nicht klickbar.
  if (!id) {
    return (
      <span className={`${base} border-border bg-surface text-muted`} title={isVault ? 'Wissens-Vault' : 'Angehängte Datei'}>
        {icon} {label}
      </span>
    );
  }

  return (
    <button
      onClick={open}
      title={isVault ? 'Im Wissens-Vault öffnen' : 'Datei öffnen'}
      className={`${base} border-border bg-surface text-muted hover:border-accent hover:text-accent`}
    >
      {icon} <span className="underline decoration-dotted underline-offset-2">{label}</span>
    </button>
  );
}

/* --- Icons (inline, keine Icon-Lib) --- */
function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
    </svg>
  );
}
function PinIcon({ filled }: { filled?: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 17v5M9 10.76 7 12.5V15h10v-2.5l-2-1.74V4H9zM7 4h10" />
    </svg>
  );
}
function ArchiveIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
    </svg>
  );
}
function ArrowDownIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M19 12l-7 7-7-7" />
    </svg>
  );
}
function OcrIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3M7 12h10" />
    </svg>
  );
}
function ProjectIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M3 11h18" />
    </svg>
  );
}
function FeedbackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    </svg>
  );
}
function SendIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}
function StopIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
    </svg>
  );
}
function ClipIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}
function FileIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}
function DownloadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
    </svg>
  );
}
function ThinkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a6 6 0 0 0-4 10.5V17h8v-3.5A6 6 0 0 0 12 3ZM9 21h6" />
    </svg>
  );
}
function ToolIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a4 4 0 0 1 5 5L16 15l3 3-2 2-3-3-3.3 3.3a4 4 0 0 1-5-5L9 12 6 9l2-2 3 3z" />
    </svg>
  );
}
function CodeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />
    </svg>
  );
}
function CanvasIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M15 3v18" />
    </svg>
  );
}
function ImageIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}
function TagIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <line x1="7" y1="7" x2="7.01" y2="7" />
    </svg>
  );
}
function ShareIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98" />
    </svg>
  );
}
function BookIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}
function GearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
