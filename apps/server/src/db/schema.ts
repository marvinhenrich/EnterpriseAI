import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Spaltennamen werden über drizzle.config `casing: 'snake_case'` automatisch
// von camelCase nach snake_case gemappt (passwordHash -> password_hash usw.),
// damit die Migration aus der Alt-DB 1:1 passt.

const now = sql`CURRENT_TIMESTAMP`;

// --- Benutzer ----------------------------------------------------------------
export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    username: text('username').notNull(),
    email: text('email'),
    passwordHash: text('password_hash'),
    role: text('role').notNull().default('user'), // 'user' | 'manager' | 'admin'
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    department: text('department'),
    lastLogin: text('last_login'),
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    passwordChangedAt: text('password_changed_at'),
    authProvider: text('auth_provider').notNull().default('local'), // 'local' | 'ad'
    adDn: text('ad_dn'),
    snakeEnabled: integer('snake_enabled', { mode: 'boolean' }).notNull().default(false),
    mustChangePassword: integer('must_change_password', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').default(now),
    updatedAt: text('updated_at').default(now),
  },
  (t) => [
    uniqueIndex('idx_users_username_lower').on(sql`lower(${t.username})`),
    index('idx_users_email').on(t.email),
  ],
);

// --- Berechtigungsgruppen ----------------------------------------------------
export const groups = sqliteTable('groups', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  description: text('description'),
  permissions: text('permissions', { mode: 'json' }).$type<Record<string, boolean>>().default({}),
  createdAt: text('created_at').default(now),
  updatedAt: text('updated_at').default(now),
});

export const userGroups = sqliteTable(
  'user_groups',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    groupId: integer('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    assignedAt: text('assigned_at').default(now),
  },
  (t) => [uniqueIndex('idx_user_groups_unique').on(t.userId, t.groupId)],
);

// Per-User-Berechtigungs-Overrides (granted=true → erlauben, false → entziehen).
// Greift zusätzlich zu Rollen-Baseline + Gruppen-Permissions.
export const userPermissions = sqliteTable(
  'user_permissions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
    granted: integer('granted', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').default(now),
  },
  (t) => [uniqueIndex('idx_user_permission').on(t.userId, t.permission)],
);

// --- Audit-Log ---------------------------------------------------------------
export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id'),
    username: text('username'),
    action: text('action').notNull(),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    details: text('details', { mode: 'json' }).$type<Record<string, unknown>>(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: text('created_at').default(now),
  },
  (t) => [index('idx_audit_created').on(t.createdAt), index('idx_audit_user').on(t.userId)],
);

// --- System-Einstellungen ----------------------------------------------------
export const systemSettings = sqliteTable('system_settings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  settingKey: text('setting_key').notNull().unique(),
  settingValue: text('setting_value'),
  updatedAt: text('updated_at').default(now),
});

// --- Memory ------------------------------------------------------------------
export const userMemory = sqliteTable(
  'user_memory',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    memoryText: text('memory_text').notNull(),
    importance: integer('importance').notNull().default(1), // 1=7d, 2=30d, 3=permanent
    createdAt: text('created_at').default(now),
    updatedAt: text('updated_at').default(now),
  },
  (t) => [index('idx_user_memory_user').on(t.userId)],
);

export const globalMemory = sqliteTable('global_memory', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  memoryText: text('memory_text').notNull().unique(),
  category: text('category'),
  importance: integer('importance').notNull().default(2),
  createdBy: integer('created_by'),
  createdAt: text('created_at').default(now),
  updatedAt: text('updated_at').default(now),
});

// --- AD-Auto-Import ----------------------------------------------------------
export const adAutoImportConfig = sqliteTable('ad_auto_import_config', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  config: text('config', { mode: 'json' }).$type<Record<string, unknown>>(),
  updatedAt: text('updated_at').default(now),
});

// --- Chats & Nachrichten (neu: DB statt dateibasierter Sessions) -------------
// --- Projekte (bündeln Chats + eigene Dateien + eigene Anweisungen) ----------
export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(), // UUID
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    instructions: text('instructions'), // projektweiter Zusatz zum System-Prompt
    // 'all' = ganzes Wissens-Vault mitnutzen · 'project' = nur Projektdateien.
    // Für abgegrenzte Themen (Forschung) verhindert 'project' Fremdeinflüsse.
    vaultScope: text('vault_scope').notNull().default('all'),
    // Vorgabe für alle Dateien des Projekts; einzelne Dateien dürfen höher stehen.
    classification: text('classification').notNull().default('intern'),
    color: text('color'),
    createdAt: text('created_at').default(now),
    updatedAt: text('updated_at').default(now),
  },
  (t) => [index('idx_projects_user').on(t.userId, t.updatedAt)],
);

/**
 * Projekt-Kontext („Projekt-Memory"): was die KI innerhalb DIESES Projekts
 * gelernt hat oder was der Nutzer ihr vorgibt. Bewusst pro Projekt getrennt —
 * Wissen aus anderen Themen soll hier nicht hineinwirken. Für den Nutzer
 * sichtbar und änderbar, nicht als versteckter Speicher.
 */
export const projectMemory = sqliteTable(
  'project_memory',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: text('project_id').notNull(),
    text: text('text').notNull(),
    source: text('source').notNull().default('auto'), // auto | manual
    chatId: text('chat_id'), // woraus abgeleitet (nur bei source=auto)
    createdBy: text('created_by'),
    createdAt: text('created_at').default(now),
    updatedAt: text('updated_at').default(now),
  },
  (t) => [index('idx_project_memory').on(t.projectId, t.createdAt)],
);

export type ProjectMemory = typeof projectMemory.$inferSelect;
export type Project = typeof projects.$inferSelect;

export const chats = sqliteTable(
  'chats',
  {
    // Einstufung des GESPRÄCHS, monoton steigend. Sie darf nie sinken, solange
    // der Verlauf im Prompt bleibt: Wer in Runde 1 eine Tabelle anhängt, hat
    // sie in Runde 5 immer noch im Kontext. Vorher wurde die Stufe pro Anfrage
    // neu aus den Anhängen DIESER Runde berechnet — eine Folgefrage ohne Anhang
    // fiel damit auf 'intern' zurück und hob alle Sperren auf.
    classification: text('classification').notNull().default('intern'),
    id: text('id').primaryKey(), // UUID
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('Neuer Chat'),
    model: text('model'),
    projectId: text('project_id'), // optional: Zugehörigkeit zu einem Projekt
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').default(now),
    updatedAt: text('updated_at').default(now),
  },
  (t) => [index('idx_chats_user').on(t.userId, t.updatedAt), index('idx_chats_project').on(t.projectId)],
);

export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    role: text('role').notNull(), // 'system' | 'user' | 'assistant'
    content: text('content').notNull(),
    attachments: text('attachments', { mode: 'json' }).$type<unknown[]>(),
    senderId: integer('sender_id'), // welcher Nutzer die Nachricht schrieb (für geteilte Chats)
    createdAt: text('created_at').default(now),
  },
  (t) => [index('idx_messages_chat').on(t.chatId, t.createdAt)],
);

// Geteilte Chats: Zugriff für weitere Nutzer (Mehrbenutzer-Threads, intern).
export const chatShares = sqliteTable(
  'chat_shares',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    canWrite: integer('can_write', { mode: 'boolean' }).notNull().default(true),
    sharedBy: integer('shared_by'),
    createdAt: text('created_at').default(now),
  },
  (t) => [uniqueIndex('idx_chat_share_unique').on(t.chatId, t.userId)],
);

// --- Statistiken & Spiel -----------------------------------------------------
export const activityStats = sqliteTable(
  'activity_stats',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull(),
    date: text('date').notNull(),
    messagesSent: integer('messages_sent').notNull().default(0),
    chatsCreated: integer('chats_created').notNull().default(0),
    filesUploaded: integer('files_uploaded').notNull().default(0),
  },
  (t) => [uniqueIndex('idx_activity_user_date').on(t.userId, t.date)],
);

export const snakeScores = sqliteTable(
  'snake_scores',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id'),
    username: text('username'),
    score: integer('score').notNull().default(0),
    createdAt: text('created_at').default(now),
  },
  (t) => [index('idx_snake_score').on(t.score)],
);

// --- Datei-Uploads -----------------------------------------------------------
export const files = sqliteTable(
  'files',
  {
    id: text('id').primaryKey(), // UUID
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chatId: text('chat_id'),
    projectId: text('project_id'), // Projektdatei: in allen Chats des Projekts verfügbar
    filename: text('filename').notNull(),
    storedPath: text('stored_path').notNull(),
    mime: text('mime'),
    size: integer('size').notNull().default(0),
    kind: text('kind').notNull().default('document'), // 'document' | 'image'
    extractedText: text('extracted_text'),
    // Texterkennung im Hintergrund: pending | done | failed | skipped
    ocrState: text('ocr_state'),
    // Referenzdatei: gilt in ALLEN Projekten dieses Nutzers. Für fachliche
    // Grundlagen (Rechenlogik, Normen), die sonst in jedem Projekt einzeln
    // hochgeladen werden müssten.
    userScope: integer('user_scope').notNull().default(0),
    // Datenklassifizierung: offen | intern | vertraulich | geheim.
    // Ab 'vertraulich' fließt der Inhalt in KEIN gemeinsames Wissen ein.
    classification: text('classification').notNull().default('intern'),
    createdAt: text('created_at').default(now),
  },
  (t) => [index('idx_files_user').on(t.userId), index('idx_files_project').on(t.projectId)],
);

// --- Wissens-Vault: Dokumente (firmenweit) -----------------------------------
export const kbDocuments = sqliteTable(
  'kb_documents',
  {
    id: text('id').primaryKey(), // UUID
    title: text('title').notNull(),
    filename: text('filename').notNull(),
    storedPath: text('stored_path').notNull(),
    mime: text('mime'),
    size: integer('size').notNull().default(0),
    chunks: integer('chunks').notNull().default(0),
    folder: text('folder').notNull().default(''), // Ordnerpfad, z. B. "QM/Prüfpläne"
    tags: text('tags'), // JSON-Array
    visibility: text('visibility').notNull().default(''), // ''|restricted|it — siehe lib/visibility.ts
    aiUse: integer('ai_use', { mode: 'boolean' }).notNull().default(true),
    uploadedBy: integer('uploaded_by'),
    createdAt: text('created_at').default(now),
  },
  (t) => [index('idx_kb_created').on(t.createdAt), index('idx_kb_folder').on(t.folder)],
);

// --- Wissens-Vault: Notizen (Obsidian-artig, Markdown + [[Wiki-Links]]) ------
export const vaultNotes = sqliteTable(
  'vault_notes',
  {
    id: text('id').primaryKey(), // UUID
    title: text('title').notNull(),
    content: text('content').notNull().default(''), // Markdown
    folder: text('folder').notNull().default(''),
    tags: text('tags'), // JSON-Array
    visibility: text('visibility').notNull().default(''), // ''|restricted|it — siehe lib/visibility.ts
    // Von der KI verwenden? Ungeprüft gesammeltes Wissen bleibt hier bewusst aus,
    // sonst verwässert es die Antworten (gemessen: 69 % der Treffer bei E&F-Fragen).
    aiUse: integer('ai_use', { mode: 'boolean' }).notNull().default(true),
    chunks: integer('chunks').notNull().default(0),
    createdBy: integer('created_by'),
    createdByName: text('created_by_name'),
    updatedByName: text('updated_by_name'),
    createdAt: text('created_at').default(now),
    updatedAt: text('updated_at').default(now),
  },
  (t) => [index('idx_vault_notes_updated').on(t.updatedAt), index('idx_vault_notes_folder').on(t.folder)],
);

// Verknüpfungen aus [[Wiki-Links]] — Basis für Backlinks („Wird erwähnt in").
export const vaultLinks = sqliteTable(
  'vault_links',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    fromNoteId: text('from_note_id').notNull(),
    toTitle: text('to_title').notNull(), // normalisiert (lowercase)
  },
  (t) => [uniqueIndex('idx_vault_link_unique').on(t.fromNoteId, t.toTitle), index('idx_vault_link_to').on(t.toTitle)],
);

// Versionshistorie der Notizen — jede Speicherung erzeugt einen Stand,
// damit nachvollziehbar ist, wer wann was geändert hat (GitHub-artig).
export const vaultRevisions = sqliteTable(
  'vault_revisions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    noteId: text('note_id').notNull(),
    title: text('title').notNull(),
    content: text('content').notNull().default(''),
    folder: text('folder').notNull().default(''),
    tags: text('tags'),
    editedBy: text('edited_by'), // Anzeigename
    editedById: integer('edited_by_id'),
    action: text('action').notNull().default('update'), // create|update|restore
    summary: text('summary'), // z. B. „+12 / −3 Zeilen"
    createdAt: text('created_at').default(now),
  },
  (t) => [index('idx_vault_rev_note').on(t.noteId, t.createdAt)],
);

export type VaultNote = typeof vaultNotes.$inferSelect;
export type VaultRevision = typeof vaultRevisions.$inferSelect;

// --- Etiketten-Datenbank (geteilt, Richtlinien-Compliance) -------------------
export const labels = sqliteTable(
  'labels',
  {
    id: text('id').primaryKey(), // UUID
    filename: text('filename').notNull(),
    storedPath: text('stored_path').notNull(),
    kind: text('kind').notNull().default('pdf'), // 'pdf' | 'image'
    size: integer('size').notNull().default(0),
    pages: integer('pages'),
    ocrText: text('ocr_text'), // gecachte OCR (null = noch nicht)
    ocrStatus: text('ocr_status').notNull().default('pending'), // pending|done|failed
    lastFound: text('last_found'), // JSON-Array der getroffenen Begriffe (letzter Scan)
    lastStatus: text('last_status'), // 'treffer' | 'ok'
    lastScanId: text('last_scan_id'),
    uploadedBy: integer('uploaded_by'),
    uploadedByName: text('uploaded_by_name'),
    createdAt: text('created_at').default(now),
  },
  (t) => [index('idx_labels_created').on(t.createdAt)],
);

export const labelTerms = sqliteTable(
  'label_terms',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    term: text('term').notNull(), // deutscher Begriff (Eingabe)
    variants: text('variants'), // JSON-Array: Übersetzungen/Synonyme aller Sprachen (null = noch nicht übersetzt)
    addedBy: integer('added_by'),
    createdAt: text('created_at').default(now),
  },
  (t) => [uniqueIndex('idx_label_terms_term').on(t.term)],
);

// Geteilter Scan-Job („der große Topf") — Live-Status für alle sichtbar.
export const labelScans = sqliteTable('label_scans', {
  id: text('id').primaryKey(),
  status: text('status').notNull().default('running'), // running|done|failed|canceled
  startedBy: integer('started_by'),
  startedByName: text('started_by_name'),
  startedAt: text('started_at').default(now),
  finishedAt: text('finished_at'),
  total: integer('total').notNull().default(0),
  done: integer('done').notNull().default(0),
  hits: integer('hits').notNull().default(0),
  termCount: integer('term_count').notNull().default(0),
  error: text('error'),
});

// --- Bildgenerierung: Jobs + Galerie (persistent, geteilte GPU-Queue) --------
export const imageJobs = sqliteTable(
  'image_jobs',
  {
    id: text('id').primaryKey(),
    userId: integer('user_id'),
    userName: text('user_name'),
    prompt: text('prompt').notNull(),
    model: text('model').notNull().default('turbo'),
    width: integer('width'),
    height: integer('height'),
    steps: integer('steps'),
    seed: integer('seed'),
    negativePrompt: text('negative_prompt'),
    refPath: text('ref_path'), // Referenzbild (img2img / Inpainting), optional
    maskPath: text('mask_path'), // Maske (Inpainting: weiß = ändern), optional
    imageStrength: real('image_strength'), // mflux-Stärke (hoch = näher am Original)
    status: text('status').notNull().default('queued'), // queued|running|done|failed
    imagePath: text('image_path'),
    ms: integer('ms'),
    error: text('error'),
    createdAt: text('created_at').default(now),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
  },
  (t) => [index('idx_image_jobs_user').on(t.userId), index('idx_image_jobs_status').on(t.status), index('idx_image_jobs_created').on(t.createdAt)],
);

// --- Feedback (Nutzer → Admin) ----------------------------------------------
export const feedback = sqliteTable(
  'feedback',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id'),
    username: text('username'),
    category: text('category').notNull().default('other'), // bug|idea|praise|other
    rating: integer('rating'), // optional 1–5
    message: text('message').notNull(),
    context: text('context'), // wo abgegeben (Seite/Chat) — hilft beim Nachvollziehen
    status: text('status').notNull().default('open'), // open|in_progress|resolved|declined
    response: text('response'), // Antwort der Administration, für den Melder sichtbar
    handledBy: text('handled_by'),
    handledAt: text('handled_at'),
    createdAt: text('created_at').default(now),
  },
  (t) => [index('idx_feedback_created').on(t.createdAt), index('idx_feedback_status').on(t.status)],
);

export type Feedback = typeof feedback.$inferSelect;

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Label = typeof labels.$inferSelect;
export type LabelScan = typeof labelScans.$inferSelect;
export type ImageJob = typeof imageJobs.$inferSelect;

