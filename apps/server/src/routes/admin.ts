import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import ExcelJS from 'exceljs';
import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, like, sql } from 'drizzle-orm';
import { db, sqliteConnection as sqlite } from '../db/client.ts';
import { users, auditLogs, chats, messages, groups, kbDocuments } from '../db/schema.ts';
import { authenticate, requirePermission } from '../middleware/auth.ts';
import { hashPassword } from '../auth/password.ts';
import { searchAdUser, testAdConnection } from '../auth/ad.ts';
import { env, isAdConfigured } from '../config/env.ts';
import { getMaintenance, setMaintenance } from '../lib/settings.ts';
import { logAudit, requestMeta } from '../lib/audit.ts';
import { PERMISSIONS, ALL_PERMISSIONS, listEffectivePermissions, getUserOverrides, setUserOverride, isPermissionKey, type PermissionKey } from '../lib/permissions.ts';
import { listFeedback, countOpenFeedback, updateFeedback, deleteFeedback, feedbackStats, FEEDBACK_STATUS, type FeedbackStatus } from '../lib/feedback.ts';
import { listConnectors } from '../lib/connectors.ts';
import { perfSummary } from '../lib/perf.ts';
import { bauMonatsbericht, monatsZeitraum, type Zeitraum } from '../lib/report.ts';
import { generateDocument } from '../lib/docgen.ts';
import type { AppEnv } from '../types.ts';
import { branding, dateiPraefix } from '../config/branding.ts';

export const adminRoutes = new Hono<AppEnv>();
// Zugang zum Admin-Bereich; einzelne Aktionen zusätzlich fein granuliert.
// Admins haben per Wildcard automatisch alle Permissions → unverändert voller Zugriff.
adminRoutes.use('*', authenticate, requirePermission('admin.access'));

// --- Übersicht / Stats -------------------------------------------------------
adminRoutes.get('/stats', requirePermission('admin.users.view'), (c) => {
  const count = (t: typeof users | typeof chats | typeof messages) =>
    db.select({ c: sql<number>`count(*)` }).from(t).get()?.c ?? 0;
  return c.json({
    users: count(users),
    chats: count(chats),
    messages: count(messages),
    activeUsers: db.select({ c: sql<number>`count(*)` }).from(users).where(eq(users.isActive, true)).get()?.c ?? 0,
  });
});

// --- Dashboard / Übersicht ---------------------------------------------------
const cnt = (sqlStr: string): number => ((sqlite.prepare(sqlStr).get() as { c: number } | undefined)?.c ?? 0);

adminRoutes.get('/overview', requirePermission('admin.users.view'), async (c) => {
  const ad = isAdConfigured ? await testAdConnection() : { ok: false };
  return c.json({
    users: cnt('SELECT count(*) c FROM users'),
    activeUsers: cnt('SELECT count(*) c FROM users WHERE is_active=1'),
    adUsers: cnt("SELECT count(*) c FROM users WHERE auth_provider='ad'"),
    chats: cnt('SELECT count(*) c FROM chats'),
    messages: cnt('SELECT count(*) c FROM messages'),
    messagesToday: cnt("SELECT count(*) c FROM messages WHERE date(created_at)=date('now')"),
    messages7d: cnt("SELECT count(*) c FROM messages WHERE created_at>=datetime('now','-7 days')"),
    newUsers7d: cnt("SELECT count(*) c FROM users WHERE created_at>=datetime('now','-7 days')"),
    activeToday: cnt("SELECT count(DISTINCT c.user_id) c FROM messages m JOIN chats c ON c.id=m.chat_id WHERE m.role='user' AND date(m.created_at)=date('now')"),
    kbDocs: cnt('SELECT count(*) c FROM kb_documents'),
    files: cnt('SELECT count(*) c FROM files'),
    model: env.OLLAMA_MODEL,
    adOk: ad.ok,
    uptimeSec: Math.round(process.uptime()),
  });
});

// --- Analytics (Zeitreihen) --------------------------------------------------
adminRoutes.get('/analytics', requirePermission('admin.users.view'), (c) => {
  const days = Math.min(Math.max(Number(c.req.query('days') ?? 14), 1), 90);
  const win = `datetime('now','-${days} days')`;
  return c.json({
    days,
    messagesPerDay: sqlite.prepare(`SELECT date(created_at) d, count(*) c FROM messages WHERE created_at>=${win} GROUP BY d ORDER BY d`).all(),
    activeUsersPerDay: sqlite.prepare(`SELECT date(m.created_at) d, count(DISTINCT c.user_id) c FROM messages m JOIN chats c ON c.id=m.chat_id WHERE m.role='user' AND m.created_at>=${win} GROUP BY d ORDER BY d`).all(),
    topUsers: sqlite.prepare(`SELECT u.username name, count(*) c FROM messages m JOIN chats c ON c.id=m.chat_id JOIN users u ON u.id=c.user_id WHERE m.role='user' GROUP BY c.user_id ORDER BY c DESC LIMIT 10`).all(),
  });
});

// --- Export: Meist aktive Nutzer als Excel -----------------------------------
adminRoutes.get('/analytics/active-users.xlsx', requirePermission('admin.users.view'), async (c) => {
  const rows = sqlite
    .prepare(
      `SELECT u.username, u.email, u.department, u.auth_provider AS authProvider,
              u.last_login AS lastLogin,
              count(DISTINCT c.id) AS chats,
              count(*) AS messages,
              max(m.created_at) AS lastActivity
         FROM messages m
         JOIN chats c ON c.id = m.chat_id
         JOIN users u ON u.id = c.user_id
        WHERE m.role = 'user'
        GROUP BY u.id
        ORDER BY messages DESC, u.username`,
    )
    .all() as Array<Record<string, unknown>>;

  const wb = new ExcelJS.Workbook();
  wb.creator = branding.appName;
  const ws = wb.addWorksheet('Meist aktive Nutzer');
  ws.columns = [
    { header: 'Rang', key: 'rank', width: 8 },
    { header: 'Benutzername', key: 'username', width: 24 },
    { header: 'E-Mail', key: 'email', width: 30 },
    { header: 'Abteilung', key: 'department', width: 20 },
    { header: 'Anmeldeart', key: 'authProvider', width: 12 },
    { header: 'Nachrichten', key: 'messages', width: 14 },
    { header: 'Chats', key: 'chats', width: 10 },
    { header: 'Letzte Aktivität', key: 'lastActivity', width: 22 },
    { header: 'Letzte Anmeldung', key: 'lastLogin', width: 22 },
  ];
  ws.getRow(1).font = { bold: true };
  rows.forEach((r, i) => ws.addRow({ rank: i + 1, ...r }));

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(buffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="meist-aktive-nutzer-${stamp}.xlsx"`,
    },
  });
});

// --- Monatsbericht (PDF/Word zum Ausdrucken) ---------------------------------
// Fasst Nutzung, Betrieb, Rückmeldungen und Wissensbestand eines Zeitraums
// zusammen. Gedacht als Beleg für Geschäftsführung und IT — deshalb als
// gestaltetes Dokument und nicht als Bildschirmansicht.
adminRoutes.get('/report', requirePermission('admin.users.view'), async (c) => {
  const monat = c.req.query('monat'); // „2026-07" — sonst die letzten 30 Tage
  const format = (c.req.query('format') ?? 'pdf').toLowerCase() === 'docx' ? 'docx' : 'pdf';

  let zeitraum: Zeitraum;
  if (monat && /^\d{4}-\d{2}$/.test(monat)) {
    zeitraum = monatsZeitraum(monat);
  } else {
    const bis = new Date();
    const von = new Date(bis.getTime() - 29 * 24 * 3600 * 1000);
    zeitraum = { von: von.toISOString().slice(0, 10), bis: bis.toISOString().slice(0, 10) };
  }

  const { titel, markdown } = bauMonatsbericht(zeitraum);
  const { buffer, mime, ext } = await generateDocument(markdown, titel, format);
  logAudit({ ...requestMeta(c), userId: c.get('user').id, username: c.get('user').username,
    action: 'REPORT_EXPORTED', resourceType: 'system', details: { von: zeitraum.von, bis: zeitraum.bis, format } });
  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': mime,
      'Content-Disposition': `attachment; filename="${dateiPraefix()}-bericht-${zeitraum.von}-bis-${zeitraum.bis}.${ext}"`,
    },
  });
});

// Welche Monate lassen sich sinnvoll auswählen? Nur solche mit Daten.
adminRoutes.get('/report/months', requirePermission('admin.users.view'), (c) => {
  const rows = sqlite
    .prepare(
      `SELECT strftime('%Y-%m', created_at) AS monat, count(*) AS anfragen
         FROM messages WHERE role='user' AND created_at IS NOT NULL
        GROUP BY monat ORDER BY monat DESC LIMIT 24`,
    )
    .all() as Array<{ monat: string; anfragen: number }>;
  return c.json({ months: rows.filter((r) => r.monat) });
});

// --- Feedback (Nutzer → Admin) -----------------------------------------------
adminRoutes.get('/feedback', requirePermission('admin.feedback.view'), (c) => {
  const status = c.req.query('status');
  const filter = FEEDBACK_STATUS.includes(status as FeedbackStatus) ? (status as FeedbackStatus) : undefined;
  const category = c.req.query('category');
  let rows = listFeedback(filter);
  if (category) rows = rows.filter((r) => r.category === category);
  return c.json({ feedback: rows, open: countOpenFeedback(), stats: feedbackStats() });
});

adminRoutes.patch('/feedback/:id', requirePermission('admin.feedback.view'), async (c) => {
  const admin = c.get('user');
  const id = Number(c.req.param('id'));
  const body = (await c.req.json().catch(() => ({}))) as { status?: string; response?: string };
  const status = FEEDBACK_STATUS.includes(body.status as FeedbackStatus) ? (body.status as FeedbackStatus) : undefined;
  if (!Number.isFinite(id) || (!status && body.response === undefined)) {
    return c.json({ error: 'status oder response erforderlich' }, 400);
  }
  if (!updateFeedback(id, { status, response: body.response }, admin.username)) {
    return c.json({ error: 'Feedback nicht gefunden' }, 404);
  }
  logAudit({ ...requestMeta(c), userId: admin.id, username: admin.username, action: 'FEEDBACK_UPDATED', resourceType: 'feedback', resourceId: id,
    details: { status, antwortGesetzt: body.response !== undefined } });
  return c.json({ ok: true });
});

adminRoutes.delete('/feedback/:id', requirePermission('admin.feedback.view'), (c) => {
  const admin = c.get('user');
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id) || !deleteFeedback(id)) return c.json({ error: 'Feedback nicht gefunden' }, 404);
  logAudit({ ...requestMeta(c), userId: admin.id, username: admin.username, action: 'FEEDBACK_DELETED', resourceType: 'feedback', resourceId: id });
  return c.json({ ok: true });
});

// --- Konnektoren (angebundene Systeme + geplante) -----------------------------
adminRoutes.get('/connectors', requirePermission('admin.users.view'), async (c) => {
  const connectors = await listConnectors();
  return c.json({
    connectors,
    summary: {
      online: connectors.filter((x) => x.status === 'online').length,
      problem: connectors.filter((x) => x.status === 'offline' || x.status === 'error').length,
      disabled: connectors.filter((x) => x.status === 'disabled').length,
      planned: connectors.filter((x) => x.status === 'planned').length,
    },
  });
});

// --- Leistungskennzahlen (Antwortzeiten über die Zeit) ------------------------
adminRoutes.get('/performance', requirePermission('admin.users.view'), (c) => {
  const tage = Math.min(Math.max(Number(c.req.query('days') ?? 14), 1), 90);
  return c.json(perfSummary(tage));
});

// --- System-Info -------------------------------------------------------------
adminRoutes.get('/system', requirePermission('admin.users.view'), async (c) => {
  let dbSizeBytes = 0;
  try { dbSizeBytes = statSync(resolve(process.cwd(), env.DATABASE_PATH)).size; } catch { /* ignore */ }
  const ad = isAdConfigured ? await testAdConnection() : { ok: false, message: 'nicht konfiguriert' };
  return c.json({
    model: env.OLLAMA_MODEL,
    embedModel: env.OLLAMA_EMBED_MODEL,
    adConfigured: isAdConfigured,
    adOk: ad.ok,
    adMessage: ad.message,
    requiredGroup: env.AD_REQUIRED_GROUP || '(deaktiviert — alle AD-Nutzer)',
    uptimeSec: Math.round(process.uptime()),
    nodeVersion: process.version,
    uid: typeof process.getuid === 'function' ? process.getuid() : -1,
    permissionsCount: ALL_PERMISSIONS.length,
    dbSizeBytes,
    httpsPort: env.HTTPS_PORT,
    bindInterface: env.BIND_INTERFACE || '(alle Interfaces)',
    maintenance: getMaintenance(),
  });
});

// --- Benutzerverwaltung ------------------------------------------------------
adminRoutes.get('/users', requirePermission('admin.users.view'), (c) => {
  const rows = db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      role: users.role,
      isActive: users.isActive,
      department: users.department,
      authProvider: users.authProvider,
      lastLogin: users.lastLogin,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt))
    .all();
  return c.json({ users: rows });
});

const createSchema = z.object({
  username: z.string().min(1),
  email: z.string().optional(),
  password: z.string().min(6),
  role: z.enum(['user', 'manager', 'admin']).default('user'),
  department: z.string().optional(),
});
adminRoutes.post('/users', requirePermission('admin.users.create'), async (c) => {
  const admin = c.get('user');
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Ungültige Eingabe (username, password ≥6 nötig)' }, 400);
  const { username, email, password, role, department } = parsed.data;
  const exists = db.select().from(users).where(sql`lower(${users.username}) = lower(${username})`).get();
  if (exists) return c.json({ error: 'Benutzername existiert bereits' }, 409);
  const hash = await hashPassword(password);
  const row = db
    .insert(users)
    .values({ username, email: email || null, passwordHash: hash, role, department: department || null, authProvider: 'local', isActive: true })
    .returning()
    .get();
  logAudit({ ...requestMeta(c), userId: admin.id, username: admin.username, action: 'ADMIN_USER_CREATED', resourceType: 'user', resourceId: row.id, details: { username, role } });
  return c.json({ user: { id: row.id, username: row.username, role: row.role } }, 201);
});

const updateSchema = z.object({
  role: z.enum(['user', 'manager', 'admin']).optional(),
  department: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
});
adminRoutes.patch('/users/:id', requirePermission('admin.users.edit'), async (c) => {
  const admin = c.get('user');
  const id = Number(c.req.param('id'));
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Ungültige Eingabe' }, 400);
  const patch: Record<string, unknown> = {};
  if (parsed.data.role !== undefined) patch.role = parsed.data.role;
  if (parsed.data.department !== undefined) patch.department = parsed.data.department;
  if (parsed.data.email !== undefined) patch.email = parsed.data.email;
  if (parsed.data.isActive !== undefined) patch.isActive = parsed.data.isActive;
  if (Object.keys(patch).length === 0) return c.json({ error: 'Keine Felder' }, 400);
  const res = db.update(users).set(patch).where(eq(users.id, id)).run();
  if (res.changes === 0) return c.json({ error: 'Benutzer nicht gefunden' }, 404);
  logAudit({ ...requestMeta(c), userId: admin.id, username: admin.username, action: 'ADMIN_USER_UPDATED', resourceType: 'user', resourceId: id, details: patch });
  return c.json({ ok: true });
});

adminRoutes.post('/users/:id/password', requirePermission('admin.users.reset_password'), async (c) => {
  const admin = c.get('user');
  const id = Number(c.req.param('id'));
  const body = (await c.req.json().catch(() => ({}))) as { password?: string };
  if (!body.password || body.password.length < 6) return c.json({ error: 'Passwort ≥6 Zeichen nötig' }, 400);
  const hash = await hashPassword(body.password);
  const res = db.update(users).set({ passwordHash: hash, authProvider: 'local' }).where(eq(users.id, id)).run();
  if (res.changes === 0) return c.json({ error: 'Benutzer nicht gefunden' }, 404);
  logAudit({ ...requestMeta(c), userId: admin.id, username: admin.username, action: 'ADMIN_PASSWORD_RESET', resourceType: 'user', resourceId: id });
  return c.json({ ok: true });
});

adminRoutes.delete('/users/:id', requirePermission('admin.users.delete'), (c) => {
  const admin = c.get('user');
  const id = Number(c.req.param('id'));
  if (id === admin.id) return c.json({ error: 'Eigenes Konto kann nicht gelöscht werden' }, 400);
  const res = db.delete(users).where(eq(users.id, id)).run();
  if (res.changes === 0) return c.json({ error: 'Benutzer nicht gefunden' }, 404);
  logAudit({ ...requestMeta(c), userId: admin.id, username: admin.username, action: 'ADMIN_USER_DELETED', resourceType: 'user', resourceId: id });
  return c.json({ ok: true });
});

// --- Berechtigungen ----------------------------------------------------------
// Katalog aller bekannten Permissions (für die Admin-UI).
adminRoutes.get('/permissions', requirePermission('admin.permissions.manage'), (c) =>
  c.json({
    permissions: ALL_PERMISSIONS.map((key) => ({ key, label: PERMISSIONS[key].label, category: PERMISSIONS[key].category, help: PERMISSIONS[key].help })),
  }),
);

// Bulk: eine Berechtigung für mehrere Benutzer (oder alle Nicht-Admins) setzen/entziehen.
const bulkSchema = z.object({
  permission: z.string(),
  granted: z.boolean().nullable(),
  userIds: z.union([z.array(z.number()), z.literal('all')]),
});
adminRoutes.post('/permissions/bulk', requirePermission('admin.permissions.manage'), async (c) => {
  const admin = c.get('user');
  const parsed = bulkSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || !isPermissionKey(parsed.data.permission)) return c.json({ error: 'Ungültige Eingabe' }, 400);
  const { permission, granted, userIds } = parsed.data;
  const ids =
    userIds === 'all'
      ? db.select({ id: users.id }).from(users).where(sql`role != 'admin'`).all().map((r) => r.id)
      : userIds;
  for (const id of ids) setUserOverride(id, permission as PermissionKey, granted);
  logAudit({ ...requestMeta(c), userId: admin.id, username: admin.username, action: 'ADMIN_PERMISSION_BULK', details: { permission, granted, count: ids.length } });
  return c.json({ ok: true, affected: ids.length });
});

// Effektive Permissions + Overrides eines Users.
adminRoutes.get('/users/:id/permissions', requirePermission('admin.permissions.manage'), (c) => {
  const id = Number(c.req.param('id'));
  const u = db.select({ role: users.role }).from(users).where(eq(users.id, id)).get();
  if (!u) return c.json({ error: 'Benutzer nicht gefunden' }, 404);
  return c.json({
    role: u.role,
    effective: listEffectivePermissions(id, u.role),
    overrides: getUserOverrides(id), // { key: true|false }
  });
});

// Override setzen/entfernen: { permission, granted: true|false|null }.
const permSchema = z.object({ permission: z.string(), granted: z.boolean().nullable() });
adminRoutes.post('/users/:id/permissions', requirePermission('admin.permissions.manage'), async (c) => {
  const admin = c.get('user');
  const id = Number(c.req.param('id'));
  const parsed = permSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || !isPermissionKey(parsed.data.permission)) {
    return c.json({ error: 'Ungültige Permission' }, 400);
  }
  const u = db.select({ role: users.role }).from(users).where(eq(users.id, id)).get();
  if (!u) return c.json({ error: 'Benutzer nicht gefunden' }, 404);
  setUserOverride(id, parsed.data.permission, parsed.data.granted);
  logAudit({ ...requestMeta(c), userId: admin.id, username: admin.username, action: 'ADMIN_PERMISSION_SET', resourceType: 'user', resourceId: id, details: { permission: parsed.data.permission, granted: parsed.data.granted } });
  return c.json({ ok: true, effective: listEffectivePermissions(id, u.role), overrides: getUserOverrides(id) });
});

// --- Gruppen (lesend) --------------------------------------------------------
adminRoutes.get('/groups', requirePermission('admin.users.view'), (c) => c.json({ groups: db.select().from(groups).all() }));

// --- Audit-Log ---------------------------------------------------------------
adminRoutes.get('/audit', requirePermission('admin.audit.view'), (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 1000);
  const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);
  const action = c.req.query('action');
  const resourceType = c.req.query('resourceType');
  const resourceId = c.req.query('resourceId');
  const user = c.req.query('user');
  const from = c.req.query('from'); // YYYY-MM-DD
  const to = c.req.query('to');
  const q = c.req.query('q'); // Freitext über Details/Objektname

  const conds = [];
  if (action) conds.push(eq(auditLogs.action, action));
  if (resourceType) conds.push(eq(auditLogs.resourceType, resourceType));
  if (resourceId) conds.push(eq(auditLogs.resourceId, resourceId));
  if (user) conds.push(like(auditLogs.username, `%${user}%`));
  if (from) conds.push(sql`${auditLogs.createdAt} >= ${from}`);
  if (to) conds.push(sql`${auditLogs.createdAt} <= ${to + ' 23:59:59'}`);
  if (q) conds.push(sql`${auditLogs.details} LIKE ${'%' + q + '%'}`);
  const where = conds.length ? and(...conds) : undefined;

  const rows = db.select().from(auditLogs).where(where).orderBy(desc(auditLogs.id)).limit(limit).offset(offset).all();
  const total = db.select({ c: sql<number>`count(*)` }).from(auditLogs).where(where).get()?.c ?? 0;
  const actions = (sqlite.prepare('SELECT DISTINCT action FROM audit_logs ORDER BY action').all() as { action: string }[]).map((r) => r.action);
  const resourceTypes = (sqlite.prepare("SELECT DISTINCT resource_type t FROM audit_logs WHERE resource_type IS NOT NULL ORDER BY t").all() as { t: string }[]).map((r) => r.t);
  return c.json({ audit: rows, total, limit, offset, actions, resourceTypes });
});

// Audit-Protokoll als CSV exportieren (eigene Berechtigung).
adminRoutes.get('/audit/export.csv', requirePermission('admin.audit.export'), (c) => {
  const action = c.req.query('action');
  const user = c.req.query('user');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const conds = [];
  if (action) conds.push(eq(auditLogs.action, action));
  if (user) conds.push(like(auditLogs.username, `%${user}%`));
  if (from) conds.push(sql`${auditLogs.createdAt} >= ${from}`);
  if (to) conds.push(sql`${auditLogs.createdAt} <= ${to + ' 23:59:59'}`);
  const rows = db.select().from(auditLogs).where(conds.length ? and(...conds) : undefined).orderBy(desc(auditLogs.id)).limit(50000).all();

  const esc = (v: unknown) => {
    const s2 = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `"${s2.replace(/"/g, '""')}"`;
  };
  const header = ['Zeitpunkt', 'Benutzer', 'Aktion', 'Objektart', 'Objekt-ID', 'Details', 'IP'];
  const csv = [
    header.join(';'),
    ...rows.map((r) => [r.createdAt, r.username, r.action, r.resourceType, r.resourceId, r.details, r.ipAddress].map(esc).join(';')),
  ].join('\r\n');

  const admin = c.get('user');
  logAudit({ ...requestMeta(c), userId: admin.id, username: admin.username, action: 'AUDIT_EXPORTED', resourceType: 'system', details: { zeilen: rows.length } });
  // BOM, damit Excel die Umlaute richtig liest.
  return new Response('\uFEFF' + csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
});


// --- Wartungsmodus -----------------------------------------------------------
adminRoutes.get('/maintenance', requirePermission('admin.maintenance'), (c) => c.json(getMaintenance()));
adminRoutes.post('/maintenance', requirePermission('admin.maintenance'), async (c) => {
  const admin = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as { on?: boolean; message?: string };
  setMaintenance(!!body.on, body.message);
  logAudit({ ...requestMeta(c), userId: admin.id, username: admin.username, action: 'ADMIN_MAINTENANCE', details: { on: !!body.on } });
  return c.json({ ok: true, ...getMaintenance() });
});

// --- AD-Suche / -Import ------------------------------------------------------
adminRoutes.post('/ad/search', requirePermission('admin.ad.import'), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { query?: string };
  if (!body.query) return c.json({ error: 'query erforderlich' }, 400);
  const found = await searchAdUser(body.query);
  return c.json({ found });
});

adminRoutes.post('/ad/import', requirePermission('admin.ad.import'), async (c) => {
  const admin = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as { query?: string };
  if (!body.query) return c.json({ error: 'query erforderlich' }, 400);
  const ad = await searchAdUser(body.query);
  if (!ad) return c.json({ error: 'Im AD nicht gefunden' }, 404);
  const exists = db.select().from(users).where(sql`lower(${users.username}) = lower(${ad.username})`).get();
  if (exists) return c.json({ error: 'Benutzer existiert bereits', user: { id: exists.id, username: exists.username } }, 409);
  const row = db
    .insert(users)
    .values({ username: ad.username, email: ad.email || null, passwordHash: null, role: 'user', department: ad.department || null, authProvider: 'ad', adDn: ad.distinguishedName, isActive: true })
    .returning()
    .get();
  logAudit({ ...requestMeta(c), userId: admin.id, username: admin.username, action: 'ADMIN_AD_IMPORT', resourceType: 'user', resourceId: row.id, details: { username: ad.username } });
  return c.json({ user: { id: row.id, username: row.username, email: row.email, department: row.department } }, 201);
});
