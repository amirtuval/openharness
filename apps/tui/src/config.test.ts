import { describe, expect, it } from 'vitest'

import { configFilePath, DEFAULT_SERVER_URL, resolveConfig } from './config'

/** Resolve with a config file whose contents are whatever `contents` says. */
function withFile(contents: string | undefined, inputs: Parameters<typeof resolveConfig>[0] = {}) {
  return resolveConfig({ env: {}, readFile: () => contents, ...inputs })
}

/** The config from a successful resolution, failing the test with the error otherwise. */
function configOf(inputs: Parameters<typeof resolveConfig>[0]) {
  const outcome = resolveConfig(inputs)
  if (!outcome.ok) throw new Error(`expected a config, got: ${outcome.error}`)
  return outcome.config
}

/** The message from a resolution that failed. */
function errorOf(inputs: Parameters<typeof resolveConfig>[0]): string {
  const outcome = resolveConfig(inputs)
  if (outcome.ok) throw new Error('expected a failure')
  return outcome.error
}

describe('configFilePath', () => {
  it('uses XDG_CONFIG_HOME when it is set', () => {
    expect(configFilePath({ XDG_CONFIG_HOME: '/tmp/xdg' })).toBe('/tmp/xdg/openharness/config.json')
  })

  it('ignores a relative XDG_CONFIG_HOME', () => {
    expect(configFilePath({ XDG_CONFIG_HOME: 'xdg' })).toMatch(
      /\/\.config\/openharness\/config\.json$/,
    )
  })

  it('falls back to ~/.config', () => {
    expect(configFilePath({})).toMatch(/\/\.config\/openharness\/config\.json$/)
  })
})

describe('resolveConfig', () => {
  it('defaults to a local server and no key', () => {
    const config = configOf({ env: {}, readFile: () => undefined })

    expect(config.server).toBe(DEFAULT_SERVER_URL)
    expect(config.apiKey).toBeUndefined()
    expect(config.sources).toEqual({ server: 'default', apiKey: 'unset' })
  })

  it('reads the environment', () => {
    const config = configOf({
      env: { OPENHARNESS_URL: 'http://env.test', OPENHARNESS_API_KEY: 'oh_env' },
      readFile: () => undefined,
    })

    expect(config.server).toBe('http://env.test')
    expect(config.apiKey).toBe('oh_env')
    expect(config.sources).toEqual({ server: 'env', apiKey: 'env' })
  })

  it('reads the config file', () => {
    const config = withFile('{"server": "http://file.test", "apiKey": "oh_file"}')

    expect(config).toMatchObject({
      ok: true,
      config: {
        server: 'http://file.test',
        apiKey: 'oh_file',
        sources: { server: 'file', apiKey: 'file' },
      },
    })
  })

  it('prefers a flag to the environment and the file', () => {
    const config = configOf({
      flags: { server: 'http://flag.test', apiKey: 'oh_flag' },
      env: { OPENHARNESS_URL: 'http://env.test', OPENHARNESS_API_KEY: 'oh_env' },
      readFile: () => '{"server": "http://file.test", "apiKey": "oh_file"}',
    })

    expect(config.server).toBe('http://flag.test')
    expect(config.apiKey).toBe('oh_flag')
    expect(config.sources).toEqual({ server: 'flag', apiKey: 'flag' })
  })

  it('prefers the environment to the file', () => {
    const config = configOf({
      env: { OPENHARNESS_URL: 'http://env.test' },
      readFile: () => '{"server": "http://file.test", "apiKey": "oh_file"}',
    })

    expect(config.server).toBe('http://env.test')
    expect(config.apiKey).toBe('oh_file')
    expect(config.sources).toEqual({ server: 'env', apiKey: 'file' })
  })

  it('treats an empty environment variable as unset', () => {
    const config = configOf({
      env: { OPENHARNESS_URL: '  ', OPENHARNESS_API_KEY: '' },
      readFile: () => '{"server": "http://file.test"}',
    })

    expect(config.server).toBe('http://file.test')
    expect(config.apiKey).toBeUndefined()
  })

  it('drops a trailing slash from the server URL', () => {
    expect(
      configOf({ env: { OPENHARNESS_URL: 'http://host.test/' }, readFile: () => undefined }).server,
    ).toBe('http://host.test')
    expect(
      configOf({ env: { OPENHARNESS_URL: 'http://host.test/api/' }, readFile: () => undefined })
        .server,
    ).toBe('http://host.test/api')
  })

  it('rejects a server that is not a URL', () => {
    const error = errorOf({ env: { OPENHARNESS_URL: 'localhost:3000' }, readFile: () => undefined })

    expect(error).toContain('localhost:3000')
    expect(error).toContain('http://localhost:3000')
    expect(error).toContain('OPENHARNESS_URL')
  })

  it('names --server when the flag is what is wrong', () => {
    expect(errorOf({ flags: { server: 'nope' }, env: {}, readFile: () => undefined })).toContain(
      '--server',
    )
  })

  it('is fine with no config file', () => {
    expect(withFile(undefined)).toMatchObject({ ok: true })
  })

  it('rejects a file that is not JSON, naming the path', () => {
    const error = errorOf({ env: {}, readFile: () => '{oops', path: '/tmp/config.json' })

    expect(error).toContain('/tmp/config.json')
    expect(error).toContain('invalid JSON')
  })

  it('rejects a file that is not an object', () => {
    expect(errorOf({ env: {}, readFile: () => '["server"]' })).toContain('must hold a JSON object')
    expect(errorOf({ env: {}, readFile: () => 'null' })).toContain('must hold a JSON object')
  })

  it('rejects an unknown key', () => {
    const error = errorOf({ env: {}, readFile: () => '{"url": "http://x.test"}' })

    expect(error).toContain("'url'")
    expect(error).toContain("'server'")
  })

  it('rejects a value of the wrong type', () => {
    expect(errorOf({ env: {}, readFile: () => '{"server": 3000}' })).toContain(
      "'server' must be a string",
    )
  })

  it('rejects an empty value', () => {
    expect(errorOf({ env: {}, readFile: () => '{"apiKey": "  "}' })).toContain("'apiKey' is empty")
  })

  it('reports a config file it cannot read', () => {
    const error = errorOf({
      env: {},
      path: '/tmp/locked.json',
      readFile: () => {
        throw new Error('EACCES: permission denied')
      },
    })

    expect(error).toContain('/tmp/locked.json')
    expect(error).toContain('permission denied')
  })
})
