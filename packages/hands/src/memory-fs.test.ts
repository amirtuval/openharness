import { describe, expect, it } from 'vitest'

import { createMemoryFileSystem } from './memory-fs'

/**
 * The in-memory file system a clone writes into (epic #349, K3).
 *
 * It is small, but it is the thing a stranger's repository writes through, so the two
 * properties worth pinning are the ones a repository's *contents* could attack: a path can
 * never climb out of the tree, and the error codes `isomorphic-git` branches on are the ones
 * node raises (`ENOENT`, `ENOTDIR`, `EEXIST`, `EISDIR`).
 */
describe('createMemoryFileSystem', () => {
  it('writes and reads a file, by bytes and as text', async () => {
    const fs = createMemoryFileSystem()
    // A write does not create its parent — that is `isomorphic-git`'s `FileSystem.write`'s
    // job (it makes the directories and retries), and node's own `writeFile` behaves the same.
    await fs.promises.mkdir('/repo', { recursive: true })
    await fs.promises.writeFile('/repo/a.txt', 'héllo')
    expect(await fs.promises.readFile('/repo/a.txt', 'utf8')).toBe('héllo')
    expect(await fs.promises.readFile('/repo/a.txt')).toEqual(new TextEncoder().encode('héllo'))
    expect((await fs.promises.lstat('/repo/a.txt')).isFile()).toBe(true)
    expect((await fs.promises.lstat('/repo/a.txt')).size).toBe(6)
  })

  it('lists a directory’s children, and the directories a write implied', async () => {
    const fs = createMemoryFileSystem()
    await fs.promises.mkdir('/repo/.git/refs/heads', { recursive: true })
    await fs.promises.writeFile('/repo/.git/HEAD', 'ref: refs/heads/main\n')
    expect((await fs.promises.readdir('/repo/.git')).sort()).toEqual(['HEAD', 'refs'])
    expect(await fs.promises.readdir('/repo/.git/refs')).toEqual(['heads'])
    expect((await fs.promises.lstat('/repo/.git')).isDirectory()).toBe(true)
  })

  it('keeps every path inside the tree, whatever a repository writes', async () => {
    const fs = createMemoryFileSystem()
    await fs.promises.mkdir('/repo/inside', { recursive: true })
    await fs.promises.writeFile('/repo/inside/../above', 'nope')
    // `..` is resolved textually, so the file landed in the tree rather than above it, and a
    // climb past the root is the root.
    expect(await fs.promises.readFile('/repo/above', 'utf8')).toBe('nope')
    await fs.promises.writeFile('/../../../../evil', 'x')
    expect(await fs.promises.readFile('/evil', 'utf8')).toBe('x')
  })

  it('raises the codes the file-system contract is read by', async () => {
    const fs = createMemoryFileSystem()
    await expect(fs.promises.readFile('/missing')).rejects.toMatchObject({ code: 'ENOENT' })
    await fs.promises.writeFile('/a', 'x')
    await fs.promises.mkdir('/dir', { recursive: true })
    await expect(fs.promises.writeFile('/missing/a', 'x')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.promises.writeFile('/a/b', 'x')).rejects.toMatchObject({ code: 'ENOTDIR' })
    await expect(fs.promises.readdir('/a')).rejects.toMatchObject({ code: 'ENOTDIR' })
    await expect(fs.promises.mkdir('/a')).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(fs.promises.mkdir('/nope/deep')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.promises.readFile('/a/b')).rejects.toMatchObject({ code: 'ENOTDIR' })
    // The root is not something a clone may delete.
    await expect(fs.promises.rmdir('/')).rejects.toMatchObject({ code: 'EPERM' })
  })

  it('removes a directory tree, recursively or not', async () => {
    const fs = createMemoryFileSystem()
    await fs.promises.mkdir('/repo/objects/pack', { recursive: true })
    await fs.promises.writeFile('/repo/objects/pack/pack-1.pack', 'bytes')
    await expect(fs.promises.rmdir('/repo')).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    await fs.promises.rm('/repo', { recursive: true })
    expect(await fs.promises.readdir('/')).toEqual([])
    // A `rm` of something that is not there is a no-op only when it was asked to be.
    await expect(fs.promises.rm('/repo')).rejects.toMatchObject({ code: 'ENOENT' })
    await fs.promises.rm('/repo', { force: true })
  })

  it('follows a symlink for `stat` and not for `lstat`', async () => {
    const fs = createMemoryFileSystem()
    await fs.promises.mkdir('/repo', { recursive: true })
    await fs.promises.writeFile('/repo/target', 'x')
    await fs.promises.symlink('/repo/target', '/repo/link')
    expect((await fs.promises.stat('/repo/link')).isFile()).toBe(true)
    expect((await fs.promises.lstat('/repo/link')).isSymbolicLink()).toBe(true)
    expect(await fs.promises.readlink('/repo/link')).toBe('/repo/target')
    // A symlink loop is an error, not an eternity.
    await fs.promises.symlink('/repo/loop', '/repo/loop')
    await expect(fs.promises.stat('/repo/loop')).rejects.toMatchObject({ code: 'ELOOP' })
  })
})
