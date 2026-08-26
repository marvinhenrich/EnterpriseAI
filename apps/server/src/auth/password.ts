import bcrypt from 'bcryptjs';

// bcryptjs liest die in der Alt-DB gespeicherten $2a$/$2b$-Hashes ohne Reset —
// damit migrierte lokale Konten (Admins) sofort weiter funktionieren.

const SALT_ROUNDS = 10;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
