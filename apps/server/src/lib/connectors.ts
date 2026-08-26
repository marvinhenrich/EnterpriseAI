import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { sqliteConnection as sqlite } from '../db/client.ts';
import { env, isAdConfigured } from '../config/env.ts';
import { testAdConnection } from '../auth/ad.ts';

// =============================================================================
// Konnektoren-Übersicht: alle Systeme, mit denen die Anwendung spricht — mit
// Live-Status. Zusätzlich die geplanten Anbindungen, damit im Admin-Panel
// sichtbar ist, was existiert und was noch aussteht.
// Alle Prüfungen laufen rein intern (localhost/Firmennetz), kein Outbound.
// =============================================================================

export type ConnectorStatus = 'online' | 'offline' | 'disabled' | 'planned' | 'error';

export interface Connector {
  id: string;
  name: string;
  category: 'KI-Modelle' | 'Verzeichnisdienst' | 'Daten & Speicher' | 'Dienste' | 'Geplant';
  status: ConnectorStatus;
  endpoint: string | null;
  detail: string; // Kurzstatus, z. B. Modellname oder Fehlermeldung
  description: string; // Wofür der Konnektor da ist
  internal: boolean; // rein intern (kein Internet)?
  latencyMs?: number | null;
  dependsOn?: string[]; // IDs der Konnektoren, die dieser braucht
  provides?: string; // wofür er im Produkt sorgt (für die Mindmap)
  impact?: string; // was NICHT mehr geht, wenn dieser Konnektor ausfällt
}

/** HTTP-Erreichbarkeit eines internen Dienstes prüfen (kurzer Timeout). */
async function probe(url: string, timeoutMs = 2500): Promise<{ ok: boolean; ms: number | null; error?: string }> {
  const start = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, ms: Date.now() - start, error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, ms: null, error: (err as Error).name === 'TimeoutError' ? 'Zeitüberschreitung' : (err as Error).message };
  }
}

function count(sql: string): number {
  try {
    return (sqlite.prepare(sql).get() as { c: number } | undefined)?.c ?? 0;
  } catch {
    return 0;
  }
}

/** Geplante Anbindungen — bewusst gepflegte Liste, damit die Roadmap sichtbar ist. */
const PLANNED: Omit<Connector, 'status' | 'latencyMs'>[] = [
  {
    id: 'datawarehouse',
    name: 'DataWarehouse (SQL Server)',
    category: 'Geplant',
    endpoint: null,
    detail: 'noch nicht angebunden',
    description: 'Lesezugriff auf die DWH-Views für Auswertungen und Kennzahlen direkt im Chat.',
    internal: true,
  },
  {
    id: 'fileshare',
    name: 'Dateiablage / Netzlaufwerk',
    category: 'Geplant',
    endpoint: null,
    detail: 'noch nicht angebunden',
    description: 'Freigegebene Ordner automatisch ins Wissens-Vault indexieren, statt Dateien einzeln hochzuladen.',
    internal: true,
    dependsOn: ['vault'],
  },
  {
    id: 'exchange',
    name: 'E-Mail / Exchange',
    category: 'Geplant',
    endpoint: null,
    detail: 'noch nicht angebunden',
    description: 'Benachrichtigungen versenden und Postfach-Inhalte auf Wunsch auswertbar machen.',
    internal: true,
  },
];

export async function listConnectors(): Promise<Connector[]> {
  const out: Connector[] = [];

  // --- Sprachmodell (Ollama) ---
  const ollama = await probe(`${env.OLLAMA_URL}/api/tags`);
  let modelPresent = false;
  if (ollama.ok) {
    try {
      const res = await fetch(`${env.OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2500) });
      const data = (await res.json()) as { models?: { name: string }[] };
      modelPresent = !!data.models?.some((m) => m.name === env.OLLAMA_MODEL || m.name.startsWith(env.OLLAMA_MODEL.split(':')[0] ?? ''));
    } catch {
      /* Modelle nicht auslesbar — Erreichbarkeit zählt */
    }
  }
  out.push({
    id: 'ollama',
    name: 'Sprachmodell (Ollama)',
    category: 'KI-Modelle',
    status: ollama.ok ? 'online' : 'offline',
    endpoint: env.OLLAMA_URL,
    detail: ollama.ok ? `${env.OLLAMA_MODEL}${modelPresent ? '' : ' (Modell nicht in der Liste)'}` : (ollama.error ?? 'nicht erreichbar'),
    description: 'Erzeugt alle Chat-Antworten. Läuft lokal auf dem Server — keine Daten verlassen das Haus.',
    internal: true,
    latencyMs: ollama.ms,
    provides: 'Chat-Antworten',
    impact: 'Ohne ihn funktioniert der Chat gar nicht — es kommen keine Antworten mehr.',
  });

  // --- Embedding-Modell (gleicher Dienst, eigener Zweck) ---
  out.push({
    id: 'embeddings',
    name: 'Embedding-Modell',
    category: 'KI-Modelle',
    status: ollama.ok ? 'online' : 'offline',
    endpoint: env.OLLAMA_URL,
    detail: env.OLLAMA_EMBED_MODEL,
    description: 'Wandelt Texte in Vektoren um — Grundlage für die semantische Suche im Wissens-Vault und in Anhängen.',
    internal: true,
    latencyMs: ollama.ms,
    provides: 'Semantische Suche',
    impact: 'Das Wissens-Vault und angehängte Dateien werden nicht mehr durchsucht. Der Chat läuft weiter, antwortet aber ohne Firmenwissen.',
  });

  // --- Bildgenerierung ---
  if (env.IMAGEGEN_ENABLED) {
    const img = await probe(`${env.IMAGEGEN_URL}/health`);
    // Manche Dienste haben kein /health — dann Basis-URL versuchen.
    const img2 = img.ok ? img : await probe(env.IMAGEGEN_URL);
    out.push({
      id: 'imagegen',
      name: 'Bildgenerierung',
      category: 'KI-Modelle',
      status: img2.ok ? 'online' : 'offline',
      endpoint: env.IMAGEGEN_URL,
      detail: img2.ok ? 'bereit' : (img2.error ?? 'nicht erreichbar'),
      description: 'Erzeugt Bilder aus Text (lokales Modell, GPU). Rein intern.',
      internal: true,
      latencyMs: img2.ms,
      provides: 'Bildgenerierung',
      impact: 'Es lassen sich keine Bilder mehr erzeugen. Chat und Vault sind nicht betroffen.',
    });
  } else {
    out.push({
      id: 'imagegen',
      name: 'Bildgenerierung',
      category: 'KI-Modelle',
      status: 'disabled',
      endpoint: env.IMAGEGEN_URL,
      detail: 'in der Konfiguration deaktiviert',
      description: 'Erzeugt Bilder aus Text (lokales Modell, GPU). Rein intern.',
      internal: true,
    });
  }

  // --- Klassifizierer (Etiketten-Prüfung, CPU) ---
  if (env.CLASSIFIER_ENABLED) {
    const cls = await probe(`${env.CLASSIFIER_URL}/health`);
    const cls2 = cls.ok ? cls : await probe(env.CLASSIFIER_URL);
    out.push({
      id: 'classifier',
      name: 'Text-Klassifizierer',
      category: 'KI-Modelle',
      status: cls2.ok ? 'online' : 'offline',
      endpoint: env.CLASSIFIER_URL,
      detail: cls2.ok ? 'bereit (CPU)' : (cls2.error ?? 'nicht erreichbar'),
      description: 'Deutsches Zero-Shot-Modell für die Etiketten-Prüfung. Läuft auf der CPU, ohne GPU-Konkurrenz zum Chat.',
      internal: true,
      latencyMs: cls2.ms,
      provides: 'Etiketten-Prüfung',
      impact: 'Der Etiketten-Scan auf Werbeaussagen läuft nicht mehr. Alles andere bleibt nutzbar.',
    });
  } else {
    out.push({
      id: 'classifier',
      name: 'Text-Klassifizierer',
      category: 'KI-Modelle',
      status: 'disabled',
      endpoint: env.CLASSIFIER_URL,
      detail: 'in der Konfiguration deaktiviert',
      description: 'Deutsches Zero-Shot-Modell für die Etiketten-Prüfung.',
      internal: true,
    });
  }

  // --- Active Directory ---
  if (isAdConfigured) {
    const ad = await testAdConnection();
    out.push({
      id: 'ad',
      name: 'Active Directory (LDAP)',
      category: 'Verzeichnisdienst',
      status: ad.ok ? 'online' : 'error',
      endpoint: env.AD_URL,
      detail: ad.ok ? `${env.AD_BASE_DN}${env.AD_REQUIRED_GROUP ? ` · Gruppe ${env.AD_REQUIRED_GROUP}` : ' · alle AD-Nutzer'}` : (ad.message ?? 'Verbindung fehlgeschlagen'),
      description: 'Anmeldung mit dem Windows-Konto und Import von Benutzern. Läuft im Firmennetz.',
      internal: true,
      provides: 'Anmeldung',
      impact: 'Anmeldung mit dem Windows-Konto ist nicht möglich; lokale Konten funktionieren weiter.',
    });
  } else {
    out.push({
      id: 'ad',
      name: 'Active Directory (LDAP)',
      category: 'Verzeichnisdienst',
      status: 'disabled',
      endpoint: null,
      detail: 'nicht konfiguriert — nur lokale Konten',
      description: 'Anmeldung mit dem Windows-Konto und Import von Benutzern.',
      internal: true,
    });
  }

  // --- Datenbank ---
  let dbSize = 0;
  try {
    dbSize = statSync(resolve(process.cwd(), env.DATABASE_PATH)).size;
  } catch {
    /* ignore */
  }
  out.push({
    id: 'database',
    name: 'Datenbank (SQLite)',
    category: 'Daten & Speicher',
    status: dbSize > 0 ? 'online' : 'error',
    endpoint: env.DATABASE_PATH,
    detail: `${(dbSize / 1024 / 1024).toFixed(1)} MB · ${count('SELECT count(*) c FROM chats')} Chats · ${count('SELECT count(*) c FROM users')} Benutzer`,
    description: 'Speichert Chats, Benutzer, Berechtigungen, Projekte und das Wissens-Vault. Liegt lokal auf dem Server.',
    internal: true,
    provides: 'Persistenz',
    impact: 'Nichts funktioniert mehr — hier liegen Chats, Benutzer, Rechte, Projekte und das Vault.',
  });

  // --- Vektor-Index ---
  const kbChunks = count('SELECT count(*) c FROM kb_chunks');
  const ragChunks = count('SELECT count(*) c FROM rag_chunks');
  out.push({
    id: 'vector',
    name: 'Vektor-Index (sqlite-vec)',
    category: 'Daten & Speicher',
    status: 'online',
    endpoint: null,
    detail: `${kbChunks} Vault-Abschnitte · ${ragChunks} Datei-Abschnitte`,
    description: 'Semantische Suche: findet inhaltlich passende Stellen im Wissens-Vault und in hochgeladenen Dateien.',
    internal: true,
    dependsOn: ['database', 'embeddings'],
    provides: 'Trefferliste',
    impact: 'Die KI findet nichts mehr im Vault oder in Anhängen und antwortet nur noch aus Modellwissen.',
  });

  // --- Wissens-Vault ---
  out.push({
    id: 'vault',
    name: 'Wissens-Vault',
    category: 'Daten & Speicher',
    status: 'online',
    endpoint: null,
    detail: `${count('SELECT count(*) c FROM vault_notes')} Notizen · ${count('SELECT count(*) c FROM kb_documents')} Dokumente`,
    description: 'Firmenweites Wissen (Notizen + Dokumente), das die KI bei passenden Fragen automatisch heranzieht.',
    internal: true,
    dependsOn: ['vector', 'database'],
    provides: 'Firmenwissen',
    impact: 'Antworten stützen sich nicht mehr auf Firmenunterlagen — das Risiko falscher Angaben steigt.',
  });

  // --- Etiketten-Datenbank ---
  out.push({
    id: 'labels',
    name: 'Etiketten-Datenbank',
    category: 'Daten & Speicher',
    status: 'online',
    endpoint: null,
    detail: `${count('SELECT count(*) c FROM labels')} Etiketten · ${count('SELECT count(*) c FROM label_terms')} Begriffe`,
    description: 'Gemeinsame Etiketten-Prüfung gegen hinterlegte Richtlinien-Begriffe.',
    internal: true,
    dependsOn: ['database', 'classifier', 'ocr'],
    provides: 'Compliance-Prüfung',
    impact: 'Etiketten können nicht mehr gegen die Richtlinien-Begriffe geprüft werden.',
  });

  // --- OCR ---
  const ocrPath = resolve(process.cwd(), 'ocr-data');
  const ocrReady = existsSync(ocrPath);
  out.push({
    id: 'ocr',
    name: 'Texterkennung (OCR)',
    category: 'Dienste',
    status: ocrReady ? 'online' : 'error',
    endpoint: ocrPath,
    detail: ocrReady ? 'Sprachdaten deutsch + englisch lokal vorhanden' : 'Sprachdaten fehlen (ocr-data)',
    description: 'Liest Text aus Bildern und Scans — komplett offline, ohne Netzwerkzugriff.',
    internal: true,
    provides: 'Text aus Bildern',
    impact: 'Aus Bildern und Scans wird kein Text mehr gelesen — die KI kann deren Inhalt nicht nutzen.',
  });

  // --- Geplante Anbindungen ---
  for (const p of PLANNED) out.push({ ...p, status: 'planned' });

  return out;
}
