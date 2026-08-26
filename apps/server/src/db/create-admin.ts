import { sql } from 'drizzle-orm';
import { hashPassword } from '../auth/password.ts';
import { db, sqliteConnection } from './client.ts';
import { users } from './schema.ts';

// Lokalen Admin anlegen/zurücksetzen — Bootstrap & Notfall-Zugang, falls AD
// nicht erreichbar ist.
//   tsx --env-file=../../.env src/db/create-admin.ts <username> <passwort> [rolle]
const [, , username, password, role = 'admin'] = process.argv;

if (!username || !password) {
  console.error('Usage: create-admin.ts <username> <passwort> [rolle]');
  process.exit(1);
}

const hash = await hashPassword(password);
const existing = db
  .select()
  .from(users)
  .where(sql`lower(${users.username}) = lower(${username})`)
  .get();

if (existing) {
  db.update(users)
    .set({ passwordHash: hash, role, authProvider: 'local', isActive: true, mustChangePassword: false })
    .where(sql`id = ${existing.id}`)
    .run();
  console.log(`✅ Admin '${username}' aktualisiert (Rolle: ${role})`);
} else {
  db.insert(users)
    .values({ username, email: null, passwordHash: hash, role, authProvider: 'local', isActive: true })
    .run();
  console.log(`✅ Admin '${username}' angelegt (Rolle: ${role})`);
}

sqliteConnection.close();
