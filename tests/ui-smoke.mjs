import puppeteer from 'puppeteer-core'

const executablePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage()
const baseUrl = process.env.BASE_URL || 'http://localhost:5173'
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
const errors = []
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
page.on('pageerror', error => errors.push(error.message))

await page.goto(baseUrl, { waitUntil: 'networkidle0' })
await page.waitForSelector('.login-submit')
await page.click('.login-submit')
await page.waitForSelector('.sidebar', { timeout: 10000 })
await page.waitForSelector('.metric-card')

const officer = await page.$eval('.user-card strong', element => element.textContent)
if (officer !== 'Aditi Rao') throw new Error(`Unexpected signed-in user: ${officer}`)

const clickNavigation = async label => {
  const clicked = await page.$$eval('.sidebar nav button', (buttons, text) => {
    const button = buttons.find(candidate => candidate.textContent?.includes(text))
    if (!button) return false
    button.click()
    return true
  }, label)
  if (!clicked) throw new Error(`Navigation item not found: ${label}`)
}

await clickNavigation('Land records')
await page.waitForSelector('.records-table tbody tr')
await page.click('.records-table tbody tr')
await page.waitForSelector('.record-modal')
if (await page.$$eval('.record-modal-fields > div', elements => elements.length) < 12) throw new Error('Complete canonical land-record fields did not load')
await page.screenshot({ path: '/tmp/dhara-record-modal.png', fullPage: true })
await page.click('.record-modal-head .icon-btn')

await clickNavigation('Cadastral map')
await page.waitForSelector('.parcel')
if (await page.$$eval('.parcel', elements => elements.length) < 8) throw new Error('Persisted parcel layer did not load')

await clickNavigation('Audit trail')
await page.waitForSelector('.timeline-item')

const settingsOpened = await page.$$eval('.sidebar-bottom button', buttons => {
  const button = buttons.find(candidate => candidate.textContent?.includes('Users & security'))
  if (!button) return false
  button.click()
  return true
})
if (!settingsOpened) throw new Error('Administrative settings navigation was not available')
await page.waitForSelector('.settings-main')
await page.waitForSelector('.user-row')
if (await page.$$eval('.user-row', elements => elements.length) < 5) throw new Error('Role management users did not load')

await clickNavigation('Overview')
await page.waitForSelector('.metrics-grid')
await page.screenshot({ path: '/tmp/dhara-dashboard.png', fullPage: true })

const citizenPage = await browser.newPage()
await citizenPage.goto(`${baseUrl}/citizen`, { waitUntil: 'networkidle0' })
await citizenPage.waitForSelector('.citizen-form')
if (!await citizenPage.$eval('.citizen-hero h1', element => element.textContent?.includes('land-record request'))) throw new Error('Citizen service portal did not load')
await citizenPage.close()

await browser.close()
if (errors.length) throw new Error(`Browser console errors:\n${errors.join('\n')}`)
console.log('UI smoke test passed: login, dashboard, GIS, audit, and console checks')
