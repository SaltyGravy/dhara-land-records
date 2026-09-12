import puppeteer from 'puppeteer-core'

const executablePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const baseUrl = process.env.BASE_URL || 'http://localhost:5173'
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] })

const fixture = await browser.newPage()
await fixture.setViewport({ width: 1200, height: 1500, deviceScaleFactor: 1 })
await fixture.setContent(`<!doctype html><style>body{margin:0;background:white;color:#111;font:36px Georgia;line-height:1.75}.sheet{margin:70px;border:5px solid #222;padding:65px}.sheet h1{text-align:center;font-size:48px}.rule{border-top:2px solid #555;margin:30px 0}</style><div class="sheet"><h1>LAND OWNERSHIP RECORD</h1><div class="rule"></div><p>Landowner name: Asha Devi</p><p>Survey number: 77/4</p><p>Khasra number: 77/4</p><p>Khata number: KH-2026-91</p><p>Plot area: 1.25 hectare</p><p>Village: Rampur</p><p>Tehsil: Sadar</p><p>District: Lucknow</p><p>Land classification: Agricultural Irrigated</p><p>Ownership details: Recorded tenure holder</p><p>Mutation reference: MUT/2026/91</p><p>Registration information: REG/2026/77</p></div>`)
await fixture.screenshot({ path: '/tmp/dhara-ocr-test.png', type: 'png' })
await fixture.close()

const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
const pageErrors = []
page.on('pageerror', error => pageErrors.push(error.message))
await page.goto(baseUrl, { waitUntil: 'networkidle0' })
await page.click('.login-submit:last-of-type')
await page.waitForSelector('.sidebar')
const uploadOpened = await page.$$eval('.sidebar nav button', buttons => {
  const button = buttons.find(candidate => candidate.textContent?.includes('Upload & process'))
  button?.click()
  return Boolean(button)
})
if (!uploadOpened) throw new Error('Upload navigation was unavailable')
await page.waitForSelector('input[type=file]')
const fileInput = await page.$('input[type=file]')
await fileInput.uploadFile('/tmp/dhara-ocr-test.png')
await page.select('.form-grid label:nth-child(4) select', 'English')
const processButton = await page.$('.upload-footer .btn.primary')
await processButton.click()
await page.waitForFunction(() => document.querySelector('.success-box')?.textContent?.includes('Processing complete'), { timeout: 180_000 })

const record = await page.evaluate(async () => {
  const token = localStorage.getItem('dhara_access_token')
  const response = await fetch('/api/documents', { headers: { Authorization: `Bearer ${token}` } })
  const records = await response.json()
  return records.find(item => item.filename === 'dhara-ocr-test.png')
})
if (!record) throw new Error('OCR record was not persisted')
const values = Object.fromEntries(record.fields.map(field => [field.label, field.value]))
if (!String(values['Landowner name']).includes('Asha Devi')) throw new Error(`Owner OCR failed: ${values['Landowner name']}`)
if (!String(values['Khasra number']).includes('77/4')) throw new Error(`Khasra OCR failed: ${values['Khasra number']}`)
if (record.status !== 'Needs review') throw new Error(`Unexpected OCR status: ${record.status}`)
await page.screenshot({ path: '/tmp/dhara-online-ocr-complete.png', fullPage: true })

await browser.close()
if (pageErrors.length) throw new Error(`Browser page errors:\n${pageErrors.join('\n')}`)
console.log(`Online OCR smoke test passed: ${record.id}, ${record.confidence}% confidence`)
