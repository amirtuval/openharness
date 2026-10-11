import { describe, expect, it } from 'vitest'

import {
  PACKAGE_NAME,
  PROTOCOL_DEPENDENCY,
  SUPPORTED_SEARCH_PROVIDERS,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_API_KEY,
  WEB_SEARCH_TOOL_NAME,
  createBraveSearchProvider,
  createWebFetchTool,
  createWebSearchTool,
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

  it('exports the built-in tools, their names, and the search seam (#305)', () => {
    expect(createWebFetchTool().name).toBe(WEB_FETCH_TOOL_NAME)
    expect(createWebFetchTool().permission).toBe('allow')
    expect(todoWriteTool.name).toBe('todo_write')
    expect(todoWriteTool.permission).toBe('allow')
    expect(typeof createBraveSearchProvider).toBe('function')
    expect(SUPPORTED_SEARCH_PROVIDERS).toEqual(['brave'])
    expect(WEB_SEARCH_TOOL_NAME).toBe('web_search')
    // The name the operator's key travels under, and the one the server's resolver fills in.
    expect(WEB_SEARCH_API_KEY).toBe('openharness_search_api_key')
    expect(typeof createWebSearchTool).toBe('function')
    expect(htmlToMarkdown('<html><body><p>hi</p></body></html>', 'https://example.com/')).toContain(
      'hi',
    )
  })
})
