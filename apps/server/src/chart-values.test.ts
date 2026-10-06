import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { readServerConfig } from './config'

/**
 * The chart's staging values, booted.
 *
 * `charts/openharness/ci/staging-values.yaml` is what Terraform hands the chart for staging:
 * the `env` map and `secrets` list the Deployment renders, checked on every chart change
 * because `helm lint` lints each `ci/*-values.yaml` (#154). Nothing checked that the values it
 * carries are ones the *server* accepts — and #159 was a crash-loop from one it does not:
 * `OPENHARNESS_DEV_LOGIN: '0'`, which `readFlag` refuses and `readServerConfig` turns into a
 * boot failure. This test boots the server from the file, so a value Terraform or the chart
 * can send but the server rejects fails in CI instead of in a CrashLoopBackOff.
 */

/** The repo root, three levels up from `apps/server/src`. */
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/** The values Terraform passes for staging — the chart side of the pair this test guards. */
const STAGING_VALUES = join(REPO_ROOT, 'charts', 'openharness', 'ci', 'staging-values.yaml')

/** The app module's Terraform locals — the other, unconditional side of the same pair. */
const TERRAFORM_LOCALS = join(REPO_ROOT, 'infra', 'modules', 'app', 'locals.tf')

/** The parts of the values document this test reads. */
interface ChartValues {
  readonly env: Record<string, string>
  readonly secrets: readonly { readonly env: string; readonly secret: string }[]
}

/** The chart's staging values, parsed. */
function readStagingValues(): ChartValues {
  return parse(readFileSync(STAGING_VALUES, 'utf8')) as ChartValues
}

/**
 * The environment a staging pod boots with, built from {@link STAGING_VALUES}.
 *
 * `env` becomes the process environment, and every `secrets` entry becomes a `<NAME>_FILE`
 * pointing at a temp file — the Deployment renders exactly that
 * (`{{ .env }}_FILE=/var/run/secrets/openharness/{{ .secret }}`, templates/deployment.yaml)
 * and the server reads the file (#154). A placeholder in a temp file stands in for the Secret
 * Manager mount.
 */
function stagingEnvironment(): { readonly vars: NodeJS.ProcessEnv; readonly dir: string } {
  const values = readStagingValues()
  const dir = mkdtempSync(join(tmpdir(), 'openharness-chart-values-'))
  const vars: NodeJS.ProcessEnv = { ...values.env }
  for (const { env, secret } of values.secrets) {
    const path = join(dir, secret)
    writeFileSync(path, `${secret}-placeholder\n`)
    vars[`${env}_FILE`] = path
  }
  return { vars, dir }
}

/**
 * The variables Terraform's `local.env` sets for **every** environment.
 *
 * They are the `NAME = value` lines of the base map — the first `{ … }` inside
 * `env = merge(…, …)`. Everything after that brace is a conditional merge (a provider's client
 * id, the Entra tenant), which a deployment with no provider does not set. A regex is enough
 * for a flat map of `NAME = value` lines, and this fails loudly rather than comparing nothing
 * if the shape ever changes.
 */
function terraformEnvVars(): string[] {
  const locals = readFileSync(TERRAFORM_LOCALS, 'utf8')
  const body = /env = merge\(\s*\{\n([\s\S]*?)\n\s*\},/u.exec(locals)?.[1]
  if (body === undefined) {
    throw new Error(`could not find the \`env = merge({ … }, …)\` map in ${TERRAFORM_LOCALS}`)
  }
  const names: string[] = []
  for (const line of body.split('\n')) {
    const name = /^\s*([A-Z][A-Z0-9_]*)\s*=/u.exec(line)?.[1]
    if (name !== undefined) {
      names.push(name)
    }
  }
  return names
}

describe('the chart values staging boots with (#159)', () => {
  it('are read by the server without a boot failure', () => {
    const { vars, dir } = stagingEnvironment()
    try {
      // The file leaves the sign-in provider to Terraform — its own comment says so: a real
      // environment passes a provider's client id in `env` and its client secret as a third
      // `secrets` entry. Without one the boot is refused (the dev login is off), so the test
      // adds the provider Terraform would, delivered the way the chart delivers it.
      const clientSecret = join(dir, 'google-client-secret')
      writeFileSync(clientSecret, 'google-client-secret-placeholder\n')

      const config = readServerConfig({
        ...vars,
        GOOGLE_CLIENT_ID: 'google-client-id.apps.googleusercontent.com',
        GOOGLE_CLIENT_SECRET_FILE: clientSecret,
      })

      // The values took effect, and the dev login is off because nothing set it.
      expect(config.devLogin).toBe(false)
      expect(config.betterAuthUrl).toBe('https://staging.oharness.dev')
      expect(config.keyProvider).toBe('gcp-kms')
      expect(config.databaseUrl).toBe('database-url-placeholder')
      expect(config.betterAuthSecret).toBe('better-auth-secret-placeholder')
      expect(config.google).toEqual({
        clientId: 'google-client-id.apps.googleusercontent.com',
        clientSecret: 'google-client-secret-placeholder',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuse OPENHARNESS_DEV_LOGIN=0, the crash-loop the issue was filed for', () => {
    const { vars, dir } = stagingEnvironment()
    try {
      // The bug: the file (and Terraform) carried `OPENHARNESS_DEV_LOGIN: '0'`. Unset is how
      // the dev login is off; a `"0"` is a flag that is neither `1` nor `true`, and readFlag
      // fails the boot with the message staging logged.
      expect(vars.OPENHARNESS_DEV_LOGIN).toBeUndefined()
      expect(() => readServerConfig({ ...vars, OPENHARNESS_DEV_LOGIN: '0' })).toThrow(
        'OPENHARNESS_DEV_LOGIN must be 1 or true when it is set, got "0"',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('name the same variables Terraform sets for every environment', () => {
    // The cheap half of "cannot drift": Terraform's unconditional map and the chart's CI
    // values must carry the same variables, so adding one to either side fails here. The
    // note in locals.tf points at this test.
    const values = readStagingValues()
    expect(Object.keys(values.env).sort()).toEqual(terraformEnvVars().sort())
  })
})
