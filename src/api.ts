import type { LandDocument } from './data'

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
}

export interface AdminUser extends AuthUser {
  id: number
  active: boolean
  created_at: string
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

function appendContext(form: FormData, context: { state: string; district: string; documentType: string; language: string }) {
  form.append('state', context.state)
  form.append('district', context.district)
  form.append('document_type', context.documentType)
  form.append('language', context.language)
}

export const api = {
  hasSession: () => Boolean(accessToken),
  login: async (username: string, password: string) => {
    const response = await request<{ access_token: string; user: AuthUser }>('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
    })
    accessToken = response.access_token
    localStorage.setItem(TOKEN_KEY, accessToken)
    return response.user
  },
  logout: () => {
    accessToken = null
    localStorage.removeItem(TOKEN_KEY)
  },
  me: () => request<AuthUser>('/api/auth/me'),
  users: () => request<AdminUser[]>('/api/users'),
  createUser: (payload: { username: string; display_name: string; password: string; role: AuthUser['role'] }) => request<AdminUser>('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  updateUser: (id: number, payload: { role?: AuthUser['role']; active?: boolean }) => request<AdminUser>(`/api/users/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  health: () => request<{ status: string }>('/api/health'),
  documents: () => request<LandDocument[]>('/api/documents'),
  document: (id: string) => request<LandDocument>(`/api/documents/${id}`),
  stats: () => request<ApiStats>('/api/stats'),
  audit: () => request<AuditEvent[]>('/api/audit?limit=100'),
  auditIntegrity: () => request<AuditIntegrity>('/api/audit/integrity'),
  notifications: () => request<NotificationItem[]>('/api/notifications'),
  markNotificationRead: (id: number) => request<NotificationItem>(`/api/notifications/${id}/read`, { method: 'POST' }),
  parcels: () => request<{ type: 'FeatureCollection'; features: ParcelFeature[] }>('/api/parcels'),
  versions: (id: string) => request<RecordVersion[]>(`/api/documents/${id}/versions`),
  integrations: () => request<IntegrationStatus[]>('/api/integrations'),
  sourceBlobUrl: async (id: string) => {
    const headers = new Headers()
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
    const response = await fetch(`/api/documents/${id}/file`, { headers })
    if (!response.ok) throw new Error('Source document is unavailable')
    return URL.createObjectURL(await response.blob())
  },
  uploadBatch: (files: File[], context: { state: string; district: string; documentType: string; language: string }) => {
    const form = new FormData()
    files.forEach(file => form.append('files', file))
    appendContext(form, context)
    return request<LandDocument[]>('/api/documents/batch', { method: 'POST', body: form })
  },
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
}
