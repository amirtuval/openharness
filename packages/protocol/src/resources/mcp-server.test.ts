import { describe, expect, it } from 'vitest'

import { newMcpServerId } from '../ids'
import {
  ConnectMcpServerRequestSchema,
  ConnectMcpServerResponseSchema,
  CreateMcpServerRequestSchema,
  ListMcpServersResponseSchema,
  MAX_MCP_HEADERS,
  McpHeadersSchema,
  McpServerSchema,
  McpServerUrlSchema,
  McpToolDefinitionSchema,
  UpdateMcpServerRequestSchema,
  estimateToolDefinitionTokens,
  estimateToolsTokens,
  isMcpServerName,
  isMcpServerUrl,
  mcpToolSummary,
} from './mcp-server'

/** A minimal valid resource, so a test can override exactly the field it is about. */
function server(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: newMcpServerId(1_700_000_000_000),
    type: 'mcp_server',
    owner_id: 'user_1',
    name: 'notes',
    url: 'https://mcp.example.com/mcp',
    auth: 'none',
    enabled: true,
    status: 'connected',
    last_error: null,
    header_names: [],
    tools: [],
    definition_tokens: 0,
    last_tested_at: null,
    created_at: '2026-03-15T10:00:00Z',
    updated_at: '2026-03-15T10:00:00Z',
    ...overrides,
  }
}

describe('MCP server names', () => {
  it('accepts lowercase names a tool-name prefix can carry', () => {
    expect(isMcpServerName('notes')).toBe(true)
    expect(isMcpServerName('my-notes-2')).toBe(true)
    expect(isMcpServerName('a')).toBe(true)
  })

  it('refuses a name that is not safe as a tool-name prefix', () => {
    expect(isMcpServerName('')).toBe(false)
    expect(isMcpServerName('-notes')).toBe(false)
    expect(isMcpServerName('notes-')).toBe(false)
    expect(isMcpServerName('MyNotes')).toBe(false)
    expect(isMcpServerName('my_notes')).toBe(false)
    expect(isMcpServerName('my.notes')).toBe(false)
    expect(isMcpServerName('a'.repeat(33))).toBe(false)
  })

  it('is what a create body enforces', () => {
    // The name's own rule is `isMcpServerName`; the request's schema is where it lands.
    expect(
      CreateMcpServerRequestSchema.safeParse({
        auth: 'none',
        name: 'Bad Name',
        url: 'https://mcp.example.com/mcp',
      }).success,
    ).toBe(false)
  })
})

describe('MCP server URLs', () => {
  it('accepts absolute http and https URLs', () => {
    expect(isMcpServerUrl('https://mcp.example.com/mcp')).toBe(true)
    expect(isMcpServerUrl('http://127.0.0.1:8080/mcp')).toBe(true)
  })

  it('refuses a URL the transport cannot use or one that hides a secret', () => {
    expect(isMcpServerUrl('ws://mcp.example.com')).toBe(false)
    expect(isMcpServerUrl('not a url')).toBe(false)
    expect(isMcpServerUrl('/mcp')).toBe(false)
    expect(isMcpServerUrl('https://user:pass@mcp.example.com')).toBe(false)
    expect(isMcpServerUrl('https://mcp.example.com/mcp#frag')).toBe(false)
    expect(McpServerUrlSchema.safeParse('ftp://x').success).toBe(false)
  })
})

describe('MCP headers', () => {
  it('accepts a non-empty name/value map and refuses an empty one', () => {
    expect(McpHeadersSchema.safeParse({ Authorization: 'Bearer x' }).success).toBe(true)
    expect(McpHeadersSchema.safeParse({}).success).toBe(false)
  })

  it('bounds the number of pairs', () => {
    const many: Record<string, string> = {}
    for (let i = 0; i < MAX_MCP_HEADERS + 1; i += 1) {
      many[`x-header-${i}`] = 'v'
    }
    expect(McpHeadersSchema.safeParse(many).success).toBe(false)
  })
})

describe('MCP tool definitions and their token estimate', () => {
  const tool = {
    name: 'search',
    description: 'Search notes',
    input_schema: { type: 'object', properties: { query: { type: 'string' } } },
  }

  it('parses a definition and summarizes it', () => {
    expect(McpToolDefinitionSchema.parse(tool)).toEqual(tool)
    const summary = mcpToolSummary(tool)
    expect(summary).toEqual({
      name: 'search',
      description: 'Search notes',
      definition_tokens: estimateToolDefinitionTokens(tool),
    })
  })

  it('estimates size from the compact JSON of the definition', () => {
    const expected = Math.ceil(JSON.stringify(tool).length / 4)
    expect(estimateToolDefinitionTokens(tool)).toBe(expected)
    expect(estimateToolsTokens([tool, tool])).toBe(expected * 2)
    expect(estimateToolsTokens([])).toBe(0)
  })

  it('counts a tool with no description the same way, null description included', () => {
    const bare = { name: 'ping', description: null, input_schema: {} }
    expect(estimateToolDefinitionTokens(bare)).toBe(Math.ceil(JSON.stringify(bare).length / 4))
  })
})

describe('MCP server request bodies', () => {
  it('accepts each auth form, with only its own field', () => {
    expect(
      CreateMcpServerRequestSchema.parse({
        auth: 'none',
        name: 'notes',
        url: 'https://mcp.example.com/mcp',
      }),
    ).toMatchObject({ auth: 'none', name: 'notes' })

    const headers = CreateMcpServerRequestSchema.parse({
      auth: 'headers',
      name: 'notes',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    })
    expect(headers).toMatchObject({ auth: 'headers' })

    const oauth = CreateMcpServerRequestSchema.parse({
      auth: 'oauth',
      name: 'notes',
      url: 'https://mcp.example.com/mcp',
      enabled: false,
    })
    expect(oauth).toMatchObject({ auth: 'oauth', enabled: false })
  })

  it('refuses a headers body with no headers, and a body that omits auth', () => {
    expect(
      CreateMcpServerRequestSchema.safeParse({
        auth: 'headers',
        name: 'notes',
        url: 'https://mcp.example.com/mcp',
      }).success,
    ).toBe(false)
    expect(
      CreateMcpServerRequestSchema.safeParse({
        name: 'notes',
        url: 'https://mcp.example.com/mcp',
      }).success,
    ).toBe(false)
  })

  it('strips the other form’s secret field rather than accepting it', () => {
    // An oauth body carrying `headers` is not a shape the union has: the field is stripped, so
    // a caller cannot smuggle a header map onto a server that will not send it.
    const parsed = CreateMcpServerRequestSchema.parse({
      auth: 'oauth',
      name: 'notes',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    })
    expect(parsed).not.toHaveProperty('headers')
  })

  it('updates any subset of the fields, headers included', () => {
    expect(UpdateMcpServerRequestSchema.parse({ enabled: false })).toEqual({ enabled: false })
    expect(
      UpdateMcpServerRequestSchema.parse({ headers: { 'x-key': 'v' }, auth: 'headers' }),
    ).toMatchObject({ auth: 'headers' })
    expect(UpdateMcpServerRequestSchema.parse({})).toEqual({})
    expect(UpdateMcpServerRequestSchema.safeParse({ url: '/relative' }).success).toBe(false)
  })
})

describe('MCP server resource', () => {
  it('parses a headers-authenticated server, names only', () => {
    const parsed = McpServerSchema.parse(
      server({ auth: 'headers', header_names: ['Authorization', 'x-api-key'] }),
    )
    expect(parsed.header_names).toEqual(['Authorization', 'x-api-key'])
    // Never a value: the resource has no field a header value could live in.
    expect(JSON.stringify(parsed)).not.toContain('Bearer')
  })

  it('refuses an unknown status, auth or a missing envelope', () => {
    expect(McpServerSchema.safeParse(server({ status: 'ok' })).success).toBe(false)
    expect(McpServerSchema.safeParse(server({ auth: 'bearer' })).success).toBe(false)
    expect(McpServerSchema.safeParse(server({ type: 'mcp' })).success).toBe(false)
    const withoutId: Record<string, unknown> = server()
    delete withoutId.id
    expect(McpServerSchema.safeParse(withoutId).success).toBe(false)
  })

  it('wraps a list and a connect response', () => {
    expect(ListMcpServersResponseSchema.parse({ data: [server()] }).data).toHaveLength(1)
    expect(
      ConnectMcpServerResponseSchema.parse({ authorization_url: 'https://as.example.com/auth' })
        .authorization_url,
    ).toBe('https://as.example.com/auth')
  })

  it('defaults a connect body to the web and accepts the CLI', () => {
    // The whole body is optional (#311): a request with nothing in it means the web app.
    expect(ConnectMcpServerRequestSchema.parse({}).client).toBe('web')
    expect(ConnectMcpServerRequestSchema.parse({ client: 'cli' }).client).toBe('cli')
    expect(ConnectMcpServerRequestSchema.safeParse({ client: 'mobile' }).success).toBe(false)
  })
})
