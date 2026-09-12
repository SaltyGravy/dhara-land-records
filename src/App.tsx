import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, AlertTriangle, ArrowLeft, ArrowRight, BarChart3, Bell, Check,
  CheckCircle2, ChevronRight, Clock3, Database, FileCheck2,
  FileSearch, FileText, Filter, FolderArchive, Gauge, Globe2, History,
  Languages, LayoutDashboard, LockKeyhole, LogIn, LogOut, Map, MapPin, Menu, MoreHorizontal,
  PanelLeftClose, Plus, RefreshCcw, ScanLine, Search, Settings, ShieldCheck,
  Sparkles, Upload, UserRound, UsersRound, X, XCircle,
} from 'lucide-react'
import { activity, districts, documents as initialDocuments, extractedFields, type DocumentStatus, type ExtractedField, type LandDocument } from './data'
import { api, type AdminUser, type ApiStats, type AuditEvent, type AuditIntegrity, type AuthUser, type IntegrationStatus, type LearningMetrics, type NotificationItem, type ParcelFeature, type RecordVersion } from './api'

type Page = 'overview' | 'upload' | 'verification' | 'records' | 'gis' | 'audit' | 'settings'

const navigation: { id: Page; label: string; icon: typeof LayoutDashboard; count?: number }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'upload', label: 'Upload & process', icon: Upload },
  { id: 'verification', label: 'Verification queue', icon: FileCheck2, count: 23 },
  { id: 'records', label: 'Land records', icon: FolderArchive },
  { id: 'gis', label: 'Cadastral map', icon: Map },
  { id: 'audit', label: 'Audit trail', icon: History },
]

const titles: Record<Page, { eyebrow: string; title: string; description: string }> = {
  overview: { eyebrow: 'OPERATIONS CENTRE', title: 'Good morning, Priya', description: 'Here is how the digitization programme is progressing today.' },
  upload: { eyebrow: 'DOCUMENT INTAKE', title: 'Upload & process', description: 'Add legacy documents and let the AI pipeline prepare structured records.' },
  verification: { eyebrow: 'HUMAN-IN-THE-LOOP', title: 'Verification workspace', description: 'Review uncertain extractions against the original document.' },
  records: { eyebrow: 'DIGITAL REPOSITORY', title: 'Land records', description: 'Search and manage every processed record in one place.' },
  gis: { eyebrow: 'SPATIAL RECORDS', title: 'Cadastral map', description: 'Explore digitized parcels and their linked ownership records.' },
  audit: { eyebrow: 'GOVERNANCE & COMPLIANCE', title: 'Audit trail', description: 'A persisted history of authenticated system and user activity.' },
  settings: { eyebrow: 'ADMINISTRATION', title: 'Users & security', description: 'Manage authorized officials, access roles, and deployment controls.' },
}

const StatusBadge = ({ status }: { status: DocumentStatus }) => {
  const icon = status === 'Verified' ? <CheckCircle2 size={13} /> : status === 'Needs review' ? <AlertTriangle size={13} /> : status === 'Processing' ? <RefreshCcw size={13} className="spin" /> : <XCircle size={13} />
  return <span className={`status status-${status.toLowerCase().replace(' ', '-')}`}>{icon}{status}</span>
}

function LoginScreen({ onLogin, initialError = '' }: { onLogin: (user: AuthUser) => Promise<void>; initialError?: string }) {
  const [username, setUsername] = useState('admin@dhara.gov.in')
  const [password, setPassword] = useState('Dhara@2026')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(initialError)
  const [ssoConfigured, setSsoConfigured] = useState(false)
  useEffect(() => { api.oidcStatus().then(status => setSsoConfigured(status.configured)).catch(() => undefined) }, [])
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError('')
    try { await onLogin(await api.login(username, password)) }
    catch (loginError) { setError(loginError instanceof Error ? loginError.message : 'Sign in failed') }
    finally { setLoading(false) }
  }
  const startSso = async () => {
    setLoading(true)
    setError('')
    try {
      const { authorization_url } = await api.beginOidc()
      window.location.assign(authorization_url)
    } catch (ssoError) {
      setError(ssoError instanceof Error ? ssoError.message : 'Government SSO could not be started')
      setLoading(false)
    }
  }
  return <main className="login-screen">
    <section className="login-story"><div className="login-brand"><span className="brand-mark"><span>ध</span></span><span className="brand-copy"><b>DHARA</b><small>भूमि अभिलेख</small></span></div><div className="login-message"><span className="eyebrow">INTELLIGENT LAND ADMINISTRATION</span><h1>Trusted records.<br/>Transparent governance.</h1><p>Securely digitize, validate, and connect legacy land records across languages, districts, and cadastral maps.</p><div className="login-assurance"><span><ShieldCheck size={18}/>Encrypted documents</span><span><FileCheck2 size={18}/>Human-verified accuracy</span><span><History size={18}/>Complete audit history</span></div></div><small>Uttar Pradesh Land Records Mission · Authorized access only</small></section>
    <section className="login-panel"><form onSubmit={submit}><div className="login-emblem"><ShieldCheck size={26}/></div><span className="eyebrow">SECURE OFFICIAL PORTAL</span><h2>Sign in to Dhara</h2><p>Use your authorized departmental account.</p>{ssoConfigured && <button type="button" className="btn secondary login-submit" disabled={loading} onClick={startSso}><ShieldCheck size={17}/>Government SSO</button>}<label>Email address<input type="email" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required/></label><label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required/></label>{error && <div className="login-error"><AlertTriangle size={15}/>{error}</div>}<button className="btn primary login-submit" disabled={loading}>{loading ? <><RefreshCcw size={17} className="spin"/>Signing in…</> : <><LogIn size={17}/>Sign in securely</>}</button><a className="citizen-link" href="/citizen"><UserRound size={16}/>Citizen services and request tracking</a><div className="demo-credentials"><strong>Prototype account</strong><span>Administrator credentials are pre-filled until government SSO is configured.</span></div></form></section>
  </main>
}

function CitizenPortal() {
  const [form, setForm] = useState({ request_type: 'Certified copy', record_id: '', applicant_name: '', contact: '', details: '', consent: false })
  const [tracking, setTracking] = useState({ requestId: '', token: '' })
  const [result, setResult] = useState<{ request_id?: string; tracking_token?: string; status: string; resolution?: string } | null>(null)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setLoading(true); setMessage('')
    try { const response = await api.submitCitizenRequest(form); setResult(response); setTracking({ requestId: response.request_id || '', token: response.tracking_token || '' }); setMessage('Request submitted. Save the tracking token; it is shown only once.') }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Request could not be submitted.') }
    finally { setLoading(false) }
  }
  const check = async (event: React.FormEvent) => {
    event.preventDefault(); setLoading(true); setMessage('')
    try { setResult(await api.citizenRequestStatus(tracking.requestId, tracking.token)) }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Request status could not be loaded.') }
    finally { setLoading(false) }
  }
  return <main className="citizen-portal"><header><a className="brand" href="/"><span className="brand-mark"><span>ध</span></span><span className="brand-copy"><b>DHARA</b><small>नागरिक सेवाएं</small></span></a><a className="btn secondary" href="/"><LockKeyhole size={16}/>Official sign-in</a></header><section className="citizen-hero"><span className="eyebrow">CITIZEN LAND RECORD SERVICES</span><h1>Submit and track a land-record request</h1><p>Request a certified copy, check a digitization record, report a correction, or register an ownership dispute without exposing sensitive records publicly.</p></section><section className="citizen-grid"><form className="card citizen-form" onSubmit={submit}><div className="card-heading"><div><span>NEW REQUEST</span><h3>Citizen service application</h3></div><FileText size={20}/></div><label>Request type<select value={form.request_type} onChange={event => setForm({...form, request_type:event.target.value})}><option>Certified copy</option><option>Record status</option><option>Correction request</option><option>Ownership dispute</option></select></label><label>Land record ID (if known)<input placeholder="LR-2026-04182" value={form.record_id} onChange={event => setForm({...form, record_id:event.target.value})}/></label><label>Applicant name<input required value={form.applicant_name} onChange={event => setForm({...form, applicant_name:event.target.value})}/></label><label>Email or mobile number<input required value={form.contact} onChange={event => setForm({...form, contact:event.target.value})}/></label><label>Request details<textarea value={form.details} onChange={event => setForm({...form, details:event.target.value})} rows={4}/></label><label className="consent"><input type="checkbox" checked={form.consent} onChange={event => setForm({...form, consent:event.target.checked})}/><span>I consent to protected processing of the information supplied for this request.</span></label><button className="btn primary" disabled={loading}>{loading ? <RefreshCcw className="spin" size={17}/> : <FileCheck2 size={17}/>}Submit request</button></form><div className="citizen-side"><form className="card citizen-form" onSubmit={check}><div className="card-heading"><div><span>TRACK REQUEST</span><h3>Application status</h3></div><Search size={20}/></div><label>Request ID<input required value={tracking.requestId} onChange={event => setTracking({...tracking, requestId:event.target.value})}/></label><label>Private tracking token<input required type="password" value={tracking.token} onChange={event => setTracking({...tracking, token:event.target.value})}/></label><button className="btn secondary" disabled={loading}>Check status</button></form>{message && <div className="citizen-message"><ShieldCheck size={18}/>{message}</div>}{result && <div className="card citizen-result"><span className="eyebrow">REQUEST STATUS</span><h3>{result.request_id || tracking.requestId}</h3><StatusBadge status={(result.status === 'Resolved' ? 'Verified' : result.status === 'Rejected' ? 'Rejected' : 'Needs review') as DocumentStatus}/>{result.tracking_token && <label>Tracking token<strong>{result.tracking_token}</strong></label>}{result.resolution && <p>{result.resolution}</p>}</div>}</div></section></main>
}

function Sidebar({ page, setPage, collapsed, setCollapsed, mobileOpen, setMobileOpen, user, onLogout, reviewCount }: { page: Page; setPage: (p: Page) => void; collapsed: boolean; setCollapsed: (v: boolean) => void; mobileOpen: boolean; setMobileOpen: (v: boolean) => void; user: AuthUser; onLogout: () => void; reviewCount: number }) {
  const allowedPages: Record<AuthUser['role'], Page[]> = {
    'Administrator': ['overview', 'upload', 'verification', 'records', 'gis', 'audit'],
    'Verification Officer': ['overview', 'verification', 'records', 'gis', 'audit'],
    'Data Operator': ['overview', 'upload', 'records', 'gis'],
    'Auditor': ['overview', 'records', 'gis', 'audit'],
    'Viewer': ['overview', 'records', 'gis'],
  }
  const visibleNavigation = navigation.filter(item => allowedPages[user.role].includes(item.id))
  const initials = user.display_name.split(' ').map(word => word[0]).join('').slice(0, 2).toUpperCase()
  return <>
    {mobileOpen && <button className="mobile-scrim" onClick={() => setMobileOpen(false)} aria-label="Close navigation" />}
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''} ${mobileOpen ? 'mobile-open' : ''}`}>
      <div className="brand-row">
        <button className="brand" onClick={() => setPage('overview')} aria-label="Dhara home">
          <span className="brand-mark"><span>ध</span></span>
          {!collapsed && <span className="brand-copy"><b>DHARA</b><small>भूमि अभिलेख</small></span>}
        </button>
        <button className="mobile-close" onClick={() => setMobileOpen(false)}><X size={19} /></button>
      </div>
      <div className="programme">
        <div className="emblem"><ShieldCheck size={20} /></div>
        {!collapsed && <div><span>Uttar Pradesh</span><small>Land Records Mission</small></div>}
      </div>
      <nav>
        {!collapsed && <p className="nav-title">WORKSPACE</p>}
        {visibleNavigation.map(item => {
          const Icon = item.icon
          return <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => { setPage(item.id); setMobileOpen(false) }} title={collapsed ? item.label : undefined}>
            <Icon size={19} strokeWidth={1.8} />
            {!collapsed && <><span>{item.label}</span>{item.id === 'verification' && reviewCount > 0 && <small className="nav-count">{reviewCount}</small>}</>}
          </button>
        })}
      </nav>
      <div className="sidebar-bottom">
        {user.role === 'Administrator' && <button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')} title={collapsed ? 'Settings' : undefined}><Settings size={19} />{!collapsed && <span>Users & security</span>}</button>}
        <div className="user-card">
          <div className="avatar">{initials}</div>
          {!collapsed && <div><strong>{user.display_name}</strong><span>{user.role}</span></div>}
          {!collapsed && <button className="logout-icon" onClick={onLogout} title="Sign out"><LogOut size={16}/></button>}
        </div>
        <button className="collapse-btn" onClick={() => setCollapsed(!collapsed)}>{collapsed ? <ArrowRight size={18} /> : <><PanelLeftClose size={18} /><span>Collapse menu</span></>}</button>
      </div>
    </aside>
  </>
}

function Header({ page, onMenu, apiOnline, notifications, onNotificationsChanged }: { page: Page; onMenu: () => void; apiOnline: boolean; notifications: NotificationItem[]; onNotificationsChanged: (items: NotificationItem[]) => void }) {
  const [open, setOpen] = useState(false)
  const unread = notifications.filter(item => !item.read).length
  const markRead = async (item: NotificationItem) => {
    if (item.read) return
    try {
      const updated = await api.markNotificationRead(item.id)
      onNotificationsChanged(notifications.map(notification => notification.id === updated.id ? updated : notification))
    } catch { /* A transient notification update must not interrupt the workspace. */ }
  }
  return <header className="topbar">
    <button className="menu-btn" onClick={onMenu}><Menu size={21} /></button>
    <div className="breadcrumb"><span>Dhara</span><ChevronRight size={14} /><b>{navigation.find(n => n.id === page)?.label || titles[page].title}</b></div>
    <div className="top-actions">
      <span className="language" title="Interface language"><Globe2 size={17} /><span>English</span></span>
      <button className="icon-btn notification" onClick={() => setOpen(!open)}><Bell size={19} />{unread > 0 && <i />}</button>
      {open && <div className="notifications popover">
        <div className="popover-head"><strong>Notifications</strong><span>{unread} new</span></div>
        {notifications.length ? notifications.slice(0, 5).map(item => <button className={item.read ? 'notification-row read' : 'notification-row'} key={item.id} onClick={() => markRead(item)}>{item.level === 'warning' ? <AlertTriangle size={16}/> : item.level === 'success' ? <CheckCircle2 size={16}/> : <Database size={16}/>}<span><b>{item.title}</b><small>{item.message}</small></span>{!item.read && <i/>}</button>) : <p><CheckCircle2 size={16}/>You are all caught up.</p>}
      </div>}
      <div className={`system-health ${apiOnline ? '' : 'offline'}`}><i />{apiOnline ? 'API connected' : 'Demo mode'}</div>
    </div>
  </header>
}

function PageHeading({ page, setPage, user }: { page: Page; setPage: (p: Page) => void; user: AuthUser }) {
  const text = titles[page]
  const canUpload = ['Administrator', 'Data Operator'].includes(user.role)
  const canExport = ['Administrator', 'Auditor'].includes(user.role)
  return <div className="page-heading">
    <div><span className="eyebrow">{text.eyebrow}</span><h1>{page === 'overview' ? `Good morning, ${user.display_name.split(' ')[0]}` : text.title}</h1><p>{text.description}</p></div>
    <div className="heading-actions">
      {page === 'overview' && <>{canExport && <button className="btn secondary" onClick={() => api.exportRecords()}><BarChart3 size={17} />Export records</button>}{canUpload && <button className="btn primary" onClick={() => setPage('upload')}><Plus size={18} />Upload records</button>}</>}
      {page === 'records' && <>{canExport && <button className="btn secondary" onClick={() => api.exportRecords()}><FileText size={17}/>Export CSV</button>}{canUpload && <button className="btn primary" onClick={() => setPage('upload')}><Plus size={18} />Add records</button>}</>}
      {page === 'gis' && <button className="btn secondary" onClick={() => api.exportParcels()}><Map size={17}/>Export GeoJSON</button>}
      {page === 'audit' && canExport && <button className="btn secondary" onClick={() => api.exportAudit()}><FileText size={17} />Export log</button>}
    </div>
  </div>
}

function Metric({ title, value, detail, icon: Icon, tone, progress }: { title: string; value: string; detail: string; icon: typeof Activity; tone: string; progress?: number }) {
  return <div className="metric-card card">
    <div className={`metric-icon ${tone}`}><Icon size={20} /></div>
    <div className="metric-top"><span>{title}</span><MoreHorizontal size={18} /></div>
    <strong>{value}</strong>
    {progress !== undefined && <div className="micro-progress"><i style={{ width: `${progress}%` }} /></div>}
    <small>{detail}</small>
  </div>
}

function VolumeChart({ data }: { data?: ApiStats['daily_volume'] }) {
  const values = data?.length ? data.map(item => item.count) : [48, 61, 55, 76, 68, 88, 82, 105, 96, 121, 113, 134, 128, 147]
  const max = Math.max(...values, 1)
  const chartDivisor = Math.max(values.length - 1, 1)
  const points = values.map((v, i) => `${(i / chartDivisor) * 100},${100 - (v / max) * 82}`).join(' ')
  const area = `0,100 ${points} 100,100`
  return <div className="chart-card card">
    <div className="card-heading"><div><span>PROCESSING VOLUME</span><h3>Documents digitized</h3></div><span className="period">Last 14 days</span></div>
    <div className="chart-summary"><strong>{values.reduce((sum, value) => sum + value, 0).toLocaleString('en-IN')}</strong><span>LIVE</span><small>records added in this period</small></div>
    <div className="line-chart">
      <div className="y-labels"><span>{max}</span><span>{Math.round(max*.66)}</span><span>{Math.round(max*.33)}</span><span>0</span></div>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Documents processed over 14 days">
        <defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#187667" stopOpacity=".22"/><stop offset="100%" stopColor="#187667" stopOpacity="0"/></linearGradient></defs>
        <polygon points={area} fill="url(#area)" />
        <polyline points={points} fill="none" stroke="#187667" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        {values.map((v, i) => <circle key={i} cx={(i / chartDivisor) * 100} cy={100 - (v / max) * 82} r="1.1" fill="#fff" stroke="#187667" strokeWidth=".7" vectorEffect="non-scaling-stroke" />)}
      </svg>
      <div className="x-labels"><span>{data?.[0]?.date.slice(5) || '28 Aug'}</span><span>{data?.[3]?.date.slice(5) || '31 Aug'}</span><span>{data?.[6]?.date.slice(5) || '3 Sep'}</span><span>{data?.[9]?.date.slice(5) || '6 Sep'}</span><span>{data?.[13]?.date.slice(5) || '10 Sep'}</span></div>
    </div>
  </div>
}

function AccuracyCard({ stats }: { stats: ApiStats | null }) {
  const average = stats?.average_confidence ?? 94.2
  const total = stats?.total_records || 1
  const verifiedPercent = Math.round(((stats?.verified || 0) / total) * 100)
  return <div className="accuracy-card card">
    <div className="card-heading"><div><span>AI PERFORMANCE</span><h3>Extraction accuracy</h3></div><Gauge size={18} className="heading-icon"/></div>
    <div className="accuracy-content">
      <div className="donut" style={{background:`conic-gradient(var(--green) 0 ${average}%, #e9ece9 ${average}% 100%)`}}><div><strong>{average}</strong><span>%</span><small>Overall</small></div></div>
      <div className="accuracy-list">
        <div><i className="dot teal"/><span>Verified</span><b>{stats?.verified ?? '—'}</b></div>
        <div><i className="dot orange"/><span>Needs review</span><b>{stats?.needs_review ?? '—'}</b></div>
        <div><i className="dot blue"/><span>Processing</span><b>{stats?.processing ?? '—'}</b></div>
      </div>
    </div>
    <div className="insight"><Sparkles size={16} /><span><b>{verifiedPercent}%</b> of persisted records are verified</span></div>
  </div>
}

function DistrictProgress({ data, onViewAll }: { data?: ApiStats['district_progress']; onViewAll: () => void }) {
  const rows = data?.length ? data.map((item, index) => ({name:item.name,processed:item.processed,total:data.reduce((sum,row)=>sum+row.processed,0),color:['#187667','#d87932','#5c7696','#9b6d84'][index%4]})) : districts
  return <div className="district-card card">
    <div className="card-heading"><div><span>DIGITIZATION COVERAGE</span><h3>District progress</h3></div><button className="link-btn" onClick={onViewAll}>View records <ArrowRight size={15} /></button></div>
    <div className="district-list">
      {rows.map(d => {
        const percent = Math.round(d.processed / d.total * 100)
        return <div key={d.name} className="district-row"><div><strong>{d.name}</strong><span>{d.processed.toLocaleString('en-IN')} processed</span></div><div className="progress"><i style={{ width: `${percent}%`, background: d.color }} /></div><b>{percent}%</b></div>
      })}
    </div>
  </div>
}

function RecentTable({ docs, setPage, onReview }: { docs: LandDocument[]; setPage: (p: Page) => void; onReview: (id: string) => void }) {
  return <div className="recent-card card">
    <div className="card-heading"><div><span>RECENT ACTIVITY</span><h3>Latest documents</h3></div><button className="link-btn" onClick={() => setPage('records')}>View all records <ArrowRight size={15} /></button></div>
    <div className="table-scroll"><table>
      <thead><tr><th>Record</th><th>Location</th><th>Language</th><th>Confidence</th><th>Status</th><th>Updated</th><th /></tr></thead>
      <tbody>{docs.slice(0, 5).map(doc => <tr key={doc.id} onClick={() => doc.status === 'Needs review' && onReview(doc.id)} className={doc.status === 'Needs review' ? 'clickable' : ''}>
        <td><div className="record-cell"><span className="file-icon"><FileText size={17} /></span><div><strong>{doc.id}</strong><span>{doc.document}</span></div></div></td>
        <td><strong className="medium">{doc.location}</strong></td>
        <td><span className="language-tag">{doc.language}</span></td>
        <td>{doc.status === 'Processing' ? '—' : <div className="confidence"><div><i style={{ width: `${doc.confidence}%` }} /></div><span>{doc.confidence}%</span></div>}</td>
        <td><StatusBadge status={doc.status} /></td><td className="muted">{doc.updated}</td><td><ChevronRight size={16} /></td>
      </tr>)}</tbody>
    </table></div>
  </div>
}

function Overview({ docs, setPage, stats, onReview }: { docs: LandDocument[]; setPage: (p: Page) => void; stats: ApiStats | null; onReview: (id: string) => void }) {
  return <>
    <section className="metrics-grid">
      <Metric title="Total records" value={(stats?.total_records ?? 48392).toLocaleString('en-IN')} detail={stats ? 'Persisted in the records database' : '+1,284 processed this month'} icon={FolderArchive} tone="teal" />
      <Metric title="Awaiting verification" value={String(stats?.needs_review ?? 23)} detail={stats ? `${stats.processing} currently processing` : '8 marked high priority'} icon={FileSearch} tone="orange" progress={35} />
      <Metric title="Extraction confidence" value={`${stats?.average_confidence ?? 91.8}%`} detail={stats ? `${stats.verified} records verified` : '+3.2% from last month'} icon={ShieldCheck} tone="blue" />
      <Metric title="Avg. processing time" value="1m 42s" detail="18 seconds faster this week" icon={Gauge} tone="purple" />
    </section>
    <section className="analytics-grid"><VolumeChart data={stats?.daily_volume}/><AccuracyCard stats={stats}/></section>
    <section className="coverage-grid"><DistrictProgress data={stats?.district_progress} onViewAll={() => setPage('records')}/>
      <div className="attention-card card"><div className="card-heading"><div><span>NEEDS ATTENTION</span><h3>Verification summary</h3></div><span className="alert-count">{stats?.needs_review ?? 23}</span></div>
        <div className="attention-list"><div><span className="attention-icon red"><AlertTriangle size={17}/></span><p><b>{docs.filter(doc => doc.status === 'Needs review' && doc.confidence < 75).length} high-priority records</b><small>Confidence below 75%</small></p><ChevronRight size={17}/></div><div><span className="attention-icon orange"><Languages size={17}/></span><p><b>{docs.filter(doc => doc.language === 'Unknown').length} unknown scripts</b><small>Manual script review needed</small></p><ChevronRight size={17}/></div><div><span className="attention-icon blue"><FileCheck2 size={17}/></span><p><b>{docs.reduce((sum, doc) => sum + (doc.validation_issues?.length || 0), 0)} validation issues</b><small>Required fields or possible duplicates</small></p><ChevronRight size={17}/></div></div>
        <button className="btn secondary full" onClick={() => setPage('verification')}>Open verification queue <ArrowRight size={16}/></button>
      </div>
    </section>
    <RecentTable docs={docs} setPage={setPage} onReview={onReview} />
  </>
}

function UploadPage({ onAdded }: { onAdded: (d: LandDocument) => void }) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])
  const [drag, setDrag] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [step, setStep] = useState(0)
  const [error, setError] = useState('')
  const [district, setDistrict] = useState('Varanasi')
  const [documentType, setDocumentType] = useState('Khasra / Khatauni')
  const [language, setLanguage] = useState('Auto-detect')
  const [completedCount, setCompletedCount] = useState(0)
  const [stageDetail, setStageDetail] = useState('Ready for secure intake')
  const steps = ['Image enhancement', 'Script detection', 'OCR & handwriting', 'Field extraction', 'Rule validation']

  const acceptFiles = (selected?: FileList | File[]) => { if (selected) { setFiles(Array.from(selected).slice(0, 20)); setStep(0); setCompletedCount(0) } }
  const start = async () => {
    if (!files.length) return
    setStep(0)
    setError('')
    setProcessing(true)
    try {
      const queued = await api.uploadBatch(files, { state: 'Uttar Pradesh', district, documentType, language })
      const { recognizeLandRecord } = await import('./ocr')
      const processed: LandDocument[] = []
      const failures: string[] = []
      for (let index = 0; index < queued.length; index += 1) {
        const queuedDocument = queued[index]
        let document = queuedDocument
        try {
          const result = await recognizeLandRecord(files[index], language, district, (stage, percent) => {
            setStageDetail(`${files[index].name}: ${stage}`)
            setStep(Math.min(steps.length - 1, Math.floor(percent / (100 / steps.length))))
          })
          document = await api.submitExtraction(queuedDocument.id, result)
          if (result.warnings.length) failures.push(...result.warnings.map(warning => `${files[index].name}: ${warning}`))
        } catch (ocrError) {
          const message = ocrError instanceof Error ? ocrError.message : 'Online OCR failed'
          failures.push(`${files[index].name}: ${message}`)
          document = await api.failExtraction(queuedDocument.id, message).catch(() => queuedDocument)
        }
        processed.push(document)
        setCompletedCount(processed.length)
      }
      setStep(steps.length)
      setStageDetail('Processing complete')
      processed.forEach(onAdded)
      if (failures.length) setError(`Completed with review notes: ${failures.slice(0, 3).join(' · ')}`)
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Upload failed')
    } finally {
      setProcessing(false)
    }
  }

  return <div className="upload-layout">
    <div className="upload-main card">
      <div className="section-title"><span className="number">1</span><div><h3>Add source documents</h3><p>PDF, PNG, JPG or TIFF · Maximum 50 MB per file</p></div></div>
      {!files.length ? <div className={`dropzone ${drag ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)} onDrop={e => { e.preventDefault(); setDrag(false); acceptFiles(e.dataTransfer.files) }} onClick={() => fileInput.current?.click()}>
        <input ref={fileInput} type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff" onChange={e => acceptFiles(e.target.files || undefined)} hidden />
        <span className="upload-art"><Upload size={27} /><i /></span><h3>Drop land records here</h3><p>Choose up to 20 files for secure batch processing</p><button className="btn secondary">Choose files</button>
      </div> : <div className="selected-file batch-selection">
        <span className="file-large"><FileText size={27}/></span><div><strong>{files.length === 1 ? files[0].name : `${files.length} documents selected`}</strong><span>{(files.reduce((total, item) => total + item.size, 0) / 1024 / 1024).toFixed(2)} MB total · Ready to process</span>{files.length > 1 && <small>{files.slice(0, 3).map(item => item.name).join(' · ')}{files.length > 3 ? ` · +${files.length - 3} more` : ''}</small>}</div><button onClick={() => { setFiles([]); setProcessing(false) }}><X size={18}/></button>
      </div>}
      <div className="section-divider" />
      <div className="section-title"><span className="number">2</span><div><h3>Record context</h3><p>Helps the AI apply the correct language and validation rules</p></div></div>
      <div className="form-grid"><label>State<select defaultValue="Uttar Pradesh"><option>Uttar Pradesh</option></select></label><label>District<select value={district} onChange={e => setDistrict(e.target.value)}><option>Varanasi</option><option>Lucknow</option><option>Prayagraj</option></select></label><label>Document type<select value={documentType} onChange={e => setDocumentType(e.target.value)}><option>Khasra / Khatauni</option><option>Jamabandi</option><option>Mutation register</option><option>Cadastral map</option></select></label><label>Primary language<select value={language} onChange={e => setLanguage(e.target.value)}>{['Auto-detect','Assamese','Bengali','English','Gujarati','Hindi','Kannada','Malayalam','Marathi','Odia','Punjabi','Sanskrit','Tamil','Telugu','Urdu'].map(option => <option key={option}>{option}</option>)}</select></label></div>
      {error && <div className="upload-error"><AlertTriangle size={16}/>{error}</div>}
      <div className="upload-footer"><span><LockKeyhole size={15}/>AES-256-GCM protected storage · SHA-256 integrity · Content validation</span><button className="btn primary" disabled={!files.length || processing} onClick={start}>{processing ? <><RefreshCcw className="spin" size={17}/>Processing {completedCount}/{files.length}…</> : <><Sparkles size={17}/>Process {files.length > 1 ? `${files.length} documents` : 'document'}</>}</button></div>
    </div>
    <aside className="pipeline-card card"><div className="card-heading"><div><span>AI PIPELINE</span><h3>What happens next</h3></div></div>
      <div className="pipeline">{steps.map((s, i) => <div key={s} className={`${processing && i === step ? 'current' : ''} ${step > i ? 'complete' : ''}`}><span>{step > i ? <Check size={15}/> : i + 1}</span><div><strong>{s}</strong><small>{['Clean, deskew and restore scan','Identify Hindi, Urdu or English','Read printed and handwritten text','Map text to land-record fields','Cross-check values and duplicates'][i]}</small></div>{processing && i === step && <RefreshCcw size={15} className="spin"/>}</div>)}</div>
      {processing && <div className="overall-progress"><div><span>{stageDetail}</span><b>{Math.min(Math.round(step / steps.length * 100), 99)}%</b></div><div><i style={{ width: `${Math.min((step + .4) / steps.length * 100, 99)}%` }}/></div></div>}
      {!processing && step >= steps.length && <div className="success-box"><CheckCircle2 size={19}/><div><strong>Processing complete</strong><span>Record added to verification queue.</span></div></div>}
      <div className="privacy-note"><ShieldCheck size={19}/><div><strong>Protected document handling</strong><span>Files are content-validated, encrypted at rest, and every action is attributed in the audit log.</span></div></div>
    </aside>
  </div>
}

function DocumentPreview({ document }: { document?: LandDocument }) {
  const [sourceUrl, setSourceUrl] = useState('')
  const [sourceError, setSourceError] = useState('')
  const [zoom, setZoom] = useState(92)
  useEffect(() => {
    let active = true
    let createdUrl = ''
    setSourceUrl('')
    setSourceError('')
    if (document?.file_url) {
      api.sourceBlobUrl(document.id).then(url => { if (active) { createdUrl = url; setSourceUrl(url) } else URL.revokeObjectURL(url) }).catch(error => active && setSourceError(error instanceof Error ? error.message : 'Source unavailable'))
    }
    return () => { active = false; if (createdUrl) URL.revokeObjectURL(createdUrl) }
  }, [document?.id, document?.file_url])
  if (document?.file_url) {
    const isPdf = document.filename?.toLowerCase().endsWith('.pdf')
    return <div className="document-preview actual-preview">
      <div className="preview-toolbar"><span>Uploaded source · {document.filename}</span><span>{document.ocr_engine}</span></div>
      {!sourceUrl && !sourceError && <div className="source-loading"><RefreshCcw className="spin" size={20}/>Decrypting source document…</div>}
      {sourceError && <div className="source-loading error"><AlertTriangle size={20}/>{sourceError}</div>}
      {sourceUrl && (isPdf ? <object data={sourceUrl} type="application/pdf"><a href={sourceUrl} target="_blank" rel="noreferrer">Open source PDF</a></object> : <img src={sourceUrl} alt={`Uploaded land record ${document.filename}`} />)}
    </div>
  }
  return <div className="document-preview">
    <div className="preview-toolbar"><span>Page 1 of 2</span><div><button onClick={() => setZoom(value => Math.max(60, value - 10))} aria-label="Zoom out">−</button><span>{zoom}%</span><button onClick={() => setZoom(value => Math.min(140, value + 10))} aria-label="Zoom in">+</button></div></div>
    <div className="paper-wrap"><div className="paper" style={{transform:`scale(${zoom / 100})`, transformOrigin:'top center'}}>
      <div className="paper-stamp">राजस्व<br/>अभिलेख</div><p className="paper-code">प्रपत्र पी-11</p><h2>खसरा / खतौनी अभिलेख</h2><p className="paper-sub">ग्राम: बड़ागाँव&nbsp;&nbsp; तहसील: पिण्डरा&nbsp;&nbsp; जिला: वाराणसी</p>
      <div className="paper-rule"/><div className="paper-meta"><span>फसली वर्ष: १४११-१४१६</span><span>खाता संख्या: ०२४९१</span></div>
      <table><thead><tr><th>खसरा सं.</th><th>खातेदार का नाम</th><th>भूमि का प्रकार</th><th>क्षेत्रफल</th></tr></thead><tbody><tr><td>८८/१</td><td>सुनीता देवी<br/><small>पत्नी राम कुमार</small></td><td>कृषि सिंचित</td><td>१.३७ हे०</td></tr><tr><td>८९/२</td><td>—</td><td>परती</td><td>०.२४ हे०</td></tr></tbody></table>
      <p className="handwriting">नामांतरण आदेश संख्या ११७ के अनुसार संशोधित</p><div className="signature"><span>लेखपाल हस्ताक्षर</span><i /></div>
      <div className="highlight h1"/><div className="highlight h2"/><div className="highlight h3"/>
    </div></div>
  </div>
}

function VerificationPage({ document, onVerified, onRejected, onBack, apiOnline }: { document?: LandDocument; onVerified: (id: string) => Promise<void>; onRejected: (id: string) => Promise<void>; onBack: () => void; apiOnline: boolean }) {
  const [fields, setFields] = useState<ExtractedField[]>(document?.fields?.length ? document.fields : extractedFields)
  const persistedValues = useRef<Record<number, string>>({})
  const [approved, setApproved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [currentIssues, setCurrentIssues] = useState(document?.validation_issues || [])
  useEffect(() => {
    const nextFields = document?.fields?.length ? document.fields : extractedFields
    setFields(nextFields)
    persistedValues.current = Object.fromEntries(nextFields.filter(field => field.id).map(field => [field.id as number, field.value]))
    setApproved(document?.status === 'Verified')
    setCurrentIssues(document?.validation_issues || [])
  }, [document])
  const issues = currentIssues
  const flagged = Math.max(fields.filter(f => f.confidence < 80).length, issues.length)
  const confidence = document?.confidence ?? 82.1
  const saveField = async (field: ExtractedField) => {
    if (!apiOnline || !document || !field.id) return
    if (persistedValues.current[field.id] === field.value) return
    try {
      const updated = await api.updateField(document.id, field.id, field.value)
      setFields(updated.fields || fields)
      setCurrentIssues(updated.validation_issues || [])
      persistedValues.current[field.id] = field.value
    } catch (fieldError) {
      setError(fieldError instanceof Error ? fieldError.message : 'Could not save correction')
    }
  }
  const approve = async () => {
    if (!document) return
    setSaving(true)
    setError('')
    try {
      for (const field of fields) await saveField(field)
      await onVerified(document.id)
      setApproved(true)
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : 'Approval failed')
    } finally {
      setSaving(false)
    }
  }
  const reject = async () => {
    if (!document) return
    setSaving(true)
    setError('')
    try { await onRejected(document.id); onBack() }
    catch (rejectionError) { setError(rejectionError instanceof Error ? rejectionError.message : 'Rejection failed') }
    finally { setSaving(false) }
  }
  return <div className="verification-shell">
    <div className="verify-bar"><div><button className="icon-btn" onClick={onBack} aria-label="Back to records"><ArrowLeft size={18}/></button><div><span>Verification queue · Version {document?.version || 1}</span><strong>{document?.id || 'No record'} · {document?.type || 'Land record'}</strong></div></div><div className="verify-progress"><span>Fields requiring review</span><div><i style={{width:`${Math.max(5, 100 - flagged * 10)}%`}}/></div><b>{flagged}</b></div><div><button className="btn danger-ghost" disabled={saving || !document || approved} onClick={reject}>Reject</button><button className="btn primary" disabled={approved || saving || !document} onClick={approve}>{approved ? <><CheckCircle2 size={17}/>Approved</> : saving ? <><RefreshCcw className="spin" size={17}/>Saving…</> : <><Check size={17}/>Approve record</>}</button></div></div>
    {error && <div className="inline-error"><AlertTriangle size={15}/>{error}</div>}
    <div className="verify-workspace"><div className="document-panel"><div className="panel-label"><span>ORIGINAL DOCUMENT</span><span className="language-tag">{document?.language || 'Hindi'} · {document?.ocr_engine || 'Sample'}</span></div><DocumentPreview document={document} /></div>
      <div className="fields-panel"><div className="panel-label"><span>EXTRACTED INFORMATION</span><span className="flag-label"><AlertTriangle size={14}/>{flagged} fields need review</span></div>
        <div className="record-overview"><div><span>AI confidence</span><strong>{confidence}%</strong></div><div><span>Validation</span><strong className={issues.length ? 'warning-text' : 'success-text'}>{issues.length ? `${issues.length} issues` : 'Passed'}</strong></div><div><span>Duplicate check</span><strong className={issues.some(issue => issue.code === 'possible_duplicate') ? 'warning-text' : 'success-text'}>{issues.some(issue => issue.code === 'possible_duplicate') ? 'Possible match' : 'Clear'}</strong></div></div>
        {issues.length > 0 && <div className="validation-list">{issues.map((issue, index) => <div key={`${issue.code}-${index}`} className={issue.severity}><AlertTriangle size={15}/><div><strong>{issue.field}</strong><span>{issue.message}</span></div></div>)}</div>}
        <div className="field-list">{fields.map((field, i) => <label key={field.id || field.label} className={field.confidence < 80 ? 'flagged-field' : ''}><div><span>{field.label}</span><span className={`score ${field.confidence < 80 ? 'low' : field.confidence < 90 ? 'medium' : ''}`}>{field.confidence}%</span></div><div className="field-input"><input value={field.value} placeholder="Not detected — enter value" onChange={e => setFields(fs => fs.map((f, j) => j === i ? {...f, value: e.target.value, valid: Boolean(e.target.value)} : f))} onBlur={() => saveField(fields[i])}/>{field.valid ? <CheckCircle2 size={18}/> : <AlertTriangle size={18}/>}</div><small>Source: {field.original}</small>{!field.valid && <p>{field.label === 'Mutation reference' ? 'Reference is missing or requires confirmation.' : 'Extracted value requires confirmation.'}</p>}</label>)}</div>
      </div>
    </div>
  </div>
}

function RecordDetails({ document, user, onClose, onReview }: { document: LandDocument; user: AuthUser; onClose: () => void; onReview: (id: string) => void }) {
  const [versions, setVersions] = useState<RecordVersion[]>([])
  const [sourceError, setSourceError] = useState('')
  const canReview = ['Administrator', 'Verification Officer'].includes(user.role)
  const canSeeVersions = ['Administrator', 'Verification Officer', 'Auditor'].includes(user.role)
  useEffect(() => {
    setVersions([])
    if (canSeeVersions) api.versions(document.id).then(setVersions).catch(() => undefined)
  }, [document.id, canSeeVersions])
  const openSource = async () => {
    const sourceWindow = window.open('', '_blank')
    setSourceError('')
    try {
      const url = await api.sourceBlobUrl(document.id)
      if (sourceWindow) sourceWindow.location.href = url
      else window.location.href = url
      window.setTimeout(() => URL.revokeObjectURL(url), 60000)
    } catch (error) {
      sourceWindow?.close()
      setSourceError(error instanceof Error ? error.message : 'Source document is unavailable')
    }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <section className="record-modal" role="dialog" aria-modal="true" aria-label={`Record ${document.id}`}>
      <div className="record-modal-head"><div><span className="eyebrow">COMPLETE LAND RECORD</span><h2>{document.id}</h2><p>{document.document} · {document.location}</p></div><button className="icon-btn" onClick={onClose} aria-label="Close record"><X size={18}/></button></div>
      <div className="record-modal-summary"><StatusBadge status={document.status}/><span>{document.confidence}% confidence</span><span>{document.language}</span><span>Version {document.version || 1}</span></div>
      {sourceError && <div className="upload-error"><AlertTriangle size={15}/>{sourceError}</div>}
      <div className="record-modal-fields">{document.fields?.map(field => <div key={field.id || field.label}><span>{field.label}</span><strong>{field.value || 'Not recorded'}</strong><small>{field.confidence}% confidence</small></div>)}</div>
      {canSeeVersions && <div className="version-history"><span className="eyebrow">VERSION HISTORY</span>{versions.length ? versions.slice(0, 5).map(version => <div key={`${version.version}-${version.created_at}`}><History size={15}/><p><b>Version {version.version} · {version.action}</b><small>{version.actor} · {new Date(version.created_at).toLocaleString('en-IN')}</small></p></div>) : <p className="muted">No corrections or decisions have been recorded yet.</p>}</div>}
      <div className="record-modal-actions"><button className="btn secondary" onClick={() => api.exportRecord(document.id)}><Database size={16}/>Canonical JSON</button>{document.file_url && <button className="btn secondary" onClick={openSource}><FileSearch size={16}/>Open source</button>}{document.status === 'Needs review' && canReview && <button className="btn primary" onClick={() => { onClose(); onReview(document.id) }}><FileCheck2 size={16}/>Review & correct</button>}</div>
    </section>
  </div>
}

function RecordsPage({ docs, onReview, onOpen }: { docs: LandDocument[]; onReview: (id: string) => void; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('All statuses')
  const filtered = useMemo(() => docs.filter(d => `${d.id} ${d.owner} ${d.location} ${d.survey}`.toLowerCase().includes(query.toLowerCase()) && (status === 'All statuses' || d.status === status)), [docs, query, status])
  return <div className="records-card card"><div className="records-tools"><div className="search-box"><Search size={18}/><input placeholder="Search owner, record ID, survey number or village…" value={query} onChange={e => setQuery(e.target.value)}/><kbd>⌘ K</kbd></div><label className="filter-select"><Filter size={16}/><select className="select-button" value={status} onChange={e => setStatus(e.target.value)}><option>All statuses</option><option>Verified</option><option>Needs review</option><option>Processing</option><option>Rejected</option></select></label></div>
    <div className="records-summary"><span><b>{filtered.length}</b> records shown</span><span>Repository total: <b>{docs.length.toLocaleString('en-IN')}</b></span></div>
    <div className="table-scroll"><table className="records-table"><thead><tr><th>Record & owner</th><th>Survey / Khasra</th><th>Location</th><th>Type</th><th>Confidence</th><th>Status</th><th /></tr></thead><tbody>{filtered.map(doc => <tr key={doc.id} className="clickable" onClick={() => onOpen(doc.id)}><td><div className="record-cell"><span className="file-icon"><FileText size={17}/></span><div><strong>{doc.id}</strong><span>{doc.owner}</span></div></div></td><td><b>{doc.survey}</b></td><td><div className="stack"><b>{doc.location.split(',')[0]}</b><span>{doc.district} district</span></div></td><td>{doc.type}</td><td>{doc.confidence ? <div className="confidence"><div><i style={{width:`${doc.confidence}%`}}/></div><span>{doc.confidence}%</span></div> : '—'}</td><td><StatusBadge status={doc.status}/></td><td><button className="icon-btn" onClick={event => { event.stopPropagation(); doc.status === 'Needs review' ? onReview(doc.id) : onOpen(doc.id) }} aria-label={doc.status === 'Needs review' ? 'Review record' : 'Open record'}><ChevronRight size={17}/></button></td></tr>)}</tbody></table></div>
    {filtered.length === 0 && <div className="empty"><FileSearch size={30}/><h3>No matching records</h3><p>Try a different owner, location, or status.</p></div>}
    <div className="pagination"><span>Showing 1–{filtered.length} of {docs.length} records</span><div><button disabled><ArrowLeft size={16}/></button><button className="selected">1</button><button disabled><ArrowRight size={16}/></button></div></div>
  </div>
}

function GisPage({ onOpenRecord, canEdit, records }: { onOpenRecord: (id: string) => void; canEdit: boolean; records: LandDocument[] }) {
  const [parcels, setParcels] = useState<ParcelFeature[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [zoom, setZoom] = useState(1)
  const [editing, setEditing] = useState(false)
  const [message, setMessage] = useState('')
  const [form, setForm] = useState({ owner: '', classification: '', status: 'Needs review', record_id: '' })
  const importInput = useRef<HTMLInputElement>(null)
  const loadParcels = () => api.parcels().then(collection => { setParcels(collection.features); setSelectedId(current => current ?? collection.features[0]?.id ?? null) })
  useEffect(() => { loadParcels().catch(() => undefined) }, [])
  const filtered = parcels.filter(parcel => `${parcel.properties.khasra} ${parcel.properties.owner} ${parcel.properties.village}`.toLowerCase().includes(query.toLowerCase()))
  const selected = parcels.find(parcel => parcel.id === selectedId) || filtered[0]
  useEffect(() => {
    if (selected) setForm({ owner: selected.properties.owner, classification: selected.properties.classification, status: selected.properties.status, record_id: selected.properties.record_id || '' })
  }, [selected?.id])
  const allCoordinates = parcels.flatMap(parcel => parcel.geometry.coordinates[0])
  const xs = allCoordinates.map(point => point[0]), ys = allCoordinates.map(point => point[1])
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  const points = (parcel: ParcelFeature) => parcel.geometry.coordinates[0].map(([x,y]) => `${25 + ((x-minX)/(maxX-minX || 1))*450},${25 + ((maxY-y)/(maxY-minY || 1))*390}`).join(' ')
  const centre = (parcel: ParcelFeature) => {
    const coordinates = points(parcel).split(' ').map(value => value.split(',').map(Number))
    return { x: coordinates.reduce((sum, point) => sum + point[0], 0) / coordinates.length, y: coordinates.reduce((sum, point) => sum + point[1], 0) / coordinates.length }
  }
  const saveParcel = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!selected) return
    setMessage('')
    try {
      const updated = await api.updateParcel(selected.id, { ...form, record_id: form.record_id || null })
      setParcels(current => current.map(parcel => parcel.id === updated.id ? updated : parcel))
      setEditing(false)
      setMessage('Parcel and record link saved.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Parcel could not be updated.') }
  }
  const importGeoJson = async (file?: File) => {
    if (!file) return
    setMessage('Validating cadastral GeoJSON…')
    try {
      const result = await api.importParcels(JSON.parse(await file.text()))
      await loadParcels()
      setMessage(`${result.imported} validated parcel boundaries imported.`)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'GeoJSON import failed.') }
    if (importInput.current) importInput.current.value = ''
  }
  return <div className="gis-shell card"><div className="map-toolbar"><div className="search-box"><Search size={17}/><input placeholder="Find village, khasra or owner…" value={query} onChange={event => setQuery(event.target.value)}/></div><div><span className="parcel-count"><Filter size={16}/>{filtered.length} parcels</span>{canEdit && <><input ref={importInput} type="file" accept=".geojson,.json,application/geo+json,application/json" hidden onChange={event => importGeoJson(event.target.files?.[0])}/><button className="btn secondary" onClick={() => importInput.current?.click()}><Upload size={16}/>Import</button></>}<button className="btn secondary" onClick={() => api.exportParcels()}><MapPin size={16}/>GeoJSON</button></div></div>
    {message && <div className="gis-message">{message}</div>}
    <div className="map-body"><div className="map-canvas"><div className="road horizontal"><span>ग्राम मार्ग</span></div><div className="road vertical"/>{parcels.length ? <svg viewBox="0 0 500 450" preserveAspectRatio="xMidYMid meet" style={{transform:`scale(${zoom})`}}>{filtered.map(parcel => { const label = centre(parcel); return <g key={parcel.id} onClick={() => { setSelectedId(parcel.id); setEditing(false) }} className={`parcel ${selected?.id === parcel.id ? 'selected' : ''} ${parcel.properties.status === 'Needs review' ? 'needs-review' : ''}`}><polygon points={points(parcel)}/><text x={label.x} y={label.y}>{parcel.properties.khasra}</text></g> })}</svg> : <div className="map-loading"><RefreshCcw className="spin"/>Loading cadastral parcels…</div>}<div className="map-controls"><button onClick={() => setZoom(value => Math.min(1.6, value + .15))} aria-label="Zoom in">+</button><button onClick={() => setZoom(value => Math.max(.7, value - .15))} aria-label="Zoom out">−</button></div><div className="map-legend"><span><i className="verified-land"/>Verified</span><span><i className="review-land"/>Needs review</span><span><i className="selected-land"/>Selected</span></div></div>
      {selected && <aside className="parcel-panel"><div className="parcel-head"><span className="eyebrow">SELECTED PARCEL</span><h2>Khasra {selected.properties.khasra}</h2><StatusBadge status={selected.properties.status as DocumentStatus}/></div>{editing ? <form className="parcel-edit-form" onSubmit={saveParcel}><label>Recorded owner<input value={form.owner} onChange={event => setForm({...form, owner:event.target.value})} required/></label><label>Classification<input value={form.classification} onChange={event => setForm({...form, classification:event.target.value})} required/></label><label>Status<select value={form.status} onChange={event => setForm({...form, status:event.target.value})}><option>Verified</option><option>Needs review</option><option>Rejected</option></select></label><label>Linked record<select value={form.record_id} onChange={event => setForm({...form, record_id:event.target.value})}><option value="">Not linked</option>{records.map(record => <option key={record.id}>{record.id}</option>)}</select></label><div><button type="button" className="btn secondary" onClick={() => setEditing(false)}>Cancel</button><button className="btn primary">Save parcel</button></div></form> : <><div className="parcel-details"><label>Recorded owner<strong>{selected.properties.owner}</strong></label><label>Area<strong>{selected.properties.area} ha</strong></label><label>Classification<strong>{selected.properties.classification}</strong></label><label>Village<strong>{selected.properties.village}</strong></label><label>Tehsil / District<strong>{selected.properties.tehsil} / {selected.properties.district}</strong></label><label>Linked record<strong className="link-text">{selected.properties.record_id || 'Not linked'}</strong></label></div><div className="boundary-check"><CheckCircle2 size={19}/><div><strong>Validated GeoJSON boundary</strong><span>Parcel geometry is loaded from the spatial records API.</span></div></div>{canEdit && <button className="btn secondary full" onClick={() => setEditing(true)}><Settings size={16}/>Edit and link parcel</button>}<button className="btn primary full" disabled={!selected.properties.record_id} onClick={() => selected.properties.record_id && onOpenRecord(selected.properties.record_id)}><FileText size={16}/>{selected.properties.record_id ? 'Open complete record' : 'No linked record'}</button></>}</aside>}
    </div>
  </div>
}

function AuditPage({ events, integrity, canExport }: { events: AuditEvent[]; integrity: AuditIntegrity | null; canExport: boolean }) {
  const [query, setQuery] = useState('')
  const [eventType, setEventType] = useState('All activity')
  const [period, setPeriod] = useState('30')
  const [expanded, setExpanded] = useState<number | null>(null)
  const fallbackEvents = activity.map((item, index) => ({ id: index, event_type: item.type, actor: item.person, action: item.action, document_id: null, details: '', created_at: new Date(Date.now() - index * 600000).toISOString() }))
  const baseEvents = events.length ? events : fallbackEvents
  const eventTypes = Array.from(new Set(baseEvents.map(event => event.event_type))).sort()
  const visibleEvents = baseEvents.filter(event => {
    const matchesQuery = `${event.actor} ${event.action} ${event.document_id || ''} ${event.details}`.toLowerCase().includes(query.toLowerCase())
    const matchesType = eventType === 'All activity' || event.event_type === eventType
    const cutoff = Date.now() - Number(period) * 86400000
    return matchesQuery && matchesType && new Date(event.created_at).getTime() >= cutoff
  })
  const timeAgo = (timestamp: string) => {
    const minutes = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 60000))
    return minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes} minutes ago` : `${Math.round(minutes / 60)} hours ago`
  }
  return <div className="audit-layout"><div className="audit-main card"><div className="records-tools"><div className="search-box"><Search size={18}/><input placeholder="Search audit events…" value={query} onChange={event => setQuery(event.target.value)}/></div><label className="filter-select"><Filter size={16}/><select className="select-button" value={eventType} onChange={event => setEventType(event.target.value)}><option>All activity</option>{eventTypes.map(type => <option key={type}>{type}</option>)}</select></label><label className="filter-select"><Clock3 size={16}/><select className="select-button" value={period} onChange={event => setPeriod(event.target.value)}><option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="3650">All time</option></select></label></div><div className="date-label">{visibleEvents.length} PERSISTED EVENTS</div><div className="timeline">{visibleEvents.map(a=><div className="timeline-item" key={a.id}><span className={`timeline-icon ${a.event_type}`}>{a.event_type==='approve'?<Check size={17}/>:a.event_type==='flag'?<AlertTriangle size={17}/>:a.event_type==='map'?<MapPin size={17}/>:a.event_type==='upload'?<Upload size={17}/>:<FileText size={17}/>}</span><div><p><b>{a.actor}</b> {a.action}</p><span>{timeAgo(a.created_at)}{a.document_id ? ` · ${a.document_id}` : ''}</span>{expanded === a.id && <small className="audit-detail">{a.details || 'No additional details were recorded for this event.'}</small>}</div><button className="icon-btn" title="Toggle event details" onClick={() => setExpanded(current => current === a.id ? null : a.id)}><MoreHorizontal size={17}/></button></div>)}</div>{visibleEvents.length === 0 && <div className="empty"><History size={28}/><h3>No matching events</h3><p>Change the activity type, period, or search terms.</p></div>}</div>
    <aside className="compliance-card card"><span className="shield-large"><ShieldCheck size={28}/></span><h3>Audit integrity</h3><p>Actions are attributed to authenticated officers and linked through a tamper-evident signing chain.</p><div><span>Chain status<b className={integrity?.valid ? 'success-text' : integrity ? 'warning-text' : ''}>{integrity?.valid ? 'Verified' : integrity ? 'Attention required' : 'Restricted'}</b></span><span>Algorithm<b>{integrity?.algorithm || 'HMAC-SHA256'}</b></span><span>Record versioning<b>Enabled</b></span><span>Events verified<b>{integrity?.events_checked ?? 'Role restricted'}</b></span></div>{canExport && <button className="btn secondary full" onClick={() => api.exportAudit()}>Export compliance log</button>}</aside>
  </div>
}

function SettingsPage() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([])
  const [showForm, setShowForm] = useState(false)
  const [error, setError] = useState('')
  const [integrationMessage, setIntegrationMessage] = useState<Record<string, string>>({})
  const [learning, setLearning] = useState<LearningMetrics | null>(null)
  const [form, setForm] = useState({ display_name: '', username: '', password: '', role: 'Viewer' as AuthUser['role'] })
  const roles: AuthUser['role'][] = ['Administrator', 'Verification Officer', 'Data Operator', 'Auditor', 'Viewer']
  useEffect(() => {
    Promise.all([api.users(), api.integrations(), api.learningMetrics()]).then(([officials, services, metrics]) => { setUsers(officials); setIntegrations(services); setLearning(metrics) }).catch(requestError => setError(requestError instanceof Error ? requestError.message : 'Could not load administration data'))
  }, [])
  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    try {
      const created = await api.createUser(form)
      setUsers(current => [...current, created].sort((a,b) => a.display_name.localeCompare(b.display_name)))
      setForm({ display_name: '', username: '', password: '', role: 'Viewer' })
      setShowForm(false)
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Could not create user') }
  }
  const update = async (target: AdminUser, payload: { role?: AuthUser['role']; active?: boolean }) => {
    setError('')
    try {
      const updated = await api.updateUser(target.id, payload)
      setUsers(current => current.map(user => user.id === updated.id ? updated : user))
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Could not update user') }
  }
  const testIntegration = async (integration: IntegrationStatus) => {
    setIntegrationMessage(current => ({ ...current, [integration.key]: 'Testing…' }))
    try {
      const result = await api.testIntegration(integration.key)
      setIntegrationMessage(current => ({ ...current, [integration.key]: result.connected ? `Connected · HTTP ${result.status}` : 'Connection failed' }))
    } catch (requestError) {
      setIntegrationMessage(current => ({ ...current, [integration.key]: requestError instanceof Error ? requestError.message : 'Connection failed' }))
    }
  }
  return <div className="settings-layout">
    <section className="settings-main card"><div className="card-heading"><div><span>AUTHORIZED OFFICIALS</span><h3>User access</h3></div><button className="btn primary" onClick={() => setShowForm(value => !value)}><Plus size={16}/>{showForm ? 'Close form' : 'Add official'}</button></div>
      {error && <div className="upload-error settings-error"><AlertTriangle size={15}/>{error}</div>}
      {showForm && <form className="new-user-form" onSubmit={create}><label>Full name<input required value={form.display_name} onChange={event => setForm({...form, display_name:event.target.value})}/></label><label>Official email<input required type="email" value={form.username} onChange={event => setForm({...form, username:event.target.value})}/></label><label>Temporary password<input required minLength={10} type="password" value={form.password} onChange={event => setForm({...form, password:event.target.value})}/></label><label>Role<select value={form.role} onChange={event => setForm({...form, role:event.target.value as AuthUser['role']})}>{roles.map(role => <option key={role}>{role}</option>)}</select></label><button className="btn primary">Create user</button></form>}
      <div className="user-list"><div className="user-list-head"><span>Official</span><span>Role</span><span>Status</span><span>Access</span></div>{users.map(target => <div className="user-row" key={target.id}><div><span className="avatar">{target.display_name.split(' ').map(word=>word[0]).join('').slice(0,2)}</span><p><b>{target.display_name}</b><small>{target.username}</small></p></div><select value={target.role} onChange={event => update(target,{role:event.target.value as AuthUser['role']})}>{roles.map(role => <option key={role}>{role}</option>)}</select><span className={`status ${target.active ? 'status-verified' : 'status-rejected'}`}>{target.active ? 'Active' : 'Disabled'}</span><button className="btn secondary" onClick={() => update(target,{active:!target.active})}>{target.active ? 'Disable' : 'Enable'}</button></div>)}</div>
    </section>
    <aside className="security-stack"><div className="card security-card"><LockKeyhole size={21}/><div><span>DOCUMENT STORAGE</span><strong>Encrypted managed storage</strong><small>Private objects with SHA-256 integrity validation</small></div></div><div className="card security-card"><History size={21}/><div><span>AUDIT CHAIN</span><strong>HMAC-SHA256</strong><small>Tamper-evident linked event history</small></div></div><div className="card security-card"><UsersRound size={21}/><div><span>ACCESS MODEL</span><strong>5 enforced roles</strong><small>PBKDF2 passwords, revocable sessions and API rate limits</small></div></div><div className="card integration-card"><div className="integration-head"><div><span>GOVERNMENT INTEGRATIONS</span><strong>Deployment readiness</strong></div><Database size={20}/></div>{integrations.map(integration => <div className="integration-row" key={integration.key}><span><b>{integration.key}</b><small>{integration.name}{integrationMessage[integration.key] ? ` · ${integrationMessage[integration.key]}` : ''}</small></span>{integration.configured && integration.key !== 'sso' ? <button className="btn secondary" onClick={() => testIntegration(integration)}>Test</button> : <i className={integration.configured ? 'configured' : ''}>{integration.configured ? 'Configured' : 'Needs endpoint'}</i>}</div>)}</div><div className="card learning-card"><Sparkles size={20}/><div><span>AI LEARNING LOOP</span><strong>Verified correction dataset</strong><small>Export officer corrections as JSONL for governed model evaluation and retraining.</small><button className="btn secondary full" onClick={() => api.exportCorrections()}>Export learning data</button></div></div></aside>
  </div>
}

function App() {
  const [page, setPage] = useState<Page>('overview')
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [docs, setDocs] = useState(initialDocuments)
  const [toast, setToast] = useState('')
  const [apiOnline, setApiOnline] = useState(false)
  const [stats, setStats] = useState<ApiStats | null>(null)
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([])
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [auditIntegrity, setAuditIntegrity] = useState<AuditIntegrity | null>(null)
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null)
  const [recordDetailId, setRecordDetailId] = useState<string | null>(null)
  const [user, setUser] = useState<AuthUser | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [authError, setAuthError] = useState('')

  const refreshOperationalData = async (activeUser: AuthUser) => {
    const canReadAudit = ['Administrator', 'Verification Officer', 'Auditor'].includes(activeUser.role)
    const [documents, currentStats, events, currentNotifications, integrity] = await Promise.all([
      api.documents(), api.stats(), canReadAudit ? api.audit() : Promise.resolve([]), api.notifications(),
      ['Administrator', 'Auditor'].includes(activeUser.role) ? api.auditIntegrity() : Promise.resolve(null),
    ])
    setDocs(documents)
    setStats(currentStats)
    setAuditEvents(events)
    setNotifications(currentNotifications)
    setAuditIntegrity(integrity)
    setApiOnline(true)
  }

  useEffect(() => {
    if (window.location.pathname === '/citizen') { setAuthLoading(false); return }
    const ssoCode = new URLSearchParams(window.location.search).get('sso_code')
    if (ssoCode) {
      window.history.replaceState({}, document.title, window.location.pathname)
      api.completeOidc(ssoCode).then(async sessionUser => { setUser(sessionUser); await refreshOperationalData(sessionUser) }).catch(error => { setAuthError(error instanceof Error ? error.message : 'Government SSO sign-in failed'); setUser(null) }).finally(() => setAuthLoading(false))
      return
    }
    if (!api.hasSession()) { setAuthLoading(false); return }
    api.me().then(async sessionUser => { setUser(sessionUser); await refreshOperationalData(sessionUser) }).catch(() => { api.logout(); setUser(null); setApiOnline(false) }).finally(() => setAuthLoading(false))
  }, [])

  const showToast = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 3000) }
  const login = async (loggedInUser: AuthUser) => {
    setUser(loggedInUser)
    await refreshOperationalData(loggedInUser)
  }
  const logout = () => {
    void api.logout()
    setUser(null)
    setApiOnline(false)
    setPage('overview')
  }
  const addDocument = (doc: LandDocument) => {
    setDocs(current => [doc, ...current.filter(item => item.id !== doc.id)])
    api.stats().then(setStats).catch(() => undefined)
    if (user && ['Administrator', 'Verification Officer', 'Auditor'].includes(user.role)) api.audit().then(setAuditEvents).catch(() => undefined)
    api.notifications().then(setNotifications).catch(() => undefined)
    setApiOnline(true)
    setSelectedDocumentId(doc.id)
    showToast('Document processed and added to verification queue')
  }
  const verify = async (documentId: string) => {
    if (apiOnline) {
      const verified = await api.approve(documentId)
      setDocs(current => current.map(document => document.id === documentId ? verified : document))
      const [currentStats, events, currentNotifications] = await Promise.all([api.stats(), api.audit(), api.notifications()])
      setStats(currentStats)
      setAuditEvents(events)
      setNotifications(currentNotifications)
    } else {
      setDocs(current => current.map(document => document.id === documentId ? {...document, status: 'Verified' as DocumentStatus, confidence: 100} : document))
    }
    showToast('Record approved and audit event stored')
  }
  const reject = async (documentId: string) => {
    const rejected = await api.reject(documentId)
    setDocs(current => current.map(document => document.id === documentId ? rejected : document))
    setAuditEvents(await api.audit())
    showToast('Record rejected and audit event stored')
  }

  const openVerification = (documentId: string) => {
    if (!user || !['Administrator', 'Verification Officer'].includes(user.role)) {
      showToast('Your role has read-only access to this record')
      return
    }
    setSelectedDocumentId(documentId)
    setPage('verification')
  }
  const verificationDocument = docs.find(document => document.id === selectedDocumentId) || docs.find(document => document.status === 'Needs review') || docs[0]
  const detailDocument = docs.find(document => document.id === recordDetailId)

  if (window.location.pathname === '/citizen') return <CitizenPortal/>
  if (authLoading) return <div className="app-loading"><span className="brand-mark"><span>ध</span></span><RefreshCcw className="spin"/>Preparing secure workspace…</div>
  if (!user) return <LoginScreen onLogin={login} initialError={authError}/>

  return <div className="app-shell">
    <Sidebar page={page} setPage={setPage} collapsed={collapsed} setCollapsed={setCollapsed} mobileOpen={mobileOpen} setMobileOpen={setMobileOpen} user={user} onLogout={logout} reviewCount={stats?.needs_review || 0}/>
    <div className="main-shell"><Header page={page} onMenu={() => setMobileOpen(true)} apiOnline={apiOnline} notifications={notifications} onNotificationsChanged={setNotifications}/><main className={page === 'verification' ? 'verify-page' : ''}><PageHeading page={page} setPage={setPage} user={user}/>
      {page === 'overview' && <Overview docs={docs} setPage={setPage} stats={stats} onReview={openVerification}/>} {page === 'upload' && <UploadPage onAdded={addDocument}/>} {page === 'verification' && <VerificationPage document={verificationDocument} onVerified={verify} onRejected={reject} onBack={() => setPage('records')} apiOnline={apiOnline}/>} {page === 'records' && <RecordsPage docs={docs} onReview={openVerification} onOpen={setRecordDetailId}/>} {page === 'gis' && <GisPage onOpenRecord={setRecordDetailId} canEdit={['Administrator', 'Verification Officer'].includes(user.role)} records={docs}/>} {page === 'audit' && <AuditPage events={auditEvents} integrity={auditIntegrity} canExport={['Administrator', 'Auditor'].includes(user.role)}/>} {page === 'settings' && <SettingsPage/>}
    </main></div>
    {detailDocument && <RecordDetails document={detailDocument} user={user} onClose={() => setRecordDetailId(null)} onReview={openVerification}/>} 
    {toast && <div className="toast"><CheckCircle2 size={18}/>{toast}</div>}
  </div>
}

export default App
