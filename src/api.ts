import type { LandDocument } from './data'
import type { OnlineOcrResult } from './ocr'

export interface ApiStats {
  total_records: number
  needs_review: number
  verified: number
  processing: number
  average_confidence: number
  district_progress: { name: string; processed: number }[]
  daily_volume: { date: string; count: number }[]
}

export interface AuditEvent {
  id: number
  event_type: string
  actor: string
  action: string
  document_id: string | null
  details: string
  created_at: string
}

export interface AuditIntegrity {
  valid: boolean
  events_checked: number
  algorithm: string
}

export interface AuthUser {
  username: string
  display_name: string
  role: 'Administrator' | 'Verification Officer' | 'Data Operator' | 'Auditor' | 'Viewer'
  // null = national access (every state); set = confined to that one state's records.
  state: string | null
}

export interface AdminUser extends AuthUser {
  id: number
  active: boolean
  created_at: string
}

export interface RegistryFlag {
  id: number
  state: string
  district: string
  khasra_number: string
  flag_type: string
  status: string
  reference: string
  notes: string
  created_by: string
  created_at: string
  updated_at: string
}

export interface NotificationItem {
  id: number
  title: string
  message: string
  level: string
  read: boolean
  created_at: string
}

export interface ParcelFeature {
  type: 'Feature'
  id: number
  geometry: { type: 'Polygon'; coordinates: number[][][] }
  properties: {
    id: number
    khasra: string
    owner: string
    area: number
    classification: string
    status: string
    category: 'Urban' | 'Rural'
    village: string
    tehsil: string
    district: string
    record_id: string | null
  }
}

export interface RecordVersion {
  version: number
  actor: string
  action: string
  snapshot: { status: string; confidence: number; fields: Record<string, string> }
  created_at: string
}

export interface IntegrationStatus {
  key: string
  name: string
  configured: boolean
  base_url: string
  configuration_variable: string
}

export interface CitizenRequestStatus {
  id?: string
  request_id?: string
  tracking_token?: string
  request_type?: string
  record_id?: string | null
  status: string
  resolution?: string
  created_at: string
  updated_at?: string
}

export interface LearningMetrics {
  language_performance: Array<{ language: string; records: number; average_confidence: number; verified: number }>
  correction_frequency: Array<{ field_label: string; corrections: number }>
  learned_patterns: Array<{ field_label: string; language: string; corrected_value: string; occurrences: number }>
  learned_patterns_message: string | null
  adaptive_threshold: number
  mechanism: string
}

const TOKEN_KEY = 'dhara_access_token'
let accessToken = localStorage.getItem(TOKEN_KEY)

function errorMessage(detail: unknown, status: number): string {
  if (typeof detail === 'string') return detail
  if (detail && typeof detail === 'object' && 'message' in detail) return String(detail.message)
  return `Request failed (${status})`
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  const response = await fetch(path, { ...options, headers })
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    if (response.status === 401 && path !== '/api/auth/login') {
      accessToken = null
      localStorage.removeItem(TOKEN_KEY)
    }
    const detail = payload && typeof payload === 'object' && 'detail' in payload ? payload.detail : null
    throw new Error(errorMessage(detail, response.status))
  }
  return response.json() as Promise<T>
}

async function download(path: string, filename: string): Promise<void> {
  const headers = new Headers()
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  const response = await fetch(path, { headers })
  if (!response.ok) throw new Error(`Download failed (${response.status})`)
  const href = URL.createObjectURL(await response.blob())
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(href), 5000)
}

function appendContext(form: FormData, context: { state: string; district: string; category: string; documentType: string; language: string }) {
  form.append('state', context.state)
  form.append('district', context.district)
  form.append('category', context.category)
  form.append('document_type', context.documentType)
  form.append('language', context.language)
}

export const api = {
  hasSession: () => Boolean(accessToken),
  // portal_state is the state the login screen was branded for (from the India-map picker) -
  // only takes effect for a national account; a state-scoped account is unaffected either way.
  login: async (username: string, password: string, portalState?: string | null) => {
    const response = await request<{ access_token: string; user: AuthUser }>('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, portal_state: portalState || undefined }),
    })
    accessToken = response.access_token
    localStorage.setItem(TOKEN_KEY, accessToken)
    return response.user
  },
  oidcStatus: () => request<{ configured: boolean; provider: string | null }>('/api/auth/oidc/status'),
  beginOidc: () => request<{ authorization_url: string }>('/api/auth/oidc/start', { method: 'POST' }),
  completeOidc: async (code: string) => {
    const response = await request<{ access_token: string; user: AuthUser }>('/api/auth/oidc/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
    })
    accessToken = response.access_token
    localStorage.setItem(TOKEN_KEY, accessToken)
    return response.user
  },
  submitCitizenRequest: (payload: { request_type: string; record_id: string; applicant_name: string; contact: string; details: string; consent: boolean }) => request<CitizenRequestStatus>('/api/citizen/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  citizenRequestStatus: (requestId: string, token: string) => request<CitizenRequestStatus>(`/api/citizen/requests/${encodeURIComponent(requestId)}?token=${encodeURIComponent(token)}`),
  logout: async () => {
    try { if (accessToken) await request<{ status: string }>('/api/auth/logout', { method: 'POST' }) }
    finally {
      accessToken = null
      localStorage.removeItem(TOKEN_KEY)
    }
  },
  me: () => request<AuthUser>('/api/auth/me'),
  users: () => request<AdminUser[]>('/api/users'),
  createUser: (payload: { username: string; display_name: string; password: string; role: AuthUser['role']; state?: string | null }) => request<AdminUser>('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  updateUser: (id: number, payload: { role?: AuthUser['role']; active?: boolean; state?: string | null }) => request<AdminUser>(`/api/users/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  health: () => request<{ status: string }>('/api/health'),
  documents: () => request<LandDocument[]>('/api/documents'),
  document: (id: string) => request<LandDocument>(`/api/documents/${id}`),
  stats: () => request<ApiStats>('/api/stats'),
  audit: () => request<AuditEvent[]>('/api/audit?limit=100'),
  auditIntegrity: () => request<AuditIntegrity>('/api/audit/integrity'),
  notifications: () => request<NotificationItem[]>('/api/notifications'),
  markNotificationRead: (id: number) => request<NotificationItem>(`/api/notifications/${id}/read`, { method: 'POST' }),
  parcels: () => request<{ type: 'FeatureCollection'; features: ParcelFeature[] }>('/api/parcels'),
  updateParcel: (id: number, payload: { owner?: string; classification?: string; status?: string; category?: string; record_id?: string | null }) => request<ParcelFeature>(`/api/parcels/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  importParcels: (collection: unknown) => request<{ imported: number }>('/api/parcels/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collection) }),
  versions: (id: string) => request<RecordVersion[]>(`/api/documents/${id}/versions`),
  integrations: () => request<IntegrationStatus[]>('/api/integrations'),
  learningMetrics: () => request<LearningMetrics>('/api/model/metrics'),
  testIntegration: (key: string) => request<{ key: string; connected: boolean; status: number; message: string }>(`/api/integrations/${key}/test`, { method: 'POST' }),
  syncIntegration: (key: string, documentId: string) => request<{ key: string; record_id: string; synchronized: boolean; status: number; message: string }>(`/api/integrations/${key}/sync/${documentId}`, { method: 'POST' }),
  sourceBlobUrl: async (id: string) => {
    const headers = new Headers()
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
    const response = await fetch(`/api/documents/${id}/file`, { headers })
    if (!response.ok) throw new Error('Source document is unavailable')
    return URL.createObjectURL(await response.blob())
  },
  uploadBatch: (files: File[], context: { state: string; district: string; category: string; documentType: string; language: string }) => {
    const form = new FormData()
    files.forEach(file => form.append('files', file))
    appendContext(form, context)
    return request<LandDocument[]>('/api/documents/batch', { method: 'POST', body: form })
  },
  // Returns one record per plot row when the register listed several plots (each becomes
  // its own document) - a single-plot upload still returns an array, just of length 1.
  submitExtraction: (documentId: string, result: OnlineOcrResult) => request<LandDocument[]>(`/api/documents/${documentId}/extraction`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result),
  }),
  failExtraction: (documentId: string, message: string) => request<LandDocument>(`/api/documents/${documentId}/extraction/fail`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }),
  }),
  updateField: (documentId: string, fieldId: number, value: string) => request<LandDocument>(`/api/documents/${documentId}/fields/${fieldId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value, actor: 'browser' }),
  }),
  validate: (documentId: string) => request<LandDocument>(`/api/documents/${documentId}/validate`, { method: 'POST' }),
  approve: (documentId: string) => request<LandDocument>(`/api/documents/${documentId}/approve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actor: 'browser' }),
  }),
  reject: (documentId: string) => request<LandDocument>(`/api/documents/${documentId}/reject`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actor: 'Rejected during verification' }),
  }),
  exportRecords: () => download('/api/export/records.csv', 'dhara-records.csv'),
  exportRecord: (id: string) => download(`/api/integration/records/${id}`, `${id}-canonical.json`),
  exportAudit: () => download('/api/export/audit.csv', 'dhara-audit.csv'),
  exportParcels: () => download('/api/export/parcels.geojson', 'dhara-parcels.geojson'),
  exportCorrections: () => download('/api/export/corrections.jsonl', 'dhara-corrections.jsonl'),
  registryFlags: (status?: string) => request<RegistryFlag[]>(`/api/registry-flags${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  createRegistryFlag: (payload: { district: string; khasra_number: string; flag_type: string; reference: string; notes?: string }) => request<RegistryFlag>('/api/registry-flags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  updateRegistryFlag: (id: number, status: string) => request<RegistryFlag>(`/api/registry-flags/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }),
}
