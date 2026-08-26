import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { hashPassword } from '../auth/password.ts';
import { db, sqliteConnection } from './client.ts';
import { users } from './schema.ts';

// =============================================================================
// Erster Administrator.
//
// Läuft bei JEDEM Start und tut nur dann etwas, wenn noch KEIN Benutzer
// existiert. Ohne diesen Schritt steht ein frisch installiertes System vor
// einer Anmeldemaske, in die niemand hineinkommt — die Anbindung ans Active
// Directory ist optional, ein lokales Konto also die einzige Tür.
//
// Das Kennwort wird zufällig erzeugt und EINMALIG ins Protokoll geschrieben.
// Bewusst nicht in eine Datei: Protokolle liest man beim ersten Start ohnehin,
// eine Datei würde vergessen und bliebe liegen.
//
// Wer es vorgeben will, setzt ADMIN_USERNAME und ADMIN_PASSWORD.
// =============================================================================

const vorhanden = db.select({ n: sql<number>`count(*)` }).from(users).get()?.n ?? 0;

if (vorhanden > 0) {
  process.exit(0);
}

const username = (process.env.ADMIN_USERNAME || 'admin').trim();
// base64url: keine Zeichen, die beim Abtippen oder in einer Zwischenablage
// Ärger machen.
const password = process.env.ADMIN_PASSWORD || randomBytes(12).toString('base64url');

db.insert(users)
  .values({
    username,
    email: null,
    passwordHash: await hashPassword(password),
    role: 'admin',
    authProvider: 'local',
    isActive: true,
  })
  .run();

const zeile = '─'.repeat(58);
console.log(`\n┌${zeile}┐`);
console.log('│  ERSTER ADMINISTRATOR ANGELEGT');
console.log(`│  Benutzer: ${username}`);
console.log(`│  Kennwort: ${password}`);
console.log('│  Nach der ersten Anmeldung ändern.');
console.log(`└${zeile}┘\n`);

sqliteConnection.close();
