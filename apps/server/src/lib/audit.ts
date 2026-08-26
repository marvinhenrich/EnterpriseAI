import type { Context } from 'hono';
import { db } from '../db/client.ts';
import { auditLogs } from '../db/schema.ts';
import { log } from './logger.ts';

// =============================================================================
// Audit: WER hat WANN WAS WO geändert.
//
// Zwei Ebenen:
//   logAudit()  — freies Ereignis (Anmeldung, Löschung, Aktion)
//   logChange() — Änderung MIT Vorher/Nachher-Vergleich (nur geänderte Felder)
//
// Grundsatz: Audit-Fehler dürfen den eigentlichen Request nie kippen.
// Sensible Werte (Passwörter, Token) werden nie im Klartext protokolliert.
// =============================================================================

/** Einheitliche Objektarten — damit die Filterung im Admin-Panel verlässlich ist. */
export const RESOURCE = {
  user: 'Benutzer',
  chat: 'Chat',
  message: 'Nachricht',
  project: 'Projekt',
  note: 'Vault-Notiz',
  document: 'Vault-Dokument',
  file: 'Datei',
  memory: 'Memory',
  label: 'Etikett',
  labelTerm: 'Etiketten-Begriff',
  image: 'Bild',
  feedback: 'Feedback',
  permission: 'Berechtigung',
  system: 'System',
} as const;
export type ResourceKind = keyof typeof RESOURCE;

interface AuditInput {
  userId?: number | null;
  username?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | number | null;
  /** Menschlich lesbare Kurzbezeichnung des Objekts (z. B. Chat-Titel). */
  resourceLabel?: string | null;
  details?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

/** Feldnamen, deren Werte nie protokolliert werden. */
const SECRET_FIELDS = /^(password|passwordHash|password_hash|token|secret|apiKey|api_key|bindPassword)$/i;

/** Lange Texte kürzen — das Audit-Log soll nicht die halbe DB spiegeln. */
function shorten(v: unknown, max = 300): unknown {
  if (typeof v !== 'string') return v;
  return v.length > max ? `${v.slice(0, max)}… (${v.length} Zeichen)` : v;
}

/** Schreibt einen Audit-Eintrag. Fehler hier dürfen den Request nie kippen. */
export function logAudit(input: AuditInput): void {
  try {
    const details = input.details ? { ...input.details } : null;
    if (details) {
      for (const k of Object.keys(details)) {
        if (SECRET_FIELDS.test(k)) details[k] = '••• (nicht protokolliert)';
        else details[k] = shorten(details[k]);
      }
      if (input.resourceLabel) details.__label = input.resourceLabel;
    }
    db.insert(auditLogs)
      .values({
        userId: input.userId ?? null,
        username: input.username ?? null,
        action: input.action,
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId != null ? String(input.resourceId) : null,
        details: details ?? (input.resourceLabel ? { __label: input.resourceLabel } : null),
        ipAddress: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      })
      .run();
  } catch (err) {
    log.error('Audit-Log fehlgeschlagen', { action: input.action, error: (err as Error).message });
  }
}

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

/** Vergleicht zwei Zustände und liefert nur die tatsächlich geänderten Felder. */
export function diffFields(
  before: Record<string, unknown> | undefined | null,
  after: Record<string, unknown> | undefined | null,
  fields?: string[],
): FieldChange[] {
  const keys = fields ?? [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  const out: FieldChange[] = [];
  for (const k of keys) {
    if (SECRET_FIELDS.test(k)) continue;
    const b = before?.[k];
    const a = after?.[k];
    // Vergleich über JSON, damit auch Objekte/Arrays sauber verglichen werden.
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    out.push({ field: k, before: shorten(b), after: shorten(a) });
  }
  return out;
}

/**
 * Protokolliert eine Änderung mit Vorher/Nachher. Schreibt nur, wenn sich
 * tatsächlich etwas geändert hat (verhindert Rauschen im Protokoll).
 */
export function logChange(input: {
  c?: Context;
  userId?: number | null;
  username?: string | null;
  action: string;
  resourceType: ResourceKind | string;
  resourceId?: string | number | null;
  resourceLabel?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  fields?: string[];
  extra?: Record<string, unknown>;
}): void {
  const changes = diffFields(input.before, input.after, input.fields);
  if (changes.length === 0 && !input.extra) return;
  logAudit({
    ...(input.c ? requestMeta(input.c) : {}),
    userId: input.userId,
    username: input.username,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    resourceLabel: input.resourceLabel,
    details: { changes, ...(input.extra ?? {}) },
  });
}

/** Extrahiert IP + User-Agent aus dem Hono-Context für den Audit-Eintrag. */
export function requestMeta(c: Context): { ip: string | null; userAgent: string | null } {
  const ip =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    null;
  return { ip, userAgent: c.req.header('user-agent') ?? null };
}

/** Kurzform für Routen: Nutzer + Request-Metadaten in einem Rutsch. */
export function auditFrom(c: Context, action: string, rest: Omit<AuditInput, 'action' | 'userId' | 'username' | 'ip' | 'userAgent'> = {}): void {
  const user = c.get('user' as never) as { id: number; username: string } | undefined;
  logAudit({ ...requestMeta(c), userId: user?.id ?? null, username: user?.username ?? null, action, ...rest });
}
