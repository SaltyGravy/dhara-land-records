import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const documents = sqliteTable('documents', {
  id: text('id').primaryKey(), owner: text('owner').notNull().default('Not detected'), document: text('document').notNull(),
  filename: text('filename').notNull(), location: text('location').notNull(), district: text('district').notNull(),
  survey: text('survey').notNull().default('—'), type: text('type').notNull(), language: text('language').notNull(),
  confidence: real('confidence').notNull().default(0), status: text('status').notNull(), fileKey: text('file_key'),
  mimeType: text('mime_type').notNull().default('application/octet-stream'), checksumSha256: text('checksum_sha256').notNull().default(''),
  ocrEngine: text('ocr_engine').notNull().default('Hosted prototype intake'), fieldsJson: text('fields_json').notNull().default('[]'),
  validationIssues: text('validation_issues').notNull().default('[]'), version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
}, table => [index('idx_documents_status').on(table.status), index('idx_documents_district').on(table.district), index('idx_documents_created_at').on(table.createdAt)])

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }), username: text('username').notNull(), displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(), role: text('role').notNull(), active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
}, table => [uniqueIndex('idx_users_username').on(table.username), index('idx_users_role').on(table.role)])

export const auditEvents = sqliteTable('audit_events', {
  id: integer('id').primaryKey({ autoIncrement: true }), eventType: text('event_type').notNull(), actor: text('actor').notNull(),
  action: text('action').notNull(), documentId: text('document_id'), details: text('details').notNull().default(''),
  previousHash: text('previous_hash').notNull().default(''), eventHash: text('event_hash').notNull().default(''), createdAt: text('created_at').notNull(),
}, table => [index('idx_audit_created_at').on(table.createdAt), index('idx_audit_document_id').on(table.documentId)])

export const parcels = sqliteTable('parcels', {
  id: integer('id').primaryKey({ autoIncrement: true }), khasra: text('khasra').notNull(), owner: text('owner').notNull(), area: real('area').notNull(),
  classification: text('classification').notNull(), status: text('status').notNull(), village: text('village').notNull(), tehsil: text('tehsil').notNull(),
  district: text('district').notNull(), recordId: text('record_id'), geometryJson: text('geometry_json').notNull(),
}, table => [index('idx_parcels_khasra').on(table.khasra), index('idx_parcels_location').on(table.district, table.village)])

export const notifications = sqliteTable('notifications', {
  id: integer('id').primaryKey({ autoIncrement: true }), title: text('title').notNull(), message: text('message').notNull(),
  level: text('level').notNull(), createdAt: text('created_at').notNull(),
})

export const notificationReceipts = sqliteTable('notification_receipts', {
  id: integer('id').primaryKey({ autoIncrement: true }), notificationId: integer('notification_id').notNull(), username: text('username').notNull(),
  readAt: text('read_at').notNull(),
}, table => [uniqueIndex('idx_notification_receipt').on(table.notificationId, table.username)])

export const revisions = sqliteTable('revisions', {
  id: integer('id').primaryKey({ autoIncrement: true }), documentId: text('document_id').notNull(), version: integer('version').notNull(),
  actor: text('actor').notNull(), action: text('action').notNull(), snapshotJson: text('snapshot_json').notNull(), createdAt: text('created_at').notNull(),
}, table => [index('idx_revisions_document').on(table.documentId, table.version)])

export const corrections = sqliteTable('corrections', {
  id: integer('id').primaryKey({ autoIncrement: true }), documentId: text('document_id').notNull(), fieldLabel: text('field_label').notNull(),
  predictedValue: text('predicted_value').notNull(), correctedValue: text('corrected_value').notNull(), sourceExcerpt: text('source_excerpt').notNull(),
  language: text('language').notNull(), actor: text('actor').notNull(), createdAt: text('created_at').notNull(),
}, table => [index('idx_corrections_field').on(table.fieldLabel), index('idx_corrections_created_at').on(table.createdAt)])

export const processingJobs = sqliteTable('processing_jobs', {
  documentId: text('document_id').primaryKey(), status: text('status').notNull().default('Queued'),
  stage: text('stage').notNull().default('Awaiting OCR'), progress: integer('progress').notNull().default(0),
  attempts: integer('attempts').notNull().default(0), error: text('error').notNull().default(''),
  engine: text('engine').notNull().default(''), startedAt: text('started_at'), updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
}, table => [index('idx_processing_jobs_status').on(table.status, table.updatedAt)])

export const ocrResults = sqliteTable('ocr_results', {
  documentId: text('document_id').primaryKey(), textContent: text('text_content').notNull().default(''),
  language: text('language').notNull().default('Unknown'), engine: text('engine').notNull().default(''),
  pageCount: integer('page_count').notNull().default(1), warningsJson: text('warnings_json').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
})

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(), username: text('username').notNull(), expiresAt: text('expires_at').notNull(),
  revokedAt: text('revoked_at'), createdAt: text('created_at').notNull(), lastSeenAt: text('last_seen_at').notNull(),
}, table => [index('idx_sessions_user').on(table.username, table.expiresAt)])

export const rateLimits = sqliteTable('rate_limits', {
  keyHash: text('key_hash').notNull(), bucket: integer('bucket').notNull(), count: integer('count').notNull().default(1),
  updatedAt: text('updated_at').notNull(),
}, table => [uniqueIndex('idx_rate_limit_key_bucket').on(table.keyHash, table.bucket)])

export const oidcStates = sqliteTable('oidc_states', {
  state: text('state').primaryKey(), nonce: text('nonce').notNull(), verifier: text('verifier').notNull(),
  redirectUri: text('redirect_uri').notNull(), expiresAt: text('expires_at').notNull(), createdAt: text('created_at').notNull(),
})

export const loginCodes = sqliteTable('login_codes', {
  id: text('id').primaryKey(), username: text('username').notNull(), expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'), createdAt: text('created_at').notNull(),
})

export const integrationRuns = sqliteTable('integration_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }), integrationKey: text('integration_key').notNull(),
  operation: text('operation').notNull(), documentId: text('document_id'), status: text('status').notNull(),
  responseCode: integer('response_code'), message: text('message').notNull().default(''), actor: text('actor').notNull(),
  createdAt: text('created_at').notNull(),
}, table => [index('idx_integration_runs').on(table.integrationKey, table.createdAt)])

export const citizenRequests = sqliteTable('citizen_requests', {
  id: text('id').primaryKey(), trackingHash: text('tracking_hash').notNull(), requestType: text('request_type').notNull(),
  recordId: text('record_id'), applicantName: text('applicant_name').notNull(), contactCipher: text('contact_cipher').notNull(),
  detailsCipher: text('details_cipher').notNull(), status: text('status').notNull().default('Submitted'),
  assignedTo: text('assigned_to'), resolution: text('resolution').notNull().default(''), createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => [index('idx_citizen_requests_status').on(table.status, table.updatedAt)])

export const learningDictionary = sqliteTable('learning_dictionary', {
  id: integer('id').primaryKey({ autoIncrement: true }), fieldLabel: text('field_label').notNull(),
  language: text('language').notNull(), predictedValue: text('predicted_value').notNull(), correctedValue: text('corrected_value').notNull(),
  occurrences: integer('occurrences').notNull().default(1), updatedAt: text('updated_at').notNull(),
}, table => [uniqueIndex('idx_learning_pattern').on(table.fieldLabel, table.language, table.predictedValue, table.correctedValue)])
