#!/usr/bin/env node
/**
 * Enforces the allowed `@openharness/*` dependency graph (see docs/architecture.md).
 *
 * The table below covers `dependencies`, `devDependencies`, `peerDependencies` and
 * `optionalDependencies`. `@openharness/config` is allowed everywhere, as a devDependency
 * only.
 *
 * Run with `yarn check:deps` from the repo root. Exits non-zero with a readable report.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const SHARED_CONFIG = '@openharness/config'

/** package name -> packages it may depend on ('any' = no restriction). */
const ALLOWED = {
  [SHARED_CONFIG]: [],
  '@openharness/protocol': [],
  '@openharness/hands': ['@openharness/protocol'],
  '@openharness/session': ['@openharness/protocol'],
  '@openharness/client': ['@openharness/protocol'],
  '@openharness/brain': ['@openharness/protocol', '@openharness/session', '@openharness/hands'],
  '@openharness/server': [
    '@openharness/protocol',
    '@openharness/session',
    '@openharness/brain',
    '@openharness/hands',
  ],
  '@openharness/web': ['@openharness/protocol', '@openharness/client'],
  '@openharness/cli': ['@openharness/protocol', '@openharness/client'],
  '@openharness/e2e': 'any',
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

/** Expands the root `workspaces` globs (`apps/*`, `packages/*`, `e2e`) into package folders. */
function findWorkspaceDirs() {
  const rootManifest = readJson(join(repoRoot, 'package.json'))
  const patterns = rootManifest.workspaces ?? []
  const dirs = []

  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const parent = resolve(repoRoot, pattern.slice(0, -2))
      if (!existsSync(parent)) continue
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(join(parent, entry.name))
      }
    } else {
      dirs.push(resolve(repoRoot, pattern))
    }
  }

  return dirs.filter((dir) => existsSync(join(dir, 'package.json')))
}

const problems = []
const seenNames = new Set()
const workspaces = findWorkspaceDirs()

for (const dir of workspaces) {
  const manifestPath = join(dir, 'package.json')
  const manifest = readJson(manifestPath)
  const self = manifest.name
  const where = relative(repoRoot, manifestPath)

  seenNames.add(self)

  // The root package is a workspace too, but it is not part of the dependency table: it may
  // only pull in the shared config.
  const allowed = dir === repoRoot ? [] : ALLOWED[self]

  if (allowed === undefined) {
    problems.push(
      `${where}: "${self}" is not in the dependency table in scripts/check-deps.mjs.\n` +
        `      Add it (and its allowed dependencies) there and to docs/architecture.md.`,
    )
    continue
  }

  for (const field of DEPENDENCY_FIELDS) {
    for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
      if (!dependency.startsWith('@openharness/')) continue

      if (dependency === self) {
        problems.push(`${where}: "${self}" depends on itself (${field}).`)
        continue
      }

      if (dependency === SHARED_CONFIG) {
        if (field !== 'devDependencies') {
          problems.push(
            `${where}: "${SHARED_CONFIG}" must be a devDependency (found in ${field}).\n` +
              `      It configures the tooling and is never shipped as runtime code.`,
          )
        }
        continue
      }

      if (allowed === 'any') continue

      if (!allowed.includes(dependency)) {
        const list = allowed.length === 0 ? 'nothing' : allowed.join(', ')
        problems.push(
          `${where}: "${self}" must not depend on "${dependency}" (found in ${field}).\n` +
            `      Allowed: ${list}.\n` +
            `      The dependency table lives in docs/architecture.md and scripts/check-deps.mjs.` +
            `\n      (range: ${range})`,
        )
      }
    }
  }
}

for (const name of Object.keys(ALLOWED)) {
  if (!seenNames.has(name)) {
    problems.push(
      `scripts/check-deps.mjs lists "${name}", but no workspace declares that package name.`,
    )
  }
}

if (problems.length > 0) {
  console.error(`check:deps ✗ ${problems.length} problem(s) found:\n`)
  for (const problem of problems) console.error(`  - ${problem}\n`)
  console.error('See docs/architecture.md for the allowed dependency graph.')
  process.exit(1)
}

console.log(
  `check:deps ✓ @openharness/* dependency rules hold for ${workspaces.length} workspaces.`,
)
