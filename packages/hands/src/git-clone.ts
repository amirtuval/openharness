/**
 * Cloning a public git repository into memory (epic #349, K3).
 *
 * The import reads a repository once, at one commit, and stores what it found; nothing is read
 * from git afterwards. This module is that one read, and it is deliberately the narrowest
 * thing that can do it:
 *
 * - **`isomorphic-git`, in this process.** There is no `git` binary on the path, no shell, no
 *   subprocess — a `spawn` of `git` would be a second program with its own idea of what a
 *   repository is, and this is the one place where "what a repository is" has to be *our*
 *   answer. `isomorphic-git` is a pure-JavaScript implementation, so the parser reading a
 *   stranger's packfile is the same kind of code as everything else here.
 * - **A shallow clone into memory.** `depth: 1`, one branch, and no checkout: the commit's
 *   tree is all an import wants, and the host's disk is not an import's to write on. The
 *   repository lives in {@link createMemoryFileSystem}, which is dropped when the clone ends.
 * - **Every request through {@link safeFetch}.** The URL is the user's, so the guard built for
 *   exactly that (epic #245, A3a) is what dials it: `https` **and `http`**, a private,
 *   loopback, link-local or metadata address refused unless the deployment's self-host setting
 *   allows it, every redirect re-checked, and each hop's socket pinned to the addresses that
 *   were checked. No credentials are ever sent — no `onAuth` is passed, so a repository that
 *   asks for them ends the clone as {@link GitCloneError} `authentication_required` rather than
 *   opening a prompt.
 * - **Bounded.** A total download cap (20 MB, K4's {@link DEFAULT_CLONE_MAX_BYTES}) across every
 *   request of the clone, and one deadline for the whole thing — a repository is somebody
 *   else's, and neither its size nor its patience is ours to trust.
 *
 * ## What is *not* here
 *
 * No submodules (`isomorphic-git` does not follow a gitlink, and the walk that lists the tree
 * skips the entry type), no Git LFS (an LFS pointer is stored as the text file it is, and no
 * object is fetched from the LFS server), no tags fetched for their own sake, no history
 * beyond the one commit, and no writes anywhere but the in-memory tree. "No `git` binary, no
 * submodules, no LFS" is K3, and each of the four is a property of this function rather than a
 * setting a caller could turn on.
 *
 * The error a caller gets is a {@link GitCloneError} with a stable {@link GitCloneErrorCode} —
 * the vocabulary of {@link SKILL_IMPORT_FAILURES} in the protocol, which is what a route turns
 * into a message for a user. The classification is deliberately coarse where a git server is
 * deliberately opaque: GitHub answers `401` for a repository that does not exist as readily as
 * for one that is private, so a `401` says "private, or requires credentials" and nothing
 * finer is claimed.
 */

import git, { TREE } from 'isomorphic-git'

import { SKILL_CLONE_MAX_BYTES, SKILL_INFLATE_MAX_BYTES } from '@openharness/protocol'

import { createMemoryFileSystem, type MemoryFileSystem } from './memory-fs'
import {
  PACK_OBJECT_TYPE,
  PackFormatError,
  PackLimitError,
  assertPackWithinInflateLimit,
  deltaChainObjectSize,
  extractPack,
  inflateBounded,
  parsePackIndex,
  readPackEntry,
  type PackFile,
} from './git-pack'
import {
  isSafeFetchError,
  safeFetch,
  type AddressResolver,
  type SafeFetchTransport,
} from './safe-fetch'

/** Why a clone failed, as a stable code. The names are the protocol's (`SKILL_IMPORT_FAILURES`). */
export type GitCloneErrorCode =
  | 'unreachable'
  | 'not_a_repository'
  | 'authentication_required'
  | 'ref_not_found'
  | 'over_limit'
  | 'refused_address'

/** A clone that could not be made, with a stable {@link GitCloneErrorCode}. */
export class GitCloneError extends Error {
  /** What went wrong; see {@link GitCloneErrorCode}. */
  readonly code: GitCloneErrorCode

  constructor(code: GitCloneErrorCode, message: string) {
    super(message)
    this.name = 'GitCloneError'
    this.code = code
  }
}

/** Whether a value is the {@link GitCloneError} this module raises, across a bundle boundary. */
export function isGitCloneError(value: unknown): value is GitCloneError {
  if (value instanceof GitCloneError) {
    return true
  }
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return (value as Partial<GitCloneError>).name === 'GitCloneError'
}

/**
 * How many bytes one clone may download, by default: 20 MB, the same number the protocol's
 * {@link SKILL_CLONE_MAX_BYTES} names.
 *
 * Spelled as that constant rather than as a second `20 * 1024 * 1024`, because the two are one
 * limit: the skill resource documents it as "the largest clone an import may download", and a
 * clone that defaulted to something else would make the documented number true only of callers
 * that passed it.
 */
export const DEFAULT_CLONE_MAX_BYTES = SKILL_CLONE_MAX_BYTES

/**
 * How long one clone may take end to end, by default: 60 seconds.
 *
 * Longer than a save-time check and shorter than a chat's patience: a shallow clone of a
 * skills repository is a couple of requests, and a host that has not answered in a minute is
 * not going to.
 */
export const DEFAULT_CLONE_TIMEOUT_MS = 60_000

/** How many redirect hops a clone follows, each re-checked. */
export const DEFAULT_CLONE_MAX_REDIRECTS = 5

/** What {@link cloneRepository} is asked for. */
export interface CloneRepositoryOptions {
  /** The `https://` (or, for a test, `http://`) URL of the repository. */
  readonly url: string
  /** The branch, tag or commit to read, or absent for the repository's default branch. */
  readonly ref?: string | null
  /**
   * Only read the blobs under this folder (or at it), from the repository's root, or every
   * blob when omitted or `null`.
   *
   * An import names a `path`, and everything it can store lies under it — so reading only
   * those blobs is what keeps a repository's unrelated (possibly enormous) content from being
   * inflated into this process. The **root** case is the one path that still reads the whole
   * tree: a `SKILL.md` at the repository's root makes the whole repository the candidate (K3).
   */
  readonly path?: string | null
  /** A caller's abort signal — a request that was cancelled — combined with the deadline. */
  readonly signal?: AbortSignal
  /** Whether a private, loopback or link-local address may be dialled (the self-host setting). */
  readonly allowPrivate?: boolean
  /** The total download cap in bytes; {@link DEFAULT_CLONE_MAX_BYTES} by default. */
  readonly maxBytes?: number
  /**
   * The total **unpacked** blob bytes one clone may read; {@link SKILL_INFLATE_MAX_BYTES} by
   * default.
   *
   * The download cap bounds the compressed pack, which is not the same number: a pack of
   * highly compressible content inflates to far more than it downloaded. Reading stops at this
   * total and fails with `over_limit`. Injectable so a test can prove the bound with a small
   * fixture rather than a multi-megabyte one.
   */
  readonly maxInflatedBytes?: number
  /** The deadline for the whole clone; {@link DEFAULT_CLONE_TIMEOUT_MS} by default. */
  readonly timeoutMs?: number | null
  /** How many redirects to follow; {@link DEFAULT_CLONE_MAX_REDIRECTS} by default. */
  readonly maxRedirects?: number
  /** How hostnames resolve; `node:dns` by default. Injectable for tests. */
  readonly resolver?: AddressResolver
  /** How a request is made; undici over a pinned dispatcher by default. Injectable for tests. */
  readonly transport?: SafeFetchTransport
}

/** One file of the cloned commit: its path from the repository's root, and its content. */
export interface ClonedFile {
  /** The file's path, forward-slashed and relative to the repository's root. */
  readonly path: string
  /** The file's bytes, exactly as the repository holds them. */
  readonly content: Uint8Array
}

/** What a clone answers: the commit it landed on and every file of that commit's tree. */
export interface ClonedRepository {
  /** The commit the clone resolved to — the ref as it was at this instant (K3). */
  readonly commit_sha: string
  /** Every blob of the commit's tree, submodule entries and nothing else left out. */
  readonly files: readonly ClonedFile[]
}

/** Where a repository is cloned to inside the in-memory tree. Nothing outside this module sees it. */
const CLONE_DIR = '/repo'

/** The git directory of {@link CLONE_DIR}. */
const CLONE_GITDIR = `${CLONE_DIR}/.git`

/**
 * Clone one repository's tree into memory, shallowly, through the guard.
 *
 * @throws GitCloneError when the repository cannot be read, the ref is not there, the address
 *   is refused, or a limit of K4 is broken
 */
export async function cloneRepository(options: CloneRepositoryOptions): Promise<ClonedRepository> {
  const maxBytes = options.maxBytes ?? DEFAULT_CLONE_MAX_BYTES
  const maxInflatedBytes = options.maxInflatedBytes ?? SKILL_INFLATE_MAX_BYTES
  // Indexing a pack reads every object to compute its id, so the ceiling that keeps a single
  // entry from exhausting memory is the protocol's unpacked cap (or a caller's larger read
  // cap) — not the read cap itself, which an import may set lower to bound *what it keeps*.
  const maxObjectBytes = Math.max(SKILL_INFLATE_MAX_BYTES, maxInflatedBytes)
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_CLONE_TIMEOUT_MS : options.timeoutMs
  const deadline = timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs)
  const signal =
    options.signal === undefined
      ? deadline
      : deadline === undefined
        ? options.signal
        : AbortSignal.any([options.signal, deadline])

  // The bytes this clone has downloaded, across every request and every hop. `safeFetch` caps
  // one response; this is the cap K4 really names — the clone, not the response. `over` is
  // recorded as well as thrown, because the body that went over is being read by
  // `isomorphic-git`, and the failure it reports for an abandoned stream is its own — the flag
  // is what survives that and says what really happened.
  const budget = { downloaded: 0, over: false }
  const fs = createMemoryFileSystem()
  await fs.promises.mkdir(CLONE_DIR, { recursive: true })
  await fs.promises.mkdir(CLONE_GITDIR, { recursive: true })

  const http = {
    request: async (request: {
      url: string
      method?: string | undefined
      headers?: Record<string, string> | undefined
      body?: AsyncIterableIterator<Uint8Array> | undefined
    }) => {
      const response = await guardFetch(
        request.url,
        request,
        options,
        signal,
        maxBytes,
        budget,
        maxObjectBytes,
      )
      return response
    },
  }

  let currentRequest: RequestKind = 'discover'

  const run = async <T>(operation: () => Promise<T>, during: RequestKind): Promise<T> => {
    currentRequest = during
    try {
      return await operation()
    } catch (error) {
      if (budget.over) {
        throw new GitCloneError('over_limit', 'the clone is over the import limit')
      }
      throw classify(error, currentRequest)
    } finally {
      currentRequest = 'discover'
    }
  }

  try {
    // 1. What is there. One advert, read before anything is fetched: it tells us the default
    // branch, whether the ref exists at all, and — for the errors — whether what answered is
    // even a git server. A caller who mistyped a branch is told so without downloading a pack.
    const info = await run(() => git.getRemoteInfo({ http, url: options.url }), 'discover')
    const target = resolveTarget(options.ref ?? null, info)

    // 2. The clone itself: depth 1, the one ref, no checkout.
    await run(
      () =>
        git.clone({
          fs,
          http,
          dir: CLONE_DIR,
          gitdir: CLONE_GITDIR,
          url: options.url,
          ref: target,
          depth: 1,
          singleBranch: true,
          noCheckout: true,
        }),
      'upload-pack',
    )

    // 3. Which commit that was, and the blobs under the requested path — never the whole tree
    // when a path was named, and never more unpacked bytes than the cap allows.
    const commitSha = await run(() => peelToCommit(fs, CLONE_GITDIR, target), 'upload-pack')
    const files = await run(
      () =>
        readTree(fs, CLONE_GITDIR, commitSha, {
          path: options.path ?? null,
          maxInflatedBytes,
        }),
      'upload-pack',
    )
    return { commit_sha: commitSha, files }
  } catch (error) {
    if (isGitCloneError(error)) {
      throw error
    }
    if (budget.over) {
      throw new GitCloneError('over_limit', 'the clone is over the import limit')
    }
    throw classify(error, currentRequest)
  }
}

/** How much of the limit one clone has spent: bytes downloaded, and whether it went over. */
interface CloneBudget {
  downloaded: number
  over: boolean
}

/** Which of the two requests a failure came from: what is asked, vs what is downloaded. */
type RequestKind = 'discover' | 'upload-pack'

/**
 * The ref to clone at: what the caller asked for, checked against the advert, or the
 * repository's own default branch.
 *
 * A caller's `ref` may be a branch, a tag or a full commit sha. Only the first two appear in an
 * advert, so a 40-character hex `ref` is passed through (a server that will not serve a bare
 * commit — GitHub will, some servers will not — answers with an error the classifier reads as
 * "no such ref"), and anything else has to be there.
 */
function resolveTarget(ref: string | null, info: RemoteAdvert): string {
  const heads = info.refs?.heads ?? {}
  const tags = info.refs?.tags ?? {}
  if (ref !== null && ref.length > 0) {
    if (/^[0-9a-f]{40}$/.test(ref)) {
      return ref
    }
    if (!(ref in heads) && !(ref in tags)) {
      throw new GitCloneError('ref_not_found', `the repository has no ref ${ref}`)
    }
    return ref
  }
  const branch = info.HEAD?.replace(/^refs\/heads\//, '')
  if (branch !== undefined && branch.length > 0) {
    return branch
  }
  const [first] = Object.keys(heads)
  if (first === undefined) {
    throw new GitCloneError('not_a_repository', 'the repository has no branches')
  }
  return first
}

/**
 * What one advert says, as `git.getRemoteInfo` shapes it.
 *
 * The refs are a tree of ref paths (`refs.heads.main`), because that is how the call builds
 * them — while `HEAD` is its **own** field, holding the symref target verbatim
 * (`refs/heads/main`), so "which branch is the default" is read from there rather than from
 * the tree.
 */
interface RemoteAdvert {
  /** The branch the server's `HEAD` points at, verbatim; absent on a server that lists none. */
  readonly HEAD?: string | undefined
  readonly refs?:
    | {
        readonly heads?: Record<string, string> | undefined
        readonly tags?: Record<string, string> | undefined
      }
    | undefined
}

/**
 * The commit `ref` names, peeling an annotated tag to the commit it points at.
 *
 * A tag's own object id is the tag, not the commit, and an import stores a commit: the
 * `object <sha>` header of a tag object is followed until a commit answers.
 */
async function peelToCommit(fs: MemoryFileSystem, gitdir: string, ref: string): Promise<string> {
  let oid = await git.resolveRef({ fs, dir: CLONE_DIR, gitdir, ref })
  for (let depth = 0; depth < 10; depth++) {
    const { object, type } = await git.readObject({ fs, dir: CLONE_DIR, gitdir, oid })
    if (type !== 'tag') {
      return oid
    }
    const text = new TextDecoder().decode(object as Uint8Array)
    const match = /^object ([0-9a-f]{40})$/m.exec(text)
    if (match?.[1] === undefined) {
      throw new GitCloneError('not_a_repository', `tag ${oid} names no object`)
    }
    oid = match[1]
  }
  throw new GitCloneError('not_a_repository', `tag ${ref} is nested too deeply`)
}

/**
 * The blobs of a commit's tree under `path`, contents read, in path order.
 *
 * The walk is this module's rather than `git.listFiles`' for one reason: a tree entry of type
 * `commit` is a **submodule**, whose object lives in another repository — the walker reports
 * the type without reading it, so it can be skipped, while a listing that reads every entry
 * fails the whole clone on one. "No submodules" (K3) is then a property of this function, and
 * a repository that uses one still imports its own files.
 *
 * The walk reads **tree objects only** — the entry type is reported without inflating a blob —
 * so the path list is cheap, and the blobs are read afterwards, one at a time, only for the
 * paths `path` selects. Two bounds apply to what is read:
 *
 * - **Only what the caller asked for.** With a `path`, a blob outside it — a huge asset in
 *   another folder of the same repository — is never inflated. With no path the whole tree is
 *   read, because a root `SKILL.md` makes the whole repository the candidate (K3).
 * - **A cumulative cap, and a per-blob one.** A download cap bounds the compressed pack, not
 *   what it unpacks to; `maxInflatedBytes` bounds the sum of the blobs really read, and
 *   crossing it fails the clone with `over_limit` before another blob is read. A git tree
 *   entry carries no size, so a cumulative check alone would have to inflate one blob whole
 *   before it could learn it was too large — one entry of a 20 MB pack can be gigabytes. The
 *   pack's own index and entry headers do carry the size, so each blob's inflation is bounded
 *   before it starts (see `git-pack.ts`), and a single blob past what is left of the cap is
 *   refused without ever being materialised. Discovery still reports a file's own K4 problem
 *   when it fits.
 *
 * A file over `SKILL_FILE_MAX_BYTES` is therefore read and reported as an `over-limit`
 * candidate problem (the preview shows it) rather than silently skipped: skipping would make a
 * skill look importable when it is not.
 */
async function readTree(
  fs: MemoryFileSystem,
  gitdir: string,
  commitSha: string,
  options: { readonly path: string | null; readonly maxInflatedBytes: number },
): Promise<ClonedFile[]> {
  const blobs: { readonly path: string; readonly oid: string }[] = []
  await git.walk({
    fs,
    dir: CLONE_DIR,
    gitdir,
    trees: [TREE({ ref: commitSha })],
    map: async (filepath, entries) => {
      const entry = entries[0]
      if (entry === null || entry === undefined) {
        return
      }
      if ((await entry.type()) === 'blob') {
        blobs.push({ path: filepath, oid: await entry.oid() })
      }
    },
  })

  const requested = options.path === null || options.path === '' ? null : options.path
  const prefix = requested === null ? null : `${requested}/`
  const selected = blobs
    .filter(({ path }) => prefix === null || path === requested || path.startsWith(prefix))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))

  // The bounded reader, over the pack the clone just wrote. Loading it is what makes a blob's
  // size knowable *before* the blob is inflated; a repository with no pack is read loose.
  const objects = new CloneObjectReader(fs, gitdir, await loadPacks(fs, gitdir))

  const files: ClonedFile[] = []
  let inflated = 0
  for (const { path, oid } of selected) {
    const remaining = options.maxInflatedBytes - inflated
    // The reader refuses a blob whose own inflated size is past what is left *before* it
    // inflates it — one entry is otherwise enough to exhaust the process, whatever the
    // cumulative total would have said afterwards.
    const content = await objects.read(oid, remaining)
    inflated += content.byteLength
    if (inflated > options.maxInflatedBytes) {
      throw new GitCloneError(
        'over_limit',
        `the clone unpacks to more than ${options.maxInflatedBytes} bytes`,
      )
    }
    files.push({ path, content })
  }
  return files
}

/**
 * One clone's object store, read with a bound.
 *
 * A packed object is read from its pack: the entry header names the blob's size (or the delta's
 * instruction stream), so an ordinary blob is inflated right here with a cap, and a delta's
 * chain is measured before `isomorphic-git` is asked to resolve it. A loose object is already a
 * zlib stream, and is read with the same cap.
 */
class CloneObjectReader {
  constructor(
    private readonly fs: MemoryFileSystem,
    private readonly gitdir: string,
    private readonly packs: readonly PackFile[],
  ) {}

  /** Read one blob, refusing to inflate past `maxBytes`. */
  async read(oid: string, maxBytes: number): Promise<Uint8Array> {
    for (const pack of this.packs) {
      const offset = pack.offsets.get(oid)
      if (offset === undefined) {
        continue
      }
      const entry = readPackEntry(pack.data, offset)
      if (entry.type === PACK_OBJECT_TYPE.blob) {
        if (entry.size > maxBytes) {
          throw new PackLimitError(`blob ${oid} inflates to more than ${maxBytes} bytes`)
        }
        const content = inflateBounded(pack.data.subarray(entry.dataOffset), entry.size)
        if (content.byteLength !== entry.size) {
          throw new PackFormatError(`blob ${oid} is not the size its entry names`)
        }
        return content
      }
      if (entry.type === PACK_OBJECT_TYPE.ofsDelta || entry.type === PACK_OBJECT_TYPE.refDelta) {
        // What a chain may make its resolver hold is bounded first; only then is
        // `isomorphic-git` asked to apply it (this package does not re-implement delta
        // application).
        deltaChainObjectSize(this.packs, pack, offset, maxBytes)
        const { blob } = await git.readBlob({
          fs: this.fs,
          dir: CLONE_DIR,
          gitdir: this.gitdir,
          oid,
        })
        return blob
      }
      throw new PackFormatError(`object ${oid} is not a blob`)
    }
    return this.readLoose(oid, maxBytes)
  }

  /** Read a loose object — its file *is* a zlib stream of `<type> <size>\0<content>`. */
  private async readLoose(oid: string, maxBytes: number): Promise<Uint8Array> {
    const path = `${this.gitdir}/objects/${oid.slice(0, 2)}/${oid.slice(2)}`
    let stored: Uint8Array | string
    try {
      stored = await this.fs.promises.readFile(path)
    } catch {
      throw new PackFormatError(`object ${oid} is in no pack and no loose object`)
    }
    const bytes = typeof stored === 'string' ? new TextEncoder().encode(stored) : stored
    const raw = inflateBounded(bytes, maxBytes)
    const nul = raw.indexOf(0)
    if (nul < 0) {
      throw new PackFormatError(`object ${oid} has no header`)
    }
    const header = new TextDecoder().decode(raw.subarray(0, nul))
    const match = /^(blob|tree|commit|tag) (\d+)$/.exec(header)
    if (match === null) {
      throw new PackFormatError(`object ${oid} has an unreadable header`)
    }
    if (match[1] !== 'blob') {
      throw new PackFormatError(`object ${oid} is not a blob`)
    }
    const size = Number(match[2])
    const content = raw.subarray(nul + 1)
    if (content.byteLength !== size) {
      throw new PackFormatError(`blob ${oid} is not the size its header names`)
    }
    return content
  }
}

/**
 * Read every pack index the clone wrote, with its pack.
 *
 * `isomorphic-git` writes one pack for a shallow clone, but nothing in the format promises
 * one, so this reads all of them. A directory that does not exist is a repository whose
 * objects are loose: an empty list, not a failure.
 */
async function loadPacks(fs: MemoryFileSystem, gitdir: string): Promise<PackFile[]> {
  let names: string[]
  try {
    names = await fs.promises.readdir(`${gitdir}/objects/pack`)
  } catch {
    return []
  }
  const packs: PackFile[] = []
  for (const name of names.filter((name) => name.endsWith('.idx')).sort()) {
    const stem = name.slice(0, -'.idx'.length)
    let index: Uint8Array | string
    let data: Uint8Array | string
    try {
      index = await fs.promises.readFile(`${gitdir}/objects/pack/${name}`)
      data = await fs.promises.readFile(`${gitdir}/objects/pack/${stem}.pack`)
    } catch {
      // An index whose pack is gone cannot be read; the object lookup fails closed rather
      // than falling back to an unbounded read of something else.
      continue
    }
    const indexBytes = typeof index === 'string' ? new TextEncoder().encode(index) : index
    const packBytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    packs.push({ data: packBytes, offsets: parsePackIndex(indexBytes) })
  }
  return packs
}

/** The client {@link cloneRepository} uses for every git request. */
async function guardFetch(
  url: string,
  request: {
    method?: string | undefined
    headers?: Record<string, string> | undefined
    body?: AsyncIterableIterator<Uint8Array> | undefined
  },
  options: CloneRepositoryOptions,
  signal: AbortSignal | undefined,
  maxBytes: number,
  budget: CloneBudget,
  maxObjectBytes: number,
): Promise<{
  url: string
  method: string
  headers: Record<string, string>
  body: AsyncIterableIterator<Uint8Array>
  statusCode: number
  statusMessage: string
}> {
  const response = await safeFetch(
    url,
    {
      method: request.method ?? 'GET',
      headers: request.headers ?? {},
      body: request.body as unknown as BodyInit,
      ...(signal === undefined ? {} : { signal }),
    },
    {
      // The clone's own cap is the running total below; the guard's per-response cap would
      // refuse a packfile the clone as a whole could still afford, so it is off and the total
      // is what bounds the download.
      maxBytes: null,
      timeoutMs: null,
      idleTimeoutMs: 30_000,
      maxRedirects: options.maxRedirects ?? DEFAULT_CLONE_MAX_REDIRECTS,
      ...(options.allowPrivate === true ? { allowPrivate: true } : {}),
      ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
      ...(options.transport === undefined ? {} : { transport: options.transport }),
    },
  )

  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    headers[name] = value
  })

  // The pack response is read whole so its own headers can be checked before
  // `isomorphic-git` indexes it — indexing inflates every object to compute its id, and a
  // single compressible entry would otherwise be materialised before any cap could look at
  // it. The download cap bounds this buffer exactly as it bounded the stream.
  const isPackRequest = (request.method ?? 'GET').toUpperCase() === 'POST'
  const body = isPackRequest
    ? await checkedPackBody(response, maxBytes, budget, maxObjectBytes)
    : counting(response, maxBytes, budget)

  return {
    url: response.url === '' ? url : response.url,
    method: request.method ?? 'GET',
    headers,
    body,
    statusCode: response.status,
    statusMessage: response.statusText,
  }
}

/**
 * Buffer one pack response, refuse a pack with an oversized object, and hand the **original**
 * bytes on: `isomorphic-git` demultiplexes the side-band stream itself.
 */
async function checkedPackBody(
  response: Response,
  maxBytes: number,
  budget: CloneBudget,
  maxObjectBytes: number,
): Promise<AsyncIterableIterator<Uint8Array>> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of counting(response, maxBytes, budget)) {
    chunks.push(chunk)
    total += chunk.byteLength
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  const pack = extractPack(body)
  if (pack !== null) {
    await assertPackWithinInflateLimit(pack, maxObjectBytes)
  }
  return once(body)
}

/** An iterator over one already-buffered body. */
function once(body: Uint8Array): AsyncIterableIterator<Uint8Array> {
  let sent = false
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    next(): Promise<IteratorResult<Uint8Array>> {
      if (sent) {
        return Promise.resolve({ done: true, value: undefined })
      }
      sent = true
      return Promise.resolve({ done: false, value: body })
    },
  }
}

/**
 * The response body, as the async iterator git wants — counting what it costs, and refusing
 * the clone the moment the total goes over the cap.
 *
 * Counting here rather than after the fact is what makes the cap real: a repository ten times
 * over the limit is stopped a fifth of the way in rather than downloaded whole and then
 * refused.
 */
async function* counting(
  response: Response,
  maxBytes: number,
  budget: CloneBudget,
): AsyncIterableIterator<Uint8Array> {
  const body = response.body
  if (body === null) {
    return
  }
  for await (const chunk of body) {
    budget.downloaded += chunk.byteLength
    if (budget.downloaded > maxBytes) {
      budget.over = true
      throw new GitCloneError('over_limit', 'the clone is over the import limit')
    }
    yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
  }
}

/**
 * What a failure means, in this module's vocabulary.
 *
 * The guard's own refusals map to the two codes a user can act on (an address this deployment
 * will not dial, a clone over the limit); everything `isomorphic-git` raises is read off its
 * `code`, which is the stable half of its error API. A failure nobody recognises is "that is
 * not a repository": something answered, and it was not git.
 */
function classify(error: unknown, during: RequestKind): GitCloneError {
  if (isGitCloneError(error)) {
    return error
  }
  // The bounded reader's two outcomes: past the budget is the user's actionable `over_limit`;
  // bytes that are not the pack/object they claim to be are not a repository.
  if (error instanceof PackLimitError) {
    return new GitCloneError('over_limit', error.message)
  }
  if (error instanceof PackFormatError) {
    return new GitCloneError('not_a_repository', error.message)
  }
  if (isSafeFetchError(error)) {
    switch (error.code) {
      case 'blocked_address':
      case 'metadata_host':
        return new GitCloneError('refused_address', error.message)
      case 'too_large':
      case 'idle_timeout':
        return new GitCloneError('over_limit', error.message)
      case 'dns_failure':
        return new GitCloneError('unreachable', error.message)
      default:
        return new GitCloneError('not_a_repository', error.message)
    }
  }
  if (isAbort(error)) {
    return new GitCloneError('over_limit', 'the clone took too long')
  }
  // A `TypeError` out of the transport — `fetch failed`, with the socket's own reason in its
  // `cause` — is a host that could not be reached rather than a page that was not git. It is
  // the one failure with no `code` of its own, which is what tells it apart from the rest.
  if (error instanceof TypeError) {
    return new GitCloneError('unreachable', error.message)
  }
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  const status = statusOf(error)
  switch (code) {
    case 'HttpError':
      if (status === 401 || status === 403) {
        return new GitCloneError('authentication_required', 'the repository needs credentials')
      }
      if (status !== undefined && status >= 500) {
        return new GitCloneError('unreachable', `the server answered ${status}`)
      }
      // A server that refuses the *fetch* is refusing the ref it was asked to send — a commit
      // it will not serve, a branch that moved out from under it. A refusal on the advert is
      // simply something that is not a repository.
      return during === 'upload-pack'
        ? new GitCloneError(
            'ref_not_found',
            `the server refused to send that ref (${status ?? 'no status'})`,
          )
        : new GitCloneError('not_a_repository', `the server answered ${status ?? 'no status'}`)
    case 'NotFoundError':
      return new GitCloneError(
        'ref_not_found',
        error instanceof Error ? error.message : 'no such ref',
      )
    case 'AbortError':
      return new GitCloneError('over_limit', 'the clone took too long')
    default:
      return new GitCloneError(
        'not_a_repository',
        error instanceof Error ? error.message : 'the repository could not be read',
      )
  }
}

/** The HTTP status an `isomorphic-git` `HttpError` carries, if that is what this is. */
function statusOf(error: unknown): number | undefined {
  const data =
    typeof error === 'object' && error !== null ? (error as { data?: unknown }).data : undefined
  if (typeof data === 'object' && data !== null) {
    const statusCode = (data as { statusCode?: unknown }).statusCode
    if (typeof statusCode === 'number') {
      return statusCode
    }
  }
  return undefined
}

/** Whether an error is an abort — the caller's, or the deadline's. */
function isAbort(error: unknown): boolean {
  return (
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) ||
    (typeof DOMException !== 'undefined' && error instanceof DOMException)
  )
}
