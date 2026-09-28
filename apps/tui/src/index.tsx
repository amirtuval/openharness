#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { render } from 'ink'
import { App } from './app'
import { parseArgs } from './args'
import { readVersion } from './version'

/** Placeholder export; the real CLI lands in the v1 chat epic. */
export const PACKAGE_NAME = '@openharness/cli'

export { App } from './app'
export { parseArgs } from './args'
export { readVersion } from './version'

const USAGE = `openharness cli (placeholder)

Usage:
  oh               render the placeholder TUI
  oh --version     print the version
  oh --help        print this message
`

/**
 * Runs the CLI once and returns the process exit code. `render` keeps the process alive
 * while the TUI is mounted — Ctrl+C is the way out (the real TUI lands in the v1 epic).
 */
export function run(argv: readonly string[]): number {
  const command = parseArgs(argv)

  switch (command.kind) {
    case 'version': {
      process.stdout.write(`${readVersion()}\n`)
      return 0
    }
    case 'help': {
      process.stdout.write(`${USAGE}\n`)
      return 0
    }
    case 'app': {
      render(<App version={readVersion()} />)
      return 0
    }
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  process.exitCode = run(process.argv.slice(2))
}
