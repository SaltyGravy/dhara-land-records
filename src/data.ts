export type DocumentStatus = 'Verified' | 'Needs review' | 'Processing' | 'Rejected'

export interface PlotRow {
  khata: string
  khasra: string
  area: string
  rent: string
  cess: string
}

export interface LandDocument {
  id: string
  owner: string
  document: string
  location: string
  district: string
  survey: string
  type: string
  language: string
  confidence: number
  status: DocumentStatus
  updated: string
  filename?: string
  file_url?: string | null
  ocr_engine?: string
  fields?: ExtractedField[]
  plot_rows?: PlotRow[]
  validation_issues?: ValidationIssue[]
  version?: number
  // Set when this record is one of several created from a single register that listed
  // multiple plots (Khata/Khasra rows) - siblings share this value (the group's first/
  // primary record id) and the same uploaded source file.
  batch_id?: string | null
}

export interface ValidationIssue {
  code: string
  field: string
  severity: 'error' | 'warning'
  message: string
}

export interface ExtractedField {
  id?: number
  label: string
  value: string
  original: string
  confidence: number
  valid: boolean
  verified?: boolean
}

export const documents: LandDocument[] = [
  { id: 'LR-2026-04182', owner: 'Mahesh Kumar Yadav', document: 'Jamabandi Register · 1998', location: 'Rampur, Lucknow', district: 'Lucknow', survey: '142/2A', type: 'Jamabandi', language: 'Hindi', confidence: 97.4, status: 'Verified', updated: '2 min ago' },
  { id: 'LR-2026-04181', owner: 'Sunita Devi', document: 'Khasra Record · 2004', location: 'Baragaon, Varanasi', district: 'Varanasi', survey: '88/1', type: 'Khasra', language: 'Hindi', confidence: 82.1, status: 'Needs review', updated: '8 min ago' },
  { id: 'LR-2026-04180', owner: 'Iqbal Ahmad Khan', document: 'Mutation Register · 1987', location: 'Sadar, Prayagraj', district: 'Prayagraj', survey: '207/4B', type: 'Mutation', language: 'Urdu', confidence: 74.8, status: 'Needs review', updated: '13 min ago' },
  { id: 'LR-2026-04179', owner: 'Kamla Prasad', document: 'Khatauni · 2010', location: 'Malihabad, Lucknow', district: 'Lucknow', survey: '51/3', type: 'Khatauni', language: 'Hindi', confidence: 93.6, status: 'Verified', updated: '21 min ago' },
  { id: 'LR-2026-04178', owner: 'Processing…', document: 'Cadastral Sheet · 1972', location: 'Pindra, Varanasi', district: 'Varanasi', survey: '—', type: 'Cadastral map', language: 'Hindi', confidence: 0, status: 'Processing', updated: 'Just now' },
  { id: 'LR-2026-04177', owner: 'Anil Singh Chauhan', document: 'Registry Deed · 1995', location: 'Karchhana, Prayagraj', district: 'Prayagraj', survey: '319/2', type: 'Registry', language: 'English', confidence: 96.2, status: 'Verified', updated: '34 min ago' },
]

export const extractedFields: ExtractedField[] = [
  { label: 'Landowner name', value: 'Sunita Devi', original: 'सुनीता देवी', confidence: 98, valid: true },
  { label: 'Survey number', value: 'SV-88/1', original: 'सर्वे ८८/१', confidence: 94, valid: true },
  { label: 'Khasra number', value: '88/1', original: '८८/१', confidence: 96, valid: true },
  { label: 'Khata number', value: 'KH-02491', original: 'खाता ०२४९१', confidence: 91, valid: true },
  { label: 'Plot area', value: '1.37 hectare', original: '१.३७ हे०', confidence: 86, valid: true },
  { label: 'Village', value: 'Baragaon', original: 'बड़ागाँव', confidence: 93, valid: true },
  { label: 'Tehsil', value: 'Pindra', original: 'पिण्डरा', confidence: 88, valid: true },
  { label: 'District', value: 'Varanasi', original: 'वाराणसी', confidence: 99, valid: true },
  { label: 'Land classification', value: 'Agricultural — Irrigated', original: 'कृषि सिंचित', confidence: 72, valid: false },
  { label: 'Ownership details', value: 'Recorded tenure holder', original: 'अधिकार अभिलेख', confidence: 79, valid: false },
  { label: 'Mutation reference', value: 'MUT/2004/117', original: 'नामांतरण ११७', confidence: 68, valid: false },
  { label: 'Registration information', value: 'REG/2004/8031', original: 'पंजीकरण ८०३१', confidence: 76, valid: false },
]

export const districts = [
  { name: 'Lucknow', processed: 12840, total: 15000, color: '#187667' },
  { name: 'Varanasi', processed: 9360, total: 12500, color: '#d87932' },
  { name: 'Prayagraj', processed: 7110, total: 11200, color: '#5c7696' },
  { name: 'Gorakhpur', processed: 4200, total: 9800, color: '#9b6d84' },
]

export const activity = [
  { person: 'Priya Sharma', action: 'approved record LR-2026-04182', time: '2 minutes ago', type: 'approve' },
  { person: 'AI pipeline', action: 'flagged 2 fields in LR-2026-04181', time: '8 minutes ago', type: 'flag' },
  { person: 'Arun Verma', action: 'corrected owner name in LR-2026-04176', time: '18 minutes ago', type: 'edit' },
  { person: 'GIS service', action: 'linked parcel 51/3 with cadastral map', time: '29 minutes ago', type: 'map' },
  { person: 'Meera Singh', action: 'uploaded batch VAR-090926-B', time: '46 minutes ago', type: 'upload' },
]
