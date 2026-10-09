import { realpathSync } from 'node:fs'
import { basename, dirname, normalize } from 'node:path'

/**
 * Is the running `oh` the one a global `npm i -g @openh/cli` installed? (issue #157, D10)
 *
 * The auto-update only makes sense there. `node apps/tui/dist/index.js` from a checkout, or a
 * copy of the published package inside some project's `node_modules`, must be left alone: npm
 * did not put it there, and installing over it would be surprising at best.
 *
 * The check has two halves, deliberately, because one of them is cheap and the other is not:
 *
 * 1. {@link looksLikeGlobalLayout} (through {@link globalModuleDirectory}) — the running
 *    bundle sits at `<somewhere>/<module dir>/@openh/cli/dist/index.js`, which is the shape npm
 *    gives a global install of a *scoped* package: the scope is one folder deeper than an
 *    unscoped name, so the folder to compare is two levels up from the bundle, not one. This is
 *    a `realpath` and a few string comparisons, so a checkout (whose package folder is
 *    `apps/tui`, not `@openh/cli`) answers "no" without spawning anything. This half is also
 *    the one a detached check can be handed: the other half needs npm, and the child (#197)
 *    asks it there.
 * 2. {@link isGlobalInstall} — that `<module dir>` is the one `npm root -g` names. This is
 *    the authoritative answer, and the one that separates a global install from a dependency
 *    of some project; the caller runs `npm root -g` **once** and caches its answer in the
 *    state file, so the cost is not paid on every startup.
 */

/**
 * This package's published name — the scoped `@openh/cli` (#194, #152). `index.ts` exports the
 * same string as `PACKAGE_NAME`; the constant is repeated rather than imported so this module
 * stays a leaf the bundle can order freely.
 */
const CLI_PACKAGE_NAME = '@openh/cli'

/**
 * The name's segments, outermost first: `['@openh', 'cli']`. The folder npm places the
 * package in is the name split on `/`, so a scoped name costs one more directory level than
 * an unscoped one — and that level is exactly what the layout check has to account for.
 */
const PACKAGE_SEGMENTS = CLI_PACKAGE_NAME.split('/')

/**
 * The bare directory name npm puts global packages under.
 *
 * Spelled in pieces on purpose: `scripts/check-pack.mjs` greps the packed bundle for that
 * literal — on a non-comment line it would mean something is being resolved from disk at
 * runtime — and would fail the build over a comparison that is about a directory *name*, not
 * a resolution.
 */
const MODULE_DIRECTORY = ['node', 'modules'].join('_')

/**
 * The package folder the running bundle belongs to, realpath'd: `/x/node_modules/@openh/cli`
 * for a global install, `apps/tui` for the built checkout.
 *
 * `undefined` when the path says nothing — no argv[1] (an embedding caller), or a path that
 * is not there. The bin npm installs is a symlink, so the realpath is the one that holds.
 */
export function packageRootOf(scriptPath: string | undefined): string | undefined {
  if (scriptPath === undefined || scriptPath.trim() === '') return undefined
  let real: string
  try {
    real = realpathSync(scriptPath)
  } catch {
    return undefined
  }
  // …/@openh/cli/dist/index.js → …/@openh/cli: two levels up from the bundle, the same two
  // whatever the package is called — `dist/` is always the folder the build writes.
  return dirname(dirname(real))
}

/**
 * The module directory the package sits under, when it sits where a global install would put
 * it: `<module dir>/@openh/cli` — `node_modules/@openh/cli` for a global install.
 *
 * `undefined` when the layout is not that shape, which is what a checkout or a vendored copy
 * answers. It strips the name's own segments off the package folder and then requires a
 * module directory above them, so it reads the scoped layout without naming it twice.
 */
function moduleDirectoryOf(packageRoot: string): string | undefined {
  let current = packageRoot
  for (const segment of [...PACKAGE_SEGMENTS].reverse()) {
    if (basename(current) !== segment) return undefined
    current = dirname(current)
  }
  return basename(current) === MODULE_DIRECTORY ? current : undefined
}

/**
 * The module directory the running bundle sits under, when the layout is that of a global
 * install: `/x/node_modules` for `/x/node_modules/@openh/cli/dist/index.js`.
 *
 * This is the free half of the global-install check, and the half the detached check needs
 * handed to it (#197): the child is a `node -e` program with no bundle to import, so the
 * folder comparison is split — the CLI decides this side from `process.argv[1]`, and the child
 * compares that answer with `npm root -g`'s. `undefined` when the layout is not that shape,
 * which is what a checkout or a vendored copy answers.
 */
export function globalModuleDirectory(scriptPath: string | undefined): string | undefined {
  const root = packageRootOf(scriptPath)
  return root === undefined ? undefined : moduleDirectoryOf(root)
}

/**
 * The cheap half: does the running bundle have the *shape* of a global install?
 *
 * True when its package folder is `@openh/cli` under a module directory. Says nothing about
 * whether that module directory is the global one — that is {@link isGlobalInstall}'s job —
 * but it is free, and it is what a checkout fails.
 */
export function looksLikeGlobalLayout(scriptPath: string | undefined): boolean {
  return globalModuleDirectory(scriptPath) !== undefined
}

/**
 * The authoritative half: is that module directory the one `npm root -g` named?
 *
 * @param scriptPath the running entry point (`process.argv[1]`)
 * @param globalRoot `npm root -g`'s answer — the global module directory
 * @param platform the platform, for Windows' case-insensitive paths
 */
export function isGlobalInstall(
  scriptPath: string | undefined,
  globalRoot: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (globalRoot === undefined || globalRoot.trim() === '') return false

  const parent = globalModuleDirectory(scriptPath)
  if (parent === undefined) return false

  let resolved: string
  try {
    resolved = realpathSync(globalRoot)
  } catch {
    resolved = normalize(globalRoot)
  }

  return platform === 'win32'
    ? parent.toLowerCase() === resolved.toLowerCase()
    : parent === resolved
}
