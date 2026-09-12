import { env } from 'cloudflare:workers'
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

function fromBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)))
}

async function createToken(username: string): Promise<string> {
  const body = toBase64Url(JSON.stringify({ sub: username, exp: Date.now() + 8 * 60 * 60 * 1000 }))
  return `${body}.${await hmac(tokenSecret(), body)}`
}

async function actorFromRequest(request: Request): Promise<User> {
  const authorization = request.headers.get('Authorization') || ''
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  const [body, signature] = token.split('.')
  if (!body || !signature || await hmac(tokenSecret(), body) !== signature) throw new ApiError(401, 'Your session is missing or has expired.')
  let payload: { sub?: string; exp?: number }
  try { payload = JSON.parse(fromBase64Url(body)) } catch { throw new ApiError(401, 'Invalid session token.') }
  if (!payload.sub || !payload.exp || payload.exp < Date.now()) throw new ApiError(401, 'Your session has expired.')
  const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(payload.sub).first<User>()
  if (!user || !user.active) throw new ApiError(401, 'This account is inactive or unavailable.')
  return user
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
    const passwordHash = await hmac(tokenSecret(), 'Dhara@2026')
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

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const path = decodeURIComponent(url.pathname)

  if (path === '/api/health' && request.method === 'GET') return json({ status: 'ok', database: 'D1', file_storage: 'R2', mode: 'hosted-prototype' })

  if (path === '/api/auth/login' && request.method === 'POST') {
    const input = await bodyJson<{ username?: string; password?: string }>(request)
    const username = String(input.username || '').trim().toLowerCase()
    const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first<User>()
    if (!user || !user.active || user.password_hash !== await hmac(tokenSecret(), String(input.password || ''))) throw new ApiError(401, 'Incorrect email or password.')
    await appendAudit('AUTH', user.display_name, 'Signed in', null, user.role)
    return json({ access_token: await createToken(user.username), user: publicUser(user) })
  }

  const actor = await actorFromRequest(request)

  if (path === '/api/auth/me' && request.method === 'GET') return json(publicUser(actor))

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
        .bind(username, displayName, await hmac(tokenSecret(), String(input.password)), input.role, isoNow()).run()
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
      const timestamp = Date.now()
      const id = `LR-${new Date().getUTCFullYear()}-${String(timestamp).slice(-6)}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`
      const fileKey = `records/${id}/${safeFilename(file.name)}`
      await env.FILES.put(fileKey, bytes, { httpMetadata: { contentType: file.type }, customMetadata: { recordId: id, uploadedBy: actor.username } })
      const fieldValues = makeFields({ District: district })
      const issues: ValidationIssue[] = [
        { code: 'OCR_REVIEW_REQUIRED', field: 'Document', severity: 'warning', message: 'Hosted intake stored the source securely; confirm extracted fields in assisted verification.' },
      ]
      const now = isoNow()
      await env.DB.prepare(`INSERT INTO documents (id, owner, document, filename, location, district, survey, type, language, confidence, status, file_key, mime_type, checksum_sha256, ocr_engine, fields_json, validation_issues, version, created_at, updated_at) VALUES (?, 'Not detected', ?, ?, ?, ?, '—', ?, ?, 8.25, 'Needs review', ?, ?, ?, 'Hosted intake · human verification', ?, ?, 1, ?, ?)`)
        .bind(id, `${documentType} · Uploaded`, file.name, `${district}, ${state}`, district, documentType, language, fileKey, file.type, await sha256(bytes), JSON.stringify(fieldValues), JSON.stringify(issues), now, now).run()
      const row = await getDocument(id)
      await addRevision(row, actor.display_name, 'Uploaded source document')
      await appendAudit('UPLOAD', actor.display_name, `Uploaded ${file.name}`, id, `${file.type}; ${bytes.byteLength} bytes; SHA-256 ${row.checksum_sha256}`)
      createdRows.push(row)
    }
    return json(createdRows.map(documentResponse), 201)
  }

  const fileMatch = path.match(/^\/api\/documents\/([^/]+)\/file$/)
  if (fileMatch && request.method === 'GET') {
    const row = await getDocument(fileMatch[1])
    if (!row.file_key) throw new ApiError(404, 'No source file is attached to this prototype record.')
    const object = await env.FILES.get(row.file_key)
    if (!object) throw new ApiError(404, 'The source file could not be found in storage.')
    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set('Content-Disposition', `inline; filename="${safeFilename(row.filename)}"`)
    headers.set('ETag', object.httpEtag)
    return new Response(object.body, { headers })
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
    if (originalPrediction !== target.value) await env.DB.prepare('INSERT INTO corrections (document_id, field_label, predicted_value, corrected_value, source_excerpt, language, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(row.id, target.label, originalPrediction, target.value, target.original, row.language, actor.display_name, now).run()
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
      const issues = await validateDocument(row)
      await env.DB.prepare('UPDATE documents SET validation_issues = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(issues), isoNow(), row.id).run()
      await appendAudit('VALIDATION', actor.display_name, `Ran ${issues.length ? 'validation checks' : 'successful validation'}`, row.id, `${issues.length} issue(s)`)
    } else if (action === 'approve') {
      requireRole(actor, ['Administrator', 'Verification Officer'])
      const issues = await validateDocument(row)
      if (issues.some(issue => issue.severity === 'error')) throw new ApiError(409, { message: 'Resolve required fields before approval.', issues })
      const currentFields = parseJson<Field[]>(row.fields_json, []).map(field => ({ ...field, verified: true }))
      await env.DB.prepare(`UPDATE documents SET status = 'Verified', fields_json = ?, validation_issues = ?, version = version + 1, updated_at = ? WHERE id = ?`).bind(JSON.stringify(currentFields), JSON.stringify(issues), isoNow(), row.id).run()
      const updated = await getDocument(row.id)
      await addRevision(updated, actor.display_name, 'Approved record')
      await appendAudit('APPROVAL', actor.display_name, 'Approved land record', row.id, `${issues.length} warning(s)`)
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

  if (path === '/api/integrations' && request.method === 'GET') {
    return json([
      { key: 'lrms', name: 'Land Records Management System', configured: Boolean(env.LRMS_BASE_URL), base_url: env.LRMS_BASE_URL || '', configuration_variable: 'LRMS_BASE_URL' },
      { key: 'dilrmp', name: 'DILRMP', configured: Boolean(env.DILRMP_BASE_URL), base_url: env.DILRMP_BASE_URL || '', configuration_variable: 'DILRMP_BASE_URL' },
      { key: 'gis', name: 'GIS / GeoServer', configured: Boolean(env.GEOSERVER_URL), base_url: env.GEOSERVER_URL || '', configuration_variable: 'GEOSERVER_URL' },
    ])
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
    const values = Object.fromEntries(parseJson<Field[]>(row.fields_json, []).map(field => [field.label, field.value || null]))
    return json({ schema: 'in.gov.dhara.land-record.v1', record_id: row.id, status: row.status, source: { filename: row.filename, checksum_sha256: row.checksum_sha256, language: row.language }, administrative_area: { district: values.District || row.district, tehsil: values.Tehsil, village: values.Village }, parcel: { survey_number: values['Survey number'], khasra_number: values['Khasra number'], khata_number: values['Khata number'], plot_area: values['Plot area'], classification: values['Land classification'] }, ownership: { landowner_name: values['Landowner name'], details: values['Ownership details'], mutation_reference: values['Mutation reference'], registration_information: values['Registration information'] }, confidence: row.confidence, version: row.version, updated_at: row.updated_at })
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
      return secure(await route(request))
    } catch (error) {
      if (error instanceof ApiError) return secure(json({ detail: error.detail }, error.status))
      console.error(error)
      return secure(json({ detail: 'The hosted service encountered an unexpected error.' }, 500))
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>
