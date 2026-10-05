/**
 * A tiny semver comparator (issue #157, D10).
 *
 * The auto-update asks npm for the published version and has to decide whether it is newer
 * than the one running. The published CLI is one self-contained file with no runtime
 * dependencies — that is the whole premise of D10 — so there is no `semver` package to do
 * this with; this is the slice of semver §11 the decision needs, prereleases included. A
 * `-next.N` build must rank **below** the release it leads to, and two prereleases must order
 * by their identifiers — `alpha.10` after `alpha.2`, numerically, not as strings — or the CLI
 * would spend every check reinstalling the same version.
 */

/** A parsed version: the three numbers, and the `-…` identifiers for a prerelease. */
export interface Version {
  readonly major: number
  readonly minor: number
  readonly patch: number
  /** The prerelease identifiers, or an empty list for a release version. */
  readonly prerelease: readonly (string | number)[]
}

/**
 * What npm hands back: `1.2.3`, optionally `v`-prefixed, with an optional prerelease and
 * build metadata. Build metadata is ignored, as the spec asks.
 */
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Parse a version string, or answer `undefined` when it is not one.
 *
 * Anything unparseable — a dist-tag, an error message, an empty line — is `undefined`, which
 * every caller treats as "no update to make" rather than as an error: a version we cannot
 * read is not a reason to install something.
 */
export function parseVersion(value: string): Version | undefined {
  const match = VERSION_PATTERN.exec(value.trim())
  if (match === null) return undefined
  const [, major, minor, patch, prerelease] = match
  if (major === undefined || minor === undefined || patch === undefined) return undefined
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease === undefined ? [] : parsePrerelease(prerelease),
  }
}

/** `alpha.1` → `['alpha', 1]`: numeric identifiers compare as numbers (semver §11.4.1). */
function parsePrerelease(value: string): readonly (string | number)[] {
  return value.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
}

/**
 * Semver precedence: `-1` when `a` is older, `1` when it is newer, `0` when they are equal.
 *
 * A release outranks any prerelease of the same `major.minor.patch`; between two prereleases,
 * identifiers are compared left to right, numeric ones numerically and the rest as ASCII
 * strings, with a numeric identifier ranking below a string one and a shorter identifier list
 * ranking below a longer one that starts the same way.
 */
export function compareVersions(a: Version, b: Version): -1 | 0 | 1 {
  const numbers = order(a.major - b.major) || order(a.minor - b.minor) || order(a.patch - b.patch)
  if (numbers !== 0) return numbers

  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1

  const shared = Math.min(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < shared; index += 1) {
    const left = a.prerelease[index]
    const right = b.prerelease[index]
    if (left === undefined || right === undefined) break
    const compared = compareIdentifier(left, right)
    if (compared !== 0) return compared
  }
  return order(a.prerelease.length - b.prerelease.length)
}

/** One prerelease identifier against another: numeric first, then ASCII. */
function compareIdentifier(a: string | number, b: string | number): -1 | 0 | 1 {
  if (typeof a === 'number' && typeof b === 'number') return order(a - b)
  if (typeof a === 'number') return -1
  if (typeof b === 'number') return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** A signed difference as the comparator's three answers. */
function order(difference: number): -1 | 0 | 1 {
  return difference < 0 ? -1 : difference > 0 ? 1 : 0
}

/**
 * Is `candidate` a later version than `current`?
 *
 * Two strings, because that is what the answer comes from: npm's output and the version the
 * bundle was built with. Either one unparseable — a dist-tag, a locally built `0.0.0-next` —
 * answers `false`: an update is an action, and it takes a version we can actually read.
 */
export function isNewer(candidate: string, current: string): boolean {
  const published = parseVersion(candidate)
  const running = parseVersion(current)
  if (published === undefined || running === undefined) return false
  return compareVersions(published, running) > 0
}
