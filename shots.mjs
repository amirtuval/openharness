import { execFileSync } from 'node:child_process'

import { chromium } from '@playwright/test'

const BASE = 'http://localhost:3000'
const OUT = 'docs/screenshots/248'
const DESKTOP = { width: 1280, height: 900 }
const NARROW = { width: 400, height: 800 }

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: DESKTOP, colorScheme: 'light' })
const page = await context.newPage()

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log(`shot ${name}`)
}

async function setTheme(theme) {
  // The radio input is `sr-only` and its label carries the look, so the text is what is
  // clicked — which is also what a reader clicks.
  await page.getByText(theme, { exact: true }).click()
  await page.waitForTimeout(200)
}

async function signIn() {
  await page.goto(`${BASE}/#/settings`)
  const username = page.getByLabel('Username')
  const saved = page.getByRole('region', { name: 'Saved credentials' })
  await Promise.race([
    username.waitFor({ timeout: 20000 }),
    saved.waitFor({ timeout: 20000 }),
  ])
  if (await username.count()) {
    await username.fill('dev@localhost')
    await page.getByLabel('Password').fill('dev')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  }
  await saved.waitFor({ timeout: 20000 })
}

async function openAzureForm() {
  await page.getByRole('button', { name: 'Add provider' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  await dialog.getByRole('button', { name: 'Azure OpenAI', exact: true }).click()
  await dialog.getByLabel('Endpoint').waitFor()
  return dialog
}

async function closeDialog(dialog) {
  // The dialog's own close control (its X), not the form's "Back to the list".
  await dialog.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
}

await signIn()

// 1. The azure form, in the three themes.
for (const theme of ['Light', 'Dim', 'Dark']) {
  await setTheme(theme)
  const dialog = await openAzureForm()
  await shot(`01-azure-form-${theme.toLowerCase()}`)
  await closeDialog(dialog)
}

// 2. The refusals, on the real server.
await setTheme('Light')
let dialog = await openAzureForm()
await dialog.getByLabel('Endpoint').fill('http://my-resource.openai.azure.com')
await dialog.getByLabel('API key').fill('az-key-00000000')
await dialog.getByLabel('Deployments').fill('gpt-4o')
await dialog.getByRole('button', { name: 'Save key' }).click()
await dialog.getByRole('alert').waitFor()
await shot('02-refused-http-endpoint')
await closeDialog(dialog)

await setTheme('Dark')
dialog = await openAzureForm()
await dialog.getByLabel('Endpoint').fill('https://localhost')
await dialog.getByLabel('API key').fill('az-key-00000000')
await dialog.getByLabel('Deployments').fill('gpt-4o')
await dialog.getByRole('button', { name: 'Save key' }).click()
await dialog.getByRole('alert').waitFor({ timeout: 30000 })
await shot('03-refused-private-endpoint')
await closeDialog(dialog)

// 3. Two seeded credentials: the list with names, and the name prompt for a third.
execFileSync('node', ['seed-azure.mjs'], { cwd: process.cwd(), stdio: 'inherit' })
await page.reload()
await page.getByRole('region', { name: 'Saved credentials' }).waitFor({ timeout: 20000 })

for (const theme of ['Light', 'Dark']) {
  await setTheme(theme)
  await shot(`04-credentials-list-${theme.toLowerCase()}`)
}

await page.setViewportSize(NARROW)
await setTheme('Light')
await shot('05-credentials-list-400')
await page.setViewportSize(DESKTOP)

dialog = await openAzureForm()
await dialog.getByLabel('Name').waitFor()
await shot('06-second-credential-name-prompt')
await dialog.getByLabel('Name').fill('openai')
await dialog.getByText('belongs to one of the built-in providers').waitFor()
await shot('07-name-taken-inline')
await dialog.getByLabel('Name').fill('azure-eu')
await shot('08-name-accepted')

await browser.close()
