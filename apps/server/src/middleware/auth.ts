import type { Context, Next } from 'hono';
import { verifyToken } from '../auth/jwt.ts';
import { hasPermission, type PermissionKey } from '../lib/permissions.ts';
import { sqliteConnection as sqlite } from '../db/client.ts';
import type { AppEnv } from '../types.ts';

/** Verlangt einen gültigen Bearer-JWT. Legt die Claims unter c.get('user') ab. */
export async function authenticate(c: Context<AppEnv>, next: Next) {
  const header = c.req.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return c.json({ error: 'Nicht authentifiziert' }, 401);

  const claims = await verifyToken(token);
  if (!claims) return c.json({ error: 'Token ungültig oder abgelaufen' }, 401);

  // Der Token allein genügt NICHT. Er läuft bis zu sieben Tage, in denen ein
  // Konto deaktiviert, gelöscht oder herabgestuft worden sein kann — der
  // Inhaber behielt bisher trotzdem seine alten Rechte. Deshalb bei JEDER
  // Anfrage gegen den aktuellen Stand prüfen. Ein Blick in eine indizierte
  // Tabelle mit 54 Zeilen, das kostet nichts.
  const konto = sqlite
    .prepare('SELECT id, role, is_active AS aktiv FROM users WHERE id = ?')
    .get(claims.id) as { id: number; role: string; aktiv: number } | undefined;
  if (!konto) return c.json({ error: 'Konto existiert nicht mehr' }, 401);
  if (!konto.aktiv) return c.json({ error: 'Konto ist deaktiviert' }, 403);

  // Rolle aus der Datenbank hat Vorrang vor der im Token eingefrorenen.
  c.set('user', { ...claims, role: konto.role });
  await next();
}

/** Verlangt zusätzlich eine bestimmte Rolle (z. B. 'admin'). */
export function requireRole(...roles: string[]) {
  return async (c: Context<AppEnv>, next: Next) => {
    const user = c.get('user');
    if (!user || !roles.includes(user.role)) {
      return c.json({ error: 'Keine Berechtigung' }, 403);
    }
    await next();
  };
}

/** Verlangt mindestens EINE der angegebenen Permissions (Admins immer ok). */
export function requirePermission(...keys: PermissionKey[]) {
  return async (c: Context<AppEnv>, next: Next) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Nicht authentifiziert' }, 401);
    if (!keys.some((k) => hasPermission(user.id, user.role, k))) {
      return c.json({ error: 'Keine Berechtigung' }, 403);
    }
    await next();
  };
}
