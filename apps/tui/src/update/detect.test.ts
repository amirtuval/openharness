import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isGlobalInstall, looksLikeGlobalLayout, packageRootOf } from './detect'

/**
 * The two layouts the check has to tell apart, made real on disk: a global install (the
 * scoped package under a global `node_modules`, reached through the `bin` symlink npm
 * creates) and the built checkout (`apps/tui/dist/index.js`).
 */
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oh-detect-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Create `<prefix>/node_modules/@openh/cli/dist/index.js` and answer both paths. */
function installPackage(prefix: string): { readonly bundle: string; readonly moduleRoot: string } {
  const moduleRoot = join(prefix, 'node_modules')
  const bundle = join(moduleRoot, '@openh', 'cli', 'dist', 'index.js')
  mkdirSync(join(moduleRoot, '@openh', 'cli', 'dist'), { recursive: true })
  writeFileSync(bundle, '// the built bundle, standing in\n')
  return { bundle, moduleRoot }
}

/** A `bin/oh` symlink to `bundle`, the way npm installs one. */
function binLink(prefix: string, bundle: string): string {
  mkdirSync(join(prefix, 'bin'), { recursive: true })
  const link = join(prefix, 'bin', 'oh')
  symlinkSync(bundle, link)
  return link
}

describe('packageRootOf', () => {
  it('is the package folder the bundle lives in', () => {
    const { bundle } = installPackage(join(root, 'prefix'))

    expect(packageRootOf(bundle)).toBe(join(root, 'prefix', 'node_modules', '@openh', 'cli'))
  })

  it('resolves the bin symlink npm installs', () => {
    const prefix = join(root, 'prefix')
    const { bundle } = installPackage(prefix)

    expect(packageRootOf(binLink(prefix, bundle))).toBe(
      join(prefix, 'node_modules', '@openh', 'cli'),
    )
  })

  it('is undefined for a path that says nothing', () => {
    expect(packageRootOf(undefined)).toBeUndefined()
    expect(packageRootOf('')).toBeUndefined()
    expect(packageRootOf(join(root, 'nowhere', 'index.js'))).toBeUndefined()
  })
})

describe('looksLikeGlobalLayout', () => {
  it('is true for a scoped package under a module directory, however it is reached', () => {
    const prefix = join(root, 'prefix')
    const { bundle } = installPackage(prefix)

    expect(looksLikeGlobalLayout(bundle)).toBe(true)
    expect(looksLikeGlobalLayout(binLink(prefix, bundle))).toBe(true)
  })

  it('is false for the checkout, whose bundle is not inside a module directory', () => {
    const bundle = join(root, 'apps', 'tui', 'dist', 'index.js')
    mkdirSync(join(root, 'apps', 'tui', 'dist'), { recursive: true })
    writeFileSync(bundle, '// built from a checkout\n')

    expect(looksLikeGlobalLayout(bundle)).toBe(false)
  })

  it('is false for the folder the package was called before it was scoped', () => {
    // `<module dir>/openharness` is the shape the unscoped name had; nothing installs that
    // any more, so it must not read as a global install of this CLI (#194).
    const bundle = join(root, 'node_modules', 'openharness', 'dist', 'index.js')
    mkdirSync(join(root, 'node_modules', 'openharness', 'dist'), { recursive: true })
    writeFileSync(bundle, '// the old layout\n')

    expect(looksLikeGlobalLayout(bundle)).toBe(false)
  })

  it('is false under some other scope', () => {
    // A fork or a vendored copy: `npm i -g` did not put it there, so it is left alone.
    const bundle = join(root, 'node_modules', '@other', 'cli', 'dist', 'index.js')
    mkdirSync(join(root, 'node_modules', '@other', 'cli', 'dist'), { recursive: true })
    writeFileSync(bundle, '// vendored\n')

    expect(looksLikeGlobalLayout(bundle)).toBe(false)
  })

  it('is false with no entry point at all', () => {
    expect(looksLikeGlobalLayout(undefined)).toBe(false)
  })
})

describe('isGlobalInstall', () => {
  it('is true when the package sits exactly where npm root -g points', () => {
    const prefix = join(root, 'prefix')
    const { bundle, moduleRoot } = installPackage(prefix)

    expect(isGlobalInstall(bundle, moduleRoot)).toBe(true)
    expect(isGlobalInstall(binLink(prefix, bundle), moduleRoot)).toBe(true)
  })

  it('is false when that module directory belongs to some other prefix', () => {
    // The shape is right but the place is not: a copy inside a project's node_modules.
    const { bundle } = installPackage(join(root, 'project'))
    const { moduleRoot: otherRoot } = installPackage(join(root, 'elsewhere'))

    expect(isGlobalInstall(bundle, otherRoot)).toBe(false)
  })

  it('is false for the checkout, whatever npm root -g says', () => {
    const bundle = join(root, 'apps', 'tui', 'dist', 'index.js')
    mkdirSync(join(root, 'apps', 'tui', 'dist'), { recursive: true })
    writeFileSync(bundle, '// built from a checkout\n')

    expect(isGlobalInstall(bundle, join(root, 'apps', 'tui'))).toBe(false)
  })

  it('is false without an answer from npm', () => {
    const { bundle } = installPackage(join(root, 'prefix'))

    expect(isGlobalInstall(bundle, undefined)).toBe(false)
    expect(isGlobalInstall(bundle, '')).toBe(false)
    expect(isGlobalInstall(bundle, '   ')).toBe(false)
  })

  it('compares Windows paths without case sensitivity', () => {
    const prefix = join(root, 'Prefix')
    const { bundle, moduleRoot } = installPackage(prefix)

    // The same directory, spelled the way a Windows API might hand it back.
    expect(isGlobalInstall(bundle, moduleRoot.toUpperCase(), 'win32')).toBe(true)
    // On any other platform those are genuinely different directories.
    expect(isGlobalInstall(bundle, moduleRoot.toUpperCase())).toBe(false)
  })
})
