import { GlobalWorkerOptions, getDocument, type PDFPageProxy } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { createWorker, OEM, PSM, type LoggerMessage } from 'tesseract.js'
import { detectScriptLanguage, extractPlotRows, extractStructuredFields } from './extraction'
import type { ExtractedField, PlotRow } from './data'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

const languageCodes: Record<string, string> = {
  Assamese: 'asm+eng', Bengali: 'ben+eng', English: 'eng', Gujarati: 'guj+eng', Hindi: 'hin+eng', Kannada: 'kan+eng',
  Malayalam: 'mal+eng', Marathi: 'mar+eng', Odia: 'ori+eng', Punjabi: 'pan+eng', Sanskrit: 'san+eng', Tamil: 'tam+eng',
  Telugu: 'tel+eng', Urdu: 'urd+eng', 'Auto-detect': 'hin+eng',
}

export interface OnlineOcrResult {
  text: string
  engine: string
  language: string
  confidence: number
  fields: ExtractedField[]
  pages: number
  warnings: string[]
  // All plot rows found in a tabular register (e.g. a Bihar Jamabandi's Khata/Khasra/area
  // table) - the Khata/Khasra/Plot area fields above only carry the first row's values, since
  // ExtractedField has no multi-row concept yet. Named to match the backend's snake_case field
  // (this whole object is sent to the API as JSON, unlike this file's own local variables).
  plot_rows: PlotRow[]
}

type Progress = (stage: string, progress: number) => void

function enhancedCanvas(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const scale = Math.min(3, Math.max(1.35, 2200 / Math.max(width, height)))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Canvas processing is unavailable in this browser.')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.filter = 'grayscale(1) contrast(1.35) brightness(1.06)'
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  const histogram = new Uint32Array(256)
  for (let index = 0; index < image.data.length; index += 4) histogram[image.data[index]] += 1
  const pixels = canvas.width * canvas.height
  let total = 0
  for (let level = 0; level < 256; level += 1) total += level * histogram[level]
  let backgroundWeight = 0, backgroundTotal = 0, maximumVariance = 0, threshold = 165
  for (let level = 0; level < 256; level += 1) {
    backgroundWeight += histogram[level]
    if (!backgroundWeight) continue
    const foregroundWeight = pixels - backgroundWeight
    if (!foregroundWeight) break
    backgroundTotal += level * histogram[level]
    const meanDifference = backgroundTotal / backgroundWeight - (total - backgroundTotal) / foregroundWeight
    const variance = backgroundWeight * foregroundWeight * meanDifference * meanDifference
    if (variance > maximumVariance) { maximumVariance = variance; threshold = level }
  }
  for (let index = 0; index < image.data.length; index += 4) {
    const value = image.data[index]
    const restored = value < threshold ? Math.max(0, value * .28) : Math.min(255, 245 + (value - threshold) * .12)
    image.data[index] = restored
    image.data[index + 1] = restored
    image.data[index + 2] = restored
  }
  context.putImageData(image, 0, 0)
  return canvas
}

async function imageCanvas(file: File): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file)
  try { return enhancedCanvas(bitmap, bitmap.width, bitmap.height) } finally { bitmap.close() }
}

// Some government "print to PDF" exports emit text items out of visual reading
// order (e.g. every value in a table row before any of that row's labels), so the
// content-stream order can't be trusted. Page coordinates can: cluster items into
// rows by y-position, then read each row left-to-right by x-position. Adjacent
// glyph/conjunct fragments of the same word carry no space between them in these
// exports - only deliberate gaps (column/field separators) contain a real " ".
interface PositionedTextItem { str: string; transform: number[] }

function reconstructPageText(items: Array<{ str?: unknown; transform?: unknown }>): string {
  const nul = String.fromCharCode(0)
  const withText = items.filter((item): item is PositionedTextItem =>
    typeof item.str === 'string' && item.str !== '' && item.str !== nul && Array.isArray(item.transform))
  withText.sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4])
  const rowTolerance = 3
  const rows: { y: number; items: PositionedTextItem[] }[] = []
  for (const item of withText) {
    const y = item.transform[5]
    const row = rows[rows.length - 1]
    if (!row || Math.abs(row.y - y) > rowTolerance) rows.push({ y, items: [item] })
    else row.items.push(item)
  }
  const text = rows
    .map(row => row.items.sort((a, b) => a.transform[4] - b.transform[4]).map(item => item.str).join(''))
    .join('\n')
  // A NUL can also arrive embedded inside an otherwise-valid item.str, not just as
  // a standalone item - strip those too rather than leaving a literal NUL in the text.
  return text.split(nul).join('')
}

async function renderPageCanvas(page: PDFPageProxy): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale: 2 })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('PDF rendering is unavailable in this browser.')
  await page.render({ canvas, canvasContext: context, viewport }).promise
  return enhancedCanvas(canvas, canvas.width, canvas.height)
}

async function pdfPages(file: File, progress: Progress): Promise<{ textLayer: string; canvases: HTMLCanvasElement[]; firstPageCanvas: HTMLCanvasElement | null; pageCount: number; warnings: string[] }> {
  const pdf = await getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise
  const text: string[] = []
  const canvases: HTMLCanvasElement[] = []
  const warnings: string[] = []
  let firstPageCanvas: HTMLCanvasElement | null = null
  const pageLimit = Math.min(pdf.numPages, 20)
  if (pdf.numPages > pageLimit) warnings.push(`OCR was limited to the first ${pageLimit} of ${pdf.numPages} pages for browser safety.`)
  for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
    progress(`Reading PDF page ${pageNumber}/${pageLimit}`, 5 + pageNumber / pageLimit * 22)
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    text.push(reconstructPageText(content.items as Array<{ str?: unknown; transform?: unknown }>))
    // Page 1 renders unconditionally: even when the text layer has plenty of content overall,
    // recognizeLandRecord still needs it for the OCR-backfill cross-check on name/village
    // fields. Later pages only render when the fallback (text layer failed outright) applies.
    if (pageNumber === 1) {
      firstPageCanvas = await renderPageCanvas(page)
      canvases.push(firstPageCanvas)
    } else if (text.join(' ').trim().length < 80) {
      canvases.push(await renderPageCanvas(page))
    }
  }
  return { textLayer: text.join('\n').trim(), canvases, firstPageCanvas, pageCount: pdf.numPages, warnings }
}

async function runOcr(canvases: HTMLCanvasElement[], requestedLanguage: string, progress: Progress, progressStart: number, progressSpan: number): Promise<{ text: string; confidence: number; code: string }> {
  const code = languageCodes[requestedLanguage] || languageCodes['Auto-detect']
  const pageTexts: string[] = []
  let confidenceTotal = 0
  progress(`Loading ${requestedLanguage === 'Auto-detect' ? 'Hindi + English' : requestedLanguage} OCR model`, progressStart)
  const worker = await createWorker(code, OEM.LSTM_ONLY, {
    logger: (message: LoggerMessage) => {
      if (message.status === 'recognizing text') progress('Recognizing printed and handwritten text', progressStart + 5 + message.progress * progressSpan)
    },
  })
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: '1' })
    for (let index = 0; index < canvases.length; index += 1) {
      progress(`OCR page ${index + 1}/${canvases.length}`, progressStart + 5 + index / Math.max(canvases.length, 1) * progressSpan)
      const result = await worker.recognize(canvases[index])
      pageTexts.push(result.data.text)
      confidenceTotal += result.data.confidence
    }
  } finally { await worker.terminate() }
  return { text: pageTexts.join('\n').trim(), confidence: canvases.length ? confidenceTotal / canvases.length : 0, code }
}

// Fields prone to dropping characters on PDFs whose embedded font has an incomplete
// ToUnicode mapping for certain conjunct glyphs (confirmed on a real government "print to
// PDF" export - e.g. "श्री" and "द" vanish from the text layer while rendering correctly on
// the page). OCR reads the rendered pixels, not the broken mapping, so it recovers these -
// but it's markedly less reliable than the text layer for precise table numbers, so it's
// only used to backfill these two free-text fields, never Khata/Khasra/Plot area/Survey.
const OCR_BACKFILL_LABELS = ['Landowner name', 'Village'] as const

export async function recognizeLandRecord(file: File, requestedLanguage: string, district: string, progress: Progress): Promise<OnlineOcrResult> {
  progress('Enhancing source document', 3)
  let text = ''
  let pages = 1
  let confidence = 98
  let engine = 'PDF text layer + DHARA NLP'
  let canvases: HTMLCanvasElement[] = []
  let firstPageCanvas: HTMLCanvasElement | null = null
  let warnings: string[] = []
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')

  if (isPdf) {
    const prepared = await pdfPages(file, progress)
    text = prepared.textLayer
    canvases = prepared.canvases
    firstPageCanvas = prepared.firstPageCanvas
    pages = prepared.pageCount
    warnings = prepared.warnings
  } else {
    canvases = [await imageCanvas(file)]
  }

  const usedTextLayer = isPdf && text.length >= 80
  if (!usedTextLayer) {
    const result = await runOcr(canvases, requestedLanguage, progress, 30, 50)
    text = result.text
    confidence = result.confidence
    engine = `Tesseract.js ${result.code} · enhanced browser OCR`
  }

  if (!text) throw new Error('No text could be recognized. The source remains stored for manual verification.')
  const language = detectScriptLanguage(text, requestedLanguage)
  progress('Classifying land-record fields', 85)
  const extractedFields = extractStructuredFields(text, district, confidence)
  const plot_rows = extractPlotRows(text)

  // The text layer succeeded (so the fallback OCR above never ran) - still run OCR on just
  // the first page, purely to catch the missing-glyph defect. Real added cost, only paid on
  // PDFs that didn't already need OCR, and confined to page 1 (where these fields live).
  if (usedTextLayer && firstPageCanvas) {
    try {
      const ocrResult = await runOcr([firstPageCanvas], requestedLanguage, progress, 86, 8)
      const ocrFields = extractStructuredFields(ocrResult.text, district, ocrResult.confidence)
      for (const label of OCR_BACKFILL_LABELS) {
        const current = extractedFields.find(field => field.label === label)
        const fromOcr = ocrFields.find(field => field.label === label)
        if (current && fromOcr && fromOcr.value.length > current.value.length) {
          current.value = fromOcr.value
          current.original = `${fromOcr.original} (OCR cross-check)`
          current.confidence = Math.round((current.confidence + fromOcr.confidence) / 2)
          current.valid = Boolean(current.value)
        }
      }
    } catch {
      // Best-effort backfill only - a failure here shouldn't fail the whole extraction
      // when the text-layer result is already usable.
    }
  }

  progress('Running validation rules', 96)
  return { text: text.slice(0, 1_000_000), engine, language, confidence, fields: extractedFields, pages, warnings, plot_rows }
}
