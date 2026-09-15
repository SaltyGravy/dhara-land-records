import type { ExtractedField, PlotRow } from './data'

export const canonicalFieldLabels = [
  'Landowner name', 'Survey number', 'Khasra number', 'Khata number', 'Plot area', 'Village',
  'Tehsil', 'District', 'Land classification', 'Ownership details', 'Mutation reference', 'Registration information',
] as const

const aliases: Record<(typeof canonicalFieldLabels)[number], string[]> = {
  'Landowner name': ['landowner name', 'land owner', 'owner name', 'recorded owner', 'खातेदार का नाम', 'खातेदार', 'भूस्वामी', 'मालिक', 'জমির মালিক', 'মালিক', 'જમીન માલિક', 'માલિક', 'ಮಾಲೀಕ', 'ഉടമ', 'जमीनमालक', 'ମାଲିକ', 'ਜ਼ਮੀਨ ਮਾਲਕ', 'ਮਾਲਕ', 'உரிமையாளர்', 'భూ యజమాని', 'యజమాని', 'مالک'],
  'Survey number': ['survey number', 'survey no', 'survey', 'सर्वे संख्या', 'सर्वे सं', 'सर्वे', 'জরিপ নম্বর', 'સર્વે નંબર', 'ಸರ್ವೆ ಸಂಖ್ಯೆ', 'സർവേ നമ്പർ', 'सर्वे क्रमांक', 'ସର୍ଭେ ନମ୍ବର', 'ਸਰਵੇ ਨੰਬਰ', 'சர்வே எண்', 'సర్వే నంబరు', 'سروے نمبر'],
  'Khasra number': ['khasra number', 'khasra no', 'khasra', 'खसरा संख्या', 'खसरा सं', 'खसरा', 'खेसरा संख्या', 'खेसरा सं', 'खेसरा', 'প্লট/খসরা', 'খসরা নম্বর', 'ખસરા નંબર', 'ಖಸ್ರಾ ಸಂಖ್ಯೆ', 'ഖസ്ര നമ്പർ', 'खसरा क्रमांक', 'ଖସରା ନମ୍ବର', 'ਖਸਰਾ ਨੰਬਰ', 'கஸ்ரா எண்', 'ఖస్రా నంబరు', 'خسرہ نمبر'],
  'Khata number': ['khata number', 'khata no', 'khatauni number', 'khata', 'खाता संख्या', 'खाता सं', 'खाता', 'খতিয়ান নম্বর', 'ખાતા નંબર', 'ಖಾತೆ ಸಂಖ್ಯೆ', 'ഖാത നമ്പർ', 'खाते क्रमांक', 'ଖାତା ନମ୍ବର', 'ਖਾਤਾ ਨੰਬਰ', 'பட்டா எண்', 'ఖాతా నంబరు', 'کھاتہ نمبر'],
  'Plot area': ['plot area', 'total area', 'area', 'क्षेत्रफल', 'रकबा', 'রকবা', 'এলাকা', 'વિસ્તાર', 'ವಿಸ್ತೀರ್ಣ', 'വിസ്തീർണ്ണം', 'क्षेत्र', 'କ୍ଷେତ୍ରଫଳ', 'ਰਕਬਾ', 'பரப்பளவு', 'విస్తీర్ణం', 'رقبہ'],
  'Village': ['village name', 'village', 'ग्राम', 'गाँव', 'मौजा', 'মৌজা', 'গ্রাম', 'ગામ', 'ಗ್ರಾಮ', 'ഗ്രാമം', 'गाव', 'ଗ୍ରାମ', 'ਪਿੰਡ', 'கிராமம்', 'గ్రామం', 'موضع', 'گاؤں'],
  'Tehsil': ['tehsil', 'taluka', 'tahsil', 'तहसील', 'तालुका', 'अनुमंडल', 'अंचल', 'থানা', 'તાલુકો', 'ತಾಲೂಕು', 'താലൂക്ക്', 'ତହସିଲ', 'ਤਹਿਸੀਲ', 'தாலுகா', 'మండలం', 'تحصیل'],
  'District': ['district name', 'district', 'जिला', 'जनपद', 'জেলা', 'જિલ્લો', 'ಜಿಲ್ಲೆ', 'ജില്ല', 'जिल्हा', 'ଜିଲ୍ଲା', 'ਜ਼ਿਲ੍ਹਾ', 'மாவட்டம்', 'జిల్లా', 'ضلع'],
  'Land classification': ['land classification', 'land type', 'class of land', 'भूमि का प्रकार', 'भूमि वर्ग', 'জমির শ্রেণী', 'જમીનનો પ્રકાર', 'ಭೂಮಿ ವರ್ಗ', 'ഭൂമി തരം', 'जमिनीचा प्रकार', 'ଜମି କିସମ', 'ਜ਼ਮੀਨ ਦੀ ਕਿਸਮ', 'நில வகை', 'భూమి రకం', 'قسم زمین'],
  'Ownership details': ['ownership details', 'ownership', 'tenure', 'right details', 'अधिकार विवरण', 'स्वामित्व', 'মালিকানার বিবরণ', 'માલિકીની વિગત', 'ಮಾಲೀಕತ್ವ', 'ഉടമസ്ഥാവകാശം', 'मालकी हक्क', 'ମାଲିକାନା', 'ਮਲਕੀਅਤ', 'உரிமை விவரம்', 'యాజమాన్య వివరాలు', 'تفصیل ملکیت'],
  'Mutation reference': ['mutation reference', 'mutation number', 'mutation no', 'mutation', 'नामांतरण आदेश', 'नामांतरण', 'দাখিল খারিজ', 'ફેરફાર નંબર', 'ಮ್ಯುಟೇಶನ್', 'പോക്കുവരവ്', 'फेरफार क्रमांक', 'ନାମଜାରି', 'ਇੰਤਕਾਲ ਨੰਬਰ', 'பட்டா மாற்றம்', 'మ్యుటేషన్', 'انتقال نمبر'],
  'Registration information': ['registration information', 'registration details', 'registration number', 'registration no', 'registry number', 'registry no', 'पंजीकरण संख्या', 'पंजीकरण विवरण', 'रजिस्ट्री संख्या', 'নিবন্ধন নম্বর', 'નોંધણી નંબર', 'ನೋಂದಣಿ ಸಂಖ್ಯೆ', 'രജിസ്ട്രേഷൻ നമ്പർ', 'नोंदणी क्रमांक', 'ପଞ୍ଜିକରଣ ସଂଖ୍ୟା', 'ਰਜਿਸਟ੍ਰੇਸ਼ਨ ਨੰਬਰ', 'பதிவு எண்', 'రిజిస్ట్రేషన్ నంబరు', 'رجسٹریشن نمبر'],
}

const digitBlocks = [0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66]

export function normalizeIndianDigits(value: string): string {
  return [...value].map(character => {
    const code = character.codePointAt(0) || 0
    const block = digitBlocks.find(start => code >= start && code <= start + 9)
    return block === undefined ? character : String(code - block)
  }).join('')
}

function cleanValue(value: string): string {
  let cleaned = normalizeIndianDigits(value).replace(/^[\s:：=\-–—|._]+/, '')
  // "का नाम" removal can expose a new leading junk character behind it - strip again.
  cleaned = cleaned.replace(/^(?:का नाम|की नाम|के नाम|नाम)\s*[:：=\-–—]*\s*/, '').replace(/^[\s:：=\-–—|._]+/, '')
  cleaned = cleaned.replace(/[|;]+$/, '')
  // Strip an unmatched trailing bracket - a common OCR misread of characters like "j" or ")".
  if (!/[({[]/.test(cleaned)) cleaned = cleaned.replace(/[)}\]]+\s*$/, '')
  return cleaned.replace(/\s+/g, ' ').trim()
}

const allAliases = Object.values(aliases).flat()

function stripLeadingFiller(value: string): string {
  // "का नाम" removal can expose a *new* leading junk character behind it (e.g. an OCR
  // artifact like "_" sitting between the filler and the real value) - run the plain
  // leading-junk strip again afterward so that doesn't end up looking like the value's
  // first character.
  let cleaned = value.replace(/^[\s:：=\-–—|._]+/, '')
  cleaned = cleaned.replace(/^(?:का नाम|की नाम|के नाम|नाम)\s*[:：=\-–—]*\s*/, '')
  return cleaned.replace(/^[\s:：=\-–—|._]+/, '')
}

// Matches the start of an *unrelated* "label :" pair further along the same line (e.g.
// "होल्डिंग संख्या :", "थाना नंबर :", "अंचल का नाम :") so a captured value doesn't run past
// it, even when that label isn't one of the fields this app tracks. Deliberately structural
// (any short run of words directly followed by a colon) rather than a fixed connector-word
// list like "नाम/संख्या" - those specific words are exactly the ones that go missing when a
// document's font/OCR drops a conjunct glyph (e.g. "होल्डिंग संख्या" -> "होग संा"), so requiring
// them by name silently stopped working on real, only mildly damaged documents.
const genericLabelPattern = /[\p{L}\p{M}]{1,14}(?:\s+[\p{L}\p{M}]{1,14}){0,2}\s*[:：]/gu

function truncateAtNextLabel(raw: string, ownLabel: string): string {
  const stripped = stripLeadingFiller(raw)
  const folded = stripped.toLocaleLowerCase()
  let cutIndex = stripped.length
  for (const alias of allAliases) {
    if (alias.toLocaleLowerCase() === ownLabel.toLocaleLowerCase()) continue
    const index = folded.indexOf(alias.toLocaleLowerCase())
    if (index >= 0 && index < cutIndex) cutIndex = index
  }
  const firstGap = stripped.search(/\s/)
  if (firstGap > 0) {
    genericLabelPattern.lastIndex = firstGap
    const match = genericLabelPattern.exec(stripped)
    if (match && match.index < cutIndex) cutIndex = match.index
  }
  return stripped.slice(0, cutIndex)
}

function valueFromLabel(lines: string[], labels: string[]): { value: string; source: string } | null {
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]
    const folded = line.toLocaleLowerCase()
    for (const label of labels) {
      const index = folded.indexOf(label.toLocaleLowerCase())
      if (index < 0) continue
      const before = index > 0 ? folded[index - 1] : ''
      const after = folded[index + label.length] || ''
      if ((before && /[\p{L}\p{N}]/u.test(before)) || (after && /[\p{L}\p{N}]/u.test(after))) continue
      let value = cleanValue(truncateAtNextLabel(line.slice(index + label.length), label))
      if (!value && lines[lineIndex + 1]) value = cleanValue(truncateAtNextLabel(lines[lineIndex + 1], label))
      if (value && value.length <= 160) return { value, source: line.trim() }
    }
  }
  return null
}

function nameFallback(lines: string[]): { value: string; source: string } | null {
  // Kinship words (पिता/बाप/अब्बू/...) in a later comma segment are the strongest signal
  // here - don't also require an exact "श्री"/"श्रीमती" prefix on the first segment, since
  // OCR frequently drops the leading conjunct (श्री -> री) on real scans.
  const kinship = /(?:पिता|बाप|अब्बू|पुत्र|पुत्री|पति|husband of|s\/o|d\/o|w\/o)/i
  for (const line of lines) {
    const segments = line.split(',')
    if (segments.length < 2) continue
    const first = segments[0].trim()
    if (first.length >= 2 && first.length <= 60 && /\p{L}/u.test(first) && !/\d/.test(first) && kinship.test(segments.slice(1).join(','))) {
      const value = cleanValue(first)
      if (value) return { value, source: line.trim() }
    }
  }
  return null
}

function numericFallback(text: string, label: (typeof canonicalFieldLabels)[number]): string {
  const normalized = normalizeIndianDigits(text)
  if (label === 'Khasra number' || label === 'Survey number') return normalized.match(/\b\d{1,6}(?:\s*[\/-]\s*[A-Za-z0-9]{1,8})+\b/)?.[0]?.replace(/\s/g, '') || ''
  if (label === 'Plot area') return normalized.match(/\b\d+(?:\.\d+)?\s*(?:hectares?|ha|acres?|sq\.?\s*m|हे(?:क्टेयर)?|हे०|एकड़)\b/i)?.[0] || ''
  return ''
}

// Matches a Bihar Jamabandi-style tabular plot row: "<khata> <khasra> <area tokens...> n/a <rent> <cess>".
// The literal "n/a" is the boundary-change-authority column's placeholder in this register type,
// used as an anchor because the area column otherwise has a variable number of tokens
// (it's written out as e.g. "0 ए 49 डि 0 हे" - acres/decimal/hectare - not one clean number).
const plotRowPattern = /^(\S+)\s+(\S+)\s+(.+?)\s+n\/a\s+(\S+)\s+(\S+)\s*$/i

export function extractPlotRows(text: string): PlotRow[] {
  const rows: PlotRow[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = normalizeIndianDigits(rawLine.trim())
    const match = line.match(plotRowPattern)
    if (!match) continue
    const [, khata, khasra, area, rent, cess] = match
    if (!/^\d/.test(khata)) continue
    rows.push({ khata, khasra, area: area.replace(/\s+/g, ' ').trim(), rent, cess })
  }
  return rows
}

export function detectScriptLanguage(text: string, fallback: string): string {
  const tests: Array<[RegExp, string]> = [
    [/[ঀ-৿]/u, 'Bengali'], [/[਀-੿]/u, 'Punjabi'], [/[઀-૿]/u, 'Gujarati'],
    [/[଀-୿]/u, 'Odia'], [/[஀-௿]/u, 'Tamil'], [/[ఀ-౿]/u, 'Telugu'],
    [/[ಀ-೿]/u, 'Kannada'], [/[ഀ-ൿ]/u, 'Malayalam'], [/[؀-ۿ]/u, 'Urdu'],
  ]
  for (const [pattern, language] of tests) if (pattern.test(text)) return language
  if (/[ऀ-ॿ]/u.test(text)) return ['Hindi', 'Marathi', 'Sanskrit'].includes(fallback) ? fallback : 'Hindi'
  if (/[A-Za-z]/.test(text)) return fallback === 'Auto-detect' ? 'English' : fallback
  return fallback === 'Auto-detect' ? 'Unknown' : fallback
}

export function extractStructuredFields(text: string, district: string, ocrConfidence: number): ExtractedField[] {
  const lines = text.split(/\r?\n/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean)
  // A tabular register (Bihar-style Jamabandi) lists Khata/Khasra/area per plot row, not as a
  // single "label: value" pair - the ordinary line-based match above can only find the table's
  // header row for these three fields, which isn't a real value. Prefer the first plot row when
  // the document has one; it's a genuine value instead of a header fragment.
  const plotRows = extractPlotRows(text)
  const firstPlot = plotRows[0]
  const plotSource = plotRows.length > 1 ? `Plot table (plot 1 of ${plotRows.length})` : 'Plot table row'
  return canonicalFieldLabels.map((label, index) => {
    const match = valueFromLabel(lines, aliases[label]) || (label === 'Landowner name' ? nameFallback(lines) : null)
    // Once a plot table is confirmed present, a bare number-pattern scan across the whole text
    // (numericFallback) is more likely to snag some other plot row's Khata/Khasra than to find a
    // real value for an unrelated field (e.g. "Survey number", which this register type has no
    // column for at all) - so only fall back to it when the document isn't already known-tabular.
    let value = match?.value || (firstPlot ? '' : numericFallback(text, label))
    let original = match?.source || (value ? value : 'Not detected')
    let confidence = value ? Math.max(45, Math.min(98, Math.round(ocrConfidence - (match ? 4 : 14)))) : 0
    if (firstPlot && label === 'Khata number') { value = firstPlot.khata; original = plotSource; confidence = 95 }
    if (firstPlot && label === 'Khasra number') { value = firstPlot.khasra; original = plotSource; confidence = 95 }
    if (firstPlot && label === 'Plot area') { value = firstPlot.area; original = plotSource; confidence = 95 }
    if (label === 'District' && !value && district && district !== 'Not specified') {
      value = district
      original = 'Upload metadata'
      confidence = 100
    }
    return { id: index + 1, label, value, original, confidence, valid: Boolean(value), verified: false }
  })
}
