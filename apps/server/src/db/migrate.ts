import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db, sqliteConnection } from './client.ts';
import { log } from '../lib/logger.ts';

// Wendet die in ./drizzle generierten Migrationen an. Idempotent: bereits
// angewendete Migrationen werden übersprungen.
const migrationsFolder = resolve(import.meta.dirname, '../../drizzle');

try {
  migrate(db, { migrationsFolder });
  log.info('✅ Datenbank-Migrationen angewendet', { migrationsFolder });
} catch (err) {
  log.error('❌ Migration fehlgeschlagen', { error: (err as Error).message });
  process.exitCode = 1;
} finally {
  sqliteConnection.close();
}
