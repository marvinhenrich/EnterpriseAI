// API-Client mit Token-Handling. Spricht das Hono-Backend unter /api an
// (Dev: Vite-Proxy → :3001; Prod: gleiche Origin).

export interface User {
  id: number;
  username: string;
  email: string | null;
  role: string;
  department?: string | null;
  authProvider?: string;
  permissions?: string[];
}
export interface Chat {
  id: string;
  userId: number;
  title: string;
  model: string | null;
  projectId?: string | null;
  pinned?: boolean;
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
  access?: 'owner' | 'shared';
  sharedByName?: string | null;
}
export interface Message {
  id: number;
  chatId: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  attachments?: unknown[] | null;
  senderName?: string | null;
  createdAt: string;
}
export interface ChatShare {
  userId: number;
  username: string | null;
  canWrite: boolean;
}
export interface ChatSearchHit {
  chatId: string;
  title: string;
  updatedAt: string | null;
  snippet: string;
  matches: number;
  titleMatch: boolean;
}

const TOKEN_KEY = 'auth_token';
// Frühere Fassungen legten den Token unter einem anderen Namen ab. Ohne
// Übernahme wären beim ersten Start nach einer Umbenennung ALLE Anmeldungen
// verloren — eine sichtbare Änderung, die es bei einem Update nicht geben darf.
// Die Altnamen der eigenen Installation kommen aus der Build-Umgebung:
//   VITE_LEGACY_TOKEN_KEYS=alter_name,noch_aelterer_name
export const ALTE_SCHLUESSEL: string[] = (import.meta.env.VITE_LEGACY_TOKEN_KEYS ?? '')
  .split(',')
  .map((s: string) => s.trim())
  .filter(Boolean);

export const tokenStore = {
  get: () => {
    const t = localStorage.getItem(TOKEN_KEY);
    if (t) return t;
    for (const alt of ALTE_SCHLUESSEL) {
      const a = localStorage.getItem(alt);
      if (a) {
        localStorage.setItem(TOKEN_KEY, a);
        localStorage.removeItem(alt);
        return a;
      }
    }
    return null;
  },
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => {
    localStorage.removeItem(TOKEN_KEY);
    for (const alt of ALTE_SCHLUESSEL) localStorage.removeItem(alt);
  },
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = tokenStore.get();
  const res = await fetch('/api' + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}) as Record<string, unknown>);
  if (!res.ok) {
    throw new ApiError(res.status, (data as { error?: string }).error ?? `Fehler ${res.status}`, (data as { errorCode?: string }).errorCode);
  }
  return data as T;
}

export interface UploadedFile {
  id: string;
  filename: string;
  kind: 'document' | 'image';
  size: number;
  hasText: boolean;
  chars: number;
}

export function ocrFile(id: string) {
  return request<{ text: string; chars: number }>(`/files/${id}/ocr`, { method: 'POST' });
}

export async function uploadFiles(fileList: File[]): Promise<UploadedFile[]> {
  const fd = new FormData();
  for (const f of fileList) fd.append('files', f);
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenStore.get()}` },
    body: fd,
  });
  const data = (await res.json().catch(() => ({}))) as { files?: UploadedFile[]; error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'Upload fehlgeschlagen');
  return data.files ?? [];
}

export const api = {
  login: (username: string, password: string) =>
    request<{ token: string; user: User; mustChangePassword: boolean }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  me: () => request<User>('/auth/me'),
  models: () => request<{ models: string[]; default: string }>('/models'),
  listChats: () => request<{ chats: Chat[] }>('/chats'),
  searchChats: (q: string) => request<{ query: string; hits: ChatSearchHit[] }>(`/chats/search?q=${encodeURIComponent(q)}`),
  createChat: (title?: string, projectId?: string | null) =>
    request<{ chat: Chat }>('/chats', { method: 'POST', body: JSON.stringify({ title, projectId }) }),
  getChat: (id: string) =>
    request<{ chat: Chat; messages: Message[]; access: 'owner' | 'shared'; canWrite: boolean }>(`/chat/${id}`),
  renameChat: (id: string, title: string) =>
    request<{ ok: boolean }>(`/chat/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  deleteChat: (id: string) => request<{ ok: boolean }>(`/chat/${id}`, { method: 'DELETE' }),
  truncateChat: (id: string, keep: number) =>
    request<{ ok: boolean }>(`/chat/${id}/truncate`, { method: 'POST', body: JSON.stringify({ keep }) }),
  setChatFlags: (id: string, flags: { pinned?: boolean; archived?: boolean }) =>
    request<{ ok: boolean }>(`/chat/${id}/flags`, { method: 'POST', body: JSON.stringify(flags) }),
  chatShares: (id: string) => request<{ shares: ChatShare[] }>(`/chat/${id}/shares`),
  shareChat: (id: string, username: string, canWrite = true) =>
    request<{ ok: boolean; shares: ChatShare[]; error?: string }>(`/chat/${id}/share`, {
      method: 'POST',
      body: JSON.stringify({ username, canWrite }),
    }),
  unshareChat: (id: string, userId: number) =>
    request<{ ok: boolean; shares: ChatShare[] }>(`/chat/${id}/share/${userId}`, { method: 'DELETE' }),
};

export interface AdminUser {
  id: number;
  username: string;
  email: string | null;
  role: string;
  isActive: boolean;
  department: string | null;
  authProvider: string;
  lastLogin: string | null;
  createdAt: string | null;
}
export interface AuditEntry {
  id: number;
  username: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  details: unknown;
  ipAddress: string | null;
  createdAt: string | null;
}

// --- Konnektoren ---------------------------------------------------------------
export type ConnectorStatus = 'online' | 'offline' | 'disabled' | 'planned' | 'error';
export interface Connector {
  id: string;
  name: string;
  category: string;
  status: ConnectorStatus;
  endpoint: string | null;
  detail: string;
  description: string;
  internal: boolean;
  latencyMs?: number | null;
  dependsOn?: string[];
  provides?: string;
  impact?: string;
}
export interface ConnectorSummary { online: number; problem: number; disabled: number; planned: number }

export interface PerfSummary {
  tage: { d: string; anfragen: number; ttfbMedian: number; totalMedian: number; fehler: number }[];
  gesamt: { anfragen: number; ttfbMedian: number; ttfbP90: number; totalMedian: number; fehlerquote: number };
  langsamste: { created_at: string; prompt_chars: number; ttfb_ms: number; total_ms: number }[];
}

// --- Projekte -----------------------------------------------------------------
export type Klasse = 'offen' | 'intern' | 'vertraulich' | 'geheim';
export interface KlassenInfo { key: Klasse; rang: number; label: string; kurz: string }

export interface Project {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  color: string | null;
  vaultScope: 'all' | 'project';
  classification: Klasse;
  chatCount: number;
  fileCount: number;
  createdAt: string | null;
  updatedAt: string | null;
}
export interface ProjectMemoryEntry {
  id: number;
  projectId: string;
  text: string;
  source: 'auto' | 'manual';
  chatId: string | null;
  createdBy: string | null;
  createdAt: string | null;
}
export interface ProjectFile {
  id: string;
  filename: string;
  kind: string;
  size: number;
  hasText: boolean;
  chars: number;
  createdAt: string | null;
  classification: Klasse;
}

export const projectApi = {
  klassen: () => request<{ klassen: KlassenInfo[]; darfHerabstufen: boolean }>('/classifications'),
  setProjectClassification: (id: string, classification: Klasse, mitDateien = true) =>
    request<{ ok: boolean; classification: Klasse; dateien: number }>(`/projects/${id}/classification`, {
      method: 'PATCH',
      body: JSON.stringify({ classification, mitDateien }),
    }),
  setFileClassification: (id: string, classification: Klasse) =>
    request<{ ok: boolean; classification: Klasse }>(`/files/${id}/classification`, {
      method: 'PATCH',
      body: JSON.stringify({ classification }),
    }),
  list: () => request<{ projects: Project[] }>('/projects'),
  get: (id: string) => request<{ project: Project; files: ProjectFile[]; memory: ProjectMemoryEntry[] }>(`/projects/${id}`),
  create: (b: { name: string; description?: string; instructions?: string; vaultScope?: 'all' | 'project' }) =>
    request<{ project: Project }>('/projects', { method: 'POST', body: JSON.stringify(b) }),
  update: (id: string, b: { name?: string; description?: string | null; instructions?: string | null; vaultScope?: 'all' | 'project' }) =>
    request<{ project: Project }>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  remove: (id: string) => request<{ ok: boolean }>(`/projects/${id}`, { method: 'DELETE' }),
  assignChat: (chatId: string, projectId: string | null) =>
    request<{ ok: boolean }>(`/chat/${chatId}/project`, { method: 'POST', body: JSON.stringify({ projectId }) }),
  uploadFiles: async (id: string, files: File[]) => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    const res = await fetch(`/api/projects/${id}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenStore.get()}` },
      body: fd,
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; files?: ProjectFile[] };
    if (!res.ok) throw new ApiError(res.status, data.error ?? `Fehler ${res.status}`);
    return data;
  },
  removeFile: (id: string, fileId: string) => request<{ ok: boolean }>(`/projects/${id}/files/${fileId}`, { method: 'DELETE' }),

  // Projekt-Kontext („Projekt-Memory")
  memory: (id: string) => request<{ memory: ProjectMemoryEntry[] }>(`/projects/${id}/memory`),
  addMemory: (id: string, text: string) =>
    request<{ entry: ProjectMemoryEntry }>(`/projects/${id}/memory`, { method: 'POST', body: JSON.stringify({ text }) }),
  updateMemory: (id: string, entryId: number, text: string) =>
    request<{ ok: boolean }>(`/projects/${id}/memory/${entryId}`, { method: 'PATCH', body: JSON.stringify({ text }) }),
  removeMemory: (id: string, entryId: number) =>
    request<{ ok: boolean }>(`/projects/${id}/memory/${entryId}`, { method: 'DELETE' }),
};

// --- Wissens-Vault ------------------------------------------------------------
export type VaultVisibility = '' | 'restricted' | 'it';
export interface KbDocument {
  id: string;
  title: string;
  filename: string;
  size: number;
  chunks: number;
  folder: string;
  tags: string[];
  visibility: VaultVisibility;
  aiUse: boolean;
  mime?: string | null;
  createdAt: string | null;
}
export interface VaultNote {
  id: string;
  title: string;
  folder: string;
  tags: string[];
  visibility: VaultVisibility;
  aiUse: boolean;
  chunks: number;
  content?: string;
  createdByName: string | null;
  updatedByName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}
export interface VaultStats {
  notes: number;
  documents: number;
  chunks: number;
  folders: string[];
  tags: { tag: string; count: number }[];
}
export interface VaultSearchHit {
  id: string;
  type: 'note' | 'document';
  title: string;
  folder: string;
  snippet: string;
  score?: number;
}
export interface LinkRef { id: string; title: string }
export interface VaultRevision {
  id: number;
  noteId: string;
  title: string;
  folder: string;
  tags: string | null;
  editedBy: string | null;
  action: 'create' | 'update' | 'restore';
  summary: string | null;
  createdAt: string | null;
  contentLength?: number;
}
export interface AuditFilters {
  action?: string; resourceType?: string; resourceId?: string;
  user?: string; from?: string; to?: string; q?: string;
  limit?: number; offset?: number;
}

export const kbApi = {
  overview: () => request<{ notes: VaultNote[]; documents: KbDocument[]; stats: VaultStats; visibilityLevels: { key: VaultVisibility; label: string; help: string }[] }>('/kb/overview'),
  list: () => request<{ documents: KbDocument[] }>('/kb/documents'),

  // Notizen
  note: (id: string) =>
    request<{ note: VaultNote & { content: string }; backlinks: LinkRef[]; links: { title: string; id: string | null }[] }>(`/kb/notes/${id}`),
  createNote: (b: { title: string; content?: string; folder?: string; tags?: string[]; visibility?: VaultVisibility; aiUse?: boolean }) =>
    request<{ note: VaultNote & { content: string } }>('/kb/notes', { method: 'POST', body: JSON.stringify(b) }),
  updateNote: (id: string, b: { title?: string; content?: string; folder?: string; tags?: string[]; visibility?: VaultVisibility; aiUse?: boolean }) =>
    request<{ note: VaultNote & { content: string } }>(`/kb/notes/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  deleteNote: (id: string) => request<{ ok: boolean }>(`/kb/notes/${id}`, { method: 'DELETE' }),

  // Dokumente
  documentContent: (id: string) => request<{ document: KbDocument; text: string }>(`/kb/documents/${id}/content`),
  updateDocument: (id: string, b: { title?: string; folder?: string; tags?: string[] }) =>
    request<{ document: KbDocument }>(`/kb/documents/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  remove: (id: string) => request<{ ok: boolean }>(`/kb/documents/${id}`, { method: 'DELETE' }),
  downloadDocument: async (id: string, filename: string) => {
    const res = await fetch(`/api/kb/documents/${id}/file`, { headers: { Authorization: `Bearer ${tokenStore.get()}` } });
    if (!res.ok) throw new ApiError(res.status, 'Download fehlgeschlagen');
    triggerDownload(await res.blob(), filename);
  },
  upload: async (files: File[], opts: { folder?: string; tags?: string[] } = {}) => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    if (opts.folder) fd.append('folder', opts.folder);
    if (opts.tags?.length) fd.append('tags', opts.tags.join(','));
    const res = await fetch('/api/kb/documents', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenStore.get()}` },
      body: fd,
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(res.status, data.error ?? `Fehler ${res.status}`);
    return data;
  },

  // Versionshistorie
  history: (id: string) => request<{ revisions: VaultRevision[] }>(`/kb/notes/${id}/history`),
  revision: (id: string, revId: number) =>
    request<{ revision: VaultRevision & { content: string }; previous: { id: number; content: string; title: string; createdAt: string | null } | null }>(
      `/kb/notes/${id}/history/${revId}`,
    ),
  restoreRevision: (id: string, revId: number) =>
    request<{ note: VaultNote & { content: string } }>(`/kb/notes/${id}/history/${revId}/restore`, { method: 'POST' }),

  // Suche
  search: (q: string, mode: 'text' | 'semantic' = 'text') =>
    request<{ query: string; mode: string; hits: VaultSearchHit[]; error?: string }>(`/kb/search?q=${encodeURIComponent(q)}&mode=${mode}`),
};

function triggerDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export type ExportFormat = 'docx' | 'pdf' | 'xlsx' | 'pptx' | 'html' | 'csv' | 'txt';

export async function exportDocument(content: string, title: string, format: ExportFormat): Promise<void> {
  const res = await fetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenStore.get()}` },
    body: JSON.stringify({ content, title, format }),
  });
  if (!res.ok) {
    const d = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, d.error ?? `Export fehlgeschlagen (${res.status})`);
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') ?? '';
  const m = cd.match(/filename="([^"]+)"/);
  triggerDownload(blob, m?.[1] ?? `dokument.${format}`);
}

export function downloadMarkdown(content: string, title: string): void {
  const name = (title || 'dokument').replace(/[^a-zA-Z0-9-_ ]+/g, '_').trim().replace(/\s+/g, '_').slice(0, 50) || 'dokument';
  triggerDownload(new Blob([content], { type: 'text/markdown;charset=utf-8' }), `${name}.md`);
}

export interface Overview {
  users: number; activeUsers: number; adUsers: number; chats: number; messages: number;
  messagesToday: number; messages7d: number; newUsers7d: number; activeToday: number;
  kbDocs: number; files: number; model: string; adOk: boolean; uptimeSec: number;
}
export interface Analytics {
  days: number;
  messagesPerDay: { d: string; c: number }[];
  activeUsersPerDay: { d: string; c: number }[];
  topUsers: { name: string; c: number }[];
}
export interface SystemInfo {
  model: string; embedModel: string; adConfigured: boolean; adOk: boolean; adMessage: string;
  requiredGroup: string; uptimeSec: number; nodeVersion: string; uid: number;
  permissionsCount: number; dbSizeBytes: number; httpsPort: number; bindInterface: string;
  maintenance: { on: boolean; message: string };
}
export interface PermissionMeta { key: string; label: string; category: string; help: string }

export interface ImageModelMeta { key: string; label: string; steps: number }
export interface ImageItem { id: string; prompt: string; model: string; seed: number | null; width: number | null; height: number | null; ms: number | null; createdAt: string | null }
export interface ImageJobActive { id: string; status: string; prompt: string; model: string; error: string | null; createdAt: string | null }
export interface ImageQueue { running: { id: string; userName: string | null; prompt: string; model: string; elapsedSec: number | null; mine: boolean } | null; queuedCount: number; myQueued: number }

export const imageApi = {
  models: () => request<{ enabled: boolean; models: ImageModelMeta[] }>('/image/models'),
  generate: (body: { prompt: string; model: string; width?: number; height?: number; steps?: number; guidance?: number; seed?: number; negative_prompt?: string; reference?: string; mask?: string; imageStrength?: number }) =>
    request<{ id: string; position: number }>('/image/generate', { method: 'POST', body: JSON.stringify(body) }),
  list: () => request<{ images: ImageItem[]; active: ImageJobActive[]; queue: ImageQueue }>('/image/list'),
  queue: () => request<{ active: ImageJobActive[]; queue: ImageQueue }>('/image/queue'),
  remove: (id: string) => request<{ ok: boolean }>(`/image/${id}`, { method: 'DELETE' }),
};

// Bilddatei (auth-geschützt) als Blob-URL laden (für <img> ohne Cookie/Token im src).
export async function fetchImageBlobUrl(id: string): Promise<string> {
  const res = await fetch(`/api/image/${id}/file`, { headers: { Authorization: `Bearer ${tokenStore.get()}` } });
  if (!res.ok) throw new ApiError(res.status, 'Bild nicht ladbar');
  return URL.createObjectURL(await res.blob());
}

// --- Geteilte Etiketten-Datenbank -------------------------------------------
export interface LabelRow { id: string; filename: string; kind: string; size: number; pages: number | null; ocrStatus: string; status: string | null; found: string[]; uploadedByName: string | null; createdAt: string | null }
export interface LabelStats { total: number; ocrDone: number; hits: number; terms: number }
export interface ScanView { id: string; status: string; total: number; done: number; hits: number; termCount: number; startedByName: string | null; startedAt: string | null; finishedAt: string | null; error: string | null; etaSec: number | null }
export interface LabelTerm { id: number; term: string; variants: string[] | null }

export const labelsApi = {
  list: () => request<{ labels: LabelRow[]; stats: LabelStats; scan: ScanView | null }>('/labels'),
  remove: (id: string) => request<{ ok: boolean; stats: LabelStats }>(`/labels/${id}`, { method: 'DELETE' }),
  terms: () => request<{ terms: LabelTerm[] }>('/labels/terms'),
  addTerms: (text: string) => request<{ added: number; terms: LabelTerm[] }>('/labels/terms', { method: 'POST', body: JSON.stringify({ text }) }),
  removeTerm: (id: number) => request<{ ok: boolean; terms: LabelTerm[] }>(`/labels/terms/${id}`, { method: 'DELETE' }),
  clearTerms: () => request<{ ok: boolean; removed: number }>('/labels/terms/clear', { method: 'POST' }),
  translate: () => request<{ ok: boolean }>('/labels/terms/translate', { method: 'POST' }),
  scan: () => request<{ scan: ScanView | null }>('/labels/scan'),
  startScan: () => request<{ ok: boolean; scan: ScanView | null }>('/labels/scan', { method: 'POST' }),
  cancelScan: () => request<{ ok: boolean }>('/labels/scan/cancel', { method: 'POST' }),
  async upload(files: File[]): Promise<{ added: number }> {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    const res = await fetch('/api/labels', { method: 'POST', headers: { Authorization: `Bearer ${tokenStore.get()}` }, body: fd });
    const d = (await res.json().catch(() => ({}))) as { added?: number; error?: string };
    if (!res.ok) throw new ApiError(res.status, d.error ?? 'Upload fehlgeschlagen');
    return { added: d.added ?? 0 };
  },
};

export async function downloadLabelsExcel(): Promise<void> {
  const res = await fetch('/api/labels/export', { headers: { Authorization: `Bearer ${tokenStore.get()}` } });
  if (!res.ok) throw new ApiError(res.status, 'Excel-Export fehlgeschlagen');
  triggerDownload(await res.blob(), 'Etiketten-Datenbank.xlsx');
}

// --- Feedback ----------------------------------------------------------------
export type FeedbackCategory = 'bug' | 'idea' | 'other';
export type FeedbackStatus = 'open' | 'in_progress' | 'resolved' | 'declined';
export interface FeedbackEntry {
  id: number;
  userId: number | null;
  username: string | null;
  category: FeedbackCategory;
  rating: number | null;
  message: string;
  context: string | null;
  status: FeedbackStatus;
  response: string | null;
  handledBy: string | null;
  handledAt: string | null;
  createdAt: string | null;
}
export interface FeedbackStats { byStatus: Record<string, number>; byCategory: Record<string, number>; total: number }

export function submitFeedback(body: { category: FeedbackCategory; message: string; context?: string }) {
  return request<{ ok: boolean; feedback: FeedbackEntry }>('/feedback', { method: 'POST', body: JSON.stringify(body) });
}

/** Eigene Rückmeldungen inkl. Bearbeitungsstand und Antwort der Administration. */
export function myFeedback() {
  return request<{ feedback: FeedbackEntry[] }>('/feedback/mine');
}

export interface ModulEintrag {
  id: string;
  name: string;
  zweck: string;
  gruppe: string;
  braucht?: string[];
  voraussetzung?: string;
  aktiv: boolean;
  /** Vorausgesetzte Module, die abgeschaltet sind — dann greift dieses hier nicht. */
  blockiertDurch: string[];
}

export const adminApi = {
  stats: () => request<{ users: number; chats: number; messages: number; activeUsers: number }>('/admin/stats'),
  feedback: (opts: { status?: FeedbackStatus; category?: string } = {}) => {
    const p = new URLSearchParams();
    if (opts.status) p.set('status', opts.status);
    if (opts.category) p.set('category', opts.category);
    const q = p.toString();
    return request<{ feedback: FeedbackEntry[]; open: number; stats: FeedbackStats }>(`/admin/feedback${q ? `?${q}` : ''}`);
  },
  updateFeedback: (id: number, b: { status?: FeedbackStatus; response?: string }) =>
    request<{ ok: boolean }>(`/admin/feedback/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  deleteFeedback: (id: number) => request<{ ok: boolean }>(`/admin/feedback/${id}`, { method: 'DELETE' }),
  overview: () => request<Overview>('/admin/overview'),
  analytics: (days = 14) => request<Analytics>(`/admin/analytics?days=${days}`),
  downloadActiveUsersExcel: async (): Promise<void> => {
    const res = await fetch('/api/admin/analytics/active-users.xlsx', { headers: { Authorization: `Bearer ${tokenStore.get()}` } });
    if (!res.ok) throw new ApiError(res.status, 'Excel-Export fehlgeschlagen');
    const cd = res.headers.get('Content-Disposition') ?? '';
    const m = cd.match(/filename="([^"]+)"/);
    triggerDownload(await res.blob(), m?.[1] ?? 'meist-aktive-nutzer.xlsx');
  },
  reportMonths: () => request<{ months: { monat: string; anfragen: number }[] }>('/admin/report/months'),
  downloadReport: async (monat: string | null, format: 'pdf' | 'docx' = 'pdf'): Promise<void> => {
    const p = new URLSearchParams({ format });
    if (monat) p.set('monat', monat);
    const res = await fetch(`/api/admin/report?${p}`, { headers: { Authorization: `Bearer ${tokenStore.get()}` } });
    if (!res.ok) throw new ApiError(res.status, 'Bericht konnte nicht erstellt werden');
    const cd = res.headers.get('Content-Disposition') ?? '';
    triggerDownload(await res.blob(), cd.match(/filename="([^"]+)"/)?.[1] ?? `bericht.${format}`);
  },
  module: () => request<{ module: ModulEintrag[] }>('/admin/modules'),
  modulSetzen: (id: string, aktiv: boolean) =>
    request<{ ok: true; id: string; aktiv: boolean; mitBetroffen: string[] }>(`/admin/modules/${id}`, {
      method: 'PATCH', body: JSON.stringify({ aktiv }),
    }),
  connectors: () => request<{ connectors: Connector[]; summary: ConnectorSummary }>('/admin/connectors'),
  performance: (days = 14) => request<PerfSummary>(`/admin/performance?days=${days}`),
  system: () => request<SystemInfo>('/admin/system'),
  users: () => request<{ users: AdminUser[] }>('/admin/users'),
  createUser: (b: { username: string; password: string; email?: string; role?: string; department?: string }) =>
    request<{ user: unknown }>('/admin/users', { method: 'POST', body: JSON.stringify(b) }),
  updateUser: (id: number, b: { role?: string; department?: string | null; email?: string | null; isActive?: boolean }) =>
    request<{ ok: boolean }>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  resetPassword: (id: number, password: string) =>
    request<{ ok: boolean }>(`/admin/users/${id}/password`, { method: 'POST', body: JSON.stringify({ password }) }),
  deleteUser: (id: number) => request<{ ok: boolean }>(`/admin/users/${id}`, { method: 'DELETE' }),
  audit: (opts: AuditFilters = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) if (v !== undefined && v !== '') p.set(k, String(v));
    if (!p.has('limit')) p.set('limit', '100');
    return request<{ audit: AuditEntry[]; total: number; limit: number; offset: number; actions: string[]; resourceTypes: string[] }>(
      `/admin/audit?${p.toString()}`,
    );
  },
  auditExportCsv: async (opts: AuditFilters = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) if (v !== undefined && v !== '') p.set(k, String(v));
    const res = await fetch(`/api/admin/audit/export.csv?${p.toString()}`, { headers: { Authorization: `Bearer ${tokenStore.get()}` } });
    if (!res.ok) throw new ApiError(res.status, 'Export fehlgeschlagen');
    const cd = res.headers.get('Content-Disposition') ?? '';
    triggerDownload(await res.blob(), cd.match(/filename="([^"]+)"/)?.[1] ?? 'audit.csv');
  },
  getMaintenance: () => request<{ on: boolean; message: string }>('/admin/maintenance'),
  setMaintenance: (on: boolean, message?: string) =>
    request<{ ok: boolean; on: boolean; message: string }>('/admin/maintenance', { method: 'POST', body: JSON.stringify({ on, message }) }),
  adSearch: (query: string) => request<{ found: unknown }>('/admin/ad/search', { method: 'POST', body: JSON.stringify({ query }) }),
  adImport: (query: string) => request<{ user: unknown; error?: string }>('/admin/ad/import', { method: 'POST', body: JSON.stringify({ query }) }),
  /** Unternehmens-Konfiguration schreiben. Wirkt sofort, ohne Neustart. */
  unternehmenSetzen: (patch: {
    appName?: string; appShort?: string; organisation?: string; farbe?: string; sprache?: string;
  }) => request<{ appName: string; appShort: string; organisation: string; farbe: string; sprache: 'de' | 'en' }>(
    '/config/unternehmen', { method: 'PATCH', body: JSON.stringify(patch) },
  ),
  permissionCatalog: () => request<{ permissions: PermissionMeta[] }>('/admin/permissions'),
  userPermissions: (id: number) =>
    request<{ role: string; effective: string[]; overrides: Record<string, boolean> }>(`/admin/users/${id}/permissions`),
  setUserPermission: (id: number, permission: string, granted: boolean | null) =>
    request<{ ok: boolean; effective: string[]; overrides: Record<string, boolean> }>(`/admin/users/${id}/permissions`, {
      method: 'POST',
      body: JSON.stringify({ permission, granted }),
    }),
  bulkPermission: (permission: string, granted: boolean | null, userIds: number[] | 'all') =>
    request<{ ok: boolean; affected: number }>('/admin/permissions/bulk', {
      method: 'POST',
      body: JSON.stringify({ permission, granted, userIds }),
    }),
};
