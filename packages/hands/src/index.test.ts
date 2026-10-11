import { describe, expect, it } from 'vitest'

import {
  PACKAGE_NAME,
  PROTOCOL_DEPENDENCY,
  WEB_FETCH_TOOL_NAME,
  createWebFetchTool,
  htmlToMarkdown,
  todoWriteTool,
} from './index'

describe('@openharness/hands', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@openharness/hands')
  })

  it('reaches protocol through its built output', () => {
    expect(PROTOCOL_DEPENDENCY).toBe('@openharness/protocol')
  })

  it('exports the built-in tools this build runs itself (#305)', () => {
    expect(createWebFetchTool().name).toBe(WEB_FETCH_TOOL_NAME)
    expect(createWebFetchTool().permission).toBe('allow')
    expect(todoWriteTool.name).toBe('todo_write')
    expect(todoWriteTool.permission).toBe('allow')
    // `web_search` is deliberately **not** here: #335 offers it by attaching the model
    // provider's own search tool to the request, so nothing in this package runs it — and the
    // packages that name it take the name from `@openharness/protocol`.
    expect(htmlToMarkdown('<html><body><p>hi</p></body></html>', 'https://example.com/')).toContain(
      'hi',
    )
  })
})
