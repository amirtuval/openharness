#!/usr/bin/env node
/**
 * `yarn check:pack` — the published package, proved (#152).
 *
 * The point of #152 is that `npm i -g openharness` yields **one self-contained file**: no
 * runtime `dependencies`, nothing resolved from `node_modules` while `oh` runs — which is
 * what makes D10's background `npm install -g` able to replace the file on disk under a
 * running process. That property is invisible to the unit tests (they import `src/`), so
 * this script proves it against the tarball itself:
 *
 * 1. `npm pack` the package and check the file list is exactly the expected one (the bundle,
 *    its declaration file, the npm-included `package.json`/README/LICENSE — and nothing the
 *    build left behind, e.g. a source map or a code-split chunk);
 * 2. `npm install` the tarball into a fresh temporary directory **outside** the workspace,
 *    with no network access beyond what installing it needs — which is nothing, since there
 *    are no dependencies — and with no workspace `node_modules` to fall back on;
 * 3. run the installed `oh --version` and `oh --help` from that directory and assert they
 *    exit 0 and print what they promise, version included;
 * 4. audit `dist/index.js`: no unresolved `import`/`require` of a bare specifier (only
 *    `node:` built-ins are allowed), and no `@openharness/` reference at all — the bundle
 *    cannot name a package it would have to resolve at runtime.
 *
 * Run it with `yarn check:pack` from `apps/tui`; the build has to be up to date first.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))

/** The files npm is expected to pack: the `files` field, minus README/LICENSE duplicates. */
const EXPECTED_FILES = ['LICENSE', 'README.md', 'dist/index.d.ts', 'dist/index.js', 'package.json']

/** Specifiers the bundle may import at runtime: the node built-ins, and nothing else. */
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)])

const failures = []

/** Record a check's outcome; a failure is collected, not thrown, so one run reports all. */
function check(name, ok, detail) {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) {
    failures.push(name)
  }
}

/** Human-readable kilobytes. */
function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} kB`
}

/**
 * Every module specifier the bundle would resolve at runtime: static `import`/`export from`
 * at the start of a line (the bundle is line-formatted, not minified), `import(...)`, and
 * `require(...)` (rolldown's CJS interop emits these as `__require`).
 */
function importSpecifiers(code) {
  const specifiers = new Set()
  for (const pattern of [
    /^import\s[^;]*?from\s*["']([^"']+)["']/gm,
    /^import\s*["']([^"']+)["']/gm,
    /^export\s[^;]*?from\s*["']([^"']+)["']/gm,
    /(?:\bimport|\brequire)\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of code.matchAll(pattern)) {
      specifiers.add(match[1])
    }
  }
  return [...specifiers].sort()
}

const tmp = mkdtempSync(join(tmpdir(), 'oh-check-pack-'))
try {
  const bundle = join(packageRoot, 'dist/index.js')
  if (!existsSync(bundle)) {
    throw new Error(`dist/index.js is missing — run \`yarn build\` first (${packageRoot})`)
  }
  // The `bin` points at the bundle, so the version `oh --version` must print is the
  // package's own — the `__CLI_VERSION__` define in tsdown.config.ts reads the same file.
  const version = pkg.version

  // --- 1. npm pack, and only the expected files -------------------------------------------------
  const packDir = join(tmp, 'pack')
  mkdirSync(packDir)
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--pack-destination', packDir], {
      cwd: packageRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  )[0]
  const packedFiles = packed.files.map((file) => file.path).sort()
  const tarball = join(packDir, packed.filename)
  check(
    'npm pack lists exactly the expected files',
    JSON.stringify(packedFiles) === JSON.stringify([...EXPECTED_FILES].sort()),
    packedFiles.join(', '),
  )

  // --- 2. install the tarball into a fresh directory outside the workspace ----------------------
  const installDir = join(tmp, 'install')
  // `--offline` is deliberate: a package with nothing to install must install with nothing to
  // fetch. If this ever needs the network, the package grew a runtime dependency.
  execFileSync(
    'npm',
    [
      'install',
      '--prefix',
      installDir,
      '--offline',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      '--loglevel',
      'error',
      tarball,
    ],
    { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const installedBin = join(installDir, 'node_modules', '.bin', 'oh')
  const installedBundle = join(installDir, 'node_modules', pkg.name, 'dist', 'index.js')
  check('the tarball installs with no dependencies', existsSync(installedBundle))

  // --- 3. run the installed `oh` ----------------------------------------------------------------
  const runOh = (args) =>
    execFileSync(installedBin, args, {
      cwd: tmp,
      encoding: 'utf8',
      // A config home of the check's own: never the developer's ~/.config/openharness.
      env: { ...process.env, XDG_CONFIG_HOME: join(tmp, 'config-home') },
      // `oh --help` is a lot of lines; keep room for them.
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

  const printedVersion = runOh(['--version']).trim()
  check(
    'the installed `oh --version` prints the package version',
    printedVersion === version,
    printedVersion,
  )

  const help = runOh(['--help'])
  check(
    'the installed `oh --help` prints the usage',
    help.includes('Usage:') && help.includes('openharness'),
  )

  // --- 4. the bundle resolves nothing from node_modules -----------------------------------------
  const code = readFileSync(installedBundle, 'utf8')
  const unresolved = importSpecifiers(code).filter((specifier) => !BUILTINS.has(specifier))
  check(
    'the bundle imports only node: built-ins',
    unresolved.length === 0,
    unresolved.length > 0
      ? `unresolved: ${unresolved.join(', ')}`
      : `${importSpecifiers(code).length} specifiers`,
  )

  check('the bundle never names `@openharness/`', !code.includes('@openharness/'))

  // The raw string `node_modules` is allowed only where it is not a reference: rolldown's
  // `//#region ../../node_modules/...` chunk comments, and the stack-parsing regex a bundled
  // dependency (`stack-utils`, via ink) builds to filter its own frames out of reports.
  const suspicious = code
    .split('\n')
    .filter((line) => line.includes('node_modules'))
    .filter((line) => !line.trimStart().startsWith('//'))
    .filter((line) => !line.includes('new RegExp('))
  check(
    'the bundle references `node_modules` only in comments or stack-parsing patterns',
    suspicious.length === 0,
    suspicious.length > 0 ? suspicious[0].trim() : 'all occurrences are comments or patterns',
  )

  // --- 5. report the sizes ------------------------------------------------------------------------
  const sizes = packed.files
    .filter((file) => file.path.startsWith('dist/'))
    .map((file) => `${file.path} ${kb(file.size)}`)
  console.log(`\ntarball ${relative(packageRoot, tarball) || packed.filename} (${kb(packed.size)})`)
  for (const size of sizes) {
    console.log(`  ${size}`)
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\ncheck:pack ✗ ${failures.length} check(s) failed.`)
  process.exit(1)
}
console.log('\ncheck:pack ✓ the tarball is one self-contained file that installs and runs.')
