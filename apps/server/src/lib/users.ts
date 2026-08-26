import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { users, type User } from '../db/schema.ts';
import type { AdUser } from '../auth/ad.ts';

export function getUserByUsername(username: string): User | undefined {
  return db
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = lower(${username})`)
    .get();
}

export function getUserByEmail(email: string): User | undefined {
  if (!email) return undefined;
  return db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .get();
}

export function getUserById(id: number): User | undefined {
  return db.select().from(users).where(eq(users.id, id)).get();
}

export function countUsers(): number {
  const row = db.select({ c: sql<number>`count(*)` }).from(users).get();
  return row?.c ?? 0;
}

/** Nach erfolgreichem lokalem Login: failed-attempts zurücksetzen, last_login setzen. */
export function touchLogin(id: number): void {
  db.update(users)
    .set({ failedLoginAttempts: 0, lastLogin: sql`CURRENT_TIMESTAMP` })
    .where(eq(users.id, id))
    .run();
}

/**
 * Legt einen AD-Benutzer an oder aktualisiert ihn nach erfolgreicher AD-Auth.
 * Defensive Suche: erst per Username (sAMAccountName), dann per E-Mail — damit
 * kein Schatten-Konto entsteht, wenn der erste Login unter einem anderen
 * Identifier (E-Mail statt sAMAccountName) erfolgte. Der erste Benutzer im
 * System wird automatisch Admin.
 */
export function upsertAdUser(adUser: AdUser): User {
  let user = getUserByUsername(adUser.username);

  if (!user && adUser.email) {
    const byEmail = getUserByEmail(adUser.email);
    if (byEmail) {
      if (String(byEmail.username).toLowerCase() !== adUser.username.toLowerCase()) {
        db.update(users).set({ username: adUser.username }).where(eq(users.id, byEmail.id)).run();
      }
      user = { ...byEmail, username: adUser.username };
    }
  }

  if (!user) {
    const isFirstUser = countUsers() === 0;
    return db
      .insert(users)
      .values({
        username: adUser.username,
        email: adUser.email || null,
        passwordHash: null,
        role: isFirstUser ? 'admin' : 'user',
        department: adUser.department || null,
        authProvider: 'ad',
        adDn: adUser.distinguishedName || null,
        isActive: true,
        lastLogin: sql`CURRENT_TIMESTAMP` as unknown as string,
      })
      .returning()
      .get();
  }

  // Ein vom Admin DEAKTIVIERTES Konto bleibt deaktiviert. Bisher setzte jeder
  // AD-Login isActive wieder auf true — ein ausgeschiedener Mitarbeiter, dessen
  // AD-Konto noch existiert, hätte sich damit selbst reaktiviert. Die Sperre im
  // Panel wäre wirkungslos gewesen.
  if (!user.isActive) {
    // Unverändert zurückgeben, ohne isActive anzufassen. Die Anmeldung scheitert
    // dann an der Aktivprüfung des Aufrufers.
    return user;
  }

  // Bestehenden Benutzer aktualisieren (E-Mail/DN können sich geändert haben).
  const emailChanged = !!adUser.email && adUser.email !== user.email;
  db.update(users)
    .set({
      authProvider: 'ad',
      adDn: adUser.distinguishedName || user.adDn,
      // isActive NICHT anfassen — siehe oben.
      ...(emailChanged ? { email: adUser.email } : {}),
      failedLoginAttempts: 0,
      lastLogin: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(users.id, user.id))
    .run();

  return {
    ...user,
    authProvider: 'ad',
    adDn: adUser.distinguishedName || user.adDn,
    email: emailChanged ? adUser.email : user.email,
  };
}
