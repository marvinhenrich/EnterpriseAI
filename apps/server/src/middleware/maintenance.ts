import type { Context, Next } from 'hono';
import { getMaintenance } from '../lib/settings.ts';
import type { AppEnv } from '../types.ts';

// Blockiert Nicht-Admins während des Wartungsmodus. Admins arbeiten weiter.
export async function maintenanceGate(c: Context<AppEnv>, next: Next) {
  const m = getMaintenance();
  if (m.on) {
    const user = c.get('user');
    if (!user || user.role !== 'admin') {
      return c.json({ error: m.message, errorCode: 'MAINTENANCE' }, 503);
    }
  }
  await next();
}
