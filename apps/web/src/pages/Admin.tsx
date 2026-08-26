import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  adminApi,
  type AdminUser,
  type AuditEntry,
  type Overview as OverviewData,
  type Analytics as AnalyticsData,
  type SystemInfo,
  type PermissionMeta,
  type FeedbackEntry,
  type FeedbackStats,
  type FeedbackStatus,
  type Connector,
  type ConnectorSummary,
  type PerfSummary,
  type ModulEintrag,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { useT, SPRACHEN, SPRACHNAMEN } from '../i18n';
import { Logo } from '../components/Logo';
import { Spinner } from '../components/Spinner';
import { Icon, Badge, StatusDot, CloseButton, SectionTitle, type IconName, type Tone } from '../components/ui';
import { branding, ladeBranding } from '../lib/branding';

type Tab = 'overview' | 'users' | 'permissions' | 'ad' | 'system' | 'audit' | 'analytics' | 'feedback' | 'connectors' | 'module' | 'unternehmen';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Übersicht' },
  { id: 'users', label: 'Benutzer' },
  { id: 'permissions', label: 'Berechtigungen' },
  { id: 'ad', label: 'AD-Import' },
  { id: 'connectors', label: 'Konnektoren' },
  { id: 'module', label: 'Module' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'feedback', label: 'Feedback' },
  { id: 'audit', label: 'Audit-Log' },
  { id: 'unternehmen', label: 'Unternehmen' },
  { id: 'system', label: 'System' },
];

// Bereiche thematisch gruppiert — sonst sind neun Einträge eine lose Liste.
const TAB_GROUPS: { title: string; tabs: Tab[] }[] = [
  { title: 'Überblick', tabs: ['overview', 'analytics'] },
  { title: 'Benutzer', tabs: ['users', 'permissions', 'ad'] },
  { title: 'System', tabs: ['unternehmen', 'module', 'connectors', 'system'] },
  { title: 'Nachvollziehbarkeit', tabs: ['feedback', 'audit'] },
];

export function Admin() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>('overview');

  if (user?.role !== 'admin' && !user?.permissions?.includes('admin.access')) {
    return (
      <div className="grid h-full place-items-center text-muted">
        <div className="text-center">
          <p>Kein Zugriff – Adminrechte erforderlich.</p>
          <button onClick={() => nav('/')} className="mt-3 text-accent hover:underline">Zurück zum Chat</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-surface px-6 py-3">
        <div className="flex items-center gap-3">
          <Logo size={28} />
          <span className="text-[15px] font-semibold">{branding().appShort} · Administration</span>
        </div>
        <button onClick={() => nav('/')} className="rounded-lg px-3 py-1.5 text-[13px] text-muted transition hover:bg-surface-2 hover:text-accent">← Zum Chat</button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Bereichswahl als Leiste links — bei neun Bereichen übersichtlicher als Reiter. */}
        <nav className="w-[190px] shrink-0 overflow-y-auto border-r border-border bg-surface p-2">
          {TAB_GROUPS.map((g) => (
            <div key={g.title} className="mb-2">
              <div className="px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-faint">{g.title}</div>
              {g.tabs.map((id) => {
                const t = TABS.find((x) => x.id === id)!;
                const active = tab === id;
                return (
                  <button
                    key={id}
                    onClick={() => setTab(id)}
                    className={`relative mb-0.5 flex w-full items-center rounded-lg px-2.5 py-2 text-left text-[13px] transition ${
                      active ? 'bg-accent-soft font-medium text-accent' : 'text-fg/80 hover:bg-surface-2'
                    }`}
                  >
                    {active && <motion.span layoutId="tab-marker" className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent" />}
                    {t.label}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="min-w-0 flex-1 overflow-y-auto bg-bg p-6">
          <div className={`mx-auto ${tab === 'connectors' ? 'max-w-[1260px]' : 'max-w-5xl'}`}>
            {tab === 'overview' && <Overview />}
            {tab === 'users' && <Users />}
            {tab === 'permissions' && <Permissions />}
            {tab === 'ad' && <AdImport />}
            {tab === 'connectors' && <Connectors />}
            {tab === 'module' && <Module />}
            {tab === 'analytics' && <Analytics />}
            {tab === 'feedback' && <Feedback />}
            {tab === 'audit' && <Audit />}
            {tab === 'unternehmen' && <Unternehmen />}
            {tab === 'system' && <System />}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Bausteine ---------------------------------------------------------------
function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-card border border-border bg-surface shadow-soft ${className}`}>{children}</div>;
}

function Help({ text }: { text: string }) {
  return (
    <span className="group relative ml-1 inline-flex align-middle">
      <span className="flex h-[15px] w-[15px] cursor-help items-center justify-center rounded-full border border-border-strong text-[9px] font-semibold text-faint">?</span>
      <span className="pointer-events-none absolute bottom-full left-1/2 z-40 mb-1.5 hidden w-60 -translate-x-1/2 rounded-lg bg-fg px-3 py-2 text-[11.5px] font-normal leading-snug text-white shadow-pop group-hover:block">
        {text}
      </span>
    </span>
  );
}

// Lücken füllen: Tage ohne Daten müssen als 0 erscheinen, sonst verzerrt die
// Zeitachse (aufeinanderfolgende Balken suggerieren sonst lückenlose Aktivität).
function fillDays(data: { d: string; c: number }[], days: number): { d: string; c: number }[] {
  const byDay = new Map(data.map((r) => [r.d, r.c]));
  const out: { d: string; c: number }[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(today);
    dt.setDate(today.getDate() - i);
    const key = dt.toISOString().slice(0, 10);
    out.push({ d: key, c: byDay.get(key) ?? 0 });
  }
  return out;
}

function BarChart({ data, days, color = 'var(--color-accent)' }: { data: { d: string; c: number }[]; days?: number; color?: string }) {
  const series = days ? fillDays(data, days) : data;
  const max = Math.max(1, ...series.map((d) => d.c));
  const total = series.reduce((s, d) => s + d.c, 0);
  const avg = series.length ? Math.round(total / series.length) : 0;
  const fmtDay = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}.`;
  // Bei vielen Tagen nicht jedes Datum beschriften (sonst überlappt es).
  const step = Math.max(1, Math.ceil(series.length / 8));

  if (series.length === 0) {
    return <div className="grid h-32 w-full place-items-center text-[12px] text-faint">Noch keine Daten</div>;
  }

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-[11px] text-faint">
        <span>Max {max}</span>
        <span>Gesamt {total} · Ø {avg}/Tag</span>
      </div>
      <div className="flex h-32 items-end gap-[3px] border-b border-l border-border pb-px pl-px">
        {series.map((d) => (
          // h-full ist nötig: der Rahmen setzt items-end, die Spalte bekäme sonst
          // automatische Höhe — und eine Prozenthöhe darin löst sich nicht auf.
          // Alle Balken fielen dann auf die Mindesthöhe zurück, das Diagramm war flach.
          <div key={d.d} className="group relative flex h-full flex-1 flex-col items-center justify-end" title={`${fmtDay(d.d)}: ${d.c}`}>
            {/* Wert beim Überfahren */}
            <span className="pointer-events-none absolute -top-4 hidden whitespace-nowrap rounded bg-fg px-1.5 py-0.5 text-[10px] text-bg group-hover:block">
              {fmtDay(d.d)}: {d.c}
            </span>
            <div
              className="w-full rounded-t transition group-hover:opacity-80"
              style={{ height: `${(d.c / max) * 100}%`, minHeight: d.c > 0 ? '3px' : '1px', background: d.c > 0 ? color : 'var(--color-border)' }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[3px] text-[10px] text-faint">
        {series.map((d, i) => (
          <div key={d.d} className="flex-1 text-center">
            {i % step === 0 ? fmtDay(d.d) : ''}
          </div>
        ))}
      </div>
    </div>
  );
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}min` : `${m} min`;
}

// --- Übersicht ---------------------------------------------------------------
function Overview() {
  const [o, setO] = useState<OverviewData | null>(null);
  const [a, setA] = useState<AnalyticsData | null>(null);
  useEffect(() => {
    adminApi.overview().then(setO).catch(() => {});
    adminApi.analytics(14).then(setA).catch(() => {});
  }, []);
  if (!o) return <Spinner />;

  const cards = [
    { label: 'Benutzer', value: o.users, sub: `${o.adUsers} aus AD` },
    { label: 'Aktiv heute', value: o.activeToday, sub: `${o.activeUsers} aktiviert` },
    { label: 'Nachrichten heute', value: o.messagesToday, sub: `${o.messages7d} in 7 Tagen` },
    { label: 'Chats gesamt', value: o.chats, sub: `${o.messages} Nachrichten` },
    { label: 'Wissens-Dokumente', value: o.kbDocs, sub: `${o.files} Datei-Uploads` },
    { label: 'Neue Nutzer (7T)', value: o.newUsers7d, sub: '' },
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {cards.map((c, i) => (
          <motion.div key={c.label} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
            <Card className="p-5">
              <div className="text-[27px] font-semibold tabular-nums">{c.value}</div>
              <div className="mt-1 text-[12.5px] text-muted">{c.label}</div>
              {c.sub && <div className="text-[11px] text-faint">{c.sub}</div>}
            </Card>
          </motion.div>
        ))}
      </div>

      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[13.5px] font-medium">Nachrichten · letzte 14 Tage</span>
          <span className="flex items-center gap-2 text-[12px] text-muted">
            <StatusDot tone={o.adOk ? 'ok' : 'danger'} /> AD {o.adOk ? 'verbunden' : 'getrennt'}
            <span className="text-faint">· Modell {o.model} · seit {fmtUptime(o.uptimeSec)}</span>
          </span>
        </div>
        <BarChart data={a?.messagesPerDay ?? []} days={14} />
      </Card>
    </div>
  );
}

// --- Benutzer ----------------------------------------------------------------
function Users() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [permUser, setPermUser] = useState<AdminUser | null>(null);
  const [creating, setCreating] = useState(false);
  const load = () => adminApi.users().then((r) => setUsers(r.users)).catch(() => {}).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  async function toggleActive(u: AdminUser) { await adminApi.updateUser(u.id, { isActive: !u.isActive }).catch(() => {}); load(); }
  async function changeRole(u: AdminUser, role: string) { await adminApi.updateUser(u.id, { role }).catch(() => {}); load(); }
  async function resetPw(u: AdminUser) { const pw = prompt(`Neues Passwort für ${u.username}:`); if (pw) await adminApi.resetPassword(u.id, pw).then(() => alert('Passwort gesetzt.')).catch((e) => alert(e.message)); }
  async function del(u: AdminUser) { if (confirm(`Benutzer "${u.username}" wirklich löschen?`)) { await adminApi.deleteUser(u.id).catch((e) => alert(e.message)); load(); } }

  if (loading) return <Spinner />;
  const filtered = users.filter((u) => u.username.toLowerCase().includes(q.toLowerCase()) || (u.email ?? '').toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <Card className="p-0">
        <div className="flex items-center justify-between gap-2 border-b border-border p-4">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Suche Benutzer / E-Mail …" className="w-64 rounded-lg border border-border-strong bg-white px-3 py-2 text-[13.5px] outline-none focus:border-accent" />
          <div className="flex items-center gap-3">
            <span className="text-[12.5px] text-muted">{filtered.length} von {users.length}</span>
            <button onClick={() => setCreating(true)} className="rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white transition hover:bg-accent-hover">+ Benutzer</button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="text-left text-muted">
              <tr className="border-b border-border">
                <th className="px-4 py-2.5 font-medium">Benutzer</th>
                <th className="px-4 py-2.5 font-medium">Quelle</th>
                <th className="px-4 py-2.5 font-medium">Rolle</th>
                <th className="px-4 py-2.5 font-medium">Letzter Login</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <tr key={u.id} className="border-b border-border/60 hover:bg-surface-2/50">
                  <td className="px-4 py-2.5"><div className="font-medium">{u.username}</div><div className="text-[11.5px] text-faint">{u.email || '—'}</div></td>
                  <td className="px-4 py-2.5"><span className={`rounded px-1.5 py-0.5 text-[11px] ${u.authProvider === 'ad' ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted'}`}>{u.authProvider === 'ad' ? 'AD' : 'lokal'}</span></td>
                  <td className="px-4 py-2.5">
                    <select value={u.role} onChange={(e) => changeRole(u, e.target.value)} className="rounded-md border border-border bg-white px-1.5 py-1 text-[12px] outline-none">
                      <option value="user">user</option><option value="manager">manager</option><option value="admin">admin</option>
                    </select>
                  </td>
                  <td className="px-4 py-2.5 text-[12px] text-faint">{u.lastLogin ? u.lastLogin.slice(0, 16).replace('T', ' ') : '—'}</td>
                  <td className="px-4 py-2.5"><button onClick={() => toggleActive(u)} className={`rounded-full px-2 py-0.5 text-[11px] ${u.isActive ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}`}>{u.isActive ? 'aktiv' : 'inaktiv'}</button></td>
                  <td className="px-4 py-2.5"><div className="flex gap-2 text-[12px]">
                    <button onClick={() => setPermUser(u)} className="text-muted hover:text-accent">Rechte</button>
                    <button onClick={() => resetPw(u)} className="text-muted hover:text-accent">Passwort</button>
                    <button onClick={() => del(u)} className="text-muted hover:text-danger">Löschen</button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {permUser && <PermissionModal user={permUser} onClose={() => setPermUser(null)} />}
      {creating && <CreateUserModal onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} />}
    </>
  );
}

function CreateUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [f, setF] = useState({ username: '', password: '', email: '', role: 'user', department: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setErr('');
    try { await adminApi.createUser(f); onCreated(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Fehler'); } finally { setBusy(false); }
  }
  return (
    <ModalShell title="Benutzer anlegen" onClose={onClose}>
      <div className="space-y-2.5">
        <input placeholder="Benutzername *" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} className="w-full rounded-lg border border-border-strong bg-white px-3 py-2 text-[14px] outline-none focus:border-accent" />
        <input placeholder="Passwort * (min. 6)" type="text" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} className="w-full rounded-lg border border-border-strong bg-white px-3 py-2 text-[14px] outline-none focus:border-accent" />
        <input placeholder="E-Mail" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} className="w-full rounded-lg border border-border-strong bg-white px-3 py-2 text-[14px] outline-none focus:border-accent" />
        <div className="flex gap-2">
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} className="flex-1 rounded-lg border border-border-strong bg-white px-3 py-2 text-[14px] outline-none"><option value="user">user</option><option value="manager">manager</option><option value="admin">admin</option></select>
          <input placeholder="Abteilung" value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} className="flex-1 rounded-lg border border-border-strong bg-white px-3 py-2 text-[14px] outline-none focus:border-accent" />
        </div>
      </div>
      {err && <div className="mt-2 text-[12.5px] text-danger">{err}</div>}
      <button onClick={save} disabled={busy} className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-60">{busy && <Spinner size={14} />} Anlegen</button>
    </ModalShell>
  );
}

// --- Berechtigungen (Katalog-Übersicht + Bulk) -------------------------------
function Permissions() {
  const [catalog, setCatalog] = useState<PermissionMeta[]>([]);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => { adminApi.permissionCatalog().then((r) => setCatalog(r.permissions)).catch(() => {}); }, []);

  async function bulk(key: string, granted: boolean | null) {
    setBusy(key + granted); setMsg('');
    try { const r = await adminApi.bulkPermission(key, granted, 'all'); setMsg(`„${key}" für ${r.affected} Nutzer ${granted === null ? 'zurückgesetzt' : granted ? 'aktiviert' : 'gesperrt'}.`); }
    catch { setMsg('Fehler.'); } finally { setBusy(''); }
  }

  const categories = [...new Set(catalog.map((p) => p.category))];
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-muted">Übersicht aller Berechtigungen. Pro Person werden sie unter <strong className="text-fg">Benutzer → Rechte</strong> gesetzt; hier kannst du eine Berechtigung für <strong className="text-fg">alle</strong> auf einmal freischalten oder sperren. Fahre über das <span className="font-semibold">?</span> für eine Erklärung.</p>
      {msg && <div className="rounded-lg bg-accent-soft px-4 py-2 text-[12.5px] text-accent">{msg}</div>}
      {categories.map((cat) => (
        <Card key={cat} className="p-0">
          <div className="border-b border-border px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-faint">{cat}</div>
          <div className="divide-y divide-border/60">
            {catalog.filter((p) => p.category === cat).map((p) => (
              <div key={p.key} className="flex items-center justify-between px-4 py-2.5">
                <div className="flex items-center">
                  <span className="text-[13.5px]">{p.label}</span>
                  <Help text={p.help} />
                  <span className="ml-2 font-mono text-[10.5px] text-faint">{p.key}</span>
                </div>
                <div className="flex items-center gap-1.5 text-[11.5px]">
                  <button disabled={!!busy} onClick={() => bulk(p.key, true)} className="rounded-md border border-border px-2 py-1 text-muted transition hover:border-success hover:text-success disabled:opacity-50">alle an</button>
                  <button disabled={!!busy} onClick={() => bulk(p.key, false)} className="rounded-md border border-border px-2 py-1 text-muted transition hover:border-danger hover:text-danger disabled:opacity-50">alle aus</button>
                  <button disabled={!!busy} onClick={() => bulk(p.key, null)} title="Override für alle entfernen (zurück zur Rollen-Vorgabe)" className="rounded-md border border-border px-2 py-1 text-muted transition hover:border-accent hover:text-accent disabled:opacity-50">↺</button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

// --- AD-Import ---------------------------------------------------------------
function AdImport() {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  async function doImport() {
    if (!query.trim()) return;
    setBusy(true); setResult('');
    try { const r = await adminApi.adImport(query.trim()); setResult(`Importiert: ${JSON.stringify(r.user)}`); }
    catch (e) { setResult('✗ ' + (e instanceof Error ? e.message : 'Fehler')); } finally { setBusy(false); }
  }
  return (
    <Card className="p-5">
      <h3 className="mb-1 text-[15px] font-semibold">Benutzer aus Active Directory importieren</h3>
      <p className="mb-4 text-[13px] text-muted">Normalerweise nicht nötig — AD-Nutzer werden beim ersten Login automatisch angelegt. Hier kannst du jemanden vorab importieren.</p>
      <div className="flex gap-2">
        <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doImport()} placeholder="z. B. m.mustermann" className="flex-1 rounded-lg border border-border-strong bg-white px-3 py-2.5 text-[14px] outline-none focus:border-accent" />
        <button onClick={doImport} disabled={busy} className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-[14px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-60">{busy && <Spinner size={14} />} Importieren</button>
      </div>
      {result && <div className="mt-3 break-all text-[13px]">{result}</div>}
    </Card>
  );
}

// --- Unternehmen -------------------------------------------------------------
// Name, Betreiber, Farbe und Sprache der Installation. Lagen bisher nur in
// Umgebungsvariablen: jede Aenderung hiess Datei bearbeiten und Dienst neu
// starten. Hier setzt ein Administrator sie selbst, und sie wirken sofort.
function Unternehmen() {
  const t = useT();
  const [form, setForm] = useState(() => {
    const b = branding();
    return { appName: b.appName, appShort: b.appShort, organisation: b.organisation, farbe: b.farbe, sprache: b.sprache };
  });
  const [busy, setBusy] = useState(false);
  const [meldung, setMeldung] = useState<{ art: 'ok' | 'fehler'; text: string } | null>(null);

  function feld(k: keyof typeof form, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
    setMeldung(null);
  }

  async function speichern() {
    setBusy(true); setMeldung(null);
    try {
      await adminApi.unternehmenSetzen(form);
      // Neu laden statt lokal zu setzen: so bekommen ALLE Abonnenten den Stand,
      // den der Server tatsaechlich gespeichert hat - Titel, Farbe, Sprache.
      await ladeBranding();
      setMeldung({ art: 'ok', text: t('zustand.gespeichert') });
    } catch (e) {
      setMeldung({ art: 'fehler', text: e instanceof Error ? e.message : t('zustand.fehler') });
    } finally {
      setBusy(false);
    }
  }

  const eingabe = 'w-full rounded-lg border border-border-strong bg-white px-3 py-2.5 text-[14px] outline-none focus:border-accent';

  return (
    <Card className="p-5">
      <h3 className="mb-1 text-[15px] font-semibold">{t('org.titel')}</h3>
      <p className="mb-5 text-[13px] text-muted">{t('org.hinweis')}</p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium">{t('org.appName')}</span>
          <input value={form.appName} onChange={(e) => feld('appName', e.target.value)} className={eingabe} />
          <Help text={t('org.appNameHilfe')} />
        </label>

        <label className="block">
          <span className="mb-1 block text-[13px] font-medium">{t('org.appShort')}</span>
          <input value={form.appShort} onChange={(e) => feld('appShort', e.target.value)} className={eingabe} />
          <Help text={t('org.appShortHilfe')} />
        </label>

        <label className="block">
          <span className="mb-1 block text-[13px] font-medium">{t('org.organisation')}</span>
          <input value={form.organisation} onChange={(e) => feld('organisation', e.target.value)} className={eingabe} />
          <Help text={t('org.organisationHilfe')} />
        </label>

        <label className="block">
          <span className="mb-1 block text-[13px] font-medium">{t('org.farbe')}</span>
          <div className="flex items-center gap-2">
            {/* Farbwaehler und Textfeld zeigen denselben Wert - wer den Hexwert
                aus dem Gestaltungshandbuch hat, tippt ihn; wer ihn sucht, klickt. */}
            <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(form.farbe) ? form.farbe : '#2563eb'}
              onChange={(e) => feld('farbe', e.target.value)}
              className="h-[42px] w-12 cursor-pointer rounded-lg border border-border-strong bg-white p-1" />
            <input value={form.farbe} onChange={(e) => feld('farbe', e.target.value)} className={eingabe} spellCheck={false} />
          </div>
          <Help text={t('org.farbeHilfe')} />
        </label>

        <label className="block sm:col-span-2">
          <span className="mb-1 block text-[13px] font-medium">{t('org.sprache')}</span>
          <select value={form.sprache} onChange={(e) => feld('sprache', e.target.value)} className={eingabe}>
            {SPRACHEN.map((sp) => <option key={sp} value={sp}>{SPRACHNAMEN[sp]}</option>)}
          </select>
          <Help text={t('org.spracheHilfe')} />
        </label>
      </div>

      <div className="mt-5 flex items-center gap-3">
        <button onClick={speichern} disabled={busy}
          className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-[14px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-60">
          {busy && <Spinner size={14} />} {t('aktion.speichern')}
        </button>
        {meldung && (
          <span className={`text-[13px] ${meldung.art === 'ok' ? 'text-muted' : 'text-red-600'}`}>{meldung.text}</span>
        )}
      </div>
    </Card>
  );
}

// --- Analytics ---------------------------------------------------------------
const MONATSNAMEN = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/**
 * Betriebsbericht zum Ausdrucken. Bewusst als Dokument und nicht als weitere
 * Bildschirmansicht — er wird in Besprechungen ausgeteilt und abgeheftet.
 */
function Berichtskarte() {
  const [monate, setMonate] = useState<{ monat: string; anfragen: number }[]>([]);
  const [gewaehlt, setGewaehlt] = useState<string>(''); // leer = letzte 30 Tage
  const [laeuft, setLaeuft] = useState<'pdf' | 'docx' | null>(null);
  const [fehler, setFehler] = useState('');

  useEffect(() => { adminApi.reportMonths().then((r) => setMonate(r.months)).catch(() => {}); }, []);

  async function hole(format: 'pdf' | 'docx') {
    setLaeuft(format);
    setFehler('');
    try { await adminApi.downloadReport(gewaehlt || null, format); }
    catch (e) { setFehler(e instanceof Error ? e.message : 'Bericht fehlgeschlagen'); }
    finally { setLaeuft(null); }
  }

  const label = (m: string) => {
    const [j, mm] = m.split('-');
    return `${MONATSNAMEN[Number(mm) - 1]} ${j}`;
  };

  return (
    <Card className="p-5">
      <SectionTitle>Betriebsbericht</SectionTitle>
      <p className="mb-3 text-[12.5px] leading-relaxed text-muted">
        Zusammenfassung von Nutzung, Antwortzeiten, Rückmeldungen und Wissensbestand als gestaltetes
        Dokument — zum Ausdrucken und Weitergeben. Alle Zahlen stammen direkt aus dem System.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={gewaehlt}
          onChange={(e) => setGewaehlt(e.target.value)}
          className="rounded-lg border border-border bg-surface px-2.5 py-1 text-[12.5px] text-muted outline-none transition focus:border-accent"
        >
          <option value="">Letzte 30 Tage</option>
          {monate.map((m) => (
            <option key={m.monat} value={m.monat}>{label(m.monat)} ({m.anfragen} Anfragen)</option>
          ))}
        </select>
        <button
          onClick={() => hole('pdf')}
          disabled={laeuft !== null}
          className="rounded-lg border border-accent px-2.5 py-1 text-[12.5px] font-medium text-accent transition hover:bg-accent hover:text-white disabled:opacity-50"
        >
          {laeuft === 'pdf' ? 'Wird erstellt…' : 'Als PDF herunterladen'}
        </button>
        <button
          onClick={() => hole('docx')}
          disabled={laeuft !== null}
          className="rounded-lg border border-border px-2.5 py-1 text-[12.5px] font-medium text-muted transition hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {laeuft === 'docx' ? 'Wird erstellt…' : 'Als Word'}
        </button>
      </div>
      {fehler && <div className="mt-2 text-[12.5px] text-danger">{fehler}</div>}
    </Card>
  );
}

function Analytics() {
  const [a, setA] = useState<AnalyticsData | null>(null);
  const [days, setDays] = useState(30);
  const [exporting, setExporting] = useState(false);
  useEffect(() => { adminApi.analytics(days).then(setA).catch(() => {}); }, [days]);

  async function exportActiveUsers() {
    setExporting(true);
    try { await adminApi.downloadActiveUsersExcel(); }
    catch { /* ignore */ }
    finally { setExporting(false); }
  }

  if (!a) return <Spinner />;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 text-[12.5px]">
        <button
          onClick={exportActiveUsers}
          disabled={exporting}
          className="rounded-lg border border-border px-2.5 py-1 font-medium text-muted transition hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {exporting ? 'Wird erstellt…' : 'Meist aktive Nutzer als Excel'}
        </button>
        <div className="flex items-center gap-2">
          {[14, 30, 90].map((d) => <button key={d} onClick={() => setDays(d)} className={`rounded-lg border px-2.5 py-1 transition ${days === d ? 'border-accent text-accent' : 'border-border text-muted hover:border-border-strong'}`}>{d} Tage</button>)}
        </div>
      </div>
      <Berichtskarte />
      <Card className="p-5"><div className="mb-3 text-[13.5px] font-medium">Nachrichten pro Tag</div><BarChart data={a.messagesPerDay} days={days} /></Card>
      <Card className="p-5"><div className="mb-3 text-[13.5px] font-medium">Aktive Nutzer pro Tag</div><BarChart data={a.activeUsersPerDay} days={days} color="#16a34a" /></Card>
      <Card className="p-5">
        <div className="mb-3 text-[13.5px] font-medium">Aktivste Nutzer</div>
        <div className="space-y-1.5">
          {a.topUsers.map((u, i) => (
            <div key={u.name} className="flex items-center gap-3 text-[13px]">
              <span className="w-5 text-faint">{i + 1}.</span>
              <span className="w-40 truncate">{u.name}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-accent" style={{ width: `${(u.c / (a.topUsers[0]?.c || 1)) * 100}%` }} /></div>
              <span className="w-14 text-right tabular-nums text-muted">{u.c}</span>
            </div>
          ))}
          {a.topUsers.length === 0 && <div className="text-[12.5px] text-faint">Noch keine Daten.</div>}
        </div>
      </Card>
    </div>
  );
}

// --- Module ------------------------------------------------------------------
// Welche Funktionen diese Installation nutzt, entscheidet der Betreiber. Ein
// abgeschaltetes Modul verschwindet aus dem Menü, aus den Routen und aus den
// Werkzeugen der KI. Standard ist überall AN — abschalten ist die Ausnahme.
function Module() {
  const [rows, setRows] = useState<ModulEintrag[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [frage, setFrage] = useState<{ m: ModulEintrag; folgen: string[] } | null>(null);
  const [hinweis, setHinweis] = useState<string | null>(null);

  const laden = () => adminApi.module().then((r) => setRows(r.module)).catch(() => setRows([]));
  useEffect(() => { void laden(); }, []);

  const schalten = async (m: ModulEintrag, aktiv: boolean) => {
    setBusy(m.id);
    try {
      const r = await adminApi.modulSetzen(m.id, aktiv);
      await laden();
      setHinweis(
        r.mitBetroffen.length
          ? `„${m.name}" ist aus. Damit greifen auch nicht mehr: ${r.mitBetroffen.join(', ')}.`
          : `„${m.name}" ist ${aktiv ? 'eingeschaltet' : 'ausgeschaltet'}.`,
      );
    } catch (e) {
      setHinweis(e instanceof Error ? e.message : 'Konnte nicht umgeschaltet werden.');
    } finally {
      setBusy(null);
      setFrage(null);
    }
  };

  // Beim Abschalten vorher zeigen, was mitgeht — Abhängigkeiten sind nicht offensichtlich.
  const anklicken = (m: ModulEintrag) => {
    if (m.aktiv) {
      const folgen = (rows ?? []).filter((x) => x.aktiv && (x.braucht ?? []).includes(m.id)).map((x) => x.name);
      setFrage({ m, folgen });
    } else void schalten(m, true);
  };

  if (!rows) return <Spinner />;
  const gruppen = [...new Set(rows.map((m) => m.gruppe))];
  const aus = rows.filter((m) => !m.aktiv).length;

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Module</h2>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            {aus === 0
              ? `Alle ${rows.length} Module sind aktiv.`
              : `${rows.length - aus} von ${rows.length} Modulen aktiv, ${aus} abgeschaltet.`}
          </p>
        </div>
      </div>

      {hinweis && (
        <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-200">
          {hinweis}
          <button onClick={() => setHinweis(null)} className="ml-3 text-xs text-neutral-400 hover:text-neutral-600">schließen</button>
        </div>
      )}

      {gruppen.map((g) => (
        <section key={g}>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">{g}</h3>
          <div className="divide-y divide-neutral-200 overflow-hidden rounded-xl border border-neutral-200 dark:divide-neutral-700 dark:border-neutral-700">
            {rows.filter((m) => m.gruppe === g).map((m) => {
              const blockiert = m.blockiertDurch.length > 0;
              return (
                <div key={m.id} className="flex items-start gap-4 bg-white px-4 py-3 dark:bg-neutral-900">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-neutral-900 dark:text-neutral-100">{m.name}</span>
                      {blockiert && (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                          wirkungslos — {m.blockiertDurch.join(', ')} ist aus
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">{m.zweck}</p>
                    {m.voraussetzung && (
                      <p className="mt-1 text-xs text-neutral-400">Voraussetzung: {m.voraussetzung}</p>
                    )}
                  </div>
                  <button
                    onClick={() => anklicken(m)}
                    disabled={busy === m.id}
                    role="switch"
                    aria-checked={m.aktiv}
                    aria-label={`${m.name} ${m.aktiv ? 'ausschalten' : 'einschalten'}`}
                    className={`relative mt-1 h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
                      m.aktiv ? 'bg-[var(--color-accent)]' : 'bg-neutral-300 dark:bg-neutral-600'
                    }`}
                  >
                    <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${m.aktiv ? 'left-[22px]' : 'left-0.5'}`} />
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {frage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setFrage(null)}>
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl dark:bg-neutral-900" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold text-neutral-900 dark:text-neutral-100">„{frage.m.name}" abschalten?</h3>
            <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
              Die Funktion verschwindet für alle Nutzer aus dem Menü und steht der KI nicht mehr zur Verfügung.
              Vorhandene Daten bleiben erhalten und sind nach dem Wiedereinschalten unverändert da.
            </p>
            {frage.folgen.length > 0 && (
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-900/30 dark:text-amber-100">
                Baut darauf auf und greift dann ebenfalls nicht mehr: {frage.folgen.join(', ')}.
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setFrage(null)} className="rounded-lg px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800">
                Abbrechen
              </button>
              <button onClick={() => void schalten(frage.m, false)} disabled={busy !== null}
                className="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900">
                Abschalten
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Konnektoren --------------------------------------------------------------
// Ein Status → eine Tonalität. Farbklassen nicht mehr von Hand streuen.
const CONN_STATUS: Record<string, { label: string; tone: Tone; dot: string; ring: string; text: string }> = {
  online:   { label: 'verbunden',        tone: 'ok',      dot: 'bg-success',  ring: 'border-success/30', text: 'text-success' },
  offline:  { label: 'nicht erreichbar', tone: 'danger',  dot: 'bg-danger',   ring: 'border-danger/30',  text: 'text-danger' },
  error:    { label: 'Störung',          tone: 'danger',  dot: 'bg-danger',   ring: 'border-danger/30',  text: 'text-danger' },
  disabled: { label: 'deaktiviert',      tone: 'neutral', dot: 'bg-faint',    ring: 'border-border',     text: 'text-muted' },
  planned:  { label: 'geplant',          tone: 'warn',    dot: 'bg-warn',     ring: 'border-warn/30',    text: 'text-warn' },
};

// Mindmap: die Anwendung im Zentrum, Konnektoren nach FUNKTION gebündelt.
// Bewusst nach Aufgabe gruppiert statt zehn Einzelknoten auf einem Kreis —
// so bleibt lesbar, wer wofür da ist und was zusammengehört.
const BRANCHES: {
  id: string; titel: string; zweck: string; glyph: IconName;
  x: number; y: number; side: 'left' | 'right';
  glieder: { id: string; rolle: string }[];
}[] = [
  {
    id: 'wissen', titel: 'Wissen finden', zweck: 'Passendes aus dem Vault holen', glyph: 'suche' as IconName,
    x: 175, y: 120, side: 'right',
    glieder: [
      { id: 'embeddings', rolle: 'Frage in Vektoren übersetzen' },
      { id: 'vector', rolle: 'ähnliche Stellen aufspüren' },
      { id: 'vault', rolle: 'Notizen & Dokumente' },
    ],
  },
  {
    id: 'zugang', titel: 'Zugang & Rechte', zweck: 'Wer darf was', glyph: 'schluessel' as IconName,
    x: 175, y: 375, side: 'right',
    glieder: [{ id: 'ad', rolle: 'Anmeldung per Windows-Konto' }],
  },
  {
    id: 'speicher', titel: 'Speicher', zweck: 'Wo alles dauerhaft liegt', glyph: 'datenbank' as IconName,
    x: 175, y: 590, side: 'right',
    glieder: [{ id: 'database', rolle: 'Chats, Projekte, Rechte, Vault' }],
  },
  {
    id: 'antwort', titel: 'Antworten erzeugen', zweck: 'Das Sprachmodell selbst', glyph: 'chat' as IconName,
    x: 1015, y: 120, side: 'left',
    glieder: [{ id: 'ollama', rolle: 'formuliert jede Antwort' }],
  },
  {
    id: 'dokumente', titel: 'Dokumente lesen', zweck: 'Gedrucktes maschinell erfassen', glyph: 'dokument' as IconName,
    x: 1015, y: 340, side: 'left',
    glieder: [{ id: 'ocr', rolle: 'Text aus Bild und Scan' }],
  },
  {
    id: 'etiketten', titel: 'Etiketten prüfen', zweck: 'Werbeaussagen gegen Richtlinien', glyph: 'etikett' as IconName,
    x: 1015, y: 560, side: 'left',
    glieder: [
      { id: 'classifier', rolle: 'Aussagen erkennen (CPU)' },
      { id: 'labels', rolle: 'Etiketten-Bestand' },
    ],
  },
  {
    id: 'bilder', titel: 'Bilder erzeugen', zweck: 'Bildmaterial lokal, ohne Cloud', glyph: 'bild' as IconName,
    x: 595, y: 700, side: 'left',
    glieder: [{ id: 'imagegen', rolle: 'erzeugt Bilder aus Text' }],
  },
];

function ConnectorHub({ connectors, onPick, picked }: { connectors: Connector[]; onPick: (id: string) => void; picked: string | null }) {
  const byId = new Map(connectors.map((c) => [c.id, c]));
  const planned = connectors.filter((c) => c.status === 'planned');
  const st = (c?: Connector) => CONN_STATUS[c?.status ?? 'disabled'] ?? CONN_STATUS.disabled!;

  const W = 1190, H = 790;
  const CX = 595, CY = 375, CR = 84;
  const CARD_W = 300;

  const anchor = (b: (typeof BRANCHES)[number]) =>
    b.id === 'bilder' ? { x: b.x, y: b.y - 46 }
    : b.side === 'right' ? { x: b.x + CARD_W / 2, y: b.y }
    : { x: b.x - CARD_W / 2, y: b.y };

  const branchState = (b: (typeof BRANCHES)[number]) => {
    const cs = b.glieder.map((g) => byId.get(g.id)).filter(Boolean) as Connector[];
    if (cs.some((c) => c.status === 'offline' || c.status === 'error')) return 'bad';
    if (cs.some((c) => c.status === 'disabled')) return 'off';
    return 'ok';
  };

  return (
    <div style={{ width: W }}>
      <div className="relative" style={{ width: W, height: H }}>
        <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full" aria-hidden="true">
          {/* Ruhiger Hintergrundring, der das Zentrum trägt */}
          <circle cx={CX} cy={CY} r={CR + 130} fill="none" stroke="currentColor" strokeWidth={1} strokeDasharray="2 8" className="text-border" />
          {BRANCHES.map((b) => {
            const a = anchor(b);
            const state = branchState(b);
            const cls = state === 'bad' ? 'text-red-400' : state === 'off' ? 'text-border' : 'text-green-500/55';
            const isBottom = b.id === 'bilder';
            const startX = isBottom ? CX : CX + (b.side === 'right' ? -CR : CR);
            const startY = isBottom ? CY + CR : CY;
            const mx = (startX + a.x) / 2;
            const d = isBottom
              ? `M ${startX} ${startY} C ${startX} ${(startY + a.y) / 2}, ${a.x} ${(startY + a.y) / 2}, ${a.x} ${a.y}`
              : `M ${startX} ${startY} C ${mx} ${startY}, ${mx} ${a.y}, ${a.x} ${a.y}`;
            return (
              <g key={b.id}>
                <path d={d} fill="none" stroke="currentColor" strokeWidth={state === 'bad' ? 3 : 2.5} className={cls} strokeLinecap="round" />
                <circle cx={a.x} cy={a.y} r={4} className={cls} fill="currentColor" />
              </g>
            );
          })}
        </svg>

        {/* Zentrum */}
        <motion.div
          initial={{ scale: 0.96, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.35 }}
          className="absolute grid -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-accent bg-surface text-center shadow-pop"
          style={{ left: CX, top: CY, width: CR * 2, height: CR * 2 }}
        >
          <div>
            <div className="text-[17px] font-semibold leading-tight">{branding().appShort}</div>
            <div className="mt-1 text-[10.5px] leading-tight text-muted">Chat · Wissens-Vault<br />Projekte · Etiketten</div>
            <div className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-success/25 bg-success/8 px-1.5 py-0.5 text-[9.5px] font-medium text-success">
              <Icon name="schloss" size={9} /> rein intern
            </div>
          </div>
        </motion.div>

        {/* Zweige */}
        {BRANCHES.map((b, i) => {
          const state = branchState(b);
          const border = state === 'bad' ? 'border-red-500/45' : state === 'off' ? 'border-border' : 'border-green-500/30';
          return (
            <motion.div
              key={b.id}
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.25, delay: 0.04 * i }}
              className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-card border-2 bg-surface p-3.5 shadow-soft ${border}`}
              style={{ left: b.x, top: b.y, width: CARD_W }}
            >
              <div className="mb-0.5 flex items-center gap-2">
                <Icon name={b.glyph} size={15} className="text-muted" />
                <span className="text-[13.5px] font-semibold">{b.titel}</span>
              </div>
              <div className="mb-2 pl-[23px] text-[11px] leading-tight text-faint">{b.zweck}</div>
              <div className="space-y-1">
                {b.glieder.map((g) => {
                  const c = byId.get(g.id);
                  if (!c) return null;
                  return (
                    <button
                      key={g.id}
                      onClick={() => onPick(picked === g.id ? '' : g.id)}
                      title={`${c.name} — ${st(c).label}`}
                      className={`flex w-full items-start gap-2 rounded-lg border px-2 py-1.5 text-left transition hover:border-accent ${
                        picked === g.id ? 'border-accent bg-accent-soft' : 'border-transparent hover:bg-surface-2'
                      }`}
                    >
                      <StatusDot tone={st(c).tone} className="mt-1.5" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] font-medium leading-tight">{c.name}</span>
                        <span className="block text-[10.5px] leading-tight text-muted">{g.rolle}</span>
                        <span className="mt-0.5 block truncate font-mono text-[9.5px] leading-tight text-faint">{c.detail}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </motion.div>
          );
        })}
      </div>

      {planned.length > 0 && (
        <div className="mt-1 border-t border-dashed border-border pt-3">
          <div className="mb-2 text-center text-[11px] font-semibold uppercase tracking-wide text-faint">Geplant — noch nicht angedockt</div>
          <div className="flex flex-wrap justify-center gap-2">
            {planned.map((p) => (
              <button
                key={p.id}
                onClick={() => onPick(picked === p.id ? '' : p.id)}
                title={p.description}
                className={`rounded-full border border-dashed border-warn/40 px-2.5 py-1 text-[11.5px] text-warn transition hover:border-warn ${picked === p.id ? 'ring-2 ring-warn/40' : ''}`}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const USE_CASES: { titel: string; nutzen: string; kette: { id: string; rolle: string }[] }[] = [
  {
    titel: 'Frage mit Firmenwissen beantworten',
    nutzen: 'Der häufigste Fall — Antwort gestützt auf eigene Unterlagen, mit Quellenangabe.',
    kette: [
      { id: 'ad', rolle: 'Anmeldung' },
      { id: 'embeddings', rolle: 'Frage verstehen' },
      { id: 'vault', rolle: 'Wissen finden' },
      { id: 'ollama', rolle: 'Antwort formulieren' },
      { id: 'database', rolle: 'Speichern' },
    ],
  },
  {
    titel: 'Dokument oder Scan auswerten',
    nutzen: 'Angehängte PDFs, Tabellen und Fotos werden lesbar und durchsuchbar gemacht.',
    kette: [
      { id: 'ocr', rolle: 'Text aus Bild lesen' },
      { id: 'embeddings', rolle: 'Inhalt erschließen' },
      { id: 'vector', rolle: 'Stellen finden' },
      { id: 'ollama', rolle: 'Antwort formulieren' },
    ],
  },
  {
    titel: 'Etiketten auf Werbeaussagen prüfen',
    nutzen: 'Findet Aussagen wie „lösemittelfrei" auf allen Etiketten — auch fremdsprachig.',
    kette: [
      { id: 'ocr', rolle: 'Etikett auslesen' },
      { id: 'classifier', rolle: 'Aussagen erkennen' },
      { id: 'labels', rolle: 'Ergebnis ablegen' },
    ],
  },
  {
    titel: 'Bild erzeugen',
    nutzen: 'Bildmaterial entsteht lokal auf dem Server.',
    kette: [
      { id: 'imagegen', rolle: 'Bild erzeugen' },
      { id: 'database', rolle: 'Galerie' },
    ],
  },
];

function Connectors() {
  const [rows, setRows] = useState<Connector[] | null>(null);
  const [summary, setSummary] = useState<ConnectorSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);
  const [showTech, setShowTech] = useState(false);

  const load = () => {
    setLoading(true);
    adminApi.connectors()
      .then((r) => { setRows(r.connectors); setSummary(r.summary); })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  if (loading && !rows) return <Spinner />;
  const list = rows ?? [];
  const byId = new Map(list.map((c) => [c.id, c]));
  const sel = picked ? byId.get(picked) ?? null : null;
  const problems = list.filter((c) => c.status === 'offline' || c.status === 'error');
  const planned = list.filter((c) => c.status === 'planned');
  const st = (c?: Connector) => CONN_STATUS[c?.status ?? 'disabled'] ?? CONN_STATUS.disabled!;

  return (
    <div className="space-y-5">
      {/* Zustand */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5 text-[12.5px]">
          {summary && [
            { label: 'verbunden', value: summary.online, cls: 'text-success' },
            { label: 'gestört', value: summary.problem, cls: 'text-danger' },
            { label: 'deaktiviert', value: summary.disabled, cls: 'text-muted' },
            { label: 'geplant', value: summary.planned, cls: 'text-warn' },
          ].map((s) => (
            <span key={s.label} className="rounded-lg border border-border bg-surface px-2.5 py-1">
              <strong className={`tabular-nums ${s.cls}`}>{s.value}</strong> <span className="text-muted">{s.label}</span>
            </span>
          ))}
          <Badge tone="ok" icon="schloss" className="px-2 py-1 text-[12px]" title="Alle Anbindungen liegen auf diesem Server oder im Firmennetz — keine externen Dienste.">
            rein intern
          </Badge>
        </div>
        <button onClick={load} disabled={loading} className="rounded-lg border border-border px-2.5 py-1 text-[12.5px] text-muted transition hover:border-accent hover:text-accent disabled:opacity-50">
          {loading ? 'Prüfe …' : 'Neu prüfen'}
        </button>
      </div>

      {problems.length > 0 && (
        <div className="space-y-1.5">
          {problems.map((p) => (
            <div key={p.id} className="rounded-card border border-danger/30 bg-danger/5 px-4 py-2">
              <span className="text-[13px] font-medium text-danger">{p.name}</span>
              <span className="text-[12.5px] text-muted"> — {p.detail}</span>
              {p.impact && <div className="text-[12px] text-muted">{p.impact}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Landkarte: die Anwendung im Zentrum, Konnektoren nach Funktion gruppiert */}
      <Card className="overflow-x-auto p-5">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-[13.5px] font-medium">Systemlandschaft</span>
          <span className="text-[11px] text-faint">Eintrag anklicken für Details</span>
        </div>
        <ConnectorHub connectors={list} onPick={(id) => setPicked(id || null)} picked={picked} />
      </Card>

      {/* Anwendungsfälle als Ergänzung — zeigt die Reihenfolge im Ablauf */}
      <div>
        <button onClick={() => setShowTech((v) => !v)} className="mb-2 flex items-center gap-1.5 text-[12.5px] text-muted transition hover:text-accent">
          <Icon name={showTech ? 'chevronUnten' : 'chevronRechts'} size={13} />
          Ablauf je Anwendungsfall {showTech ? 'ausblenden' : 'anzeigen'}
        </button>
        {showTech && (
      <div className="space-y-2.5">
        {USE_CASES.map((uc) => {
          const kette = uc.kette.filter((k) => byId.has(k.id));
          const gestoert = kette.some((k) => ['offline', 'error'].includes(byId.get(k.id)!.status));
          const aus = kette.some((k) => byId.get(k.id)!.status === 'disabled');
          return (
            <Card key={uc.titel} className="p-4">
              <div className="mb-2.5 flex flex-wrap items-baseline gap-x-2">
                <span className="text-[14px] font-medium">{uc.titel}</span>
                <span className="text-[12px] text-muted">{uc.nutzen}</span>
                <Badge tone={gestoert ? 'danger' : aus ? 'neutral' : 'ok'} dot className="ml-auto shrink-0">
                  {gestoert ? 'gestört' : aus ? 'teilweise aus' : 'einsatzbereit'}
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {kette.map((k, i) => {
                  const c = byId.get(k.id)!;
                  return (
                    <span key={k.id} className="flex items-center gap-1">
                      {i > 0 && <Icon name="pfeilRechts" size={12} className="mx-0.5 text-faint" />}
                      <button
                        onClick={() => setPicked(picked === k.id ? null : k.id)}
                        title={`${c.name} — ${st(c).label}`}
                        className={`flex items-center gap-1.5 rounded-lg border bg-surface px-2 py-1 text-left transition hover:border-accent ${st(c).ring} ${picked === k.id ? 'ring-2 ring-accent' : ''}`}
                      >
                        <StatusDot tone={st(c).tone} />
                        <span>
                          <span className="block text-[11.5px] font-medium leading-tight">{k.rolle}</span>
                          <span className="block text-[10px] leading-tight text-faint">{c.name}</span>
                        </span>
                      </button>
                    </span>
                  );
                })}
              </div>
            </Card>
          );
        })}
      </div>
        )}
      </div>

      {/* Detail zur Auswahl */}
      {sel && (
        <Card className="p-4">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <StatusDot tone={st(sel).tone} />
            <span className="text-[14.5px] font-medium">{sel.name}</span>
            <span className={`text-[12px] ${st(sel).text}`}>{st(sel).label}</span>
            {sel.latencyMs != null && <span className="text-[11.5px] tabular-nums text-faint">{sel.latencyMs} ms</span>}
            <CloseButton onClick={() => setPicked(null)} className="ml-auto" />
          </div>
          <p className="mb-2 text-[12.5px] text-muted">{sel.description}</p>
          {sel.impact && (
            <p className="mb-2 rounded-md border border-warn/25 bg-warn/5 px-2.5 py-1.5 text-[12px]">
              <span className="font-medium text-warn">Bei Ausfall:</span> <span className="text-muted">{sel.impact}</span>
            </p>
          )}
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px]">
            <span><span className="text-faint">Status:</span> {sel.detail}</span>
            {sel.endpoint && <span className="font-mono text-[11.5px]"><span className="font-sans text-faint">Endpunkt:</span> {sel.endpoint}</span>}
          </div>
          {sel.dependsOn?.length ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[12px]">
              <span className="text-faint">Braucht:</span>
              {sel.dependsOn.map((d) => (
                <button key={d} onClick={() => setPicked(d)} className="rounded-full border border-border px-2 py-0.5 text-[11.5px] text-muted transition hover:border-accent hover:text-accent">
                  {byId.get(d)?.name ?? d}
                </button>
              ))}
            </div>
          ) : null}
        </Card>
      )}


      {/* Geplant */}
      {planned.length > 0 && (
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-muted">Geplant — noch nicht angebunden</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {planned.map((p) => (
              <div key={p.id} className="rounded-card border border-dashed border-warn/30 bg-surface px-3.5 py-2.5">
                <div className="text-[12.5px] font-medium">{p.name}</div>
                <p className="text-[11.5px] leading-snug text-muted">{p.description}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Feedback ----------------------------------------------------------------
const FEEDBACK_LABELS: Record<string, { label: string; tone: Tone }> = {
  bug: { label: 'Fehler', tone: 'danger' },
  idea: { label: 'Idee', tone: 'info' },
  other: { label: 'Sonstiges', tone: 'neutral' },
};

const FB_STATUS: Record<string, { label: string; tone: Tone; cls: string; dot: string }> = {
  open:        { label: 'Offen',          tone: 'warn',    cls: 'text-warn',    dot: 'bg-warn' },
  in_progress: { label: 'In Bearbeitung', tone: 'info',    cls: 'text-accent',  dot: 'bg-accent' },
  resolved:    { label: 'Erledigt',       tone: 'ok',      cls: 'text-success', dot: 'bg-success' },
  declined:    { label: 'Abgelehnt',      tone: 'neutral', cls: 'text-muted',   dot: 'bg-faint' },
};

function Feedback() {
  const [rows, setRows] = useState<FeedbackEntry[]>([]);
  const [stats, setStats] = useState<FeedbackStats | null>(null);
  const [status, setStatus] = useState<FeedbackStatus | ''>('');
  const [category, setCategory] = useState('');
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    setLoading(true);
    adminApi.feedback({ status: status || undefined, category: category || undefined })
      .then((r) => { setRows(r.feedback); setStats(r.stats); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [status, category]);

  async function setState(f: FeedbackEntry, next: FeedbackStatus) {
    setBusy(true);
    await adminApi.updateFeedback(f.id, { status: next }).catch(() => {});
    setBusy(false);
    load();
  }
  async function saveResponse(f: FeedbackEntry) {
    setBusy(true);
    await adminApi.updateFeedback(f.id, { response: draft, status: f.status === 'open' ? 'in_progress' : f.status }).catch(() => {});
    setBusy(false);
    setOpenId(null);
    setDraft('');
    load();
  }
  async function remove(id: number) {
    if (!confirm('Dieses Feedback wirklich löschen?')) return;
    await adminApi.deleteFeedback(id).catch(() => {});
    load();
  }

  return (
    <div className="space-y-3">
      {/* Kennzahlen */}
      {stats && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(['open', 'in_progress', 'resolved', 'declined'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setStatus(status === k ? '' : k)}
              className={`rounded-card border bg-surface p-3 text-left transition hover:border-accent ${status === k ? 'border-accent' : 'border-border'}`}
            >
              <div className={`text-[20px] font-semibold tabular-nums ${FB_STATUS[k]!.cls}`}>{stats.byStatus[k] ?? 0}</div>
              <div className="text-[12px] text-muted">{FB_STATUS[k]!.label}</div>
            </button>
          ))}
        </div>
      )}

      <Card className="p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-lg border border-border-strong bg-white px-2.5 py-1.5 text-[12.5px] outline-none">
            <option value="">Alle Kategorien</option>
            {Object.entries(FEEDBACK_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v.label} ({stats?.byCategory[k] ?? 0})</option>
            ))}
          </select>
          {(status || category) && (
            <button onClick={() => { setStatus(''); setCategory(''); }} className="text-[12px] text-muted hover:text-danger">Filter zurücksetzen</button>
          )}
          <span className="ml-auto text-[12px] text-muted">{rows.length} von {stats?.total ?? 0}</span>
        </div>

        {loading && rows.length === 0 ? (
          <div className="p-6"><Spinner /></div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-[13px] text-faint">Keine Rückmeldungen für diese Auswahl.</div>
        ) : (
          <div className="divide-y divide-border/60">
            {rows.map((f) => {
              const cat = FEEDBACK_LABELS[f.category] ?? FEEDBACK_LABELS.other!;
              const stt = FB_STATUS[f.status] ?? FB_STATUS.open!;
              const editing = openId === f.id;
              return (
                <div key={f.id} className={`p-4 ${f.status === 'resolved' || f.status === 'declined' ? 'opacity-70' : ''}`}>
                  <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[12px]">
                    <StatusDot tone={stt.tone} />
                    <span className={`font-medium ${stt.cls}`}>{stt.label}</span>
                    <Badge tone={cat.tone}>{cat.label}</Badge>
                    <span className="font-medium text-fg">{f.username || 'Unbekannt'}</span>
                    <span className="text-faint">{f.createdAt}</span>
                    {f.context && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-faint" title="Wo die Rückmeldung abgegeben wurde">{f.context}</span>}
                  </div>

                  <div className="whitespace-pre-wrap break-words text-[13.5px] text-fg/90">{f.message}</div>

                  {f.response && !editing && (
                    <div className="mt-2 rounded-lg border-l-2 border-accent bg-accent-soft/40 px-3 py-2 text-[12.5px]">
                      <div className="mb-0.5 text-[11px] font-medium text-accent">Antwort an {f.username}{f.handledBy ? ` · ${f.handledBy}` : ''}</div>
                      <div className="whitespace-pre-wrap text-muted">{f.response}</div>
                    </div>
                  )}

                  {editing ? (
                    <div className="mt-2">
                      <textarea
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        rows={3}
                        placeholder="Antwort an den Melder — wird ihm unter „Meine Rückmeldungen“ angezeigt."
                        className="w-full resize-y rounded-lg border border-border-strong bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent"
                      />
                      <div className="mt-1.5 flex justify-end gap-2">
                        <button onClick={() => { setOpenId(null); setDraft(''); }} className="rounded-lg px-3 py-1.5 text-[12.5px] text-muted hover:bg-surface-2">Abbrechen</button>
                        <button onClick={() => saveResponse(f)} disabled={busy} className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-50">
                          Antwort speichern
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {(['open', 'in_progress', 'resolved', 'declined'] as const)
                        .filter((k) => k !== f.status)
                        .map((k) => (
                          <button
                            key={k}
                            onClick={() => setState(f, k)}
                            disabled={busy}
                            className="rounded-lg border border-border px-2.5 py-1 text-[11.5px] text-muted transition hover:border-accent hover:text-accent disabled:opacity-50"
                          >
                            → {FB_STATUS[k]!.label}
                          </button>
                        ))}
                      <button
                        onClick={() => { setOpenId(f.id); setDraft(f.response ?? ''); }}
                        className="rounded-lg border border-border px-2.5 py-1 text-[11.5px] text-muted transition hover:border-accent hover:text-accent"
                      >
                        {f.response ? 'Antwort bearbeiten' : 'Antworten'}
                      </button>
                      <button onClick={() => remove(f.id)} className="ml-auto text-[11.5px] text-muted transition hover:text-danger">Löschen</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

// --- Audit-Log ---------------------------------------------------------------
const RES_LABEL: Record<string, string> = {
  user: 'Benutzer', chat: 'Chat', project: 'Projekt', note: 'Vault-Notiz', document: 'Vault-Dokument',
  file: 'Datei', memory: 'Memory', label: 'Etikett', image: 'Bild', feedback: 'Feedback', system: 'System',
};

/** Details eines Eintrags lesbar darstellen — inkl. Vorher/Nachher-Vergleich. */
function AuditDetails({ details }: { details: unknown }) {
  if (!details || typeof details !== 'object') return null;
  const d = details as Record<string, unknown>;
  const changes = Array.isArray(d.changes) ? (d.changes as { field: string; before: unknown; after: unknown }[]) : [];
  const rest = Object.entries(d).filter(([k]) => k !== 'changes' && k !== '__label');
  const fmt = (v: unknown) => (v === undefined || v === null || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

  return (
    <div className="mt-1.5 space-y-1.5">
      {changes.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border">
          {changes.map((ch, i) => (
            <div key={i} className="grid grid-cols-[130px_1fr] gap-2 border-b border-border/60 px-2.5 py-1.5 text-[11.5px] last:border-0">
              <span className="font-medium text-muted">{ch.field}</span>
              <span className="min-w-0">
                <span className="mr-1 rounded bg-red-500/10 px-1 text-red-700 line-through decoration-red-400/60">{fmt(ch.before)}</span>
                <span className="text-faint">→</span>
                <span className="ml-1 rounded bg-green-500/10 px-1 text-green-700">{fmt(ch.after)}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      {rest.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-faint">
          {rest.map(([k, v]) => <span key={k}><span className="text-muted">{k}:</span> {fmt(v)}</span>)}
        </div>
      )}
    </div>
  );
}

function Audit() {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [actions, setActions] = useState<string[]>([]);
  const [resTypes, setResTypes] = useState<string[]>([]);
  const [f, setF] = useState<{ action: string; resourceType: string; user: string; from: string; to: string; q: string }>({
    action: '', resourceType: '', user: '', from: '', to: '', q: '',
  });
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<number | null>(null);
  const LIMIT = 100;

  const load = () => {
    setLoading(true);
    adminApi.audit({ ...f, limit: LIMIT, offset: page * LIMIT })
      .then((r) => { setRows(r.audit); setTotal(r.total); setActions(r.actions); setResTypes(r.resourceTypes); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [f, page]);
  useEffect(() => { setPage(0); }, [f]);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const inputCls = 'rounded-lg border border-border-strong bg-white px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent';
  const active = Object.values(f).some(Boolean);

  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <select value={f.action} onChange={set('action')} className={inputCls}>
          <option value="">Alle Aktionen</option>
          {actions.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select value={f.resourceType} onChange={set('resourceType')} className={inputCls}>
          <option value="">Alle Objektarten</option>
          {resTypes.map((t) => <option key={t} value={t}>{RES_LABEL[t] ?? t}</option>)}
        </select>
        <input value={f.user} onChange={set('user')} placeholder="Benutzer" className={`${inputCls} w-32`} />
        <input type="date" value={f.from} onChange={set('from')} title="von" className={inputCls} />
        <input type="date" value={f.to} onChange={set('to')} title="bis" className={inputCls} />
        <input value={f.q} onChange={set('q')} placeholder="Objekt / Details durchsuchen" className={`${inputCls} w-52`} />
        {active && (
          <button onClick={() => setF({ action: '', resourceType: '', user: '', from: '', to: '', q: '' })} className="rounded-lg px-2 py-1.5 text-[12px] text-muted hover:text-danger">
            Filter zurücksetzen
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[12px] text-muted">{total} Einträge</span>
          <button
            onClick={() => adminApi.auditExportCsv(f).catch(() => {})}
            className="rounded-lg border border-border px-2.5 py-1.5 text-[12px] text-muted transition hover:border-accent hover:text-accent"
          >
            CSV-Export
          </button>
        </div>
      </div>

      {loading && rows.length === 0 ? (
        <div className="p-6"><Spinner /></div>
      ) : rows.length === 0 ? (
        <div className="p-8 text-center text-[13px] text-faint">Keine Einträge für diese Filter.</div>
      ) : (
        <div className="divide-y divide-border/60">
          {rows.map((r) => {
            const label = (r.details as { __label?: string } | null)?.__label;
            const isOpen = open === r.id;
            return (
              <div key={r.id} className={`px-4 py-2.5 transition ${isOpen ? 'bg-accent-soft/30' : ''}`}>
                <button onClick={() => setOpen(isOpen ? null : r.id)} className="flex w-full items-start gap-3 text-left">
                  <span className="w-[125px] shrink-0 whitespace-nowrap text-[11.5px] tabular-nums text-faint">{r.createdAt}</span>
                  <span className="w-[110px] shrink-0 truncate text-[12.5px] font-medium">{r.username || '—'}</span>
                  <span className="min-w-0 flex-1">
                    <span className="text-[12.5px] font-medium text-accent">{r.action}</span>
                    {r.resourceType && <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">{RES_LABEL[r.resourceType] ?? r.resourceType}</span>}
                    {label && <span className="ml-2 truncate text-[12px] text-muted">„{label}"</span>}
                  </span>
                  <span className="shrink-0 text-[11px] text-faint">{r.ipAddress || ''}</span>
                </button>
                {isOpen && (
                  <div className="pl-[138px]">
                    <AuditDetails details={r.details} />
                    {r.resourceId && (
                      <button
                        onClick={() => setF({ ...f, q: '', action: '', user: '', resourceType: r.resourceType ?? '' })}
                        className="mt-1 text-[11.5px] text-faint hover:text-accent"
                        title="Nach dieser Objektart filtern"
                      >
                        Objekt-ID: {r.resourceId}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {total > LIMIT && (
        <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-[12.5px]">
          <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="rounded-lg border border-border px-2.5 py-1 text-muted transition hover:border-accent disabled:opacity-40">
            ← Neuer
          </button>
          <span className="text-muted">Seite {page + 1} von {Math.ceil(total / LIMIT)}</span>
          <button onClick={() => setPage((p) => p + 1)} disabled={(page + 1) * LIMIT >= total} className="rounded-lg border border-border px-2.5 py-1 text-muted transition hover:border-accent disabled:opacity-40">
            Älter →
          </button>
        </div>
      )}
    </Card>
  );
}

// Antwortzeiten über die Zeit — macht Verschlechterungen sichtbar, bevor sich
// jemand beschwert. Kennzahlen, keine Inhalte.
function Performance() {
  const [p, setP] = useState<PerfSummary | null>(null);
  useEffect(() => { adminApi.performance(14).then(setP).catch(() => {}); }, []);
  if (!p) return null;
  const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-baseline justify-between">
        <span className="text-[13.5px] font-medium">Antwortzeiten (14 Tage)</span>
        <span className="text-[11px] text-faint">{p.gesamt.anfragen} Anfragen gemessen</span>
      </div>
      {p.gesamt.anfragen === 0 ? (
        <p className="text-[12.5px] text-faint">Noch keine Messwerte — die Erfassung läuft ab jetzt mit.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: 'Bis 1. Wort (Median)', value: fmt(p.gesamt.ttfbMedian) },
              { label: 'Bis 1. Wort (90 %)', value: fmt(p.gesamt.ttfbP90) },
              { label: 'Gesamt (Median)', value: fmt(p.gesamt.totalMedian) },
              { label: 'Fehlerquote', value: `${p.gesamt.fehlerquote} %` },
            ].map((k) => (
              <div key={k.label} className="rounded-lg border border-border p-3">
                <div className="text-[17px] font-semibold tabular-nums">{k.value}</div>
                <div className="text-[11.5px] text-muted">{k.label}</div>
              </div>
            ))}
          </div>
          {p.tage.length > 0 && (
            <div className="mt-4">
              <div className="mb-1 text-[11.5px] text-faint">Zeit bis zum ersten Wort, je Tag</div>
              <BarChart data={p.tage.map((t) => ({ d: t.d, c: t.ttfbMedian }))} days={14} color="#7c3aed" />
            </div>
          )}
          {p.langsamste.length > 0 && (
            <div className="mt-4">
              <div className="mb-1 text-[11.5px] text-faint">Langsamste Anfragen — meist sehr große Kontexte</div>
              <div className="space-y-0.5">
                {p.langsamste.map((l, i) => (
                  <div key={i} className="flex gap-3 text-[11.5px] text-muted">
                    <span className="w-[125px] shrink-0 tabular-nums text-faint">{l.created_at}</span>
                    <span className="w-20 shrink-0 tabular-nums">{fmt(l.total_ms)}</span>
                    <span className="tabular-nums text-faint">{Math.round(l.prompt_chars / 1000)}k Zeichen Kontext</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// --- System ------------------------------------------------------------------
function System() {
  const [s, setS] = useState<SystemInfo | null>(null);
  const [mMsg, setMMsg] = useState('');
  const reload = () => adminApi.system().then((r) => { setS(r); setMMsg(r.maintenance.message); }).catch(() => {});
  useEffect(() => { reload(); }, []);
  if (!s) return <Spinner />;

  async function setMaint(on: boolean) { await adminApi.setMaintenance(on, mMsg).catch(() => {}); reload(); }

  const info = [
    ['Sprachmodell', s.model],
    ['Embedding-Modell', s.embedModel],
    ['Active Directory', s.adConfigured ? (s.adOk ? 'verbunden' : 'Störung — ' + s.adMessage) : 'nicht konfiguriert'],
    ['AD-Pflichtgruppe', s.requiredGroup],
    ['Laufzeit', fmtUptime(s.uptimeSec)],
    ['Node-Version', s.nodeVersion],
    ['Prozess (UID)', s.uid === 0 ? '0 — läuft als root (nicht empfohlen)' : `${s.uid} — unprivilegiert`],
    ['Berechtigungen', String(s.permissionsCount)],
    ['Datenbankgröße', fmtBytes(s.dbSizeBytes)],
    ['HTTPS-Port', String(s.httpsPort)],
    ['Netzwerk-Interface', s.bindInterface],
  ];

  return (
    <div className="space-y-4">
      <Performance />
      <Card className="p-0">
        <div className="border-b border-border px-5 py-3 text-[14px] font-semibold">System-Status</div>
        <div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2">
          {info.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between bg-surface px-5 py-2.5 text-[13px]">
              <span className="text-muted">{k}</span>
              <span className="font-medium">{v}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-5">
        <h3 className="mb-1 text-[15px] font-semibold">Wartungsmodus</h3>
        <p className="mb-3 text-[13px] text-muted">Im Wartungsmodus können nur Admins die KI nutzen; alle anderen sehen die Hinweismeldung.</p>
        <textarea value={mMsg} onChange={(e) => setMMsg(e.target.value)} rows={2} className="mb-3 w-full rounded-lg border border-border-strong bg-white px-3 py-2 text-[14px] outline-none focus:border-accent" placeholder="Hinweismeldung" />
        <div className="flex items-center gap-3">
          <button onClick={() => setMaint(!s.maintenance.on)} className={`rounded-lg px-4 py-2.5 text-[14px] font-medium text-white transition ${s.maintenance.on ? 'bg-danger hover:opacity-90' : 'bg-accent hover:bg-accent-hover'}`}>{s.maintenance.on ? 'Wartung beenden' : 'Wartung aktivieren'}</button>
          <span className={`text-[13px] ${s.maintenance.on ? 'text-danger' : 'text-success'}`}>{s.maintenance.on ? 'Wartung AKTIV' : 'Betrieb normal'}</span>
        </div>
      </Card>
    </div>
  );
}

// --- Modale ------------------------------------------------------------------
function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" onClick={onClose}>
      <motion.div initial={{ opacity: 0, y: 12, scale: 0.99 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.2 }} onClick={(e) => e.stopPropagation()} className="max-h-[82vh] w-[min(94vw,520px)] overflow-y-auto rounded-card border border-border bg-surface p-6 shadow-pop">
        <div className="mb-3 flex items-center justify-between"><h3 className="text-[16px] font-semibold">{title}</h3><CloseButton onClick={onClose} /></div>
        {children}
      </motion.div>
    </div>
  );
}

function PermissionModal({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const [catalog, setCatalog] = useState<PermissionMeta[]>([]);
  const [effective, setEffective] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const isAdmin = user.role === 'admin';

  useEffect(() => {
    Promise.all([adminApi.permissionCatalog(), adminApi.userPermissions(user.id)])
      .then(([cat, perms]) => { setCatalog(cat.permissions); setEffective(perms.effective); setOverrides(perms.overrides); })
      .catch(() => {}).finally(() => setLoading(false));
  }, [user.id]);

  async function toggle(key: string, next: boolean) { const r = await adminApi.setUserPermission(user.id, key, next).catch(() => null); if (r) { setEffective(r.effective); setOverrides(r.overrides); } }
  async function reset(key: string) { const r = await adminApi.setUserPermission(user.id, key, null).catch(() => null); if (r) { setEffective(r.effective); setOverrides(r.overrides); } }
  const categories = [...new Set(catalog.map((p) => p.category))];

  return (
    <ModalShell title={`Berechtigungen · ${user.username}`} onClose={onClose}>
      <p className="mb-4 text-[12.5px] text-muted">Rolle: {user.role}. Grün = aktiv. „Override" ist individuell gesetzt, sonst aus Rolle geerbt.</p>
      {isAdmin ? (
        <div className="rounded-lg bg-accent-soft px-4 py-3 text-[13px] text-accent">Admins haben automatisch alle Berechtigungen.</div>
      ) : loading ? <Spinner /> : (
        <div className="space-y-4">
          {categories.map((cat) => (
            <div key={cat}>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">{cat}</div>
              <div className="space-y-1">
                {catalog.filter((p) => p.category === cat).map((p) => {
                  const active = effective.includes(p.key);
                  const hasOverride = p.key in overrides;
                  return (
                    <div key={p.key} className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-surface-2">
                      <div className="flex items-center gap-2.5">
                        <button onClick={() => toggle(p.key, !active)} className={`relative h-5 w-9 shrink-0 rounded-full transition ${active ? 'bg-accent' : 'bg-border-strong'}`}>
                          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${active ? 'left-[18px]' : 'left-0.5'}`} />
                        </button>
                        <div className="flex items-center">
                          <span className="text-[13px]">{p.label}</span>
                          <Help text={p.help} />
                        </div>
                      </div>
                      <div className="flex items-center gap-2 text-[11px]">
                        <span className={hasOverride ? 'text-warn' : 'text-faint'}>{hasOverride ? 'Override' : 'geerbt'}</span>
                        {hasOverride && <button onClick={() => reset(p.key)} className="text-muted hover:text-accent" title="Auf geerbt zurücksetzen">↺</button>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </ModalShell>
  );
}
