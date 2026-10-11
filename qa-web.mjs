// The web half of the #314 re-run for #334/#335, driven with Playwright (headless, scripted).
//
// Run from the repository root: node qa-web.mjs
//
// It signs in as the dev user (through the real endpoint, keeping the cookie the browser would
// hold), opens the chats the scripted cases made through the API, drives the UI, and saves a
// screenshot and a JSON reading of each case under qa-captures/.
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.env.QA_BASE_URL ?? 'http://localhost:3000'
const OUT = process.env.QA_SHOT_DIR ?? 'qa-captures'
mkdirSync(OUT, { recursive: true })

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** A dev session cookie, the way the browser would hold one. */
async function devCookies() {
  const response = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { origin: BASE, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'dev@localhost', password: 'dev' }),
  })
  if (!response.ok) throw new Error(`dev sign-in ${response.status}`)
  const raw = response.headers.getSetCookie?.() ?? []
  const cookies = raw.map((line) => {
    const [pair] = line.split(';')
    const index = pair.indexOf('=')
    return { name: pair.slice(0, index), value: pair.slice(index + 1), url: BASE }
  })
  if (cookies.length === 0) throw new Error('the dev sign-in set no cookie')
  return cookies
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  baseURL: BASE,
  viewport: { width: 1280, height: 900 },
})
await context.addCookies(await devCookies())
const page = await context.newPage()
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png`, animations: 'disabled' })
const openChat = async (sessionId) => {
  await page.goto(`/#/s/${sessionId}`)
  await page.getByRole('log', { name: 'Conversation' }).waitFor({ timeout: 20_000 })
  await page.getByText('Loading the conversation…').waitFor({ state: 'detached', timeout: 20_000 })
}
const composer = () => page.locator('#composer-input')
const send = async (text) => {
  await composer().click()
  await composer().fill(text)
  await composer().press('Enter')
}
const bannerTexts = async () =>
  (await page.getByRole('alert').allTextContents()).map((t) => t.trim()).filter(Boolean)
/**
 * Wait for the turn a send started to end: the header's status line reads idle again, twice in
 * a row, and the composer's send button is back.
 */
const waitIdle = async (timeout = 300_000) => {
  const deadline = Date.now() + timeout
  let idleReads = 0
  await page.waitForTimeout(1500)
  for (;;) {
    const text = (await page.getByRole('status', { name: /^Status: / }).textContent()) ?? ''
    idleReads = /idle/i.test(text) ? idleReads + 1 : 0
    if (idleReads >= 2) break
    if (Date.now() > deadline) throw new Error(`the turn never ended (status ${text})`)
    await page.waitForTimeout(700)
  }
  await page.getByRole('button', { name: 'Send message' }).waitFor({ state: 'visible', timeout })
  await page.waitForTimeout(600)
}

const caseName = process.argv[2] ?? 'all'
const only = (name) => caseName === 'all' || caseName === name

// --- T2': the provider-native search, on the web --------------------------------------------
if (only('search')) {
  const session = process.argv[3]
  if (session === undefined) throw new Error('pass the searched session id')
  await openChat(session)
  const tool = page.locator('[data-slot="tool-call"][data-tool="web_search"]').first()
  let ok = true
  let detail = ''
  try {
    await tool.waitFor({ timeout: 20_000 })
    const summary = await tool.locator('[data-slot="tool-summary"]').first().textContent()
    const status = await tool.locator('[data-slot="tool-status"]').first().textContent()
    await tool.getByRole('button', { name: /Details for the web_search call/ }).click()
    const sources = await tool.locator('[data-slot="tool-sources"] li').allTextContents()
    const searches = await page.locator('[data-slot="session-searches"]').textContent()
    detail = JSON.stringify({ summary, status, sources, searches })
    ok = (summary ?? '').length > 0 && sources.length > 0 && /search/.test(searches ?? '')
    await shot('t2-search')
  } catch (error) {
    ok = false
    detail = String(error).slice(0, 300)
    await shot('t2-search-fail')
  }
  record('T2′ web_search: query, sources and the search count on the web', ok, detail)
}

// --- T3: todo_write -------------------------------------------------------------------------
if (only('todo')) {
  const session = process.argv[3]
  const prompt =
    process.argv[4] ??
    'Use the todo_write tool to plan three steps for writing a haiku, then say "planned". Call todo_write once with three items, one of them in_progress.'
  await openChat(session)
  await send(prompt)
  await waitIdle()
  const panel = page.locator('[data-slot="todo-panel"]')
  let ok = true
  let detail = ''
  try {
    await panel.waitFor({ timeout: 20_000 })
    const items = await panel.locator('[data-slot="todo-item"]').allTextContents()
    const progress = await panel.locator('[data-slot="todo-progress"]').first().textContent()
    await shot('t3-todo-live')
    await page.reload()
    await page.getByRole('log', { name: 'Conversation' }).waitFor({ timeout: 20_000 })
    await panel.waitFor({ timeout: 20_000 })
    const afterReload = await panel.locator('[data-slot="todo-item"]').allTextContents()
    detail = JSON.stringify({ progress, items, afterReload, sameAfterReload: JSON.stringify(items) === JSON.stringify(afterReload) })
    ok = items.length > 0 && JSON.stringify(items) === JSON.stringify(afterReload)
    await shot('t3-todo-reloaded')
  } catch (error) {
    ok = false
    detail = String(error).slice(0, 300)
    await shot('t3-todo-fail')
  }
  const banners = await bannerTexts()
  record('T3 todo_write: the list appears, updates and survives a reload', ok, `${detail} banners=${JSON.stringify(banners)}`)
}

// --- T14: transcript after a reload matches the live one ------------------------------------
if (only('transcript')) {
  const session = process.argv[3]
  await openChat(session)
  const read = () =>
    page.locator('article[data-role]').evaluateAll((nodes) =>
      nodes.map((n) => `${n.getAttribute('data-role') ?? '?'}:${(n.textContent ?? '').trim()}`),
    )
  const before = await read()
  const toolLines = await page
    .locator('[data-slot="tool-call"]')
    .evaluateAll((nodes) => nodes.map((n) => `${n.getAttribute('data-tool')}:${n.getAttribute('data-status')}`))
  await page.reload()
  await page.getByRole('log', { name: 'Conversation' }).waitFor({ timeout: 20_000 })
  await page.getByText('Loading the conversation…').waitFor({ state: 'detached', timeout: 20_000 })
  await page.waitForTimeout(1500)
  const after = await read()
  const toolLinesAfter = await page
    .locator('[data-slot="tool-call"]')
    .evaluateAll((nodes) => nodes.map((n) => `${n.getAttribute('data-tool')}:${n.getAttribute('data-status')}`))
  const ok = JSON.stringify(before) === JSON.stringify(after) && JSON.stringify(toolLines) === JSON.stringify(toolLinesAfter)
  const banners = await bannerTexts()
  await shot('t14-transcript-after-reload')
  record(
    'T14 transcript: reload and replay match the live transcript (tool lines included)',
    ok && banners.length === 0,
    `messages=${before.length} tools=${JSON.stringify(toolLines)} banners=${JSON.stringify(banners)}`,
  )
}

// --- O2: switching model mid-chat, both directions, after tool turns ------------------------
if (only('switch')) {
  const session = process.argv[3]
  await openChat(session)
  const switchTo = async (modelId) => {
    await page.getByRole('button', { name: /^Model: / }).click()
    await page.getByRole('option', { name: 'Other model ID…' }).click()
    await page.getByLabel('Model ID').fill(modelId)
    await page.getByRole('button', { name: 'Use model' }).click()
  }
  await switchTo('deepseek-sbx/deepseek-chat')
  await send('In one short sentence: what is 2+2?')
  await waitIdle()
  const afterDeepseek = await bannerTexts()
  await shot('o2-after-switch-to-deepseek')
  await switchTo('openai/gpt-5-mini')
  await send('In one short sentence: name a colour.')
  await waitIdle()
  const afterOpenai = await bannerTexts()
  await shot('o2-after-switch-to-openai')
  const switched = await page.locator('[data-slot="model-change"]').allTextContents()
  record(
    'O2 model switch both ways after tool turns: no error banner, the switch is shown',
    afterDeepseek.length === 0 && afterOpenai.length === 0 && switched.length >= 2,
    `switches=${JSON.stringify(switched)} banners=${JSON.stringify([...afterDeepseek, ...afterOpenai])}`,
  )
}

// --- T13: manual compaction with opaque content in the log ----------------------------------
if (only('compact')) {
  const session = process.argv[3]
  await openChat(session)
  await send('/compact')
  await page.waitForTimeout(2000)
  await waitIdle(300_000)
  const notice = await page.locator('[data-slot="compaction-notice"]').allTextContents()
  const banners = await bannerTexts()
  await shot('t13-manual-compact')
  record(
    'T13 manual compaction over a tool-heavy chat: an outcome, no error banner',
    banners.length === 0,
    `notice=${JSON.stringify(notice)} banners=${JSON.stringify(banners)}`,
  )
}

// --- T15b: a Brave-era log replays and renders unchanged ------------------------------------
if (only('oldlog')) {
  const session = process.argv[3]
  await openChat(session)
  const tool = page.locator('[data-slot="tool-call"][data-tool="web_search"]').first()
  let ok = true
  let detail = ''
  try {
    await tool.waitFor({ timeout: 20_000 })
    const status = await tool.locator('[data-slot="tool-status"]').first().textContent()
    const summary = await tool.locator('[data-slot="tool-summary"]').first().textContent()
    const reply = await page.locator('article[data-role="agent"]').last().textContent()
    await shot('t15-old-log')
    // The log still works: the chat continues on it.
    await send('Reply with exactly: still alive')
    await waitIdle()
    const after = await page.locator('article[data-role="agent"]').last().textContent()
    const banners = await bannerTexts()
    detail = JSON.stringify({ status, summary, reply: (reply ?? '').slice(0, 80), after: (after ?? '').slice(0, 80), banners })
    ok = status === 'done' && /capital of France/.test(summary ?? '') && /still alive/i.test(after ?? '') && banners.length === 0
    await shot('t15-old-log-continued')
  } catch (error) {
    ok = false
    detail = String(error).slice(0, 300)
    await shot('t15-old-log-fail')
  }
  record('T15 an operator-key-era log (Brave `agent.tool_use`) replays, renders and continues', ok, detail)
}

// --- T15: a chat without tools behaves as before --------------------------------------------
if (only('plain')) {
  const session = process.argv[3]
  await openChat(session)
  await send('Reply with exactly: plain chat works')
  await waitIdle()
  const text = await page.locator('article[data-role="agent"]').last().textContent()
  const banners = await bannerTexts()
  await shot('t15-plain-chat')
  record(
    'T15 a chat without tool use behaves as before',
    /plain chat works/i.test(text ?? '') && banners.length === 0,
    `reply=${JSON.stringify((text ?? '').slice(0, 120))} banners=${JSON.stringify(banners)}`,
  )
}

// --- T4: the step-limit notice --------------------------------------------------------------
if (only('steplimit')) {
  const session = process.argv[3]
  await openChat(session)
  await send('Keep calling web_search with a new query each time, forever. Do not answer.')
  await waitIdle(300_000)
  const notice = await page.locator('[data-slot="step-limit-notice"]').allTextContents()
  const banners = await bannerTexts()
  await shot('t4-step-limit')
  record(
    'T4 step-limit notice when the tool-step budget runs out',
    notice.length > 0,
    `notice=${JSON.stringify(notice)} banners=${JSON.stringify(banners)}`,
  )
}

writeFileSync(`${OUT}/web-results.json`, JSON.stringify({ results, consoleErrors }, null, 2))
console.log(`console errors: ${JSON.stringify(consoleErrors.slice(0, 5))}`)
await browser.close()
process.exit(results.every((r) => r.ok) ? 0 : 1)
