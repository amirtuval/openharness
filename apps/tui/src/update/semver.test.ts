import { describe, expect, it } from 'vitest'

import { compareVersions, isNewer, parseVersion } from './semver'

/** Compare two version strings, failing the test when either will not parse. */
function compare(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === undefined || right === undefined) throw new Error(`not versions: ${a} ${b}`)
  return compareVersions(left, right)
}

describe('parseVersion', () => {
  it('reads a plain release', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
  })

  it('reads a v-prefix, the way a tag is written', () => {
    expect(parseVersion('v0.4.10')?.patch).toBe(10)
  })

  it('reads prerelease identifiers, numeric ones as numbers', () => {
    expect(parseVersion('1.0.0-next.12')?.prerelease).toEqual(['next', 12])
  })

  it('drops build metadata, which the spec says does not affect precedence', () => {
    expect(parseVersion('1.2.3+build.7')?.prerelease).toEqual([])
    expect(isNewer('1.2.4+build.1', '1.2.4')).toBe(false)
  })

  it('is undefined for anything that is not a version', () => {
    for (const value of ['', '  ', 'latest', '1.2', '1.2.3.4', 'v', 'not a version', '1.0.0-']) {
      expect(parseVersion(value), value).toBeUndefined()
    }
  })
})

describe('compareVersions', () => {
  it('orders the three numbers', () => {
    expect(compare('1.2.3', '1.2.4')).toBe(-1)
    expect(compare('1.3.0', '1.2.9')).toBe(1)
    expect(compare('2.0.0', '1.99.99')).toBe(1)
    expect(compare('1.2.3', '1.2.3')).toBe(0)
  })

  it('ranks a prerelease below the release it leads to', () => {
    expect(compare('1.0.0-next.1', '1.0.0')).toBe(-1)
    expect(compare('1.0.0', '1.0.0-next.1')).toBe(1)
  })

  it('orders prereleases by their identifiers, not their strings', () => {
    expect(compare('1.0.0-alpha', '1.0.0-beta')).toBe(-1)
    expect(compare('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1)
    expect(compare('1.0.0-rc.1', '1.0.0-beta.11')).toBe(1)
  })

  it('ranks a numeric identifier below an alphanumeric one', () => {
    expect(compare('1.0.0-1', '1.0.0-alpha')).toBe(-1)
    expect(compare('1.0.0-alpha', '1.0.0-1')).toBe(1)
  })

  it('ranks a shorter identifier list below a longer one that starts the same', () => {
    expect(compare('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1)
    expect(compare('1.0.0-alpha.1', '1.0.0-alpha')).toBe(1)
  })

  it('compares the numbers before the prerelease', () => {
    expect(compare('1.0.1-alpha', '1.0.0')).toBe(1)
    expect(compare('2.0.0-alpha', '1.9.9')).toBe(1)
  })
})

describe('isNewer', () => {
  it('is true only for a strictly later version', () => {
    expect(isNewer('1.2.4', '1.2.3')).toBe(true)
    expect(isNewer('1.2.3', '1.2.3')).toBe(false)
    expect(isNewer('1.2.3', '1.2.4')).toBe(false)
  })

  it('treats the release as newer than its own prerelease', () => {
    // The published `latest` overtaking the `next` build the user runs is an update.
    expect(isNewer('0.4.0', '0.4.0-next.3')).toBe(true)
    expect(isNewer('0.4.0-next.4', '0.4.0-next.3')).toBe(true)
    expect(isNewer('0.4.0-next.3', '0.4.0')).toBe(false)
  })

  it('answers false when either side is not a version', () => {
    // A dist-tag, an error message on stdout, a bundle with no version baked in: none is an
    // update, and none is a reason to install anything.
    expect(isNewer('latest', '1.0.0')).toBe(false)
    expect(isNewer('1.0.0', 'not-a-version')).toBe(false)
    expect(isNewer('', '1.0.0')).toBe(false)
    expect(isNewer('1.0.0', '')).toBe(false)
  })
})
