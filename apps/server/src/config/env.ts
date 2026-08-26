import { ladeKonfiguration } from './laden.ts';

// Installationskonfiguration einlesen, BEVOR die Werte geprüft werden.
const KONFIG_ORDNER = ladeKonfiguration();

import { z } from 'zod';

// .env wird über `tsx --env-file=../../.env` geladen (siehe package.json-Scripts).
// Hier validieren wir die Variablen einmal beim Start — fehlende/triviale Werte
// sollen den Prozess sofort und mit klarer Meldung abbrechen, statt später
// undurchsichtige Laufzeitfehler zu produzieren.

const boolish = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const schema = z.object({
  // Server
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // Datensouveränität: HTTPS nur an dieses Interface binden (Firmen-Ethernet),
  // damit die KI NICHT vom WLAN-/Internet-Segment erreichbar ist. Leer = HOST.
  BIND_INTERFACE: z.string().default(''),
  // HTTPS: wenn HTTPS_PORT > 0 und Cert/Key vorhanden, zusätzlich TLS-Server.
  HTTPS_PORT: z.coerce.number().int().default(0),
  TLS_CERT_PATH: z.string().default('./certs/cert.pem'),
  TLS_KEY_PATH: z.string().default('./certs/key.pem'),
  // Privilege-Dropping: Nach dem Binden privilegierter Ports (443) auf diesen
  // Nutzer wechseln. Leer = kein Drop (Dev). Prod: appleadmin / staff.
  DROP_TO_USER: z.string().default(''),
  DROP_TO_GROUP: z.string().default(''),

  // Auth
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET muss mindestens 32 Zeichen lang sein')
    .refine((v) => v !== 'supersecret', 'JWT_SECRET darf nicht der Platzhalter sein'),
  JWT_TTL: z.string().default('7d'),

  // Datenbank
  // Leerer Eintrag zählt als „nicht gesetzt": „DATABASE_PATH=" in der .env
  // ergäbe sonst den leeren Pfad, und SQLite scheitert am Verzeichnis statt an
  // einer Datei — mit einer Meldung, die niemand auf die .env zurückführt.
  DATABASE_PATH: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().default('./data/app.db')),

  // Active Directory
  AD_URL: z.string().default(''),
  AD_FALLBACK_URL: z.string().default(''),
  AD_BASE_DN: z.string().default(''),
  AD_USER_SEARCH_BASE: z.string().default(''),
  AD_BIND_DN: z.string().default(''),
  AD_BIND_PASSWORD: z.string().default(''),
  AD_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  // Leer = keine Gruppenprüfung. Eine konkrete Gruppe gehört in die
  // Konfiguration der jeweiligen Installation, nicht in die Vorgabe.
  AD_REQUIRED_GROUP: z.string().default(''),
  DEBUG_AD_AUTH: boolish(false),

  // Ollama
  OLLAMA_URL: z.string().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('gpt-oss:120b'),
  OLLAMA_EMBED_MODEL: z.string().default('bge-m3'), // multilingual (gut für Deutsch), 1024 dim
  // Kontextfenster: so wählen, dass das Modell vollständig in den Unified-Memory
  // passt (gpt-oss:120b ~65 GB → 65k Kontext bei 128 GB RAM ist sicher schnell).
  OLLAMA_NUM_CTX: z.coerce.number().int().positive().default(65536),
  OLLAMA_NUM_PREDICT: z.coerce.number().int().default(8192),
  OLLAMA_TEMPERATURE: z.coerce.number().default(0.3),
  // Reasoning-Schritt vor jeder Antwort: kostet ~8-10 s, daher per Default AUS
  // (Geschwindigkeit hat Priorität). Pro Anfrage optional aktivierbar.
  // Denkaufwand von gpt-oss. Gemessen an 4 echten E&F-Fragen (2026-08-19):
  //   off     38 % Fachtreffer, 147 s gesamt
  //   low     43 %,              70 s
  //   medium  48 %,              55 s   <- beste Trefferquote UND schnellste
  //   high    43 %,             101 s
  // „Aus" war die schlechteste UND langsamste Einstellung: Das Modell denkt
  // ohnehin, der Schalter unterdrückt nur die Steuerung darüber.
  OLLAMA_THINK: z.enum(['off', 'low', 'medium', 'high']).default('medium'),
  // Modell im RAM halten + beim Start vorwärmen → kein Kaltstart-Delay.
  OLLAMA_KEEP_ALIVE: z.string().default('24h'),
  OLLAMA_WARMUP: boolish(true),
  // Wie viele letzte Nachrichten als Kontext an das Modell gehen.
  // --- Ablage der Installationsdaten -------------------------------------------
  // Alles Installationsspezifische liegt AUSSERHALB des Quellbaums: Konfiguration,
  // Logo, Zertifikate, Datenbank, hochgeladene Dateien. Der Quelltext lässt sich
  // damit unverändert veröffentlichen und aktualisieren, ohne dass jemand
  // versehentlich Betriebsdaten mitnimmt.
  //
  // Vorgabe ist ein Ordner neben dem Projekt; über CONFIG_DIR frei wählbar
  // (z. B. /etc/enterpriseai oder /Volumes/Daten/ki-config).
  CONFIG_DIR: z.string().default('../config'),

  // --- Erscheinungsbild -------------------------------------------------------
  // Der Code kennt keinen Firmennamen. Diese Werte prägen Oberfläche und
  // erzeugte Dokumente; die Vorgaben sind neutral, damit eine frische
  // Installation ohne Anpassung funktioniert.
  APP_NAME: z.string().default('EnterpriseAI'),
  APP_SHORT: z.string().default(''),
  ORG_NAME: z.string().default(''),
  BRAND_COLOR: z.string().default('#2563eb'),
  BRAND_LOGO_PATH: z.string().default(''),
  DOC_FOOTER: z.string().default('Intern'),

  MAX_CONTEXT_MESSAGES: z.coerce.number().int().positive().default(40),

  // Datei-Uploads
  UPLOAD_DIR: z.string().default('./data/uploads'),
  // Hochgesetzt am 21.08.2026: 25 MB waren die Ursache dafür, dass große
  // Druckdaten und Scans abgelehnt wurden. Gemessen verarbeitet der Server
  // 800 MB in 0,3 s; Dateien landen auf der Platte, nicht im Speicher.
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(500),
  MAX_UPLOAD_MB_LARGE: z.coerce.number().int().positive().default(2000), // mit Permission 'files.large'
  MAX_FILES_PER_QUERY: z.coerce.number().int().positive().default(5),
  MAX_FILE_CONTEXT_CHARS: z.coerce.number().int().positive().default(200000),
  // Wie viel Text je Datei GESPEICHERT wird. Bewusst deutlich höher als das
  // Kontextbudget: Der Volltext wird für die Suche (RAG) zerlegt und von
  // Werkzeugen ausgewertet — beim Speichern zu kappen hieße, den Rest des
  // Dokuments dauerhaft unauffindbar zu machen. Gekürzt wird erst beim
  // Zusammenstellen des Prompts.
  MAX_FILE_STORED_CHARS: z.coerce.number().int().positive().default(2000000),
  OLLAMA_MULTIMODAL: boolish(false),

  // Bildgenerierung (lokaler mflux/MLX-Dienst, STRIKT intern auf 127.0.0.1).
  // Leer/aus → Feature deaktiviert. Kein Outbound: spricht nur localhost.
  IMAGEGEN_ENABLED: boolish(false),
  IMAGEGEN_URL: z.string().default('http://127.0.0.1:7870'),
  IMAGEGEN_TIMEOUT_MS: z.coerce.number().int().positive().default(180000),

  // Text-Klassifizierer (gBERT Zero-Shot, deutsch, CPU — strikt intern auf 127.0.0.1).
  // Für Etiketten-/Dokument-Einordnung. Kein GPU → keine Chat-Konkurrenz.
  CLASSIFIER_ENABLED: boolish(false),
  CLASSIFIER_URL: z.string().default('http://127.0.0.1:7871'),
  CLASSIFIER_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  CLASSIFIER_OCR_TIMEOUT_MS: z.coerce.number().int().positive().default(300000), // OCR ist langsamer (CPU)
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Ungültige Konfiguration in .env:');
  for (const issue of parsed.error.issues) {
    console.error(`   - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

// AD gilt als konfiguriert, wenn eine echte URL und eine echte Base-DN gesetzt
// sind (nicht die localhost-/Beispiel-Defaults). Spiegelt die Prüfung der
// Alt-Installation, damit sich der Login-Pfad identisch verhält.
export const isAdConfigured =
  env.AD_URL.length > 0 &&
  env.AD_URL !== 'ldap://localhost:389' &&
  env.AD_BASE_DN.length > 0 &&
  env.AD_BASE_DN.toLowerCase() !== 'dc=example,dc=com';

// Such-Basis: fällt auf AD_BASE_DN zurück, wenn nicht separat gesetzt.
export const adUserSearchBase = env.AD_USER_SEARCH_BASE || env.AD_BASE_DN;

/** Wo die Installationskonfiguration gefunden wurde (null = keine). */
export const konfigQuelle = KONFIG_ORDNER;
