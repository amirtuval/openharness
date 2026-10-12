import { makeMcpServer } from '@openharness/protocol/fixtures'
import { describe, expect, it } from 'vitest'

import {
  MCP_ENABLED_FIELD,
  MCP_HEADER_NAME_FIELD,
  MCP_HEADER_VALUE_FIELD,
  MCP_NAME_FIELD,
  MCP_URL_FIELD,
  collectedHeaders,
  derivedServerName,
  enabledFrom,
  mcpHeaderProblem,
  mcpServerBody,
  mcpServerFields,
  mcpServerValues,
} from './form'

/**
 * The MCP server form (epic #303, X10; #313; detection: #314), on its own: the prompts it asks,
 * the rules it checks them with, and the body the answers become.
 *
 * There is **no auth-type prompt** since issue #314 — the server probes the URL — so the form is
 * three fields and an optional header pair, and the body never carries an `auth`. The conditional
 * part that remains is the header pair, which an edit may leave blank to keep what is sealed; the
 * table of cases below pins it.
 */
describe('the fields a server is asked for', () => {
  it('asks for the URL first, then an optional name, an optional header and on/off', () => {
    const fields = mcpServerFields({ editing: false })
    expect(fields.map((field) => field.name)).toEqual([
      MCP_URL_FIELD,
      MCP_NAME_FIELD,
      MCP_HEADER_NAME_FIELD,
      MCP_HEADER_VALUE_FIELD,
      MCP_ENABLED_FIELD,
    ])
    // Nothing asks the reader to classify the server: that is what the probe is for.
    expect(fields.some((field) => field.label.toLowerCase().startsWith('authentication'))).toBe(
      false,
    )
    // The name may be left blank (the server derives one), and both header prompts may be too.
    expect(fields[1]?.optional).toBe(true)
    expect(fields[2]?.optional).toBe(true)
    expect(fields[2]?.secret).toBe(false)
    expect(fields[3]?.optional).toBe(true)
    expect(fields[3]?.secret).toBe(true)
    expect(fields[4]?.options).toEqual(['on', 'off'])
    expect(fields[4]?.defaultValue).toBe('on')
  })

  it('names what an edit already holds, and says a blank pair keeps it', () => {
    const fields = mcpServerFields({ editing: true, storedHeaderNames: ['Authorization'] })
    const label = fields[2]?.label ?? ''
    expect(label).toContain('Authorization')
    expect(label).toContain('blank')
  })

  it('checks the URL and the name with the protocol’s own rules, and a blank name is fine', () => {
    const fields = mcpServerFields({ editing: false })
    const url = fields[0]
    const name = fields[1]
    expect(url?.validate?.('https://mcp.example.com/mcp')).toBeNull()
    expect(url?.validate?.('mcp.example.com')).toContain('http')
    expect(name?.validate?.('notes')).toBeNull()
    expect(name?.validate?.('')).toBeNull()
    expect(name?.validate?.('Notes Server')).toContain('lowercase')
  })
})

describe('the body the answers become', () => {
  const values = {
    [MCP_NAME_FIELD]: ' notes ',
    [MCP_URL_FIELD]: ' https://mcp.example.com/mcp ',
    [MCP_ENABLED_FIELD]: 'off',
  }

  it('creates without an auth type — the server detects it', () => {
    expect(mcpServerBody({ editing: false }, values)).toEqual({
      kind: 'create',
      body: {
        name: 'notes',
        url: 'https://mcp.example.com/mcp',
        enabled: false,
      },
    })
  })

  it('omits the name when the reader left it blank, so the server derives one', () => {
    const body = mcpServerBody({ editing: false }, { ...values, [MCP_NAME_FIELD]: '  ' })
    expect(body.body).toEqual({ url: 'https://mcp.example.com/mcp', enabled: false })
    expect('name' in body.body).toBe(false)
  })

  it('carries a header pair, which implies headers on the wire', () => {
    const body = mcpServerBody(
      { editing: false },
      {
        ...values,
        [MCP_HEADER_NAME_FIELD]: ' Authorization ',
        [MCP_HEADER_VALUE_FIELD]: 'Bearer k',
      },
    )
    expect(body).toEqual({
      kind: 'create',
      body: {
        name: 'notes',
        url: 'https://mcp.example.com/mcp',
        enabled: false,
        headers: { Authorization: 'Bearer k' },
      },
    })
    expect('auth' in body.body).toBe(false)
  })

  it('omits the map on an edit that typed nothing, so what is sealed is kept', () => {
    const built = mcpServerBody({ editing: true }, values)
    expect(built).toEqual({
      kind: 'update',
      body: {
        name: 'notes',
        url: 'https://mcp.example.com/mcp',
        enabled: false,
      },
    })
    expect('headers' in built.body).toBe(false)
  })

  it('carries a map an edit was given, replacing the whole of what is stored', () => {
    const built = mcpServerBody(
      { editing: true },
      { ...values, [MCP_HEADER_NAME_FIELD]: 'X-Api-Key', [MCP_HEADER_VALUE_FIELD]: 'k' },
    )
    expect(built.body).toMatchObject({ headers: { 'X-Api-Key': 'k' } })
  })
})

describe('the name a create would store', () => {
  it('is what the reader typed, else what the URL’s host derives', () => {
    expect(
      derivedServerName({ [MCP_URL_FIELD]: 'https://mcp.linear.app/mcp', [MCP_NAME_FIELD]: 'lin' }),
    ).toBe('lin')
    expect(derivedServerName({ [MCP_URL_FIELD]: 'https://mcp.linear.app/mcp' })).toBe(
      'mcp-linear-app',
    )
    expect(derivedServerName({})).toBe('')
  })
})

describe('the checks that hold a prompt', () => {
  it('refuses a half-typed header pair', () => {
    const values = { [MCP_HEADER_NAME_FIELD]: 'Authorization', [MCP_HEADER_VALUE_FIELD]: '' }
    expect(mcpHeaderProblem(values)).toContain('both a name')
    expect(collectedHeaders(values)).toEqual({ Authorization: '' })
  })

  it('is happy with both blank — the map is optional now', () => {
    expect(mcpHeaderProblem({})).toBeNull()
    expect(
      mcpHeaderProblem({ [MCP_HEADER_NAME_FIELD]: '', [MCP_HEADER_VALUE_FIELD]: '' }),
    ).toBeNull()
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
      [MCP_ENABLED_FIELD]: 'on',
    })
    // Nothing is prefilled for the pair: the values are sealed, and a blank pair is what keeps
    // them (see the body above). Nor is an auth type carried: the form never asks for one.
    expect(MCP_HEADER_NAME_FIELD in mcpServerValues(server)).toBe(false)
  })
})
