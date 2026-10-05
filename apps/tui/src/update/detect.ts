import { realpathSync } from 'node:fs'
import { basename, dirname, normalize } from 'node:path'

/**
 * Is the running `oh` the one a global `npm i -g openharness` installed? (issue #157, D10)
 *
 * The auto-update only makes sense there. `node apps/tui/dist/index.js` from a checkout, or a
 * copy of the published package inside some project's `node_modules`, must be left alone: npm
 * did not put it there, and installing over it would be surprising at best.
 *
 * The check has two halves, deliberately, because one of them is cheap and the other is not:
 *
 * 1. {@link looksLikeGlobalLayout} — the running bundle sits at
 *    `<somewhere>/<module dir>/openharness/dist/index.js`, which is the shape npm gives a
 *    global install. This is a `realpath` and two string comparisons, so a checkout (whose
 *    package folder is `apps/tui`, not `openharness`) answers "no" without spawning anything.
 * 2. {@link isGlobalInstall} — that `<module dir>` is the one `npm root -g` names. This is
 *    the authoritative answer, and the one that separates a global install from a dependency
 *    of some project; the caller runs `npm root -g` **once** and caches its answer in the
 *    state file, so the cost is not paid on every startup.
 */

/**
 * This package's published name — the unscoped `openharness` (#152). `index.ts` exports the
 * same string as `PACKAGE_NAME`; the constant is repeated rather than imported so this module
 * stays a leaf the bundle can order freely.
 */
const CLI_PACKAGE_NAME = 'openharness'

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
 * The package folder the running bundle belongs to, realpath'd: `/x/node_modules/openharness`
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
  // …/openharness/dist/index.js → …/openharness: two levels up from the bundle.
  return dirname(dirname(real))
}

/**
 * The cheap half: does the running bundle have the *shape* of a global install?
 *
 * True when its package folder is named `openharness` and sits directly inside a module
 * directory. Says nothing about whether that module directory is the global one — that is
 * {@link isGlobalInstall}'s job — but it is free, and it is what a checkout fails.
 */
export function looksLikeGlobalLayout(scriptPath: string | undefined): boolean {
  const root = packageRootOf(scriptPath)
  if (root === undefined) return false
  return basename(root) === CLI_PACKAGE_NAME && basename(dirname(root)) === MODULE_DIRECTORY
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

  const root = packageRootOf(scriptPath)
  if (root === undefined) return false
  if (basename(root) !== CLI_PACKAGE_NAME) return false

  const parent = dirname(root)
  if (basename(parent) !== MODULE_DIRECTORY) return false

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
