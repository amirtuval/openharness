import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const OUT = '/tmp/shots'
mkdirSync(OUT, { recursive: true })
const BASE = 'http://localhost:3000'

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
page.on('console', (m) => { if (m.type() === 'error') console.log('console error:', m.text()) })
page.on('response', (r) => { if (r.status() >= 400) console.log('HTTP', r.status(), r.url()) })

await page.goto(`${BASE}/#/signin`, { waitUntil: 'networkidle' })
await page.getByLabel('Username').fill('dev@localhost')
await page.getByLabel('Password').fill('dev')
await page.getByRole('button', { name: 'Sign in' }).click()
await page.waitForTimeout(1500)

await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' })
await page.getByRole('region', { name: 'Saved credentials' }).waitFor({ timeout: 15000 })

async function theme(name) {
  // The theme is one attribute on <html> (the store's own resolution writes the same one), so
  // the three palettes are screenshotted by setting it — what the Appearance picker paints.
  if (!page.url().endsWith('#/settings')) {
    await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' })
  }
  await page.getByRole('region', { name: 'Saved credentials' }).waitFor({ timeout: 15000 })
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), name)
  await page.waitForTimeout(400)
  console.log('theme', name, '->', await page.evaluate(() => document.documentElement.dataset.theme))
}

for (const t of ['light', 'dim', 'dark']) {
  await theme(t)
  await page.screenshot({ path: `${OUT}/list-${t}-desktop.png` })
}
// 400px
await page.setViewportSize({ width: 400, height: 900 })
for (const t of ['light', 'dim', 'dark']) {
  await theme(t)
  await page.screenshot({ path: `${OUT}/list-${t}-400.png`, fullPage: false })
}
await page.setViewportSize({ width: 1280, height: 900 })
await theme('light')

// The rows the list shows
const rows = await page.getByRole('listitem').allInnerTexts()
console.log('ROWS:', JSON.stringify(rows))

// Replace: the form opens prefilled with the stored name, and Save is enabled.
await page.getByRole('button', { name: 'Replace the azure credential' }).click()
const dialog = page.getByRole('dialog')
await dialog.waitFor()
const nameInput = dialog.getByLabel('Name')
console.log('REPLACE name value:', JSON.stringify(await nameInput.inputValue()))
const names = await dialog.getByRole('button').allInnerTexts()
console.log('DIALOG BUTTONS:', JSON.stringify(names))
// The form opens with the fields empty (a replace re-enters the secret), so fill them: the
// bug #263 found was that Save stayed disabled *with* the fields filled, because the
// prefilled name was refused as already taken.
await dialog.getByLabel('Endpoint').fill('https://my-resource.openai.azure.com')
await dialog.getByLabel('API key').fill('az-key-4242')
await dialog.getByLabel('Deployments').fill('gpt-4o, gpt-4o-mini')
await page.waitForTimeout(200)
console.log('REPLACE save enabled:', await dialog.getByRole('button', { name: /Replace key|Save key/ }).isEnabled())
await page.screenshot({ path: `${OUT}/replace-prefilled.png` })

// A blank name holds the save.
await nameInput.fill('')
await page.waitForTimeout(200)
console.log('BLANK save enabled:', await dialog.getByRole('button', { name: /Replace key|Save key/ }).isEnabled())
await page.screenshot({ path: `${OUT}/replace-blank.png` })
await dialog.getByRole('button', { name: 'Cancel' }).click()
await page.waitForTimeout(300)

// Add a second Azure credential: Save waits for a name.
await page.getByRole('button', { name: 'Add provider' }).click()
const dialog2 = page.getByRole('dialog')
await dialog2.getByRole('button', { name: 'Azure OpenAI' }).click()
await dialog2.getByLabel('Endpoint').fill('https://my-resource.openai.azure.com')
await dialog2.getByLabel('API key').fill('az-key-9999')
await dialog2.getByLabel('Deployments').fill('gpt-4o')
await page.waitForTimeout(200)
console.log('ADD blank-name save enabled:', await dialog2.getByRole('button', { name: /Replace key|Save key/ }).isEnabled())
await page.screenshot({ path: `${OUT}/add-blank-name.png` })
await dialog2.getByLabel('Name').fill('azure-eu')
await page.waitForTimeout(200)
console.log('ADD named save enabled:', await dialog2.getByRole('button', { name: /Replace key|Save key/ }).isEnabled())
await page.screenshot({ path: `${OUT}/add-named.png` })

await browser.close()
console.log('done')
