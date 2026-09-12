import { env } from 'cloudflare:workers'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { fieldLabels, fields as makeFields, seedDocuments, seedParcels, type Field } from './data'

type Role = 'Administrator' | 'Verification Officer' | 'Data Operator' | 'Auditor' | 'Viewer'
type User = { id: number; username: string; display_name: string; password_hash: string; role: Role; active: number; created_at: string }
type DocumentRow = {
  id: string; owner: string; document: string; filename: string; location: string; district: string; survey: string
  type: string; language: string; confidence: number; status: string; file_key: string | null; mime_type: string
  checksum_sha256: string; ocr_engine: string; fields_json: string; validation_issues: string; version: number
  created_at: string; updated_at: string
}
type ValidationIssue = { code: string; field: string; severity: 'error' | 'warning'; message: string }

const encoder = new TextEncoder()
const allowedRoles: Role[] = ['Administrator', 'Verification Officer', 'Data Operator', 'Auditor', 'Viewer']
const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, owner TEXT NOT NULL DEFAULT 'Not detected', document TEXT NOT NULL, filename TEXT NOT NULL, location TEXT NOT NULL, district TEXT NOT NULL, survey TEXT NOT NULL DEFAULT '—', type TEXT NOT NULL, language TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0, status TEXT NOT NULL, file_key TEXT, mime_type TEXT NOT NULL DEFAULT 'application/octet-stream', checksum_sha256 TEXT NOT NULL DEFAULT '', ocr_engine TEXT NOT NULL DEFAULT 'Hosted prototype intake', fields_json TEXT NOT NULL DEFAULT '[]', validation_issues TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_district ON documents(district)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents(created_at)`,
  `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)`,
  `CREATE TABLE IF NOT EXISTS audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, document_id TEXT, details TEXT NOT NULL DEFAULT '', previous_hash TEXT NOT NULL DEFAULT '', event_hash TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_events(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_document_id ON audit_events(document_id)`,
  `CREATE TABLE IF NOT EXISTS parcels (id INTEGER PRIMARY KEY AUTOINCREMENT, khasra TEXT NOT NULL, owner TEXT NOT NULL, area REAL NOT NULL, classification TEXT NOT NULL, status TEXT NOT NULL, village TEXT NOT NULL, tehsil TEXT NOT NULL, district TEXT NOT NULL, record_id TEXT, geometry_json TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_parcels_khasra ON parcels(khasra)`,
  `CREATE INDEX IF NOT EXISTS idx_parcels_location ON parcels(district, village)`,
  `CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, message TEXT NOT NULL, level TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS notification_receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, notification_id INTEGER NOT NULL, username TEXT NOT NULL, read_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_receipt ON notification_receipts(notification_id, username)`,
  `CREATE TABLE IF NOT EXISTS revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, version INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_revisions_document ON revisions(document_id, version)`,
  `CREATE TABLE IF NOT EXISTS corrections (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, field_label TEXT NOT NULL, predicted_value TEXT NOT NULL, corrected_value TEXT NOT NULL, source_excerpt TEXT NOT NULL, language TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_corrections_field ON corrections(field_label)`,
  `CREATE INDEX IF NOT EXISTS idx_corrections_created_at ON corrections(created_at)`,
  `CREATE TABLE IF NOT EXISTS processing_jobs (document_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'Queued', stage TEXT NOT NULL DEFAULT 'Awaiting OCR', progress INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', engine TEXT NOT NULL DEFAULT '', started_at TEXT, updated_at TEXT NOT NULL, completed_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_processing_jobs_status ON processing_jobs(status, updated_at)`,
  `CREATE TABLE IF NOT EXISTS ocr_results (document_id TEXT PRIMARY KEY, text_content TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT 'Unknown', engine TEXT NOT NULL DEFAULT '', page_count INTEGER NOT NULL DEFAULT 1, warnings_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(username, expires_at)`,
  `CREATE TABLE IF NOT EXISTS rate_limits (key_hash TEXT NOT NULL, bucket INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, PRIMARY KEY (key_hash, bucket))`,
  `CREATE TABLE IF NOT EXISTS oidc_states (state TEXT PRIMARY KEY, nonce TEXT NOT NULL, verifier TEXT NOT NULL, redirect_uri TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS login_codes (id TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS integration_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, integration_key TEXT NOT NULL, operation TEXT NOT NULL, document_id TEXT, status TEXT NOT NULL, response_code INTEGER, message TEXT NOT NULL DEFAULT '', actor TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_integration_runs ON integration_runs(integration_key, created_at)`,
  `CREATE TABLE IF NOT EXISTS citizen_requests (id TEXT PRIMARY KEY, tracking_hash TEXT NOT NULL, request_type TEXT NOT NULL, record_id TEXT, applicant_name TEXT NOT NULL, contact_cipher TEXT NOT NULL, details_cipher TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Submitted', assigned_to TEXT, resolution TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_citizen_requests_status ON citizen_requests(status, updated_at)`,
  `CREATE TABLE IF NOT EXISTS learning_dictionary (id INTEGER PRIMARY KEY AUTOINCREMENT, field_label TEXT NOT NULL, language TEXT NOT NULL, predicted_value TEXT NOT NULL, corrected_value TEXT NOT NULL, occurrences INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_pattern ON learning_dictionary(field_label, language, predicted_value, corrected_value)`,
]

class ApiError extends Error {
  constructor(public status: number, public detail: unknown) { super(typeof detail === 'string' ? detail : 'API error') }
}

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders } })
}

function isoNow(): string { return new Date().toISOString() }

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T } catch { return fallback }
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(value => value.toString(16).padStart(2, '0')).join('')
}

async function sha256(value: string | ArrayBuffer): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value))
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)))
}

function tokenSecret(): string { return env.SITE_AUTH_SECRET || 'dhara-hosted-prototype-secret-2026' }
function auditSecret(): string { return env.AUDIT_SIGNING_KEY || tokenSecret() }

function toBase64Url(value: string): string {
  const bytes = encoder.encode(value)
  let binary = ''
  bytes.forEach(byte => { binary += String.fromCharCode(byte) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  bytes.forEach(byte => { binary += String.fromCharCode(byte) })
  return btoa(binary)
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomUrlToken(size = 32): string { return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(size))) }

async function pkceChallenge(verifier: string): Promise<string> {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))))
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function base64UrlToBytes(value: string): Uint8Array {
  return base64ToBytes(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4))
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index]
  return difference === 0
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer { return Uint8Array.from(bytes).buffer }

async function hashPassword(password: string): Promise<string> {
  // The Sites Web Crypto runtime caps PBKDF2 at 100,000 iterations.
  const iterations = 100_000
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const digest = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256))
  return `pbkdf2_sha256$${iterations}$${bytesToBase64(salt)}$${bytesToBase64(digest)}`
}

async function verifyPassword(password: string, encoded: string): Promise<{ valid: boolean; legacy: boolean }> {
  if (!encoded.startsWith('pbkdf2_sha256$')) return { valid: encoded === await hmac(tokenSecret(), password), legacy: true }
  try {
    const [, iterationsText, saltText, digestText] = encoded.split('$')
    const salt = base64ToBytes(saltText)
    const expected = base64ToBytes(digestText)
    const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
    const actual = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: exactBuffer(salt), iterations: Number(iterationsText) }, key, expected.length * 8))
    return { valid: equalBytes(actual, expected), legacy: false }
  } catch { return { valid: false, legacy: false } }
}

async function encryptSensitive(value: string): Promise<string> {
  const keyMaterial = await crypto.subtle.digest('SHA-256', encoder.encode(`${tokenSecret()}|citizen-data`))
  const key = await crypto.subtle.importKey('raw', keyMaterial, 'AES-GCM', false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(value)))
  return `${bytesToBase64Url(iv)}.${bytesToBase64Url(ciphertext)}`
}

async function decryptSensitive(value: string): Promise<string> {
  const [ivText, ciphertextText] = value.split('.')
  if (!ivText || !ciphertextText) return ''
  const keyMaterial = await crypto.subtle.digest('SHA-256', encoder.encode(`${tokenSecret()}|citizen-data`))
  const key = await crypto.subtle.importKey('raw', keyMaterial, 'AES-GCM', false, ['decrypt'])
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: exactBuffer(base64UrlToBytes(ivText)) }, key, exactBuffer(base64UrlToBytes(ciphertextText)))
    return new TextDecoder().decode(plaintext)
  } catch { return '[Protected data unavailable]' }
}

const protectedFileHeader = encoder.encode('DHARA2')

async function protectedFileKey(): Promise<CryptoKey> {
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(env.DOCUMENT_ENCRYPTION_KEY || `${tokenSecret()}|document-files`))
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

async function encryptProtectedFile(value: ArrayBuffer | string): Promise<Uint8Array> {
  const plaintext = typeof value === 'string' ? encoder.encode(value) : new Uint8Array(value)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await protectedFileKey(), exactBuffer(plaintext)))
  const result = new Uint8Array(protectedFileHeader.length + iv.length + ciphertext.length)
  result.set(protectedFileHeader, 0)
  result.set(iv, protectedFileHeader.length)
  result.set(ciphertext, protectedFileHeader.length + iv.length)
  return result
}

async function decryptProtectedFile(value: ArrayBuffer): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(value)
  const encrypted = protectedFileHeader.every((byte, index) => bytes[index] === byte)
  if (!encrypted) return value
  const iv = bytes.slice(protectedFileHeader.length, protectedFileHeader.length + 12)
  const ciphertext = bytes.slice(protectedFileHeader.length + 12)
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: exactBuffer(iv) }, await protectedFileKey(), exactBuffer(ciphertext))
}

function fromBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)))
}

type TokenPayload = { sub: string; exp: number; jti: string }

async function createToken(username: string): Promise<string> {
  const sessionId = crypto.randomUUID()
  const expires = Date.now() + 8 * 60 * 60 * 1000
  const now = isoNow()
  await env.DB.prepare('INSERT INTO sessions (id, username, expires_at, revoked_at, created_at, last_seen_at) VALUES (?, ?, ?, NULL, ?, ?)').bind(sessionId, username, new Date(expires).toISOString(), now, now).run()
  const body = toBase64Url(JSON.stringify({ sub: username, exp: expires, jti: sessionId }))
  return `${body}.${await hmac(tokenSecret(), body)}`
}

async function tokenPayload(request: Request): Promise<TokenPayload> {
  const authorization = request.headers.get('Authorization') || ''
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  const [body, signature] = token.split('.')
  if (!body || !signature || await hmac(tokenSecret(), body) !== signature) throw new ApiError(401, 'Your session is missing or has expired.')
  let payload: Partial<TokenPayload>
  try { payload = JSON.parse(fromBase64Url(body)) } catch { throw new ApiError(401, 'Invalid session token.') }
  if (!payload.sub || !payload.exp || !payload.jti || payload.exp < Date.now()) throw new ApiError(401, 'Your session has expired.')
  return payload as TokenPayload
}

async function actorFromRequest(request: Request): Promise<User> {
  const payload = await tokenPayload(request)
  const session = await env.DB.prepare('SELECT revoked_at, expires_at FROM sessions WHERE id = ? AND username = ?').bind(payload.jti, payload.sub).first<{ revoked_at: string | null; expires_at: string }>()
  if (!session || session.revoked_at || new Date(session.expires_at).getTime() < Date.now()) throw new ApiError(401, 'Your session is no longer active.')
  const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(payload.sub).first<User>()
  if (!user || !user.active) throw new ApiError(401, 'This account is inactive or unavailable.')
  await env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').bind(isoNow(), payload.jti).run()
  return user
}

async function enforceRateLimit(request: Request): Promise<void> {
  const url = new URL(request.url)
  const category = url.pathname === '/api/auth/login' ? 'login' : url.pathname.startsWith('/api/citizen/') ? 'citizen' : 'api'
  const limit = category === 'login' ? 12 : category === 'citizen' ? 30 : 300
  const source = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0] || 'unknown'
  const keyHash = await sha256(`${tokenSecret()}|${source}|${category}`)
  const bucket = Math.floor(Date.now() / 60_000)
  const updated = isoNow()
  await env.DB.prepare(`INSERT INTO rate_limits (key_hash, bucket, count, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(key_hash, bucket) DO UPDATE SET count = rate_limits.count + 1, updated_at = excluded.updated_at`).bind(keyHash, bucket, updated).run()
  const row = await env.DB.prepare('SELECT count FROM rate_limits WHERE key_hash = ? AND bucket = ?').bind(keyHash, bucket).first<{ count: number }>()
  if ((row?.count || 0) > limit) throw new ApiError(429, 'Too many requests. Try again shortly.')
  if (Math.random() < .01) await env.DB.prepare('DELETE FROM rate_limits WHERE bucket < ?').bind(bucket - 120).run()
}

type OidcDiscovery = { authorization_endpoint: string; token_endpoint: string; jwks_uri: string; issuer: string }

async function oidcDiscovery(): Promise<OidcDiscovery> {
  if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID) throw new ApiError(503, 'Government SSO is not configured yet.')
  const endpoint = `${env.OIDC_ISSUER.replace(/\/$/, '')}/.well-known/openid-configuration`
  const response = await fetch(endpoint, { headers: { Accept: 'application/json' }, cf: { cacheTtl: 300, cacheEverything: true } })
  if (!response.ok) throw new ApiError(502, 'The configured identity provider is unavailable.')
  const discovery = await response.json() as Partial<OidcDiscovery>
  if (!discovery.authorization_endpoint || !discovery.token_endpoint || !discovery.jwks_uri || !discovery.issuer) throw new ApiError(502, 'The identity provider configuration is incomplete.')
  return discovery as OidcDiscovery
}

function requireRole(user: User, roles: Role[]): void {
  if (!roles.includes(user.role)) throw new ApiError(403, `This action requires one of these roles: ${roles.join(', ')}.`)
}

async function bodyJson<T>(request: Request): Promise<T> {
  try { return await request.json() as T } catch { throw new ApiError(400, 'The request body must contain valid JSON.') }
}

function publicUser(user: User) {
  return { id: user.id, username: user.username, display_name: user.display_name, role: user.role, active: Boolean(user.active), created_at: user.created_at }
}

function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000))
  if (seconds < 60) return seconds < 10 ? 'Just now' : `${seconds} sec ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  return `${Math.floor(hours / 24)} day${hours < 48 ? '' : 's'} ago`
}

function documentResponse(row: DocumentRow) {
  return {
    id: row.id, owner: row.owner, document: row.document, filename: row.filename, location: row.location,
    district: row.district, survey: row.survey, type: row.type, language: row.language, confidence: row.confidence,
    status: row.status, updated: relativeTime(row.updated_at), created_at: row.created_at,
    file_url: row.file_key ? `/api/documents/${encodeURIComponent(row.id)}/file` : null,
    ocr_engine: row.ocr_engine, fields: parseJson<Field[]>(row.fields_json, []),
    validation_issues: parseJson<ValidationIssue[]>(row.validation_issues, []), version: row.version,
  }
}

function snapshot(row: DocumentRow) {
  const fieldMap = Object.fromEntries(parseJson<Field[]>(row.fields_json, []).map(field => [field.label, field.value]))
  return { status: row.status, confidence: row.confidence, fields: fieldMap }
}

async function appendAudit(eventType: string, actor: string, action: string, documentId: string | null, details = ''): Promise<void> {
  const previous = await env.DB.prepare('SELECT event_hash FROM audit_events ORDER BY id DESC LIMIT 1').first<{ event_hash: string }>()
  const createdAt = isoNow()
  const previousHash = previous?.event_hash || ''
  const eventHash = await hmac(auditSecret(), [eventType, actor, action, documentId || '', details, previousHash, createdAt].join('|'))
  await env.DB.prepare('INSERT INTO audit_events (event_type, actor, action, document_id, details, previous_hash, event_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(eventType, actor, action, documentId, details, previousHash, eventHash, createdAt).run()
}

async function addRevision(row: DocumentRow, actor: string, action: string): Promise<void> {
  await env.DB.prepare('INSERT INTO revisions (document_id, version, actor, action, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(row.id, row.version, actor, action, JSON.stringify(snapshot(row)), isoNow()).run()
}

async function getDocument(id: string): Promise<DocumentRow> {
  const row = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first<DocumentRow>()
  if (!row) throw new ApiError(404, `Land record ${id} was not found.`)
  return row
}

type IntegrationKey = 'lrms' | 'dilrmp' | 'registration' | 'gis' | 'notifications'
type IntegrationConfig = { key: IntegrationKey; name: string; baseUrl: string; token: string; variable: string }

function integrationConfig(key: IntegrationKey): IntegrationConfig {
  const configs: Record<IntegrationKey, IntegrationConfig> = {
    lrms: { key, name: 'Land Records Management System', baseUrl: env.LRMS_BASE_URL || '', token: env.LRMS_API_TOKEN || '', variable: 'LRMS_BASE_URL' },
    dilrmp: { key, name: 'DILRMP', baseUrl: env.DILRMP_BASE_URL || '', token: env.DILRMP_API_TOKEN || '', variable: 'DILRMP_BASE_URL' },
    registration: { key, name: 'Registration database', baseUrl: env.REGISTRATION_API_URL || '', token: env.REGISTRATION_API_TOKEN || '', variable: 'REGISTRATION_API_URL' },
    gis: { key, name: 'GIS / GeoServer', baseUrl: env.GEOSERVER_URL || '', token: env.GEOSERVER_API_TOKEN || '', variable: 'GEOSERVER_URL' },
    notifications: { key, name: 'SMS / email notification gateway', baseUrl: env.NOTIFICATION_GATEWAY_URL || '', token: env.NOTIFICATION_GATEWAY_TOKEN || '', variable: 'NOTIFICATION_GATEWAY_URL' },
  }
  return configs[key]
}

function integrationUrl(config: IntegrationConfig, path: string): string {
  if (!config.baseUrl) throw new ApiError(409, `${config.name} is not configured.`)
  const base = new URL(config.baseUrl)
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) throw new ApiError(422, `${config.name} must use HTTPS.`)
  return new URL(path.replace(/^\//, ''), `${base.toString().replace(/\/$/, '')}/`).toString()
}

async function integrationFetch(config: IntegrationConfig, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (init.body) headers.set('Content-Type', 'application/json')
  if (config.token) headers.set('Authorization', `Bearer ${config.token}`)
  return fetch(integrationUrl(config, path), { ...init, headers, signal: AbortSignal.timeout(10_000) })
}

function canonicalRecord(row: DocumentRow) {
  const values = Object.fromEntries(parseJson<Field[]>(row.fields_json, []).map(field => [field.label, field.value || null]))
  return {
    schema: 'in.gov.dhara.land-record.v1', record_id: row.id, status: row.status,
    source: { filename: row.filename, checksum_sha256: row.checksum_sha256, language: row.language },
    administrative_area: { district: values.District || row.district, tehsil: values.Tehsil, village: values.Village },
    parcel: { survey_number: values['Survey number'], khasra_number: values['Khasra number'], khata_number: values['Khata number'], plot_area: values['Plot area'], classification: values['Land classification'] },
    ownership: { landowner_name: values['Landowner name'], details: values['Ownership details'], mutation_reference: values['Mutation reference'], registration_information: values['Registration information'] },
    confidence: row.confidence, version: row.version, updated_at: row.updated_at,
  }
}

async function logIntegration(config: IntegrationConfig, operation: string, row: DocumentRow | null, status: string, code: number | null, message: string, actor: string): Promise<void> {
  await env.DB.prepare('INSERT INTO integration_runs (integration_key, operation, document_id, status, response_code, message, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(config.key, operation, row?.id || null, status, code, message.slice(0, 500), actor, isoNow()).run()
}

async function externalValidation(row: DocumentRow, actor: string): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = []
  for (const key of ['lrms', 'dilrmp', 'registration'] as IntegrationKey[]) {
    const config = integrationConfig(key)
    if (!config.baseUrl) continue
    try {
      const response = await integrationFetch(config, 'validate', { method: 'POST', body: JSON.stringify(canonicalRecord(row)), headers: { 'Idempotency-Key': `${row.id}-v${row.version}-validate` } })
      const payload = await response.json().catch(() => ({})) as { valid?: boolean; issues?: ValidationIssue[]; message?: string }
      await logIntegration(config, 'validate', row, response.ok ? 'Succeeded' : 'Failed', response.status, payload.message || response.statusText, actor)
      if (Array.isArray(payload.issues)) issues.push(...payload.issues.filter(issue => issue && issue.field && issue.message).map((issue): ValidationIssue => ({ code: `${key.toUpperCase()}_${String(issue.code || 'CHECK')}`, field: String(issue.field), severity: issue.severity === 'error' ? 'error' : 'warning', message: String(issue.message).slice(0, 300) })))
      else if (!response.ok) issues.push({ code: `${key.toUpperCase()}_UNAVAILABLE`, field: 'External validation', severity: 'warning', message: `${config.name} could not complete its verification check.` })
    } catch (error) {
      await logIntegration(config, 'validate', row, 'Failed', null, error instanceof Error ? error.message : 'Connection failed', actor)
      issues.push({ code: `${key.toUpperCase()}_UNAVAILABLE`, field: 'External validation', severity: 'warning', message: `${config.name} is temporarily unavailable; internal validation completed.` })
    }
  }
  return issues
}

async function dispatchNotification(title: string, message: string, level: string, documentId: string | null): Promise<void> {
  const config = integrationConfig('notifications')
  if (!config.baseUrl) return
  try {
    const response = await integrationFetch(config, 'notifications', { method: 'POST', body: JSON.stringify({ title, message, level, document_id: documentId, channels: ['email', 'sms', 'push'] }) })
    await logIntegration(config, 'notify', documentId ? await getDocument(documentId) : null, response.ok ? 'Succeeded' : 'Failed', response.status, response.statusText, 'System')
  } catch (error) {
    await logIntegration(config, 'notify', documentId ? await getDocument(documentId) : null, 'Failed', null, error instanceof Error ? error.message : 'Connection failed', 'System')
  }
}

async function createDatabaseBackup(reason: string, actor: string): Promise<{ key: string; size: number; checksum: string }> {
  const tableNames = ['documents', 'users', 'audit_events', 'parcels', 'notifications', 'notification_receipts', 'revisions', 'corrections', 'processing_jobs', 'ocr_results', 'integration_runs', 'citizen_requests', 'learning_dictionary']
  const data: Record<string, unknown[]> = {}
  for (const table of tableNames) data[table] = (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results
  const createdAt = isoNow()
  const payload = JSON.stringify({ format: 'dhara-d1-backup-v1', created_at: createdAt, reason, actor, tables: data })
  const checksum = await sha256(payload)
  const key = `backups/${createdAt.replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.json`
  await env.FILES.put(key, await encryptProtectedFile(payload), { httpMetadata: { contentType: 'application/octet-stream' }, customMetadata: { checksumSha256: checksum, reason, actor, encryption: 'AES-256-GCM', contentType: 'application/json' } })
  return { key, size: encoder.encode(payload).byteLength, checksum }
}

async function scheduledMaintenance(): Promise<void> {
  await ensureDatabase()
  const backup = await createDatabaseBackup('scheduled-daily', 'System scheduler')
  const now = isoNow()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL').bind(now),
    env.DB.prepare('DELETE FROM oidc_states WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM login_codes WHERE expires_at < ? OR used_at IS NOT NULL').bind(now),
    env.DB.prepare('DELETE FROM rate_limits WHERE bucket < ?').bind(Math.floor(Date.now() / 60_000) - 120),
  ])
  const listed = await env.FILES.list({ prefix: 'backups/', limit: 1000 })
  const expired = listed.objects.sort((left, right) => right.uploaded.getTime() - left.uploaded.getTime()).slice(30)
  if (expired.length) await env.FILES.delete(expired.map(object => object.key))
  await appendAudit('BACKUP', 'System scheduler', 'Created protected database backup', null, `${backup.key}; ${backup.size} bytes; SHA-256 ${backup.checksum}`)
}

async function validateDocument(row: DocumentRow): Promise<ValidationIssue[]> {
  const values = Object.fromEntries(parseJson<Field[]>(row.fields_json, []).map(field => [field.label, field.value.trim()]))
  const issues: ValidationIssue[] = []
  for (const label of ['Landowner name', 'Khasra number', 'Village', 'District']) {
    if (!values[label]) issues.push({ code: 'REQUIRED_FIELD', field: label, severity: 'error', message: `${label} is required before approval.` })
  }
  if (values['Plot area'] && !/\d/.test(values['Plot area'])) {
    issues.push({ code: 'INVALID_AREA', field: 'Plot area', severity: 'warning', message: 'Plot area should include a numeric measurement.' })
  }
  if (values['Khasra number'] && values['District']) {
    const duplicate = await env.DB.prepare(`SELECT id FROM documents WHERE id <> ? AND district = ? AND (survey = ? OR fields_json LIKE ?) LIMIT 1`)
      .bind(row.id, values['District'], values['Khasra number'], `%"value":"${values['Khasra number'].replace(/[%_]/g, '')}"%`).first<{ id: string }>()
    if (duplicate) issues.push({ code: 'POSSIBLE_DUPLICATE', field: 'Khasra number', severity: 'warning', message: `A possible duplicate exists in ${duplicate.id}.` })
  }
  return issues
}

let databaseReady: Promise<void> | null = null

async function initializeDatabase(): Promise<void> {
  await env.DB.batch(schemaStatements.map(statement => env.DB.prepare(statement)))
  const userCount = await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{ count: number }>()
  if (!userCount?.count) {
    const created = isoNow()
    const demoUsers: Array<[string, string, Role]> = [
      ['admin@dhara.gov.in', 'Aditi Rao', 'Administrator'],
      ['verifier@dhara.gov.in', 'Priya Sharma', 'Verification Officer'],
      ['operator@dhara.gov.in', 'Meera Singh', 'Data Operator'],
      ['auditor@dhara.gov.in', 'Arun Verma', 'Auditor'],
      ['viewer@dhara.gov.in', 'District Viewer', 'Viewer'],
    ]
    const passwordHash = await hashPassword('Dhara@2026')
    await env.DB.batch(demoUsers.map(([username, name, role]) => env.DB.prepare('INSERT INTO users (username, display_name, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, 1, ?)').bind(username, name, passwordHash, role, created)))
  }

  const documentCount = await env.DB.prepare('SELECT COUNT(*) AS count FROM documents').first<{ count: number }>()
  if (!documentCount?.count) {
    const now = Date.now()
    await env.DB.batch(seedDocuments.map((record, index) => {
      const created = new Date(now - index * 8 * 60_000).toISOString()
      return env.DB.prepare(`INSERT INTO documents (id, owner, document, filename, location, district, survey, type, language, confidence, status, file_key, mime_type, checksum_sha256, ocr_engine, fields_json, validation_issues, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'application/pdf', '', 'Seeded multilingual demo', ?, '[]', 1, ?, ?)`)
        .bind(record.id, record.owner, record.document, record.filename, record.location, record.district, record.survey, record.type, record.language, record.confidence, record.status, JSON.stringify(record.fields), created, created)
    }))
    const rows = await env.DB.prepare('SELECT * FROM documents').all<DocumentRow>()
    await env.DB.batch(rows.results.map(row => env.DB.prepare('INSERT INTO revisions (document_id, version, actor, action, snapshot_json, created_at) VALUES (?, 1, ?, ?, ?, ?)')
      .bind(row.id, 'AI pipeline', 'Imported prototype record', JSON.stringify(snapshot(row)), row.created_at)))
  }

  const parcelCount = await env.DB.prepare('SELECT COUNT(*) AS count FROM parcels').first<{ count: number }>()
  if (!parcelCount?.count) {
    await env.DB.batch(seedParcels.map(parcel => env.DB.prepare('INSERT INTO parcels (khasra, owner, area, classification, status, village, tehsil, district, record_id, geometry_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(parcel[0], parcel[1], parcel[2], parcel[3], parcel[4], 'Baragaon', 'Pindra', 'Varanasi', parcel[5], JSON.stringify(parcel[6]))))
  }

  const notificationCount = await env.DB.prepare('SELECT COUNT(*) AS count FROM notifications').first<{ count: number }>()
  if (!notificationCount?.count) {
    const created = isoNow()
    await env.DB.batch([
      env.DB.prepare('INSERT INTO notifications (title, message, level, created_at) VALUES (?, ?, ?, ?)').bind('Verification queue ready', 'Two historical records are ready for assisted verification.', 'info', created),
      env.DB.prepare('INSERT INTO notifications (title, message, level, created_at) VALUES (?, ?, ?, ?)').bind('Hosted prototype online', 'Secure D1 storage, R2 uploads and audit tracking are active.', 'success', created),
    ])
  }

  const auditCount = await env.DB.prepare('SELECT COUNT(*) AS count FROM audit_events').first<{ count: number }>()
  if (!auditCount?.count) await appendAudit('SYSTEM', 'System', 'Initialized hosted DHARA prototype', null, 'D1 and R2 services ready')
}

async function ensureDatabase(): Promise<void> {
  databaseReady ||= initializeDatabase().catch(error => { databaseReady = null; throw error })
  await databaseReady
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function csvResponse(filename: string, rows: unknown[][]): Response {
  return new Response(rows.map(row => row.map(csvCell).join(',')).join('\n'), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` } })
}

function safeFilename(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'document' }

function allowedFile(file: File, bytes: ArrayBuffer): boolean {
  const header = new Uint8Array(bytes.slice(0, 8))
  const pdf = header[0] === 0x25 && header[1] === 0x50 && header[2] === 0x44 && header[3] === 0x46
  const png = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47
  const jpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
  const tiff = (header[0] === 0x49 && header[1] === 0x49 && header[2] === 0x2a) || (header[0] === 0x4d && header[1] === 0x4d && header[3] === 0x2a)
  return bytes.byteLength > 0 && bytes.byteLength <= 50 * 1024 * 1024 && (pdf || png || jpeg || tiff) && /^(application\/pdf|image\/(png|jpeg|tiff?))$/i.test(file.type)
}

async function scanUploadedFile(file: File, bytes: ArrayBuffer): Promise<string> {
  if (!env.MALWARE_SCAN_URL) return 'scanner-not-configured'
  const endpoint = new URL(env.MALWARE_SCAN_URL)
  if (endpoint.protocol !== 'https:') throw new ApiError(422, 'The malware scanning service must use HTTPS.')
  const headers = new Headers({ 'Content-Type': file.type, 'X-File-Name': safeFilename(file.name) })
  if (env.MALWARE_SCAN_TOKEN) headers.set('Authorization', `Bearer ${env.MALWARE_SCAN_TOKEN}`)
  const response = await fetch(endpoint, { method: 'POST', headers, body: bytes, signal: AbortSignal.timeout(30_000) })
  const result = await response.json().catch(() => ({})) as { clean?: boolean; threat?: string }
  if (!response.ok || result.clean !== true) throw new ApiError(422, result.threat ? `The malware scanner rejected this file: ${String(result.threat).slice(0, 120)}` : 'The malware scanner could not approve this file.')
  return 'clean'
}

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const path = decodeURIComponent(url.pathname)

  if (path === '/api/health' && request.method === 'GET') return json({ status: 'ok', database: 'D1', file_storage: 'R2', mode: 'hosted-prototype' })

  if (path === '/api/auth/login' && request.method === 'POST') {
    const input = await bodyJson<{ username?: string; password?: string }>(request)
    const username = String(input.username || '').trim().toLowerCase()
    const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first<User>()
    const passwordCheck = user ? await verifyPassword(String(input.password || ''), user.password_hash) : { valid: false, legacy: false }
    if (!user || !user.active || !passwordCheck.valid) throw new ApiError(401, 'Incorrect email or password.')
    if (passwordCheck.legacy) await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(String(input.password)), user.id).run()
    await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL').bind(isoNow()).run()
    await appendAudit('AUTH', user.display_name, 'Signed in', null, user.role)
    return json({ access_token: await createToken(user.username), user: publicUser(user) })
  }

  if (path === '/api/auth/oidc/status' && request.method === 'GET') {
    return json({ configured: Boolean(env.OIDC_ISSUER && env.OIDC_CLIENT_ID), provider: env.OIDC_ISSUER ? new URL(env.OIDC_ISSUER).hostname : null })
  }

  if (path === '/api/auth/oidc/start' && request.method === 'POST') {
    const discovery = await oidcDiscovery()
    const state = randomUrlToken()
    const nonce = randomUrlToken()
    const verifier = randomUrlToken(48)
    const redirectUri = env.OIDC_REDIRECT_URI || `${url.origin}/api/auth/oidc/callback`
    const created = isoNow()
    const expires = new Date(Date.now() + 10 * 60_000).toISOString()
    await env.DB.prepare('INSERT INTO oidc_states (state, nonce, verifier, redirect_uri, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(state, nonce, verifier, redirectUri, expires, created).run()
    const authorizationUrl = new URL(discovery.authorization_endpoint)
    authorizationUrl.searchParams.set('client_id', env.OIDC_CLIENT_ID!)
    authorizationUrl.searchParams.set('redirect_uri', redirectUri)
    authorizationUrl.searchParams.set('response_type', 'code')
    authorizationUrl.searchParams.set('scope', 'openid email profile')
    authorizationUrl.searchParams.set('state', state)
    authorizationUrl.searchParams.set('nonce', nonce)
    authorizationUrl.searchParams.set('code_challenge', await pkceChallenge(verifier))
    authorizationUrl.searchParams.set('code_challenge_method', 'S256')
    return json({ authorization_url: authorizationUrl.toString() })
  }

  if (path === '/api/auth/oidc/callback' && request.method === 'GET') {
    const stateValue = url.searchParams.get('state') || ''
    const authorizationCode = url.searchParams.get('code') || ''
    if (!stateValue || !authorizationCode || url.searchParams.has('error')) throw new ApiError(400, 'Government SSO authorization was not completed.')
    const stored = await env.DB.prepare('SELECT * FROM oidc_states WHERE state = ?').bind(stateValue).first<{ state: string; nonce: string; verifier: string; redirect_uri: string; expires_at: string }>()
    if (!stored || new Date(stored.expires_at).getTime() < Date.now()) throw new ApiError(400, 'The SSO request has expired. Start again from the sign-in page.')
    await env.DB.prepare('DELETE FROM oidc_states WHERE state = ?').bind(stateValue).run()
    const discovery = await oidcDiscovery()
    const tokenBody = new URLSearchParams({ grant_type: 'authorization_code', code: authorizationCode, redirect_uri: stored.redirect_uri, client_id: env.OIDC_CLIENT_ID!, code_verifier: stored.verifier })
    if (env.OIDC_CLIENT_SECRET) tokenBody.set('client_secret', env.OIDC_CLIENT_SECRET)
    const tokenResponse = await fetch(discovery.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: tokenBody })
    if (!tokenResponse.ok) throw new ApiError(401, 'The identity provider rejected the authorization code.')
    const tokenSet = await tokenResponse.json() as { id_token?: string }
    if (!tokenSet.id_token) throw new ApiError(401, 'The identity provider did not return an identity token.')
    const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri))
    const verified = await jwtVerify(tokenSet.id_token, jwks, { issuer: discovery.issuer, audience: env.OIDC_CLIENT_ID })
    if (verified.payload.nonce !== stored.nonce) throw new ApiError(401, 'The SSO identity response could not be verified.')
    const username = String(verified.payload.email || verified.payload.preferred_username || verified.payload.upn || '').trim().toLowerCase()
    if (!username) throw new ApiError(403, 'The identity provider did not supply an official account identifier.')
    const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first<User>()
    if (!user || !user.active) throw new ApiError(403, 'This official account has not been authorized in DHARA.')
    const loginCode = randomUrlToken(36)
    const created = isoNow()
    await env.DB.prepare('INSERT INTO login_codes (id, username, expires_at, used_at, created_at) VALUES (?, ?, ?, NULL, ?)').bind(loginCode, username, new Date(Date.now() + 2 * 60_000).toISOString(), created).run()
    return Response.redirect(`${url.origin}/?sso_code=${encodeURIComponent(loginCode)}`, 302)
  }

  if (path === '/api/auth/oidc/complete' && request.method === 'POST') {
    const input = await bodyJson<{ code?: string }>(request)
    const code = String(input.code || '')
    const stored = await env.DB.prepare('SELECT * FROM login_codes WHERE id = ?').bind(code).first<{ id: string; username: string; expires_at: string; used_at: string | null }>()
    if (!stored || stored.used_at || new Date(stored.expires_at).getTime() < Date.now()) throw new ApiError(401, 'The one-time SSO sign-in code is invalid or expired.')
    await env.DB.prepare('UPDATE login_codes SET used_at = ? WHERE id = ?').bind(isoNow(), code).run()
    const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(stored.username).first<User>()
    if (!user || !user.active) throw new ApiError(403, 'This official account is inactive.')
    await appendAudit('AUTH', user.display_name, 'Signed in with government SSO', null, user.role)
    return json({ access_token: await createToken(user.username), user: publicUser(user) })
  }

  if (path === '/api/citizen/requests' && request.method === 'POST') {
    const input = await bodyJson<{ request_type?: string; record_id?: string; applicant_name?: string; contact?: string; details?: string; consent?: boolean }>(request)
    const requestTypes = ['Certified copy', 'Record status', 'Correction request', 'Ownership dispute']
    const requestType = String(input.request_type || '')
    const applicantName = String(input.applicant_name || '').trim().slice(0, 120)
    const contact = String(input.contact || '').trim().slice(0, 160)
    const details = String(input.details || '').trim().slice(0, 2_000)
    const recordId = input.record_id ? String(input.record_id).trim().slice(0, 64) : null
    if (!requestTypes.includes(requestType) || applicantName.length < 2 || contact.length < 5 || !input.consent) throw new ApiError(422, 'Provide the request type, applicant name, contact details and consent.')
    if (recordId) await getDocument(recordId)
    const id = `CR-${new Date().getUTCFullYear()}-${String(Date.now()).slice(-7)}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`
    const trackingToken = randomUrlToken(24)
    const trackingHash = await sha256(`${tokenSecret()}|${trackingToken}`)
    const now = isoNow()
    await env.DB.batch([
      env.DB.prepare('INSERT INTO citizen_requests (id, tracking_hash, request_type, record_id, applicant_name, contact_cipher, details_cipher, status, assigned_to, resolution, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)').bind(id, trackingHash, requestType, recordId, applicantName, await encryptSensitive(contact), await encryptSensitive(details), 'Submitted', '', now, now),
      env.DB.prepare('INSERT INTO notifications (title, message, level, created_at) VALUES (?, ?, ?, ?)').bind('Citizen service request', `${id}: ${requestType}${recordId ? ` for ${recordId}` : ''}`, 'info', now),
    ])
    await appendAudit('CITIZEN_REQUEST', 'Citizen portal', `Submitted ${requestType}`, recordId, id)
    await dispatchNotification('Citizen request received', `${id} has been submitted successfully.`, 'info', recordId)
    return json({ request_id: id, tracking_token: trackingToken, status: 'Submitted', created_at: now }, 201)
  }

  const citizenStatusMatch = path.match(/^\/api\/citizen\/requests\/([^/]+)$/)
  if (citizenStatusMatch && request.method === 'GET') {
    const trackingToken = url.searchParams.get('token') || ''
    const trackingHash = await sha256(`${tokenSecret()}|${trackingToken}`)
    const row = await env.DB.prepare('SELECT id, request_type, record_id, status, resolution, created_at, updated_at FROM citizen_requests WHERE id = ? AND tracking_hash = ?').bind(citizenStatusMatch[1], trackingHash).first()
    if (!row) throw new ApiError(404, 'Request and tracking token did not match.')
    return json(row)
  }

  const actor = await actorFromRequest(request)

  if (path === '/api/auth/me' && request.method === 'GET') return json(publicUser(actor))

  if (path === '/api/auth/logout' && request.method === 'POST') {
    const payload = await tokenPayload(request)
    await env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').bind(isoNow(), payload.jti).run()
    await appendAudit('AUTH', actor.display_name, 'Signed out', null, actor.role)
    return json({ status: 'signed_out' })
  }

  if (path === '/api/citizen/requests' && request.method === 'GET') {
    requireRole(actor, ['Administrator', 'Verification Officer'])
    const result = await env.DB.prepare('SELECT * FROM citizen_requests ORDER BY updated_at DESC LIMIT 200').all<{ id: string; request_type: string; record_id: string | null; applicant_name: string; contact_cipher: string; details_cipher: string; status: string; assigned_to: string | null; resolution: string; created_at: string; updated_at: string }>()
    return json(await Promise.all(result.results.map(async row => ({ ...row, contact: await decryptSensitive(row.contact_cipher), details: await decryptSensitive(row.details_cipher), contact_cipher: undefined, details_cipher: undefined }))))
  }

  const citizenManageMatch = path.match(/^\/api\/citizen\/requests\/([^/]+)$/)
  if (citizenManageMatch && request.method === 'PATCH') {
    requireRole(actor, ['Administrator', 'Verification Officer'])
    const input = await bodyJson<{ status?: string; resolution?: string }>(request)
    const row = await env.DB.prepare('SELECT * FROM citizen_requests WHERE id = ?').bind(citizenManageMatch[1]).first<{ id: string; record_id: string | null; status: string; resolution: string }>()
    if (!row) throw new ApiError(404, 'Citizen request not found.')
    const statuses = ['Submitted', 'Under review', 'Action required', 'Resolved', 'Rejected']
    const status = input.status === undefined ? row.status : String(input.status)
    const resolution = input.resolution === undefined ? row.resolution : String(input.resolution).trim().slice(0, 1_000)
    if (!statuses.includes(status)) throw new ApiError(422, 'Invalid citizen-request status.')
    const now = isoNow()
    await env.DB.prepare('UPDATE citizen_requests SET status = ?, resolution = ?, assigned_to = ?, updated_at = ? WHERE id = ?').bind(status, resolution, actor.username, now, row.id).run()
    await appendAudit('CITIZEN_REQUEST', actor.display_name, `Changed ${row.id} to ${status}`, row.record_id, resolution)
    await dispatchNotification('Citizen request updated', `${row.id} is now ${status}.`, status === 'Resolved' ? 'success' : 'info', row.record_id)
    return json({ id: row.id, status, resolution, updated_at: now })
  }

  if (path === '/api/users' && request.method === 'GET') {
    requireRole(actor, ['Administrator'])
    const result = await env.DB.prepare('SELECT * FROM users ORDER BY created_at, id').all<User>()
    return json(result.results.map(publicUser))
  }

  if (path === '/api/users' && request.method === 'POST') {
    requireRole(actor, ['Administrator'])
    const input = await bodyJson<{ username?: string; display_name?: string; password?: string; role?: Role }>(request)
    const username = String(input.username || '').trim().toLowerCase()
    const displayName = String(input.display_name || '').trim()
    if (!/^\S+@\S+\.\S+$/.test(username) || !displayName || String(input.password || '').length < 8 || !allowedRoles.includes(input.role as Role)) throw new ApiError(422, 'Provide a valid email, display name, role, and password of at least 8 characters.')
    try {
      const result = await env.DB.prepare('INSERT INTO users (username, display_name, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, 1, ?)')
        .bind(username, displayName, await hashPassword(String(input.password)), input.role, isoNow()).run()
      const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(result.meta.last_row_id).first<User>()
      await appendAudit('USER', actor.display_name, `Created ${input.role} account`, null, username)
      return json(publicUser(user!), 201)
    } catch { throw new ApiError(409, 'An account with that email already exists.') }
  }

  const userMatch = path.match(/^\/api\/users\/(\d+)$/)
  if (userMatch && request.method === 'PATCH') {
    requireRole(actor, ['Administrator'])
    const input = await bodyJson<{ role?: Role; active?: boolean }>(request)
    const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(Number(userMatch[1])).first<User>()
    if (!target) throw new ApiError(404, 'User not found.')
    if (input.role !== undefined && !allowedRoles.includes(input.role)) throw new ApiError(422, 'Invalid role.')
    const role = input.role ?? target.role
    const active = input.active === undefined ? target.active : Number(input.active)
    if (target.id === actor.id && !active) throw new ApiError(409, 'You cannot deactivate your own account.')
    await env.DB.prepare('UPDATE users SET role = ?, active = ? WHERE id = ?').bind(role, active, target.id).run()
    const updated = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(target.id).first<User>()
    await appendAudit('USER', actor.display_name, 'Updated user access', null, `${target.username}: ${role}, active=${Boolean(active)}`)
    return json(publicUser(updated!))
  }

  if (path === '/api/documents' && request.method === 'GET') {
    const result = await env.DB.prepare('SELECT * FROM documents ORDER BY created_at DESC').all<DocumentRow>()
    return json(result.results.map(documentResponse))
  }

  if (path === '/api/documents/batch' && request.method === 'POST') {
    requireRole(actor, ['Administrator', 'Data Operator'])
    const form = await request.formData()
    const uploads = form.getAll('files').filter((item): item is File => item instanceof File)
    if (!uploads.length) throw new ApiError(422, 'Select at least one PDF or image.')
    if (uploads.length > 20) throw new ApiError(422, 'A batch can contain at most 20 files.')
    const state = String(form.get('state') || 'Not specified').trim()
    const district = String(form.get('district') || 'Not specified').trim()
    const documentType = String(form.get('document_type') || 'Land record').trim()
    const language = String(form.get('language') || 'Unknown').trim()
    const createdRows: DocumentRow[] = []
    for (const file of uploads) {
      const bytes = await file.arrayBuffer()
      if (!allowedFile(file, bytes)) throw new ApiError(415, `${file.name}: use a valid PDF, PNG, JPEG or TIFF file up to 50 MB.`)
      const scanResult = await scanUploadedFile(file, bytes)
      const timestamp = Date.now()
      const id = `LR-${new Date().getUTCFullYear()}-${String(timestamp).slice(-6)}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`
      const fileKey = `records/${id}/${safeFilename(file.name)}`
      await env.FILES.put(fileKey, await encryptProtectedFile(bytes), { httpMetadata: { contentType: 'application/octet-stream' }, customMetadata: { recordId: id, uploadedBy: actor.username, encryption: 'AES-256-GCM', contentType: file.type } })
      const fieldValues = makeFields({ District: district })
      const now = isoNow()
      await env.DB.prepare(`INSERT INTO documents (id, owner, document, filename, location, district, survey, type, language, confidence, status, file_key, mime_type, checksum_sha256, ocr_engine, fields_json, validation_issues, version, created_at, updated_at) VALUES (?, 'Awaiting extraction', ?, ?, ?, ?, '—', ?, ?, 0, 'Processing', ?, ?, ?, 'Queued browser OCR', ?, '[]', 1, ?, ?)`)
        .bind(id, `${documentType} · Uploaded`, file.name, `${district}, ${state}`, district, documentType, language, fileKey, file.type, await sha256(bytes), JSON.stringify(fieldValues), now, now).run()
      await env.DB.prepare(`INSERT INTO processing_jobs (document_id, status, stage, progress, attempts, error, engine, started_at, updated_at, completed_at) VALUES (?, 'Queued', 'Source stored', 10, 0, '', '', NULL, ?, NULL)`).bind(id, now).run()
      const row = await getDocument(id)
      await addRevision(row, actor.display_name, 'Uploaded source document')
      await appendAudit('UPLOAD', actor.display_name, `Uploaded ${file.name}`, id, `${file.type}; ${bytes.byteLength} bytes; malware=${scanResult}; AES-256-GCM; SHA-256 ${row.checksum_sha256}`)
      createdRows.push(row)
    }
    return json(createdRows.map(documentResponse), 201)
  }

  const extractionFailMatch = path.match(/^\/api\/documents\/([^/]+)\/extraction\/fail$/)
  if (extractionFailMatch && request.method === 'POST') {
    requireRole(actor, ['Administrator', 'Data Operator'])
    const row = await getDocument(extractionFailMatch[1])
    const input = await bodyJson<{ message?: string }>(request)
    const message = String(input.message || 'OCR could not recognize this source.').slice(0, 500)
    const issue: ValidationIssue = { code: 'OCR_REVIEW_REQUIRED', field: 'Document', severity: 'warning', message: 'Automated OCR could not complete; the securely stored source requires manual verification.' }
    const now = isoNow()
    await env.DB.batch([
      env.DB.prepare(`UPDATE documents SET status = 'Needs review', owner = 'Not detected', confidence = 0, ocr_engine = 'OCR unavailable · manual verification', validation_issues = ?, updated_at = ? WHERE id = ?`).bind(JSON.stringify([issue]), now, row.id),
      env.DB.prepare(`INSERT INTO processing_jobs (document_id, status, stage, progress, attempts, error, engine, started_at, updated_at, completed_at) VALUES (?, 'Failed', 'Manual verification required', 100, 1, ?, 'Browser OCR', ?, ?, ?) ON CONFLICT(document_id) DO UPDATE SET status='Failed', stage='Manual verification required', progress=100, attempts=processing_jobs.attempts+1, error=excluded.error, engine=excluded.engine, updated_at=excluded.updated_at, completed_at=excluded.completed_at`).bind(row.id, message, now, now, now),
    ])
    const updated = await getDocument(row.id)
    await addRevision(updated, actor.display_name, 'OCR routed to manual verification')
    await appendAudit('OCR_FAILURE', actor.display_name, 'Online OCR requires manual review', row.id, message)
    return json(documentResponse(updated))
  }

  const extractionMatch = path.match(/^\/api\/documents\/([^/]+)\/extraction$/)
  if (extractionMatch && request.method === 'POST') {
    requireRole(actor, ['Administrator', 'Data Operator'])
    const row = await getDocument(extractionMatch[1])
    const input = await bodyJson<{ text?: string; engine?: string; language?: string; confidence?: number; fields?: Field[]; pages?: number; warnings?: string[] }>(request)
    const submitted = Array.isArray(input.fields) ? input.fields : []
    const learned = await env.DB.prepare('SELECT field_label, predicted_value, corrected_value, occurrences FROM learning_dictionary WHERE language = ? AND occurrences >= 2 ORDER BY occurrences DESC').bind(String(input.language || row.language || 'Unknown')).all<{ field_label: string; predicted_value: string; corrected_value: string; occurrences: number }>()
    const learnedMap = new Map(learned.results.map(pattern => [`${pattern.field_label}|${pattern.predicted_value.trim().toLocaleLowerCase()}`, pattern]))
    const byLabel = new Map(submitted.filter(field => field && fieldLabels.includes(field.label as typeof fieldLabels[number])).map(field => [field.label, field]))
    const sanitizedFields: Field[] = fieldLabels.map((label, index) => {
      const field = byLabel.get(label)
      const predicted = String(field?.value || '').trim().slice(0, 500)
      const learnedPattern = learnedMap.get(`${label}|${predicted.toLocaleLowerCase()}`)
      const value = String(learnedPattern?.corrected_value || predicted).slice(0, 500)
      const original = String(field?.original || (value ? value : 'Not detected')).trim().slice(0, 500)
      const score = Number(field?.confidence)
      const confidence = learnedPattern ? Math.max(92, Number(score) || 0) : score
      return { id: index + 1, label, value, original, confidence: value && Number.isFinite(confidence) ? Math.max(0, Math.min(100, Math.round(confidence * 100) / 100)) : 0, valid: Boolean(value), verified: false }
    })
    const detected = sanitizedFields.filter(field => field.value)
    const sourceConfidence = Number.isFinite(Number(input.confidence)) ? Math.max(0, Math.min(100, Number(input.confidence))) : 0
    const fieldConfidence = detected.length ? detected.reduce((sum, field) => sum + field.confidence, 0) / detected.length : 0
    const confidence = Math.round((sourceConfidence * .35 + fieldConfidence * .65) * 100) / 100
    const values = Object.fromEntries(sanitizedFields.map(field => [field.label, field.value]))
    const textContent = String(input.text || '').slice(0, 1_000_000)
    if (!textContent.trim()) throw new ApiError(422, 'Recognized text is required to complete extraction.')
    const language = String(input.language || row.language || 'Unknown').slice(0, 60)
    const engine = String(input.engine || 'Browser OCR').slice(0, 120)
    const warnings = Array.isArray(input.warnings) ? input.warnings.map(warning => String(warning).slice(0, 300)).slice(0, 10) : []
    const pages = Math.max(1, Math.min(10_000, Math.round(Number(input.pages) || 1)))
    const now = isoNow()
    await env.DB.batch([
      env.DB.prepare(`UPDATE documents SET owner = ?, survey = ?, location = ?, district = ?, language = ?, confidence = ?, status = 'Needs review', ocr_engine = ?, fields_json = ?, validation_issues = '[]', version = version + 1, updated_at = ? WHERE id = ?`)
        .bind(values['Landowner name'] || 'Not detected', values['Survey number'] || values['Khasra number'] || '—', [values.Village, values.District || row.district].filter(Boolean).join(', '), values.District || row.district, language, confidence, engine, JSON.stringify(sanitizedFields), now, row.id),
      env.DB.prepare(`INSERT INTO ocr_results (document_id, text_content, language, engine, page_count, warnings_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(document_id) DO UPDATE SET text_content=excluded.text_content, language=excluded.language, engine=excluded.engine, page_count=excluded.page_count, warnings_json=excluded.warnings_json, created_at=excluded.created_at`).bind(row.id, textContent, language, engine, pages, JSON.stringify(warnings), now),
      env.DB.prepare(`INSERT INTO processing_jobs (document_id, status, stage, progress, attempts, error, engine, started_at, updated_at, completed_at) VALUES (?, 'Completed', 'Verification ready', 100, 1, '', ?, ?, ?, ?) ON CONFLICT(document_id) DO UPDATE SET status='Completed', stage='Verification ready', progress=100, attempts=processing_jobs.attempts+1, error='', engine=excluded.engine, updated_at=excluded.updated_at, completed_at=excluded.completed_at`).bind(row.id, engine, now, now, now),
    ])
    let updated = await getDocument(row.id)
    const issues = await validateDocument(updated)
    warnings.forEach((warning, index) => issues.push({ code: `OCR_WARNING_${index + 1}`, field: 'Document', severity: 'warning', message: warning }))
    await env.DB.prepare('UPDATE documents SET validation_issues = ? WHERE id = ?').bind(JSON.stringify(issues), row.id).run()
    updated = await getDocument(row.id)
    await addRevision(updated, actor.display_name, 'Completed online OCR and field extraction')
    await appendAudit('OCR_COMPLETE', actor.display_name, `Extracted ${detected.length} of ${fieldLabels.length} fields`, row.id, `${engine}; ${pages} page(s); ${Math.round(confidence)}% confidence`)
    await env.DB.prepare('INSERT INTO notifications (title, message, level, created_at) VALUES (?, ?, ?, ?)').bind('OCR processing complete', `${row.id} is ready for assisted verification.`, issues.some(issue => issue.severity === 'error') ? 'warning' : 'success', now).run()
    await dispatchNotification('OCR processing complete', `${row.id} is ready for assisted verification.`, issues.some(issue => issue.severity === 'error') ? 'warning' : 'success', row.id)
    return json(documentResponse(updated))
  }

  const processingMatch = path.match(/^\/api\/documents\/([^/]+)\/processing$/)
  if (processingMatch && request.method === 'GET') {
    await getDocument(processingMatch[1])
    const job = await env.DB.prepare('SELECT * FROM processing_jobs WHERE document_id = ?').bind(processingMatch[1]).first()
    return json(job || { document_id: processingMatch[1], status: 'Not tracked', stage: 'Imported record', progress: 100 })
  }

  const fileMatch = path.match(/^\/api\/documents\/([^/]+)\/file$/)
  if (fileMatch && request.method === 'GET') {
    const row = await getDocument(fileMatch[1])
    if (!row.file_key) throw new ApiError(404, 'No source file is attached to this prototype record.')
    const object = await env.FILES.get(row.file_key)
    if (!object) throw new ApiError(404, 'The source file could not be found in storage.')
    const content = await decryptProtectedFile(await object.arrayBuffer())
    if (row.checksum_sha256 && await sha256(content) !== row.checksum_sha256) throw new ApiError(500, 'The protected source file failed its integrity check.')
    const headers = new Headers({ 'Content-Type': row.mime_type, 'Content-Length': String(content.byteLength) })
    headers.set('Content-Disposition', `inline; filename="${safeFilename(row.filename)}"`)
    headers.set('ETag', object.httpEtag)
    return new Response(content, { headers })
  }

  const versionsMatch = path.match(/^\/api\/documents\/([^/]+)\/versions$/)
  if (versionsMatch && request.method === 'GET') {
    await getDocument(versionsMatch[1])
    const result = await env.DB.prepare('SELECT version, actor, action, snapshot_json, created_at FROM revisions WHERE document_id = ? ORDER BY version DESC, id DESC').bind(versionsMatch[1]).all<{ version: number; actor: string; action: string; snapshot_json: string; created_at: string }>()
    return json(result.results.map(row => ({ ...row, snapshot: parseJson(row.snapshot_json, {}) })))
  }

  const fieldMatch = path.match(/^\/api\/documents\/([^/]+)\/fields\/(\d+)$/)
  if (fieldMatch && request.method === 'PATCH') {
    requireRole(actor, ['Administrator', 'Verification Officer', 'Data Operator'])
    const row = await getDocument(fieldMatch[1])
    const input = await bodyJson<{ value?: string }>(request)
    const id = Number(fieldMatch[2])
    const current = parseJson<Field[]>(row.fields_json, [])
    const target = current.find(field => field.id === id)
    if (!target) throw new ApiError(404, 'Extracted field not found.')
    const originalPrediction = target.value
    target.value = String(input.value ?? '').trim()
    target.valid = Boolean(target.value)
    target.verified = true
    target.confidence = target.value ? 100 : 0
    const fieldByLabel = Object.fromEntries(current.map(field => [field.label, field.value]))
    const detected = current.filter(field => field.value).length
    const confidence = Math.round(detected / current.length * 10000) / 100
    const now = isoNow()
    await env.DB.prepare(`UPDATE documents SET owner = ?, survey = ?, location = ?, district = ?, confidence = ?, fields_json = ?, version = version + 1, updated_at = ? WHERE id = ?`)
      .bind(fieldByLabel['Landowner name'] || 'Not detected', fieldByLabel['Survey number'] || fieldByLabel['Khasra number'] || '—', [fieldByLabel.Village, fieldByLabel.District].filter(Boolean).join(', ') || row.location, fieldByLabel.District || row.district, confidence, JSON.stringify(current), now, row.id).run()
    if (originalPrediction !== target.value) await env.DB.batch([
      env.DB.prepare('INSERT INTO corrections (document_id, field_label, predicted_value, corrected_value, source_excerpt, language, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(row.id, target.label, originalPrediction, target.value, target.original, row.language, actor.display_name, now),
      env.DB.prepare(`INSERT INTO learning_dictionary (field_label, language, predicted_value, corrected_value, occurrences, updated_at) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(field_label, language, predicted_value, corrected_value) DO UPDATE SET occurrences = learning_dictionary.occurrences + 1, updated_at = excluded.updated_at`).bind(target.label, row.language, originalPrediction, target.value, now),
    ])
    const updated = await getDocument(row.id)
    await addRevision(updated, actor.display_name, `Corrected ${target.label}`)
    await appendAudit('FIELD_EDIT', actor.display_name, `Updated ${target.label}`, row.id, `${originalPrediction} → ${target.value}`)
    return json(documentResponse(updated))
  }

  const actionMatch = path.match(/^\/api\/documents\/([^/]+)\/(validate|approve|reject)$/)
  if (actionMatch && request.method === 'POST') {
    const row = await getDocument(actionMatch[1])
    const action = actionMatch[2]
    if (action === 'validate') {
      requireRole(actor, ['Administrator', 'Verification Officer', 'Data Operator'])
      const issues = [...await validateDocument(row), ...await externalValidation(row, actor.display_name)]
      await env.DB.prepare('UPDATE documents SET validation_issues = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(issues), isoNow(), row.id).run()
      await appendAudit('VALIDATION', actor.display_name, `Ran ${issues.length ? 'validation checks' : 'successful validation'}`, row.id, `${issues.length} issue(s)`)
    } else if (action === 'approve') {
      requireRole(actor, ['Administrator', 'Verification Officer'])
      const issues = [...await validateDocument(row), ...await externalValidation(row, actor.display_name)]
      if (issues.some(issue => issue.severity === 'error')) throw new ApiError(409, { message: 'Resolve required fields before approval.', issues })
      const currentFields = parseJson<Field[]>(row.fields_json, []).map(field => ({ ...field, verified: true }))
      await env.DB.prepare(`UPDATE documents SET status = 'Verified', fields_json = ?, validation_issues = ?, version = version + 1, updated_at = ? WHERE id = ?`).bind(JSON.stringify(currentFields), JSON.stringify(issues), isoNow(), row.id).run()
      const updated = await getDocument(row.id)
      await addRevision(updated, actor.display_name, 'Approved record')
      await appendAudit('APPROVAL', actor.display_name, 'Approved land record', row.id, `${issues.length} warning(s)`)
      await env.DB.prepare('INSERT INTO notifications (title, message, level, created_at) VALUES (?, ?, ?, ?)').bind('Record approved', `${row.id} was approved by ${actor.display_name}.`, 'success', isoNow()).run()
      await dispatchNotification('Record approved', `${row.id} was approved by ${actor.display_name}.`, 'success', row.id)
    } else {
      requireRole(actor, ['Administrator', 'Verification Officer'])
      await env.DB.prepare(`UPDATE documents SET status = 'Rejected', version = version + 1, updated_at = ? WHERE id = ?`).bind(isoNow(), row.id).run()
      const updated = await getDocument(row.id)
      await addRevision(updated, actor.display_name, 'Rejected record')
      await appendAudit('REJECTION', actor.display_name, 'Rejected land record', row.id, 'Manual verification decision')
    }
    return json(documentResponse(await getDocument(row.id)))
  }

  const documentMatch = path.match(/^\/api\/documents\/([^/]+)$/)
  if (documentMatch && request.method === 'GET') return json(documentResponse(await getDocument(documentMatch[1])))

  if (path === '/api/stats' && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT status, district, confidence, created_at FROM documents').all<{ status: string; district: string; confidence: number; created_at: string }>()
    const records = rows.results
    const districtCounts = new Map<string, number>()
    const dateCounts = new Map<string, number>()
    records.forEach(row => {
      districtCounts.set(row.district, (districtCounts.get(row.district) || 0) + 1)
      const date = row.created_at.slice(0, 10)
      dateCounts.set(date, (dateCounts.get(date) || 0) + 1)
    })
    return json({
      total_records: records.length,
      needs_review: records.filter(row => row.status === 'Needs review').length,
      verified: records.filter(row => row.status === 'Verified').length,
      processing: records.filter(row => row.status === 'Processing').length,
      average_confidence: records.length ? Math.round(records.reduce((sum, row) => sum + row.confidence, 0) / records.length * 10) / 10 : 0,
      district_progress: [...districtCounts.entries()].map(([name, processed]) => ({ name, processed })).sort((a, b) => b.processed - a.processed),
      daily_volume: [...dateCounts.entries()].map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date)).slice(-14),
    })
  }

  if (path === '/api/model/metrics' && request.method === 'GET') {
    requireRole(actor, ['Administrator', 'Verification Officer', 'Auditor'])
    const [documents, corrections, patterns] = await Promise.all([
      env.DB.prepare(`SELECT language, COUNT(*) AS records, ROUND(AVG(confidence), 2) AS average_confidence, SUM(CASE WHEN status = 'Verified' THEN 1 ELSE 0 END) AS verified FROM documents GROUP BY language ORDER BY records DESC`).all(),
      env.DB.prepare('SELECT field_label, COUNT(*) AS corrections FROM corrections GROUP BY field_label ORDER BY corrections DESC').all(),
      env.DB.prepare('SELECT field_label, language, predicted_value, corrected_value, occurrences, updated_at FROM learning_dictionary ORDER BY occurrences DESC, updated_at DESC LIMIT 50').all(),
    ])
    return json({ language_performance: documents.results, correction_frequency: corrections.results, learned_patterns: patterns.results, adaptive_threshold: 2, mechanism: 'Human-verified correction memory with language- and field-specific reuse' })
  }

  if (path === '/api/admin/backups' && request.method === 'POST') {
    requireRole(actor, ['Administrator'])
    const backup = await createDatabaseBackup('manual', actor.display_name)
    await appendAudit('BACKUP', actor.display_name, 'Created protected database backup', null, `${backup.key}; ${backup.size} bytes; SHA-256 ${backup.checksum}`)
    return json({ ...backup, created_at: isoNow() }, 201)
  }

  if (path === '/api/admin/backups' && request.method === 'GET') {
    requireRole(actor, ['Administrator', 'Auditor'])
    const listed = await env.FILES.list({ prefix: 'backups/', limit: 100 })
    return json(listed.objects.sort((left, right) => right.uploaded.getTime() - left.uploaded.getTime()).map(object => ({ key: object.key, size: object.size, uploaded: object.uploaded.toISOString(), checksum: object.customMetadata?.checksumSha256 || null, reason: object.customMetadata?.reason || null })))
  }

  if (path === '/api/admin/operations' && request.method === 'GET') {
    requireRole(actor, ['Administrator', 'Auditor'])
    const [jobs, sessions, integrations, citizen, lastBackup] = await Promise.all([
      env.DB.prepare('SELECT status, COUNT(*) AS count FROM processing_jobs GROUP BY status').all(),
      env.DB.prepare('SELECT COUNT(*) AS count FROM sessions WHERE revoked_at IS NULL AND expires_at > ?').bind(isoNow()).first<{ count: number }>(),
      env.DB.prepare('SELECT status, COUNT(*) AS count FROM integration_runs GROUP BY status').all(),
      env.DB.prepare(`SELECT COUNT(*) AS count FROM citizen_requests WHERE status NOT IN ('Resolved', 'Rejected')`).first<{ count: number }>(),
      env.FILES.list({ prefix: 'backups/', limit: 1 }),
    ])
    return json({ processing_jobs: jobs.results, active_sessions: sessions?.count || 0, integration_runs: integrations.results, open_citizen_requests: citizen?.count || 0, latest_backup: lastBackup.objects[0]?.uploaded.toISOString() || null, scheduled_backup: '02:00 UTC daily', backup_retention: 30 })
  }

  if (path === '/api/audit' && request.method === 'GET') {
    requireRole(actor, ['Administrator', 'Auditor'])
    const requested = Number(url.searchParams.get('limit') || 100)
    const limit = Math.max(1, Math.min(500, Number.isFinite(requested) ? requested : 100))
    const result = await env.DB.prepare('SELECT id, event_type, actor, action, document_id, details, created_at FROM audit_events ORDER BY id DESC LIMIT ?').bind(limit).all()
    return json(result.results)
  }

  if (path === '/api/audit/integrity' && request.method === 'GET') {
    requireRole(actor, ['Administrator', 'Auditor'])
    const result = await env.DB.prepare('SELECT * FROM audit_events ORDER BY id').all<{ event_type: string; actor: string; action: string; document_id: string | null; details: string; previous_hash: string; event_hash: string; created_at: string }>()
    let previousHash = ''
    let valid = true
    for (const event of result.results) {
      const expected = await hmac(auditSecret(), [event.event_type, event.actor, event.action, event.document_id || '', event.details, previousHash, event.created_at].join('|'))
      if (event.previous_hash !== previousHash || event.event_hash !== expected) { valid = false; break }
      previousHash = event.event_hash
    }
    return json({ valid, events_checked: result.results.length, algorithm: 'HMAC-SHA-256 chained events' })
  }

  if (path === '/api/notifications' && request.method === 'GET') {
    const result = await env.DB.prepare(`SELECT n.id, n.title, n.message, n.level, n.created_at, CASE WHEN r.id IS NULL THEN 0 ELSE 1 END AS read FROM notifications n LEFT JOIN notification_receipts r ON n.id = r.notification_id AND r.username = ? ORDER BY n.id DESC`).bind(actor.username).all()
    return json(result.results.map(row => ({ ...row, read: Boolean((row as Record<string, unknown>).read) })))
  }

  const notificationMatch = path.match(/^\/api\/notifications\/(\d+)\/read$/)
  if (notificationMatch && request.method === 'POST') {
    const id = Number(notificationMatch[1])
    const notification = await env.DB.prepare('SELECT * FROM notifications WHERE id = ?').bind(id).first<Record<string, unknown>>()
    if (!notification) throw new ApiError(404, 'Notification not found.')
    await env.DB.prepare('INSERT OR IGNORE INTO notification_receipts (notification_id, username, read_at) VALUES (?, ?, ?)').bind(id, actor.username, isoNow()).run()
    return json({ ...notification, read: true })
  }

  if (path === '/api/parcels' && request.method === 'GET') {
    const result = await env.DB.prepare('SELECT * FROM parcels ORDER BY id').all<{ id: number; khasra: string; owner: string; area: number; classification: string; status: string; village: string; tehsil: string; district: string; record_id: string | null; geometry_json: string }>()
    return json({ type: 'FeatureCollection', features: result.results.map(parcel => ({ type: 'Feature', id: parcel.id, geometry: { type: 'Polygon', coordinates: [parseJson<number[][]>(parcel.geometry_json, [])] }, properties: { id: parcel.id, khasra: parcel.khasra, owner: parcel.owner, area: parcel.area, classification: parcel.classification, status: parcel.status, village: parcel.village, tehsil: parcel.tehsil, district: parcel.district, record_id: parcel.record_id } })) })
  }

  const parcelMatch = path.match(/^\/api\/parcels\/(\d+)$/)
  if (parcelMatch && request.method === 'PATCH') {
    requireRole(actor, ['Administrator', 'Verification Officer'])
    const id = Number(parcelMatch[1])
    const parcel = await env.DB.prepare('SELECT * FROM parcels WHERE id = ?').bind(id).first<{ id: number; owner: string; classification: string; status: string; record_id: string | null }>()
    if (!parcel) throw new ApiError(404, 'Parcel not found.')
    const input = await bodyJson<{ owner?: string; classification?: string; status?: string; record_id?: string | null }>(request)
    const owner = input.owner === undefined ? parcel.owner : String(input.owner).trim().slice(0, 200)
    const classification = input.classification === undefined ? parcel.classification : String(input.classification).trim().slice(0, 120)
    const status = input.status === undefined ? parcel.status : String(input.status)
    const recordId = input.record_id === undefined ? parcel.record_id : input.record_id ? String(input.record_id).trim() : null
    if (!owner || !classification || !['Verified', 'Needs review', 'Rejected'].includes(status)) throw new ApiError(422, 'Provide a valid owner, classification and parcel status.')
    if (recordId) await getDocument(recordId)
    await env.DB.prepare('UPDATE parcels SET owner = ?, classification = ?, status = ?, record_id = ? WHERE id = ?').bind(owner, classification, status, recordId, id).run()
    await appendAudit('GIS_EDIT', actor.display_name, `Updated cadastral parcel ${id}`, recordId, `owner=${owner}; classification=${classification}; status=${status}`)
    const updated = await env.DB.prepare('SELECT * FROM parcels WHERE id = ?').bind(id).first<{ id: number; khasra: string; owner: string; area: number; classification: string; status: string; village: string; tehsil: string; district: string; record_id: string | null; geometry_json: string }>()
    return json({ type: 'Feature', id: updated!.id, geometry: { type: 'Polygon', coordinates: [parseJson<number[][]>(updated!.geometry_json, [])] }, properties: { id: updated!.id, khasra: updated!.khasra, owner: updated!.owner, area: updated!.area, classification: updated!.classification, status: updated!.status, village: updated!.village, tehsil: updated!.tehsil, district: updated!.district, record_id: updated!.record_id } })
  }

  if (path === '/api/parcels/import' && request.method === 'POST') {
    requireRole(actor, ['Administrator'])
    const collection = await bodyJson<{ type?: string; features?: Array<{ geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown> }> }>(request)
    if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features) || !collection.features.length || collection.features.length > 500) throw new ApiError(422, 'Upload a GeoJSON FeatureCollection containing 1–500 polygon parcels.')
    const statements: D1PreparedStatement[] = []
    for (const [index, feature] of collection.features.entries()) {
      const ring = Array.isArray(feature.geometry?.coordinates) ? (feature.geometry!.coordinates as unknown[])[0] : null
      if (feature.geometry?.type !== 'Polygon' || !Array.isArray(ring) || ring.length < 4 || !ring.every(point => Array.isArray(point) && point.length >= 2 && point.slice(0, 2).every(value => Number.isFinite(Number(value))))) throw new ApiError(422, `Feature ${index + 1} does not contain a valid polygon ring.`)
      const coordinates = (ring as unknown[][]).map(point => [Number(point[0]), Number(point[1])])
      const first = coordinates[0]
      const last = coordinates[coordinates.length - 1]
      if (first[0] !== last[0] || first[1] !== last[1]) coordinates.push([...first])
      if (coordinates.some(([longitude, latitude]) => longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90)) throw new ApiError(422, `Feature ${index + 1} contains out-of-range coordinates.`)
      const properties = feature.properties || {}
      const khasra = String(properties.khasra || properties.khasra_number || '').trim().slice(0, 80)
      if (!khasra) throw new ApiError(422, `Feature ${index + 1} is missing khasra.`)
      const recordId = properties.record_id ? String(properties.record_id).trim() : null
      if (recordId) await getDocument(recordId)
      statements.push(env.DB.prepare('INSERT INTO parcels (khasra, owner, area, classification, status, village, tehsil, district, record_id, geometry_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(khasra, String(properties.owner || 'Not recorded').slice(0, 200), Math.max(0, Number(properties.area || properties.area_hectares || 0)), String(properties.classification || 'Unclassified').slice(0, 120), ['Verified', 'Needs review', 'Rejected'].includes(String(properties.status)) ? String(properties.status) : 'Needs review', String(properties.village || 'Unassigned').slice(0, 100), String(properties.tehsil || 'Unassigned').slice(0, 100), String(properties.district || 'Unassigned').slice(0, 100), recordId, JSON.stringify(coordinates)))
    }
    await env.DB.batch(statements)
    await appendAudit('GIS_IMPORT', actor.display_name, `Imported ${statements.length} cadastral parcels`, null, 'Validated GeoJSON polygon dataset')
    return json({ imported: statements.length }, 201)
  }

  if (path === '/api/integrations' && request.method === 'GET') {
    requireRole(actor, ['Administrator'])
    const configs = (['lrms', 'dilrmp', 'registration', 'gis', 'notifications'] as IntegrationKey[]).map(integrationConfig)
    return json([
      ...configs.map(config => ({ key: config.key, name: config.name, configured: Boolean(config.baseUrl), base_url: config.baseUrl, configuration_variable: config.variable })),
      { key: 'sso', name: 'Government OpenID Connect SSO', configured: Boolean(env.OIDC_ISSUER && env.OIDC_CLIENT_ID), base_url: env.OIDC_ISSUER || '', configuration_variable: 'OIDC_ISSUER' },
    ])
  }

  const integrationTestMatch = path.match(/^\/api\/integrations\/(lrms|dilrmp|registration|gis|notifications)\/test$/)
  if (integrationTestMatch && request.method === 'POST') {
    requireRole(actor, ['Administrator'])
    const config = integrationConfig(integrationTestMatch[1] as IntegrationKey)
    try {
      const response = await integrationFetch(config, 'health', { method: 'GET' })
      const message = (await response.text()).slice(0, 500) || response.statusText
      await logIntegration(config, 'test', null, response.ok ? 'Succeeded' : 'Failed', response.status, message, actor.display_name)
      if (!response.ok) throw new ApiError(502, `${config.name} returned HTTP ${response.status}.`)
      return json({ key: config.key, connected: true, status: response.status, message })
    } catch (error) {
      if (error instanceof ApiError) throw error
      await logIntegration(config, 'test', null, 'Failed', null, error instanceof Error ? error.message : 'Connection failed', actor.display_name)
      throw new ApiError(502, `${config.name} could not be reached.`)
    }
  }

  const integrationSyncMatch = path.match(/^\/api\/integrations\/(lrms|dilrmp|registration|gis)\/sync\/([^/]+)$/)
  if (integrationSyncMatch && request.method === 'POST') {
    requireRole(actor, ['Administrator'])
    const config = integrationConfig(integrationSyncMatch[1] as IntegrationKey)
    const row = await getDocument(integrationSyncMatch[2])
    if (row.status !== 'Verified') throw new ApiError(409, 'Only verified records can be synchronized externally.')
    try {
      const response = await integrationFetch(config, 'records', { method: 'POST', body: JSON.stringify(canonicalRecord(row)), headers: { 'Idempotency-Key': `${config.key}-${row.id}-v${row.version}` } })
      const message = (await response.text()).slice(0, 500) || response.statusText
      await logIntegration(config, 'sync', row, response.ok ? 'Succeeded' : 'Failed', response.status, message, actor.display_name)
      if (!response.ok) throw new ApiError(502, `${config.name} rejected the record with HTTP ${response.status}.`)
      await appendAudit('INTEGRATION', actor.display_name, `Synchronized record with ${config.name}`, row.id, message)
      return json({ key: config.key, record_id: row.id, synchronized: true, status: response.status, message })
    } catch (error) {
      if (error instanceof ApiError) throw error
      await logIntegration(config, 'sync', row, 'Failed', null, error instanceof Error ? error.message : 'Connection failed', actor.display_name)
      throw new ApiError(502, `${config.name} could not be reached.`)
    }
  }

  if (path === '/api/integrations/runs' && request.method === 'GET') {
    requireRole(actor, ['Administrator', 'Auditor'])
    const result = await env.DB.prepare('SELECT * FROM integration_runs ORDER BY id DESC LIMIT 100').all()
    return json(result.results)
  }

  if (path === '/api/export/records.csv' && request.method === 'GET') {
    requireRole(actor, ['Administrator', 'Auditor', 'Verification Officer'])
    const result = await env.DB.prepare('SELECT id, owner, document, district, survey, type, language, confidence, status, updated_at FROM documents ORDER BY created_at DESC').all<Record<string, unknown>>()
    return csvResponse('dhara-records.csv', [['Record ID', 'Owner', 'Document', 'District', 'Survey/Khasra', 'Type', 'Language', 'Confidence', 'Status', 'Updated'], ...result.results.map(row => [row.id, row.owner, row.document, row.district, row.survey, row.type, row.language, row.confidence, row.status, row.updated_at])])
  }

  if (path === '/api/export/audit.csv' && request.method === 'GET') {
    requireRole(actor, ['Administrator', 'Auditor'])
    const result = await env.DB.prepare('SELECT id, event_type, actor, action, document_id, details, created_at FROM audit_events ORDER BY id').all<Record<string, unknown>>()
    return csvResponse('dhara-audit.csv', [['ID', 'Event type', 'Actor', 'Action', 'Document ID', 'Details', 'Created'], ...result.results.map(row => [row.id, row.event_type, row.actor, row.action, row.document_id, row.details, row.created_at])])
  }

  if (path === '/api/export/parcels.geojson' && request.method === 'GET') {
    const result = await env.DB.prepare('SELECT * FROM parcels ORDER BY id').all<{ id: number; khasra: string; owner: string; area: number; classification: string; status: string; village: string; tehsil: string; district: string; record_id: string | null; geometry_json: string }>()
    const collection = { type: 'FeatureCollection', features: result.results.map(parcel => ({ type: 'Feature', id: parcel.id, geometry: { type: 'Polygon', coordinates: [parseJson<number[][]>(parcel.geometry_json, [])] }, properties: { id: parcel.id, khasra: parcel.khasra, owner: parcel.owner, area: parcel.area, classification: parcel.classification, status: parcel.status, village: parcel.village, tehsil: parcel.tehsil, district: parcel.district, record_id: parcel.record_id } })) }
    return new Response(JSON.stringify(collection, null, 2), { headers: { 'Content-Type': 'application/geo+json', 'Content-Disposition': 'attachment; filename="dhara-parcels.geojson"' } })
  }

  if (path === '/api/export/corrections.jsonl' && request.method === 'GET') {
    requireRole(actor, ['Administrator', 'Auditor'])
    const result = await env.DB.prepare('SELECT document_id, field_label, predicted_value, corrected_value, source_excerpt, language, actor, created_at FROM corrections ORDER BY id').all()
    return new Response(result.results.map(row => JSON.stringify(row)).join('\n'), { headers: { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': 'attachment; filename="dhara-corrections.jsonl"' } })
  }

  const integrationMatch = path.match(/^\/api\/integration\/records\/([^/]+)$/)
  if (integrationMatch && request.method === 'GET') {
    const row = await getDocument(integrationMatch[1])
    return json(canonicalRecord(row))
  }

  throw new ApiError(404, 'API endpoint not found.')
}

function secure(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  headers.set('Cache-Control', headers.has('Content-Disposition') ? 'private, no-store' : 'no-store')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url)
      if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
      await ensureDatabase()
      await enforceRateLimit(request)
      return secure(await route(request))
    } catch (error) {
      if (error instanceof ApiError) return secure(json({ detail: error.detail }, error.status))
      console.error(error)
      return secure(json({ detail: 'The hosted service encountered an unexpected error.' }, 500))
    }
  },
  async scheduled(_controller: ScheduledController, _runtimeEnv: Cloudflare.Env, context: ExecutionContext): Promise<void> {
    context.waitUntil(scheduledMaintenance())
  },
} satisfies ExportedHandler<Cloudflare.Env>
