#!/usr/bin/env node
/**
 * `yarn oh`, `yarn oh:staging`, `yarn oh:prod`: build this checkout's CLI and run it against
 * the environment the name stands for (#192).
 *
 * An installed `oh` defaults to production, so a checkout has to say otherwise out loud —
 * and one `OPENHARNESS_URL` per name, set on the child, is the whole of it. It is a script
 * rather than a line of `package.json` because setting an environment variable portably
 * would otherwise mean a dependency (`cross-env`), and this repo takes none it does not need.
 *
 * The build comes first — `turbo run build --filter=@openh/cli...`, the CLI and its
 * workspace dependencies — and its output is held back: turbo writes progress to **stdout**,
 * and stdout belongs to the CLI, where `yarn oh --version` has to print a version and nothing
 * else. A build that fails is the one case where that output is the thing to read, so it is
 * printed then, to stderr.
 *
 * Everything after the environment name goes to the CLI untouched, which is what makes
 * `yarn oh:staging login --no-browser` mean `oh login --no-browser` against staging.
 *
 * Run from the repo root, through the root `package.json` scripts.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { constants } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The environment names, and the server each one runs against. */
const ENVIRONMENTS = {
  dev: 'http://localhost:3000',
  staging: 'https://staging.oharness.dev',
  prod: 'https://app.oharness.dev',
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const cliPath = join(repoRoot, 'apps', 'tui', 'dist', 'index.js')

const [environment, ...args] = process.argv.slice(2)
const server = ENVIRONMENTS[environment]
if (server === undefined) {
  process.stderr.write(
    `oh: unknown environment '${environment ?? ''}'; expected ${Object.keys(ENVIRONMENTS).join(', ')}.\n`,
  )
  process.exit(2)
}

// The local turbo when the install put one there (yarn's `node_modules/.bin`), and the
// path-independent name otherwise, so this works run through yarn and run by hand.
const turboBin = join(repoRoot, 'node_modules', '.bin', 'turbo')
const turbo = existsSync(turboBin) ? turboBin : 'turbo'

const build = spawnSync(turbo, ['run', 'build', '--filter=@openh/cli...'], {
  cwd: repoRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})
if (build.error !== undefined) {
  process.stderr.write(`oh: could not build the CLI: ${build.error.message}\n`)
  process.exit(1)
}
if (build.status !== 0) {
  process.stderr.write(build.stdout ?? '')
  process.stderr.write(build.stderr ?? '')
  process.exit(build.status ?? 1)
}

// A terminal sends Ctrl+C to the whole foreground process group, and the CLI is in it, so the
// CLI receives the signal itself and its own handler decides what it means — interrupt the
// reply, cancel a login, exit. This wrapper stays out of the way rather than dying first and
// leaving the terminal to a child that is still using it.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {})
}

const child = spawn(process.execPath, [cliPath, ...args], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, OPENHARNESS_URL: server },
})

child.on('exit', (code, signal) => {
  if (code !== null) {
    process.exit(code)
  }
  // Killed by a signal it did not handle: the shell's convention for that is 128 + the
  // signal's number, which is also how `oh` reports the two it does handle.
  const number = signal === null ? undefined : constants.signals[signal]
  process.exit(128 + (number ?? 0))
})
