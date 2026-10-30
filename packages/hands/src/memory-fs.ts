/**
 * An in-memory file system, just large enough for a clone (epic #349, K3).
 *
 * The import writes **nothing to disk**: the repository it clones lives in one of these, which
 * is dropped when the clone is over. That is the whole reason this file exists — a clone of a
 * repository nobody has reviewed must not be able to name a path on the host's disk, leave a
 * file behind, or read one — and it is small because a `depth: 1, noCheckout: true` clone
 * needs only the ten operations `isomorphic-git`'s file-system contract names
 * (https://isomorphic-git.org/docs/en/fs), plus `rm`, which it prefers when a backend has one.
 *
 * It is deliberately **not** a general-purpose file system: there are no symlink escapes to
 * worry about (a symlink is a value here, never followed by the operating system), no
 * permissions, no timestamps beyond what a caller asks for, and no persistence. Nothing
 * outside this package should use it.
 *
 * A path is absolute and normalized — this module does the normalization itself, so `..` and
 * `.` cannot climb out of the tree: `/a/../b` is `/b`, and `/..` is `/`. That is the same rule
 * a checkout would need; here it is a property of the store.
 *
 * Every operation is `async` even where it does not await anything, and that is load-bearing
 * rather than stylistic: `isomorphic-git` decides whether an object is a promise-based file
 * system by calling `readFile()` and checking whether the *answer* is a promise, so a method
 * that threw synchronously would make the whole object look like a callback-style one.
 */
/* eslint-disable @typescript-eslint/require-await -- see above: `async` is what makes these
   methods answer a promise, which is how `isomorphic-git` detects this file system. */

/** The subset of an `fs.Stats` object `isomorphic-git` reads. */
export interface MemoryStats {
  readonly dev: number
  readonly ino: number
  readonly mode: number
  readonly size: number
  readonly uid: number
  readonly gid: number
  readonly mtimeSeconds: number
  readonly mtimeNanoseconds: number
  readonly ctimeSeconds: number
  readonly ctimeNanoseconds: number
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

/** The promise-based file system `isomorphic-git` accepts. */
export interface MemoryFileSystem {
  readonly promises: {
    readFile(path: string, options?: ReadOptions): Promise<Uint8Array | string>
    writeFile(path: string, data: Uint8Array | string, options?: WriteOptions): Promise<void>
    unlink(path: string): Promise<void>
    readdir(path: string): Promise<string[]>
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
    rmdir(path: string, options?: { recursive?: boolean }): Promise<void>
    rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
    stat(path: string): Promise<MemoryStats>
    lstat(path: string): Promise<MemoryStats>
    readlink(path: string): Promise<string>
    symlink(target: string, path: string): Promise<void>
    chmod(path: string, mode: number): Promise<void>
  }
}

/** How a read may ask for its answer: a `Buffer` encoding, or `{ encoding }`. */
type ReadOptions = string | { readonly encoding?: string | null } | undefined

/** How a write may say what mode or encoding it means. */
interface WriteOptions {
  readonly encoding?: string | null
  readonly mode?: number
}

interface MemoryFile {
  readonly kind: 'file'
  readonly data: Uint8Array
  mode: number
}

interface MemoryDirectory {
  readonly kind: 'dir'
  mode: number
}

interface MemorySymlink {
  readonly kind: 'symlink'
  readonly target: string
  mode: number
}

type MemoryEntry = MemoryFile | MemoryDirectory | MemorySymlink

/** A directory's default mode, and a file's — the ones git writes for a plain blob. */
const DIRECTORY_MODE = 0o040755
const FILE_MODE = 0o100644
const SYMLINK_MODE = 0o120000

/** The encodings whose read answer is a string rather than bytes. */
const TEXT_ENCODINGS = new Set(['utf8', 'utf-8', 'ascii', 'latin1', 'binary', 'base64', 'hex'])

/** Build one in-memory file system. Each call is a fresh, empty tree with a root directory. */
export function createMemoryFileSystem(): MemoryFileSystem {
  const entries = new Map<string, MemoryEntry>()
  entries.set('/', { kind: 'dir', mode: DIRECTORY_MODE })

  function lookup(path: string): MemoryEntry | undefined {
    return entries.get(normalize(path))
  }

  function must(path: string): MemoryEntry {
    const found = lookup(path)
    if (found === undefined) {
      // A path that cannot exist because something above it is a file is `ENOTDIR`, the code
      // node and `isomorphic-git` both expect for it — not a plain `ENOENT`.
      throw fsError(blocked(path) ? 'ENOTDIR' : 'ENOENT', path)
    }
    return found
  }

  /** Whether some ancestor of a missing path is a file, which is what `ENOTDIR` means. */
  function blocked(path: string): boolean {
    const target = normalize(path)
    let at = target.lastIndexOf('/')
    while (at > 0) {
      const ancestor = entries.get(target.slice(0, at))
      if (ancestor !== undefined && ancestor.kind !== 'dir') {
        return true
      }
      at = target.lastIndexOf('/', at - 1)
    }
    return false
  }

  function write(path: string, data: Uint8Array, mode: number): void {
    const target = normalize(path)
    if (target === '/') {
      throw fsError('EISDIR', path)
    }
    const parent = dirname(target)
    const parentEntry = entries.get(parent)
    if (parentEntry === undefined) {
      throw fsError('ENOENT', path)
    }
    if (parentEntry.kind !== 'dir') {
      throw fsError('ENOTDIR', path)
    }
    entries.set(target, { kind: 'file', data, mode })
  }

  function remove(path: string): void {
    const target = normalize(path)
    if (target === '/') {
      throw fsError('EPERM', path)
    }
    for (const key of [...entries.keys()]) {
      if (key === target || key.startsWith(`${target}/`)) {
        entries.delete(key)
      }
    }
  }

  return {
    promises: {
      async readFile(path, options) {
        const entry = must(path)
        if (entry.kind === 'dir') {
          throw fsError('EISDIR', path)
        }
        if (entry.kind === 'symlink') {
          throw fsError('EINVAL', path)
        }
        const encoding = typeof options === 'string' ? options : options?.encoding
        if (encoding !== undefined && encoding !== null && TEXT_ENCODINGS.has(encoding)) {
          return new TextDecoder().decode(entry.data)
        }
        return entry.data
      },

      async writeFile(path, data, options) {
        const bytes =
          typeof data === 'string' ? new TextEncoder().encode(data) : Uint8Array.from(data)
        write(path, bytes, options?.mode ?? FILE_MODE)
      },

      async unlink(path) {
        const entry = must(path)
        if (entry.kind === 'dir') {
          throw fsError('EISDIR', path)
        }
        entries.delete(normalize(path))
      },

      async readdir(path) {
        const entry = must(path)
        if (entry.kind !== 'dir') {
          throw fsError('ENOTDIR', path)
        }
        const target = normalize(path)
        const prefix = target === '/' ? '/' : `${target}/`
        const names = new Set<string>()
        for (const key of entries.keys()) {
          if (key === target || !key.startsWith(prefix)) {
            continue
          }
          const rest = key.slice(prefix.length)
          const [name] = rest.split('/')
          if (name !== undefined && name.length > 0) {
            names.add(name)
          }
        }
        return [...names]
      },

      async mkdir(path, options) {
        const target = normalize(path)
        if (target === '/') {
          if (options?.recursive === true) {
            return
          }
          throw fsError('EEXIST', path)
        }
        const existing = entries.get(target)
        if (existing !== undefined) {
          if (existing.kind === 'dir' && options?.recursive === true) {
            return
          }
          throw fsError('EEXIST', path)
        }
        const parent = dirname(target)
        if (options?.recursive === true) {
          if (entries.get(parent) === undefined) {
            await this.mkdir(parent, { recursive: true })
          }
        } else if (entries.get(parent) === undefined) {
          throw fsError('ENOENT', path)
        }
        entries.set(target, { kind: 'dir', mode: DIRECTORY_MODE })
      },

      async rmdir(path, options) {
        const target = normalize(path)
        const entry = must(path)
        if (entry.kind !== 'dir') {
          throw fsError('ENOTDIR', path)
        }
        const children = [...entries.keys()].filter(
          (key) => key !== target && key.startsWith(`${target}/`),
        )
        if (children.length > 0 && options?.recursive !== true) {
          throw fsError('ENOTEMPTY', path)
        }
        remove(target)
      },

      async rm(path, options) {
        const entry = lookup(path)
        if (entry === undefined) {
          if (options?.force === true) {
            return
          }
          throw fsError('ENOENT', path)
        }
        if (entry.kind === 'dir' && options?.recursive !== true) {
          // Node's `rm` refuses a directory without `recursive`; `isomorphic-git` always asks
          // for it, and a caller that did not means the file it names anyway.
          throw fsError('EISDIR', path)
        }
        remove(path)
      },

      async stat(path) {
        return statsOf(follow(path), path)
      },

      async lstat(path) {
        return statsOf(must(path), path)
      },

      async readlink(path) {
        const entry = must(path)
        if (entry.kind !== 'symlink') {
          throw fsError('EINVAL', path)
        }
        return entry.target
      },

      async symlink(target, path) {
        write(path, new Uint8Array(), SYMLINK_MODE)
        entries.set(normalize(path), { kind: 'symlink', target, mode: SYMLINK_MODE })
      },

      async chmod(path, mode) {
        const entry = must(path)
        entry.mode = (entry.mode & 0o777000) | (mode & 0o777)
      },
    },
  }

  /** The entry a `stat` lands on: a symlink is followed, and a dangling one fails like a missing file. */
  function follow(path: string): MemoryEntry {
    let entry = must(path)
    let seen = 0
    while (entry.kind === 'symlink') {
      if (seen++ > 32) {
        throw fsError('ELOOP', path)
      }
      entry = must(entry.target)
    }
    return entry
  }
}

/** The `Stats` shape `isomorphic-git` reads, for one entry. */
function statsOf(entry: MemoryEntry, path: string): MemoryStats {
  return {
    dev: 1,
    ino: hash(path),
    mode: entry.mode,
    size: entry.kind === 'file' ? entry.data.byteLength : 0,
    uid: 0,
    gid: 0,
    mtimeSeconds: 0,
    mtimeNanoseconds: 0,
    ctimeSeconds: 0,
    ctimeNanoseconds: 0,
    isFile: () => entry.kind === 'file',
    isDirectory: () => entry.kind === 'dir',
    isSymbolicLink: () => entry.kind === 'symlink',
  }
}

/** A stable, in-process inode number: nothing reads it but git's own bookkeeping. */
function hash(path: string): number {
  let value = 0
  for (let index = 0; index < path.length; index++) {
    value = (value * 31 + path.charCodeAt(index)) >>> 0
  }
  return value
}

/** An `Error` carrying the `code` the file-system contract's callers branch on. */
function fsError(code: string, path: string): Error & { code: string } {
  const error = new Error(`${code}: ${path}`) as Error & { code: string }
  error.code = code
  return error
}

/** The directory part of a normalized path; the root's is itself. */
function dirname(path: string): string {
  const at = path.lastIndexOf('/')
  return at <= 0 ? '/' : path.slice(0, at)
}

/**
 * One path, absolute and normalized: `/` for the root, no trailing slash, no `.` or `..`
 * segment left to resolve.
 *
 * `..` is resolved **textually**, and a climb above the root is the root — so no path this
 * module is handed can name something outside the tree, whatever a repository's file names
 * say.
 */
function normalize(path: string): string {
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment.length === 0 || segment === '.') {
      continue
    }
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return `/${segments.join('/')}`.replace(/\/$/, '') || '/'
}
