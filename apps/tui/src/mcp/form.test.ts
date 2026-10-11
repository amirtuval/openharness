import { makeMcpServer } from '@openharness/protocol/fixtures'
import { describe, expect, it } from 'vitest'

import {
  MCP_AUTH_FIELD,
  MCP_ENABLED_FIELD,
  MCP_HEADER_NAME_FIELD,
  MCP_HEADER_VALUE_FIELD,
  MCP_NAME_FIELD,
  MCP_URL_FIELD,
  authFromLabel,
  collectedHeaders,
  enabledFrom,
  mcpHeaderProblem,
  mcpServerBody,
  mcpServerFields,
  mcpServerValues,
} from './form'

/**
 * The MCP server form (epic #303, X10; #313), on its own: the prompts it asks, the rules it
 * checks them with, and the body the answers become.
 *
 * The conditional part is the whole point — a `headers` server is asked for a pair and the other
 * two are not, and an edit may leave the pair blank to keep what is sealed — so it is a table of
 * cases rather than a crawl through a screen.
 */
describe('the fields a server is asked for', () => {
  it('asks for a name, a URL and an auth type, then whether it is on', () => {
    const fields = mcpServerFields({ editing: false, auth: null })
    expect(fields.map((field) => field.name)).toEqual([
      MCP_NAME_FIELD,
      MCP_URL_FIELD,
      MCP_AUTH_FIELD,
      MCP_ENABLED_FIELD,
    ])
    // The auth type is a list the reader picks from, not a box to type in: the value decides
    // whether a header pair is asked for at all.
    expect(fields[2]?.options).toEqual(['None', 'Headers', 'OAuth'])
    expect(fields[3]?.options).toEqual(['on', 'off'])
    expect(fields[3]?.defaultValue).toBe('on')
  })

  it('asks for a header pair only for a headers-authenticated server', () => {
    const fields = mcpServerFields({ editing: false, auth: 'headers' })
    expect(fields.map((field) => field.name)).toEqual([
      MCP_NAME_FIELD,
      MCP_URL_FIELD,
      MCP_AUTH_FIELD,
      MCP_HEADER_NAME_FIELD,
      MCP_HEADER_VALUE_FIELD,
      MCP_ENABLED_FIELD,
    ])
    expect(fields[4]?.secret).toBe(true)
    expect(fields[4]?.optional).toBe(false)
  })

  it('leaves the pair optional on an edit, and names what is stored', () => {
    const fields = mcpServerFields({
      editing: true,
      auth: 'headers',
      storedHeaderNames: ['Authorization'],
    })
    const label = fields[3]?.label ?? ''
    // The values are sealed and never come back, so the label says what is held and that
    // leaving both blank keeps it.
    expect(label).toContain('Authorization')
    expect(label).toContain('blank')
    expect(fields[3]?.optional).toBe(true)
    expect(fields[4]?.optional).toBe(true)
  })

  it('checks the name and the URL with the protocol’s own rules', () => {
    const fields = mcpServerFields({ editing: false, auth: 'none' })
    const name = fields[0]
    const url = fields[1]
    expect(name?.validate?.('notes')).toBeNull()
    expect(name?.validate?.('Notes Server')).toContain('lowercase')
    expect(url?.validate?.('https://mcp.example.com/mcp')).toBeNull()
    expect(url?.validate?.('mcp.example.com')).toContain('http')
  })
})

describe('the auth a label stands for', () => {
  it('reads the list back, and falls back to none', () => {
    expect(authFromLabel('Headers')).toBe('headers')
    expect(authFromLabel('OAuth')).toBe('oauth')
    expect(authFromLabel('None')).toBe('none')
    expect(authFromLabel('something else')).toBe('none')
  })
})

describe('the body the answers become', () => {
  const values = {
    [MCP_NAME_FIELD]: ' notes ',
    [MCP_URL_FIELD]: ' https://mcp.example.com/mcp ',
    [MCP_ENABLED_FIELD]: 'off',
  }

  it('creates an open server with the name and URL trimmed', () => {
    expect(mcpServerBody({ editing: false, auth: 'none' }, values)).toEqual({
      kind: 'create',
      body: {
        auth: 'none',
        name: 'notes',
        url: 'https://mcp.example.com/mcp',
        enabled: false,
      },
    })
  })

  it('creates a headers server with the pair it was given', () => {
    expect(
      mcpServerBody(
        { editing: false, auth: 'headers' },
        {
          ...values,
          [MCP_HEADER_NAME_FIELD]: ' Authorization ',
          [MCP_HEADER_VALUE_FIELD]: 'Bearer k',
        },
      ),
    ).toEqual({
      kind: 'create',
      body: {
        auth: 'headers',
        name: 'notes',
        url: 'https://mcp.example.com/mcp',
        enabled: false,
        headers: { Authorization: 'Bearer k' },
      },
    })
  })

  it('omits the map on an edit that typed nothing, so what is sealed is kept', () => {
    const built = mcpServerBody({ editing: true, auth: 'headers' }, values)
    expect(built).toEqual({
      kind: 'update',
      body: {
        name: 'notes',
        url: 'https://mcp.example.com/mcp',
        auth: 'headers',
        enabled: false,
      },
    })
    // An edit never carries `auth`-inappropriate fields: the update schema takes what it is
    // given and the route checks the pairings.
    expect('headers' in built.body).toBe(false)
  })

  it('carries a map an edit was given, replacing the whole of what is stored', () => {
    const built = mcpServerBody(
      { editing: true, auth: 'headers' },
      { ...values, [MCP_HEADER_NAME_FIELD]: 'X-Api-Key', [MCP_HEADER_VALUE_FIELD]: 'k' },
    )
    expect(built.body).toMatchObject({ headers: { 'X-Api-Key': 'k' } })
  })
})

describe('the checks that hold a prompt', () => {
  it('refuses a half-typed header pair', () => {
    const values = { [MCP_HEADER_NAME_FIELD]: 'Authorization', [MCP_HEADER_VALUE_FIELD]: '' }
    expect(mcpHeaderProblem('headers', values, { required: false })).toContain('both a name')
    expect(collectedHeaders(values)).toEqual({ Authorization: '' })
  })

  it('requires a map for a new headers server, and not for an edit', () => {
    expect(mcpHeaderProblem('headers', {}, { required: true })).toContain('at least one header')
    expect(mcpHeaderProblem('headers', {}, { required: false })).toBeNull()
    expect(mcpHeaderProblem('none', {}, { required: true })).toBeNull()
  })

  it('reads the yes/no list, where anything but off is on', () => {
    expect(enabledFrom('on')).toBe(true)
    expect(enabledFrom(undefined)).toBe(true)
    expect(enabledFrom('off')).toBe(false)
  })
})

describe('the values an edit starts from', () => {
  it('starts empty for a new server, on', () => {
    expect(mcpServerValues(null)).toEqual({ [MCP_ENABLED_FIELD]: 'on' })
  })

  it('starts from the server, with the header pair left blank', () => {
    const server = makeMcpServer({ name: 'wiki', auth: 'headers', header_names: ['Authorization'] })
    expect(mcpServerValues(server)).toEqual({
      [MCP_NAME_FIELD]: 'wiki',
      [MCP_URL_FIELD]: server.url,
      [MCP_AUTH_FIELD]: 'Headers',
      [MCP_ENABLED_FIELD]: 'on',
    })
    // Nothing is prefilled for the pair: the values are sealed, and a blank pair is what keeps
    // them (see the body above).
    expect(MCP_HEADER_NAME_FIELD in mcpServerValues(server)).toBe(false)
  })
})
