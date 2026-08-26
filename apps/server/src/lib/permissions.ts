import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { groups, userGroups, userPermissions } from '../db/schema.ts';

// =============================================================================
// Berechtigungssystem (enterprise, erweiterbar).
//
// Effektive Permissions eines Users =
//     Rollen-Baseline  ∪  Gruppen-Permissions  ∪/∖  Per-User-Overrides
//
// - Admins haben implizit ALLE Permissions (Wildcard).
// - Neue Permissions: einfach in PERMISSIONS + ggf. ROLE_BASELINE ergänzen.
// - Durchsetzung server-seitig via hasPermission()/requirePermission().
// =============================================================================

// Zentraler Katalog: Schlüssel → { Label, Kategorie }. Single Source of Truth.
export const PERMISSIONS = {
  // Chat
  'chat.use': { label: 'Chat nutzen', category: 'Chat', help: 'Grundrecht: mit der KI chatten. Ohne dieses Recht ist der Chat gesperrt.' },
  'chat.select_model': { label: 'Modell auswählen', category: 'Chat', help: 'Blendet oben rechts im Chat die Modell-Auswahl ein. Sonst läuft immer das Standardmodell.' },
  'chat.think_mode': { label: 'Reasoning-/Think-Modus', category: 'Chat', help: 'Erlaubt den „Think"-Schalter: gründlichere, aber langsamere Antworten bei komplexen Aufgaben.' },
  'chat.share': { label: 'Chats teilen', category: 'Chat', help: 'Eigene Chats mit Kolleg:innen teilen (lesen/fortführen). Empfänger sehen sie unter „Geteilt mit mir".' },
  'chat.use_tools': { label: 'Werkzeuge nutzen', category: 'Chat', help: 'Schalter „Werkzeuge": die KI darf rechnen, das Datum abrufen und das Wissens-Vault durchsuchen. Rein intern.' },
  // Dateien
  'files.upload': { label: 'Dateien hochladen', category: 'Dateien', help: 'Dokumente/Bilder in den Chat hochladen (PDF, Word, Excel, Text, Bilder).' },
  'files.large': { label: 'Große Dateien', category: 'Dateien', help: 'Höheres Upload-Limit (statt Standard ein größeres Maximum pro Datei).' },
  'rag.use': { label: 'Dokumentensuche (RAG)', category: 'Dateien', help: 'Die KI durchsucht angehängte Dokumente semantisch nach den relevanten Stellen.' },
  // Dokumentenverarbeitung
  'docs.export': { label: 'Dokumente exportieren', category: 'Dokumente', help: 'KI-Antworten als Word, Excel, PowerPoint, PDF, HTML, CSV, Text oder Markdown herunterladen.' },
  'docs.actions': { label: 'Schnell-Aktionen', category: 'Dokumente', help: 'Bei angehängten Dateien: Ein-Klick „Zusammenfassen/Übersetzen/Kernpunkte/Tabelle extrahieren" auf das ganze Dokument.' },
  'docs.ocr': { label: 'OCR (Scans/Bilder)', category: 'Dokumente', help: 'Texterkennung: Hochgeladene Scans/Fotos werden ausgelesen und durchsuchbar. Läuft komplett offline.' },
  'docs.sheet': { label: 'Excel-Auswertung', category: 'Dokumente', help: 'Große Excel-/CSV-Listen filtern, summieren, gruppieren — auch wenn sie zu groß für den Kontext sind.' },
  // Entwicklung
  'code.assist': { label: 'Coding-Assistent', category: 'Entwicklung', help: 'Programmier-Modus „wie Claude Code": optimierte, vollständige Code-Antworten, Kopieren/Herunterladen je Code-Block, Projekt-ZIP und ein Code-Canvas-Seitenpanel. Es wird KEIN Code ausgeführt.' },
  // Bilder
  'image.generate': { label: 'Bildgenerierung', category: 'Bilder', help: 'Bilder aus Text erzeugen (lokal auf dem Server, rein intern — keine externen Dienste, Modell Z-Image Turbo). Verbraucht GPU-Zeit.' },
  // Etiketten-Datenbank (geteilt, Richtlinien-Compliance)
  'labels.read': { label: 'Etiketten-DB: ansehen', category: 'Etiketten', help: 'Die gemeinsame Etiketten-Datenbank, die Richtlinien-Begriffe, den Live-Scan-Status und die Ergebnisse ansehen sowie als Excel exportieren. Nur lesen.' },
  'labels.write': { label: 'Etiketten-DB: bearbeiten & scannen', category: 'Etiketten', help: 'Etiketten (PDF/Bild) hochladen, Richtlinien-Begriffe pflegen und den gemeinsamen Scan starten/abbrechen. Der Scan wendet alle Begriffe auf alle Etiketten an — sichtbar für alle.' },
  'labels.delete': { label: 'Etiketten-DB: löschen', category: 'Etiketten', help: 'Etiketten und Begriffe aus der gemeinsamen Datenbank entfernen. Mit Bedacht vergeben.' },
  // Wissens-Vault
  'kb.query': { label: 'Wissens-Vault nutzen', category: 'Wissens-Vault', help: 'Das firmenweite Wissens-Vault (Notizen + Dokumente) wird bei passenden Fragen automatisch herangezogen und ist durchsuchbar.' },
  'kb.manage': { label: 'Wissens-Vault pflegen', category: 'Wissens-Vault', help: 'Kurator: Notizen schreiben und Dokumente im firmenweiten Wissens-Vault hinzufügen/ändern/entfernen.' },
  'kb.read.restricted': { label: 'Vertrauliches im Vault lesen', category: 'Wissens-Vault', help: 'Zugriff auf Inhalte der Stufe „Vertraulich". Ohne dieses Recht sind sie unsichtbar — auch für die KI-Suche und in Antworten. Gezielt vergeben.' },
  'data.declassify': { label: 'Einstufung herabsetzen', category: 'Datenklassifizierung', help: 'Erlaubt, eine Datei oder ein Projekt auf eine NIEDRIGERE Schutzstufe zu setzen (z. B. „Streng vertraulich" → „Intern"). Heraufstufen darf jeder Eigentümer ohne dieses Recht. Nur an Personen vergeben, die eine Freigabe verantworten dürfen.' },
  'kb.read.it': { label: 'IT-Interna im Vault lesen', category: 'Wissens-Vault', help: 'Zugriff auf Inhalte der Stufe „IT-intern" (Netze, Server, Zugänge, Zertifikate). Ohne dieses Recht unsichtbar. Nur an die IT vergeben.' },
  // Memory
  'memory.manage': { label: 'Eigenes Memory', category: 'Memory', help: 'Die KI merkt sich Persönliches über den Nutzer; verwaltbar/abschaltbar.' },
  'memory.global.contribute': { label: 'Unternehmenswissen beisteuern', category: 'Memory', help: 'Nicht-sensible, unternehmensweite Fakten aus Gesprächen fließen ins gemeinsame Wissen (mit Sicherheitsfilter).' },
  // Administration
  'admin.access': { label: 'Admin-Bereich öffnen', category: 'Administration', help: 'Voraussetzung für alle Admin-Funktionen. Ohne dieses Recht ist /admin gesperrt.' },
  'admin.users.view': { label: 'Benutzer ansehen', category: 'Administration', help: 'Benutzerliste und Statistiken einsehen (nur lesen).' },
  'admin.users.create': { label: 'Benutzer anlegen', category: 'Administration', help: 'Neue lokale Benutzerkonten erstellen.' },
  'admin.users.edit': { label: 'Benutzer bearbeiten', category: 'Administration', help: 'Rolle, Abteilung, E-Mail, Aktiv-Status ändern.' },
  'admin.users.delete': { label: 'Benutzer löschen', category: 'Administration', help: 'Benutzerkonten entfernen.' },
  'admin.users.reset_password': { label: 'Passwörter zurücksetzen', category: 'Administration', help: 'Für lokale Konten ein neues Passwort setzen.' },
  'admin.permissions.manage': { label: 'Berechtigungen vergeben', category: 'Administration', help: 'Rechte pro Benutzer freischalten/entziehen (dieses Panel).' },
  'admin.ad.import': { label: 'AD-Import', category: 'Administration', help: 'Benutzer aus dem Active Directory suchen und importieren.' },
  'admin.maintenance': { label: 'Wartungsmodus', category: 'Administration', help: 'Wartungsmodus an/aus: Nicht-Admins sehen dann nur einen Hinweis.' },
  'admin.audit.view': { label: 'Audit-Log einsehen', category: 'Administration', help: 'Protokoll aller sicherheitsrelevanten Aktionen ansehen.' },
  'admin.audit.export': { label: 'Audit-Log exportieren', category: 'Administration', help: 'Das Audit-Protokoll als Datei herunterladen.' },
  'admin.system.settings': { label: 'Systemeinstellungen', category: 'Administration', help: 'Systemweite Einstellungen verwalten.' },
  'admin.feedback.view': { label: 'Feedback ansehen', category: 'Administration', help: 'Von Nutzern abgegebenes Feedback im Admin-Panel einsehen und verwalten.' },
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PermissionKey[];

export function isPermissionKey(k: string): k is PermissionKey {
  return k in PERMISSIONS;
}

// Rollen-Baseline: was eine Rolle ohne weitere Freischaltung kann.
// 'admin' = Wildcard (alles). 'chat.select_model' ist bewusst NICHT Baseline
// → standardmäßig versteckt, nur per Override/Gruppe freischaltbar.
// WICHTIG (Bestandsschutz): Die user-Baseline enthält ALLES, was Nutzer heute
// können — so verliert beim Einführen neuer Gates niemand bestehende Rechte.
// Neue Opt-in-Rechte (chat.select_model, chat.think_mode, files.large) sind
// bewusst NICHT Baseline und werden einzeln freigeschaltet.
// Erweitert 2026-08-11: Die folgenden Rechte waren faktisch nur bei 1 von 48
// Nutzern gesetzt, obwohl sie harmlos und rein lokal sind (kein Outbound, keine
// GPU-Last, keine Datenweitergabe). Sie gehören zum Grundnutzen der Anwendung.
// Bewusst NICHT Baseline: chat.select_model (Modellwahl), files.large (Upload-
// Limit), image.generate (GPU-Last), labels.* (Spezialbereich), kb.manage,
// admin.* — diese bleiben gezielt freizuschalten.
const USER_BASELINE: PermissionKey[] = [
  'chat.use',
  'files.upload',
  'rag.use',
  'memory.manage',
  'memory.global.contribute',
  'kb.query',
  // Neu in der Baseline:
  'chat.use_tools', // Vault-Suche, Rechner, Datum — rein intern
  'chat.think_mode', // Schalter für gründlichere Antworten
  'chat.share', // Chats mit Kolleg:innen teilen
  'docs.export', // Antworten als Word/PDF/Excel herunterladen
  'docs.actions', // Zusammenfassen/Übersetzen/Kernpunkte
  'docs.ocr', // Texterkennung in Scans/Fotos (offline)
  'docs.sheet', // Excel-/CSV-Auswertung
  'code.assist', // Programmiermodus (rein generierend, keine Ausführung)
];
const ROLE_BASELINE: Record<string, PermissionKey[]> = {
  user: USER_BASELINE,
  manager: USER_BASELINE, // wie user; zusätzliche Admin-Rechte per Override/Gruppe
  admin: ALL_PERMISSIONS, // Wildcard
};

function baselineFor(role: string): PermissionKey[] {
  return ROLE_BASELINE[role] ?? ROLE_BASELINE.user!;
}

/** Effektive Permissions als Set. Admins → alle. */
export function effectivePermissions(userId: number, role: string): Set<PermissionKey> {
  if (role === 'admin') return new Set(ALL_PERMISSIONS);

  const set = new Set<PermissionKey>(baselineFor(role));

  // Gruppen-Permissions (groups.permissions = { key: true })
  const groupIds = db.select({ gid: userGroups.groupId }).from(userGroups).where(eq(userGroups.userId, userId)).all().map((r) => r.gid);
  if (groupIds.length > 0) {
    const grps = db.select({ permissions: groups.permissions }).from(groups).where(inArray(groups.id, groupIds)).all();
    for (const g of grps) {
      for (const [key, val] of Object.entries(g.permissions ?? {})) {
        if (val && isPermissionKey(key)) set.add(key);
      }
    }
  }

  // Per-User-Overrides (granted true → add, false → remove)
  const overrides = db.select().from(userPermissions).where(eq(userPermissions.userId, userId)).all();
  for (const o of overrides) {
    if (!isPermissionKey(o.permission)) continue;
    if (o.granted) set.add(o.permission);
    else set.delete(o.permission);
  }

  return set;
}

export function listEffectivePermissions(userId: number, role: string): PermissionKey[] {
  return [...effectivePermissions(userId, role)];
}

export function hasPermission(userId: number, role: string, key: PermissionKey): boolean {
  if (role === 'admin') return true;
  return effectivePermissions(userId, role).has(key);
}

// --- Verwaltung der Per-User-Overrides --------------------------------------
export function getUserOverrides(userId: number): Record<string, boolean> {
  const rows = db.select().from(userPermissions).where(eq(userPermissions.userId, userId)).all();
  return Object.fromEntries(rows.map((r) => [r.permission, r.granted]));
}

/** Setzt/entfernt einen Override. granted=null → Override löschen (zurück zur Baseline). */
export function setUserOverride(userId: number, permission: string, granted: boolean | null): void {
  if (!isPermissionKey(permission)) return;
  if (granted === null) {
    db.delete(userPermissions)
      .where(and(eq(userPermissions.userId, userId), eq(userPermissions.permission, permission)))
      .run();
    return;
  }
  db.insert(userPermissions)
    .values({ userId, permission, granted })
    .onConflictDoUpdate({ target: [userPermissions.userId, userPermissions.permission], set: { granted } })
    .run();
}
