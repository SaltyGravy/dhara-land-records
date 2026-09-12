import type { ExtractedField } from './data'

export const canonicalFieldLabels = [
  'Landowner name', 'Survey number', 'Khasra number', 'Khata number', 'Plot area', 'Village',
  'Tehsil', 'District', 'Land classification', 'Ownership details', 'Mutation reference', 'Registration information',
] as const

const aliases: Record<(typeof canonicalFieldLabels)[number], string[]> = {
  'Landowner name': ['landowner name', 'land owner', 'owner name', 'recorded owner', 'खातेदार का नाम', 'खातेदार', 'भूस्वामी', 'मालिक', 'জমির মালিক', 'মালিক', 'જમીન માલિક', 'માલિક', 'ಮಾಲೀಕ', 'ഉടമ', 'जमीनमालक', 'ମାଲିକ', 'ਜ਼ਮੀਨ ਮਾਲਕ', 'ਮਾਲਕ', 'உரிமையாளர்', 'భూ యజమాని', 'యజమాని', 'مالک'],
  'Survey number': ['survey number', 'survey no', 'survey', 'सर्वे संख्या', 'सर्वे सं', 'सर्वे', 'জরিপ নম্বর', 'સર્વે નંબર', 'ಸರ್ವೆ ಸಂಖ್ಯೆ', 'സർവേ നമ്പർ', 'सर्वे क्रमांक', 'ସର୍ଭେ ନମ୍ବର', 'ਸਰਵੇ ਨੰਬਰ', 'சர்வே எண்', 'సర్వే నంబరు', 'سروے نمبر'],
  'Khasra number': ['khasra number', 'khasra no', 'khasra', 'खसरा संख्या', 'खसरा सं', 'खसरा', 'খসরা নম্বর', 'ખસરા નંબર', 'ಖಸ್ರಾ ಸಂಖ್ಯೆ', 'ഖസ്ര നമ്പർ', 'खसरा क्रमांक', 'ଖସରା ନମ୍ବର', 'ਖਸਰਾ ਨੰਬਰ', 'கஸ்ரா எண்', 'ఖస్రా నంబరు', 'خسرہ نمبر'],
  'Khata number': ['khata number', 'khata no', 'khatauni number', 'khata', 'खाता संख्या', 'खाता सं', 'खाता', 'খতিয়ান নম্বর', 'ખાતા નંબર', 'ಖಾತೆ ಸಂಖ್ಯೆ', 'ഖാത നമ്പർ', 'खाते क्रमांक', 'ଖାତା ନମ୍ବର', 'ਖਾਤਾ ਨੰਬਰ', 'பட்டா எண்', 'ఖాతా నంబరు', 'کھاتہ نمبر'],
  'Plot area': ['plot area', 'total area', 'area', 'क्षेत्रफल', 'রকবা', 'এলাকা', 'વિસ્તાર', 'ವಿಸ್ತೀರ್ಣ', 'വിസ്തീർണ്ണം', 'क्षेत्र', 'କ୍ଷେତ୍ରଫଳ', 'ਰਕਬਾ', 'பரப்பளவு', 'విస్తీర్ణం', 'رقبہ'],
  'Village': ['village name', 'village', 'ग्राम', 'गाँव', 'মৌজা', 'গ্রাম', 'ગામ', 'ಗ್ರಾಮ', 'ഗ്രാമം', 'गाव', 'ଗ୍ରାମ', 'ਪਿੰਡ', 'கிராமம்', 'గ్రామం', 'موضع', 'گاؤں'],
  'Tehsil': ['tehsil', 'taluka', 'tahsil', 'तहसील', 'तालुका', 'থানা', 'તાલુકો', 'ತಾಲೂಕು', 'താലൂക്ക്', 'ତହସିଲ', 'ਤਹਿਸੀਲ', 'தாலுகா', 'మండలం', 'تحصیل'],
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
  return normalizeIndianDigits(value).replace(/^[\s:：=\-–—|.]+/, '').replace(/[|;]+$/, '').replace(/\s+/g, ' ').trim()
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
      let value = cleanValue(line.slice(index + label.length))
      if (!value && lines[lineIndex + 1]) value = cleanValue(lines[lineIndex + 1])
      if (value && value.length <= 160) return { value, source: line.trim() }
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
  return canonicalFieldLabels.map((label, index) => {
    const match = valueFromLabel(lines, aliases[label])
    let value = match?.value || numericFallback(text, label)
    let original = match?.source || (value ? value : 'Not detected')
    let confidence = value ? Math.max(45, Math.min(98, Math.round(ocrConfidence - (match ? 4 : 14)))) : 0
    if (label === 'District' && !value && district && district !== 'Not specified') {
      value = district
      original = 'Upload metadata'
      confidence = 100
    }
    return { id: index + 1, label, value, original, confidence, valid: Boolean(value), verified: false }
  })
}
