import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { systemSettings } from '../db/schema.ts';

// Key-Value-Systemeinstellungen (Wartungsmodus, Hinweise etc.).

export function getSetting(key: string): string | null {
  return db.select().from(systemSettings).where(eq(systemSettings.settingKey, key)).get()?.settingValue ?? null;
}

export function setSetting(key: string, value: string): void {
  db.insert(systemSettings)
    .values({ settingKey: key, settingValue: value })
    .onConflictDoUpdate({ target: systemSettings.settingKey, set: { settingValue: value, updatedAt: sql`CURRENT_TIMESTAMP` } })
    .run();
}

export function getMaintenance(): { on: boolean; message: string } {
  return {
    on: getSetting('maintenance_mode') === '1',
    message: getSetting('maintenance_message') || 'Die KI wird gerade gewartet. Bitte versuchen Sie es in Kürze erneut.',
  };
}

export function setMaintenance(on: boolean, message?: string): void {
  setSetting('maintenance_mode', on ? '1' : '0');
  if (message !== undefined) setSetting('maintenance_message', message);
}
