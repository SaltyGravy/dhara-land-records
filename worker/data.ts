export type Field = { id: number; label: string; value: string; original: string; confidence: number; valid: boolean; verified: boolean }

export const fieldLabels = [
  'Landowner name', 'Survey number', 'Khasra number', 'Khata number', 'Plot area', 'Village',
  'Tehsil', 'District', 'Land classification', 'Ownership details', 'Mutation reference', 'Registration information',
] as const

export function fields(values: Partial<Record<(typeof fieldLabels)[number], string>>, verified = false): Field[] {
  return fieldLabels.map((label, index) => {
    const value = values[label] || ''
    const confidence = value ? (label === 'District' ? 99 : label === 'Landowner name' ? 98 : 91) : 0
    return { id: index + 1, label, value, original: value || 'Not detected', confidence, valid: Boolean(value), verified }
  })
}

export const seedDocuments = [
  { id: 'LR-2026-04182', owner: 'Mahesh Kumar Yadav', document: 'Jamabandi Register · 1998', filename: 'LR-2026-04182.pdf', location: 'Rampur, Lucknow', district: 'Lucknow', survey: '142/2A', type: 'Jamabandi', language: 'Hindi', confidence: 97.4, status: 'Verified', fields: fields({ 'Landowner name': 'Mahesh Kumar Yadav', 'Survey number': '142/2A', 'Khasra number': '142/2A', 'Village': 'Rampur', 'District': 'Lucknow', 'Ownership details': 'Recorded tenure holder' }, true) },
  { id: 'LR-2026-04181', owner: 'Sunita Devi', document: 'Khasra Record · 2004', filename: 'LR-2026-04181.pdf', location: 'Baragaon, Varanasi', district: 'Varanasi', survey: '88/1', type: 'Khasra', language: 'Hindi', confidence: 82.1, status: 'Needs review', fields: fields({ 'Landowner name': 'Sunita Devi', 'Survey number': '88/1', 'Khasra number': '88/1', 'Khata number': 'KH-02491', 'Plot area': '1.37 hectare', 'Village': 'Baragaon', 'Tehsil': 'Pindra', 'District': 'Varanasi', 'Land classification': 'Agricultural — Irrigated', 'Ownership details': 'Recorded tenure holder', 'Mutation reference': 'MUT/2004/117' }) },
  { id: 'LR-2026-04180', owner: 'Iqbal Ahmad Khan', document: 'Mutation Register · 1987', filename: 'LR-2026-04180.pdf', location: 'Sadar, Prayagraj', district: 'Prayagraj', survey: '207/4B', type: 'Mutation', language: 'Urdu', confidence: 74.8, status: 'Needs review', fields: fields({ 'Landowner name': 'Iqbal Ahmad Khan', 'Khasra number': '207/4B', 'Village': 'Sadar', 'District': 'Prayagraj', 'Mutation reference': 'MUT/1987/2074' }) },
  { id: 'LR-2026-04179', owner: 'Kamla Prasad', document: 'Khatauni · 2010', filename: 'LR-2026-04179.pdf', location: 'Malihabad, Lucknow', district: 'Lucknow', survey: '51/3', type: 'Khatauni', language: 'Hindi', confidence: 93.6, status: 'Verified', fields: fields({ 'Landowner name': 'Kamla Prasad', 'Khasra number': '51/3', 'Village': 'Malihabad', 'District': 'Lucknow', 'Ownership details': 'Recorded tenure holder' }, true) },
  { id: 'LR-2026-04177', owner: 'Anil Singh Chauhan', document: 'Registry Deed · 1995', filename: 'LR-2026-04177.pdf', location: 'Karchhana, Prayagraj', district: 'Prayagraj', survey: '319/2', type: 'Registry', language: 'English', confidence: 96.2, status: 'Verified', fields: fields({ 'Landowner name': 'Anil Singh Chauhan', 'Survey number': '319/2', 'Khasra number': '319/2', 'Village': 'Karchhana', 'District': 'Prayagraj', 'Ownership details': 'Registered owner', 'Registration information': 'REG/1995/3192' }, true) },
]

export const seedParcels = [
  ['88/1','Sunita Devi',1.37,'Agricultural — Irrigated','Verified','LR-2026-04181',[[82.9200,25.5400],[82.9250,25.5412],[82.9260,25.5370],[82.9220,25.5352],[82.9195,25.5370],[82.9200,25.5400]]],
  ['88/2','Ram Kumar',.84,'Agricultural','Verified',null,[[82.9250,25.5412],[82.9300,25.5403],[82.9295,25.5367],[82.9260,25.5370],[82.9250,25.5412]]],
  ['89/1','Mohan Lal',1.12,'Agricultural','Needs review',null,[[82.9195,25.5370],[82.9220,25.5352],[82.9212,25.5310],[82.9180,25.5315],[82.9170,25.5340],[82.9195,25.5370]]],
  ['89/2','Village Commons',2.08,'Fallow land','Verified',null,[[82.9220,25.5352],[82.9260,25.5370],[82.9295,25.5367],[82.9285,25.5317],[82.9212,25.5310],[82.9220,25.5352]]],
  ['90','Asha Devi',1.62,'Agricultural','Verified',null,[[82.9300,25.5403],[82.9340,25.5385],[82.9332,25.5334],[82.9285,25.5317],[82.9295,25.5367],[82.9300,25.5403]]],
  ['91/1','Rakesh Singh',1.09,'Orchard','Verified',null,[[82.9180,25.5315],[82.9212,25.5310],[82.9225,25.5265],[82.9190,25.5252],[82.9160,25.5280],[82.9180,25.5315]]],
  ['91/2','Shyam Narayan',1.74,'Agricultural','Needs review',null,[[82.9212,25.5310],[82.9285,25.5317],[82.9290,25.5268],[82.9225,25.5265],[82.9212,25.5310]]],
  ['92','Iqbal Ahmad',1.46,'Residential','Verified',null,[[82.9285,25.5317],[82.9332,25.5334],[82.9345,25.5280],[82.9320,25.5252],[82.9290,25.5268],[82.9285,25.5317]]],
] as const
