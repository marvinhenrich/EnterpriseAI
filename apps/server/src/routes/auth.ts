import { Hono } from 'hono';
import { z } from 'zod';
import { env, isAdConfigured } from '../config/env.ts';
import { authenticateWithAD, type AdAuthResult } from '../auth/ad.ts';
import { verifyPassword } from '../auth/password.ts';
import { signToken } from '../auth/jwt.ts';
import { authenticate } from '../middleware/auth.ts';
import { logAudit, requestMeta } from '../lib/audit.ts';
import { getUserById, getUserByUsername, getUserByEmail, touchLogin, upsertAdUser } from '../lib/users.ts';
import { listEffectivePermissions } from '../lib/permissions.ts';
import { log } from '../lib/logger.ts';
import type { AppEnv } from '../types.ts';

export const authRoutes = new Hono<AppEnv>();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

/** Promise mit Timeout: liefert `onTimeout`, wenn p nicht rechtzeitig auflöst. */
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(onTimeout), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(onTimeout);
      },
    );
  });
}

// =============================================================================
// POST /api/auth/login
// Reihenfolge: lokaler Login (bcrypt) zuerst, dann AD. Das Passwort wird nie
// verändert. Fehler-Mapping entspricht der Alt-Installation:
//   DNS/CONNECTION/BIND/NOT_CONFIGURED -> 503, NOT_IN_GROUP -> 403, sonst 401.
// =============================================================================
authRoutes.post('/login', async (c) => {
  const meta = requestMeta(c);
  const body = await c.req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Benutzername/E-Mail und Passwort sind erforderlich' }, 400);
  }

  let username = parsed.data.username;
  const password = parsed.data.password; // NIEMALS verändern

  // Normalisierung: "DOMAIN\user" -> "user". E-Mail/UPN bleibt unverändert.
  if (username.includes('\\')) username = username.split('\\')[1] ?? username;
  username = username.trim();
  const isEmailLogin = username.includes('@');

  // --- 1. Lokaler Login (bcrypt) -------------------------------------------
  let user = getUserByUsername(username);
  if (!user && isEmailLogin) user = getUserByEmail(username);

  if (user && user.authProvider === 'local' && user.passwordHash) {
    const match = await verifyPassword(password, user.passwordHash);
    if (match) {
      if (!user.isActive) {
        logAudit({ ...meta, userId: user.id, username, action: 'LOGIN_FAILED', resourceType: 'user', resourceId: user.id, details: { reason: 'account_disabled' } });
        return c.json({ error: 'Ihr Konto wurde deaktiviert. Bitte kontaktieren Sie einen Administrator.', errorCode: 'ACCOUNT_DISABLED' }, 403);
      }
      touchLogin(user.id);
      const token = await signToken({ id: user.id, username: user.username, email: user.email, role: user.role, provider: 'local' });
      logAudit({ ...meta, userId: user.id, username: user.username, action: 'LOGIN_SUCCESS', resourceType: 'user', resourceId: user.id, details: { provider: 'local' } });
      return c.json({
        token,
        user: { id: user.id, username: user.username, email: user.email, role: user.role, permissions: listEffectivePermissions(user.id, user.role) },
        mustChangePassword: user.mustChangePassword,
      });
    }
    log.info('[Login] Lokales Passwort falsch, versuche AD', { username });
  }

  // --- 2. AD-Login ----------------------------------------------------------
  if (!isAdConfigured) {
    if (user && user.authProvider === 'local') {
      logAudit({ ...meta, userId: user.id, username, action: 'LOGIN_FAILED', resourceType: 'user', resourceId: user.id, details: { reason: 'invalid_password_local' } });
      return c.json({ error: 'Ungültige Anmeldedaten', errorCode: 'INVALID_CREDENTIALS' }, 401);
    }
    logAudit({ ...meta, username, action: 'LOGIN_FAILED', details: { reason: 'ad_not_configured' } });
    return c.json({ error: 'Active Directory ist nicht konfiguriert. Bitte kontaktieren Sie einen Administrator.' }, 503);
  }

  // Gesamt-Budget für die AD-Interaktion (Connect + Bind + Suche + User-Bind).
  const budgetMs = Math.max(env.AD_TIMEOUT_MS + 3000, 8000);
  const result = await withTimeout<AdAuthResult>(
    authenticateWithAD(username, password),
    budgetMs,
    { ok: false, error: 'CONNECTION_ERROR', message: 'Der Anmeldeserver antwortet nicht. Bitte erneut versuchen.' },
  );

  if (!result.ok) {
    const status =
      result.error === 'DNS_ERROR' || result.error === 'CONNECTION_ERROR' || result.error === 'BIND_ERROR' || result.error === 'NOT_CONFIGURED'
        ? 503
        : result.error === 'NOT_IN_GROUP'
          ? 403
          : 401;
    logAudit({
      ...meta,
      userId: user?.id ?? null,
      username,
      action: 'LOGIN_FAILED',
      details: { reason: result.error, message: result.message },
    });
    return c.json({ error: result.message, errorCode: result.error }, status);
  }

  // --- 3. AD-Erfolg: Benutzer anlegen/aktualisieren, JWT ausstellen ---------
  const dbUser = upsertAdUser(result.user);

  // Die Sperre im Adminpanel muss auch für AD-Konten gelten. Bisher prüfte nur
  // der lokale Zweig isActive — ein deaktivierter Mitarbeiter mit gültigem
  // AD-Konto bekam hier trotzdem ein Token.
  if (!dbUser.isActive) {
    logAudit({ ...meta, userId: dbUser.id, username: dbUser.username, action: 'LOGIN_FAILED',
      resourceType: 'user', resourceId: dbUser.id, details: { reason: 'account_disabled', provider: 'ad' } });
    return c.json({ error: 'Ihr Konto wurde deaktiviert. Bitte kontaktieren Sie einen Administrator.', errorCode: 'ACCOUNT_DISABLED' }, 403);
  }

  const token = await signToken({ id: dbUser.id, username: dbUser.username, email: dbUser.email, role: dbUser.role, provider: 'ad' });
  logAudit({ ...meta, userId: dbUser.id, username: dbUser.username, action: 'LOGIN_SUCCESS', resourceType: 'user', resourceId: dbUser.id, details: { provider: 'ad' } });

  return c.json({
    token,
    user: { id: dbUser.id, username: dbUser.username, email: dbUser.email, role: dbUser.role, permissions: listEffectivePermissions(dbUser.id, dbUser.role) },
    mustChangePassword: false,
  });
});

// =============================================================================
// GET /api/auth/me — aktuelles Profil (für Frontend-Bootstrap)
// =============================================================================
authRoutes.get('/me', authenticate, (c) => {
  const claims = c.get('user');
  const user = getUserById(claims.id);
  if (!user) return c.json({ error: 'Benutzer nicht gefunden' }, 404);
  return c.json({
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    department: user.department,
    authProvider: user.authProvider,
    permissions: listEffectivePermissions(user.id, user.role),
  });
});
