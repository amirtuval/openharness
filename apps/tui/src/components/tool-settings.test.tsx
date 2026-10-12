import { ApiError, type Client } from '@openharness/client'
import { createFakeClient } from '@openharness/client/testing'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  frameOf,
  pressKey,
  typeText,
  waitFor,
  waitForFrame,
  waitForScreen,
} from '../test-support/input'
import { ToolSettingsScreen } from './tool-settings'

/** The environment a chat screen has: the server an error is described against. */
const CONTEXT = { server: 'http://localhost:3000' }

afterEach(cleanup)

/** Render `/tools` against a client, and record what it left with. */
function renderTools(
  client: Client,
  modelId: string | undefined = 'anthropic/claude-sonnet-5',
): { readonly app: ReturnType<typeof render>; readonly done: () => boolean } {
  let left = false
  const app = render(
    <ToolSettingsScreen
      client={client}
      context={CONTEXT}
      modelId={modelId}
      onDone={() => {
        left = true
      }}
    />,
  )
  return { app, done: () => left }
}

/** One tool as the fake's settings hold it. */
async function tool(fake: ReturnType<typeof createFakeClient>, name: string) {
  const { data } = await fake.tools.list()
  return data.find((entry) => entry.name === name)
}

/** Wait until the stored policy for a tool is the one expected — the write really landed. */
async function waitForPolicy(
  fake: ReturnType<typeof createFakeClient>,
  name: string,
  policy: string,
): Promise<void> {
  await vi.waitFor(async () => {
    expect((await tool(fake, name))?.policy).toBe(policy)
  })
}

describe('/tools: the listing', () => {
  it('lists this build’s tools with their on/off and permission, then says what it leaves out', async () => {
    const fake = createFakeClient()
    const { app } = renderTools(fake)
    await waitForScreen(app, 'Tools')

    await waitForFrame(app, 'web_fetch')
    const frame = frameOf(app)
    // One row per built-in: the marker, the name, the state and the permission — with the
    // "(default)" note where the permission in force is the tool's own declaration.
    expect(frame).toContain('❯ web_fetch')
    expect(frame).toContain('on   allow (default)')
    expect(frame).toContain('web_search')
    expect(frame).toContain('todo_write')
    // This build's own tools only: a remote tool belongs to its server (#313).
    expect(frame).toContain('MCP tools are not listed here; /mcp sets them, per server.')
    expect(frame).toContain('←/→ permission')
  })

  it('says how many remote tools it left out when there are any', async () => {
    const fake = createFakeClient({
      mcpTools: [
        { server: 'notes', name: 'search' },
        { server: 'notes', name: 'read' },
      ],
    })
    const { app } = renderTools(fake)
    await waitForScreen(app, 'Tools')
    await waitForFrame(app, '2 MCP tools are not listed here; /mcp sets them, per server.')
    expect(frameOf(app)).not.toContain('notes__search')
  })

  it('says why a tool this model cannot use is not offered', async () => {
    const fake = createFakeClient({
      toolsAvailable: { web_search: false },
      toolsReason: { web_search: 'This model has no web search.' },
    })
    const { app } = renderTools(fake, 'anthropic/claude-haiku-4')
    await waitForScreen(app, 'Tools')
    await waitForFrame(app, 'This model has no web search.')
    expect(frameOf(app)).toContain('web_search')
  })

  it('reads the list against the chat’s model', async () => {
    const fake = createFakeClient()
    const list = vi.spyOn(fake.tools, 'list')
    const { app } = renderTools(fake, 'openai/gpt-5')
    await waitForScreen(app, 'Tools')
    await waitFor(() => list.mock.calls.length > 0)
    expect(list.mock.calls[0]?.[0]).toEqual({ model_id: 'openai/gpt-5' })
  })
})

describe('/tools: the keys', () => {
  it('walks the permissions with ←/→, one PUT per change', async () => {
    const fake = createFakeClient()
    const put = vi.spyOn(fake.tools, 'put')
    const { app } = renderTools(fake)
    await waitForScreen(app, 'Tools')
    await waitForFrame(app, '❯ web_fetch')

    pressKey(app, 'right')
    await waitForPolicy(fake, 'web_fetch', 'ask')
    expect(put).toHaveBeenCalledTimes(1)
    // The one write names the one tool, both halves of its setting, and nothing else.
    expect(put.mock.calls[0]?.[0]).toEqual({
      builtin: { web_fetch: { enabled: true, policy: 'ask' } },
    })
    await waitForFrame(app, 'web_fetch: ask.')

    pressKey(app, 'right')
    await waitForPolicy(fake, 'web_fetch', 'deny')
    pressKey(app, 'left')
    await waitForPolicy(fake, 'web_fetch', 'ask')
    expect(put).toHaveBeenCalledTimes(3)
    // Nothing else moved: a merge over one tool never clears another's setting.
    expect((await tool(fake, 'todo_write'))?.policy).toBe('allow')
  })

  it('skips `ask` for the provider-executed search, which the server refuses', async () => {
    const fake = createFakeClient()
    const put = vi.spyOn(fake.tools, 'put')
    const { app } = renderTools(fake)
    await waitForScreen(app, 'Tools')
    await waitForFrame(app, '❯ web_fetch')

    pressKey(app, 'down')
    await waitForFrame(app, '❯ web_search')
    pressKey(app, 'right')
    await waitForPolicy(fake, 'web_search', 'deny')
    // The whole point: the write never carries `ask`.
    expect(put.mock.calls[0]?.[0]).toEqual({
      builtin: { web_search: { enabled: true, policy: 'deny' } },
    })
    await waitForFrame(app, 'web_search: deny.')

    pressKey(app, 'right')
    await waitForPolicy(fake, 'web_search', 'allow')
    expect(put).toHaveBeenCalledTimes(2)
  })

  it('turns a tool off and on with space', async () => {
    const fake = createFakeClient()
    const { app } = renderTools(fake)
    await waitForScreen(app, 'Tools')
    await waitForFrame(app, '❯ web_fetch')

    typeText(app, ' ')
    await vi.waitFor(async () => {
      expect((await tool(fake, 'web_fetch'))?.enabled).toBe(false)
    })
    await waitForFrame(app, 'web_fetch turned off.')
    // The permission is untouched: the write carries back the half it did not name.
    expect((await tool(fake, 'web_fetch'))?.policy).toBe('allow')

    typeText(app, ' ')
    await vi.waitFor(async () => {
      expect((await tool(fake, 'web_fetch'))?.enabled).toBe(true)
    })
    await waitForFrame(app, 'web_fetch turned on.')
  })

  it('shows a refused write inline, with the list where it was', async () => {
    const fake = createFakeClient()
    const client: Client = {
      ...fake,
      tools: {
        ...fake.tools,
        put: () =>
          Promise.reject(
            new ApiError(400, 'a web_search cannot be evaluated under ask.', {
              type: 'invalid_request_error',
            }),
          ),
      },
    }
    const { app } = renderTools(client)
    await waitForScreen(app, 'Tools')
    await waitForFrame(app, '❯ web_fetch')

    pressKey(app, 'right')
    await waitForFrame(app, 'cannot be evaluated under ask')
    // The list is still there, still on the same row, and nothing was stored.
    expect(frameOf(app)).toContain('❯ web_fetch')
    expect((await tool(fake, 'web_fetch'))?.policy).toBe('allow')
  })

  it('leaves on Esc and on Ctrl+C', async () => {
    const first = renderTools(createFakeClient())
    await waitForScreen(first.app, 'Tools')
    pressKey(first.app, 'escape')
    await waitFor(() => first.done())

    const second = renderTools(createFakeClient())
    await waitForScreen(second.app, 'Tools')
    pressKey(second.app, 'ctrlC')
    await waitFor(() => second.done())
  })
})

describe('/tools: a list longer than the screen', () => {
  it('keeps the cursor in frame and counts what is out of sight', async () => {
    // Forty stored tools: far more than a terminal shows, which is the reader's report about
    // the `/mcp` tools face — held here for the screen that has the same shape.
    const fake = createFakeClient({ toolSettings: manyTools() })
    const { app } = renderTools(fake)
    await waitForScreen(app, 'Tools')
    await waitForFrame(app, '❯ web_fetch')
    expect(frameOf(app)).toContain('more')

    pressKey(app, 'end')
    await waitForFrame(app, '❯ tool_9')
    const atEnd = frameOf(app)
    expect(atEnd).toContain('↑ 24 more')
    expect(atEnd).not.toContain('web_fetch')

    pressKey(app, 'home')
    await waitForFrame(app, '❯ web_fetch')
    expect(frameOf(app)).toContain('↓ 24 more')

    // A page down leaves the first screen behind: the cursor moved and the window with it.
    pressKey(app, 'pageDown')
    await waitFor(() => !frameOf(app).includes('❯ web_fetch'))
  })
})

/** Forty stored settings, so the list is longer than any frame draws at once. */
function manyTools() {
  const builtin: Record<string, { enabled: boolean; policy: 'allow' }> = {}
  for (let index = 0; index < 40; index += 1) {
    builtin[`tool_${String(index)}`] = { enabled: true, policy: 'allow' }
  }
  return { builtin, mcp: {} }
}
