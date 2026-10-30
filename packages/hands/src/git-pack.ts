/**
 * Reading a packfile's object sizes before inflating anything (epic #349, K3; #390 QA).
 *
 * `isomorphic-git` has no bounded read: `git.readBlob` inflates an object whole inside its
 * pack reader. That is fine for the *cumulative* cap the clone keeps — every object is counted
 * after it has been read — but it is not enough for a hostile repository, because one entry of
 * a 20 MB pack can be twenty gigabytes of zeros and is inflated before the caller can look at
 * it. A git tree entry carries no size, so the check has to happen one level down: the pack's
 * own index and entry headers do carry it.
 *
 * This module is that one level down, and nothing else:
 *
 * - **The index gives oid → offset.** `indexPack` writes index v2 into the in-memory
 *   repository, so the object's own entry can be found without scanning the pack.
 * - **The entry header gives the inflated size** — for an ordinary object, the object's size;
 *   for a delta, the size of the delta instructions. The zlib stream is not touched to read
 *   it.
 * - **A delta's *result* size is in the delta header**, the second varint of the instruction
 *   stream. Reading it costs one bounded inflate of the (small) delta, not of the object it
 *   reconstructs. A chain is walked the same way, so the sum of everything a chain would make
 *   `isomorphic-git` hold can be bounded before it reads any of it.
 * - **An ordinary blob is inflated here**, with Node's zlib `maxOutputLength`, so the single
 *   blob the cap cannot afford is stopped at the cap rather than after it.
 *
 * Only packed objects are this module's business. A loose object is already a zlib stream on
 * its own; {@link inflateBounded} reads it with the same bound.
 *
 * The format is git's (`Documentation/gitformat-pack.txt`): index v2's fanout, sorted object
 * ids, CRCs, offsets and large offsets; a pack entry's type-and-size varint, its `ofs_delta`
 * distance or `ref_delta` base id, and the zlib stream that follows.
 */

import { createInflate, inflateSync } from 'node:zlib'

/** The pack entry types this module distinguishes, as git numbers them. */
export const PACK_OBJECT_TYPE = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
  ofsDelta: 6,
  refDelta: 7,
} as const

/** The first entry's offset: `PACK`, a version and the object count, 12 bytes in. */
const PACK_HEADER_BYTES = 12

/** Git's own default pack depth is 50; a chain longer than this is not one git produced. */
const MAX_DELTA_DEPTH = 64

/**
 * The object at one pack offset, read without inflating it.
 *
 * `size` is the inflated size of the data that follows the header: the object's own size for
 * an ordinary entry, or the delta instruction stream's size for a delta. `dataOffset` is where
 * that zlib stream begins.
 */
export interface PackEntry {
  readonly type: number
  readonly size: number
  readonly dataOffset: number
  /** The base of a delta, by offset inside the same pack or by object id anywhere. */
  readonly base: { readonly offset: number } | { readonly oid: string } | null
}

/** One pack and the object ids its index names. */
export interface PackFile {
  /** The pack's bytes, as the in-memory file system holds them. */
  readonly data: Uint8Array
  /** Object id (lowercase hex) → the entry's offset in {@link data}. */
  readonly offsets: ReadonlyMap<string, number>
}

/** The two numbers at the start of a delta instruction stream. */
export interface DeltaSizes {
  readonly source: number
  readonly target: number
}

/** An object whose inflated form is larger than the budget its reader was given. */
export class PackLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PackLimitError'
  }
}

/** A pack or index this module cannot read; the clone reports it as not being a repository. */
export class PackFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PackFormatError'
  }
}

/**
 * Inflate one zlib stream, refusing to allocate more than `maxOutputLength` bytes.
 *
 * The cap is handed to zlib rather than checked afterwards, which is the whole point: a
 * 20 GB bomb never exists as a buffer. `data` may carry the rest of the pack after the stream;
 * zlib stops at the end of the deflate stream and ignores it.
 *
 * @throws PackLimitError when the stream would inflate past the cap
 * @throws PackFormatError when the bytes are not a valid zlib stream
 */
export function inflateBounded(data: Uint8Array, maxOutputLength: number): Uint8Array {
  try {
    // zlib refuses a cap of zero; one byte is the smallest allowance, and a caller that
    // expected nothing checks the answer's length itself.
    return inflateSync(data, { maxOutputLength: Math.max(1, Math.floor(maxOutputLength)) })
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE'
    ) {
      throw new PackLimitError(`the object inflates past ${maxOutputLength} bytes`)
    }
    throw new PackFormatError(
      error instanceof Error ? `the object did not inflate: ${error.message}` : String(error),
    )
  }
}

/**
 * Parse a version-2 pack index into object id → offset.
 *
 * Only v2 is read: it is what `isomorphic-git` writes, and a v1 index does not appear in a
 * repository this process cloned. A larger-than-2 GiB offset (the high bit of the 32-bit
 * field names an entry in the large-offset table) is read too, even though this clone's
 * download cap means it cannot occur.
 */
export function parsePackIndex(idx: Uint8Array): Map<string, number> {
  if (idx.byteLength < 8 + 256 * 4 + 40) {
    throw new PackFormatError('the pack index is too short')
  }
  const view = Buffer.from(idx.buffer, idx.byteOffset, idx.byteLength)
  if (view.readUInt32BE(0) !== 0xff744f63) {
    throw new PackFormatError('the pack index is not a version-2 index')
  }
  if (view.readUInt32BE(4) !== 2) {
    throw new PackFormatError('the pack index is not version 2')
  }
  const count = view.readUInt32BE(8 + 255 * 4)
  const oidStart = 8 + 256 * 4
  const crcStart = oidStart + count * 20
  const offsetStart = crcStart + count * 4
  const largeStart = offsetStart + count * 4
  if (view.byteLength < largeStart + 40) {
    throw new PackFormatError('the pack index is truncated')
  }
  const offsets = new Map<string, number>()
  for (let index = 0; index < count; index++) {
    const oid = view.toString('hex', oidStart + index * 20, oidStart + index * 20 + 20)
    const raw = view.readUInt32BE(offsetStart + index * 4)
    let offset = raw
    if (raw & 0x80000000) {
      const large = largeStart + (raw & 0x7fffffff) * 8
      if (view.byteLength < large + 8) {
        throw new PackFormatError('the pack index names a missing large offset')
      }
      offset = Number(view.readBigUInt64BE(large))
    }
    offsets.set(oid, offset)
  }
  return offsets
}

/**
 * Read the header of the pack entry at `offset` — its type, inflated data size and where its
 * zlib stream starts — without inflating the entry.
 *
 * @throws PackFormatError when the header is truncated or names an unknown type
 */
export function readPackEntry(data: Uint8Array, offset: number): PackEntry {
  if (offset < PACK_HEADER_BYTES || offset >= data.byteLength) {
    throw new PackFormatError('the pack entry is outside the pack')
  }
  let cursor = offset
  let byte = data[cursor] ?? 0
  cursor++
  const type = (byte >> 4) & 0b111
  let size = byte & 0b1111
  let scale = 16
  while ((byte & 0x80) !== 0) {
    if (cursor >= data.byteLength || scale > 2 ** 52) {
      throw new PackFormatError('the pack entry has no size')
    }
    byte = data[cursor] ?? 0
    cursor++
    size += (byte & 0x7f) * scale
    scale *= 128
  }
  if (
    type !== PACK_OBJECT_TYPE.commit &&
    type !== PACK_OBJECT_TYPE.tree &&
    type !== PACK_OBJECT_TYPE.blob &&
    type !== PACK_OBJECT_TYPE.tag &&
    type !== PACK_OBJECT_TYPE.ofsDelta &&
    type !== PACK_OBJECT_TYPE.refDelta
  ) {
    throw new PackFormatError(`the pack entry has unknown type ${type}`)
  }

  let base: PackEntry['base'] = null
  if (type === PACK_OBJECT_TYPE.ofsDelta) {
    // A distance encoded seven bits at a time, most significant group first, with the
    // "+1" bias git uses so that a zero byte still advances the offset.
    let next = data[cursor] ?? 0
    cursor++
    let distance = next & 0x7f
    while ((next & 0x80) !== 0) {
      if (cursor >= data.byteLength || distance > 2 ** 52) {
        throw new PackFormatError('the delta base offset is truncated')
      }
      next = data[cursor] ?? 0
      cursor++
      distance = (distance + 1) * 128 + (next & 0x7f)
    }
    base = { offset: offset - distance }
  } else if (type === PACK_OBJECT_TYPE.refDelta) {
    if (cursor + 20 > data.byteLength) {
      throw new PackFormatError('the delta base id is truncated')
    }
    const view = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    base = { oid: view.toString('hex', cursor, cursor + 20) }
    cursor += 20
  }
  if (cursor > data.byteLength) {
    throw new PackFormatError('the pack entry header is truncated')
  }
  return { type, size, dataOffset: cursor, base }
}

/**
 * Read the source and target sizes at the front of a delta instruction stream.
 *
 * Both are git's own varints: seven bits per byte, most significant group first. Only the
 * first few bytes are needed, and the caller has already bounded the stream's size.
 */
export function readDeltaSizes(delta: Uint8Array): DeltaSizes {
  let cursor = 0
  const readVarint = (): number => {
    let value = 0
    let scale = 1
    // A varint is at most ten bytes; anything longer is not one.
    for (let index = 0; index < 10; index++) {
      if (cursor >= delta.byteLength) {
        throw new PackFormatError('the delta header is truncated')
      }
      const byte = delta[cursor] ?? 0
      cursor++
      value += (byte & 0x7f) * scale
      scale *= 128
      if ((byte & 0x80) === 0) {
        return value
      }
    }
    throw new PackFormatError('the delta header is not a varint')
  }
  const source = readVarint()
  const target = readVarint()
  return { source, target }
}

/**
 * The sizes a delta chain would make its reader hold, checked against `maxBytes`.
 *
 * `isomorphic-git` resolves a chain recursively and caches links past a shallow depth, so what
 * it may allocate is the sum of every link's delta stream and reconstructed object — not just
 * the object the caller asked for. The walk answers that sum only after checking every link
 * against the budget, and refuses a chain that is cyclic, too deep or outside the pack.
 *
 * @returns the size of the object the head entry names
 * @throws PackLimitError when the chain would allocate past `maxBytes`
 * @throws PackFormatError when the chain is malformed
 */
export function deltaChainObjectSize(
  packs: readonly PackFile[],
  pack: PackFile,
  headOffset: number,
  maxBytes: number,
): number {
  const visited = new Set<number>()
  let currentPack = pack
  let offset = headOffset
  let total = 0
  let headSize: number | null = null

  for (let depth = 0; depth <= MAX_DELTA_DEPTH; depth++) {
    if (visited.has(offset)) {
      throw new PackFormatError('the delta chain loops')
    }
    visited.add(offset)
    const entry = readPackEntry(currentPack.data, offset)
    if (entry.type === PACK_OBJECT_TYPE.ofsDelta || entry.type === PACK_OBJECT_TYPE.refDelta) {
      total += entry.size
      if (total > maxBytes) {
        throw new PackLimitError(`the delta chain inflates past ${maxBytes} bytes`)
      }
      // `entry.size` is already accounted for in `total`, so the budget covers it; zlib is
      // told the exact bound so the instruction stream is never inflated past its own size
      // (a pack that lies about the size simply fails to inflate).
      const delta = inflateBounded(currentPack.data.subarray(entry.dataOffset), entry.size)
      if (delta.byteLength !== entry.size) {
        throw new PackFormatError('the delta is not the size its entry names')
      }
      const sizes = readDeltaSizes(delta)
      total += sizes.target
      if (total > maxBytes) {
        throw new PackLimitError(`the delta chain inflates past ${maxBytes} bytes`)
      }
      if (headSize === null) {
        headSize = sizes.target
      }
      const base = entry.base
      if (base === null) {
        throw new PackFormatError('the delta names no base')
      }
      const located = locate(packs, currentPack, offset, base)
      currentPack = located.pack
      offset = located.offset
      continue
    }
    total += entry.size
    if (total > maxBytes) {
      throw new PackLimitError(`the delta chain inflates past ${maxBytes} bytes`)
    }
    if (entry.type !== PACK_OBJECT_TYPE.blob) {
      throw new PackFormatError('a blob delta resolves to a non-blob')
    }
    return headSize ?? entry.size
  }
  throw new PackFormatError('the delta chain is too deep')
}

/** What scanning one entry's zlib stream learned, with the stream not retained. */
interface InflatedFacts {
  /** How many bytes the stream inflated to. */
  readonly size: number
  /** How many compressed bytes the stream consumed; the next entry starts after them. */
  readonly consumed: number
  /** The first bytes of the output, which hold a delta's two sizes. */
  readonly prefix: Uint8Array
}

/**
 * Extract the pack from one smart-HTTP response body.
 *
 * `git-upload-pack` answers with **side-band-64k**: the pack travels inside pkt-lines whose
 * first payload byte is the band (`1` is pack data, `2` progress, `3` a fatal message). A body
 * that is already a bare pack is returned as it is. `null` means no pack was found — an error
 * answer, say — and the caller has nothing to check.
 *
 * This mirrors `GitSideBand.demux`, which `isomorphic-git` runs on the same bytes after this
 * module has looked at them.
 */
export function extractPack(body: Uint8Array): Uint8Array | null {
  if (isPack(body)) {
    return body
  }
  const chunks: Uint8Array[] = []
  let cursor = 0
  while (cursor + 4 <= body.byteLength) {
    const length = pktLength(body, cursor)
    if (length === null) {
      return null
    }
    if (length <= 2) {
      // A flush (`0000`) or a v2 delimiter/response-end (`0001`/`0002`).
      cursor += 4
      continue
    }
    if (cursor + length > body.byteLength) {
      return null
    }
    const payload = body.subarray(cursor + 4, cursor + length)
    if (payload.byteLength > 0 && payload[0] === 1) {
      chunks.push(payload.subarray(1))
    }
    cursor += length
  }
  return chunks.length === 0 ? null : concat(chunks)
}

/**
 * Refuse a pack that holds any object too large to inflate — **before** `isomorphic-git`
 * indexes it.
 *
 * Indexing a pack means reading every object to compute its id (`GitPackIndex.fromPack`), so
 * bounding the blobs the clone later *reads* is not enough: one compressible entry is inflated
 * whole while the index is built. This walks the pack's own headers, which carry each object's
 * inflated size, and stops at the first object past `maxObjectBytes`. A delta's *result* size
 * is read from its (small) instruction stream, so the object a delta reconstructs is bounded
 * by the same number without ever being materialised.
 *
 * `maxObjectBytes` is a memory-safety ceiling rather than the read cap: an import may name a
 * folder, and this scan cannot tell which blobs are under it, so refusing a repository for one
 * oversized object anywhere is the conservative answer. The caller passes the protocol's
 * unpacked cap (or a larger caller-chosen one), which no skill that passes K4 can approach.
 *
 * @throws PackLimitError when an object would inflate past `maxObjectBytes`
 * @throws PackFormatError when the pack cannot be walked
 */
export async function assertPackWithinInflateLimit(
  pack: Uint8Array,
  maxObjectBytes: number,
): Promise<void> {
  if (!isPack(pack)) {
    throw new PackFormatError('the download is not a pack')
  }
  const view = Buffer.from(pack.buffer, pack.byteOffset, pack.byteLength)
  const count = view.readUInt32BE(8)
  if (count > pack.byteLength) {
    throw new PackFormatError('the pack names more objects than it can hold')
  }
  const entries = new Map<number, PackEntry & { readonly target: number | null }>()
  let cursor = PACK_HEADER_BYTES
  for (let index = 0; index < count; index++) {
    const entry = readPackEntry(pack, cursor)
    if (entry.size > maxObjectBytes) {
      throw new PackLimitError(
        `an object in the repository inflates to more than ${maxObjectBytes} bytes`,
      )
    }
    const facts = await scanInflated(pack, entry.dataOffset, entry.size)
    if (facts.size !== entry.size) {
      throw new PackFormatError('a pack entry is not the size its header names')
    }
    let target: number | null = null
    if (entry.type === PACK_OBJECT_TYPE.ofsDelta || entry.type === PACK_OBJECT_TYPE.refDelta) {
      const sizes = readDeltaSizes(facts.prefix)
      target = sizes.target
      if (target > maxObjectBytes) {
        throw new PackLimitError(
          `an object in the repository inflates to more than ${maxObjectBytes} bytes`,
        )
      }
    }
    entries.set(cursor, { ...entry, target })
    cursor = entry.dataOffset + facts.consumed
  }
  if (cursor !== pack.byteLength - 20) {
    throw new PackFormatError('the pack does not end where its objects do')
  }

  // `isomorphic-git` resolves a delta chain recursively and may hold more than the object at
  // its head, so every linked chain's members are summed against the same ceiling. A
  // `ref_delta` whose base id names an earlier object cannot be followed here (the ids are
  // what indexing computes); that link is bounded by its own target check above.
  for (const [offset, entry] of entries) {
    if (entry.type !== PACK_OBJECT_TYPE.ofsDelta) {
      continue
    }
    let total = 0
    let current: (PackEntry & { readonly target: number | null }) | undefined = entry
    let currentOffset = offset
    const seen = new Set<number>()
    for (let depth = 0; current !== undefined; depth++) {
      if (depth > MAX_DELTA_DEPTH) {
        throw new PackFormatError('the delta chain is too deep')
      }
      if (seen.has(currentOffset)) {
        throw new PackFormatError('the delta chain loops')
      }
      seen.add(currentOffset)
      total += current.size + (current.target ?? 0)
      if (total > maxObjectBytes) {
        throw new PackLimitError(
          `a delta chain in the repository inflates to more than ${maxObjectBytes} bytes`,
        )
      }
      if (current.type !== PACK_OBJECT_TYPE.ofsDelta) {
        break
      }
      const base = current.base
      if (base === null || !('offset' in base)) {
        // The base is named by id and indexing has not computed ids yet; its own target
        // check above is what bounds it.
        break
      }
      current = entries.get(base.offset)
      if (current === undefined) {
        throw new PackFormatError('a delta base is not in the pack')
      }
      currentOffset = base.offset
    }
  }
}

/** Whether a body starts with a pack's signature. */
function isPack(body: Uint8Array): boolean {
  return (
    body.byteLength >= PACK_HEADER_BYTES &&
    body[0] === 0x50 && // P
    body[1] === 0x41 && // A
    body[2] === 0x43 && // C
    body[3] === 0x4b // K
  )
}

/** The length a pkt-line's four hex digits name, or `null` when they are not hex. */
function pktLength(body: Uint8Array, cursor: number): number | null {
  let length = 0
  for (let index = 0; index < 4; index++) {
    const byte = body[cursor + index] ?? -1
    const digit =
      byte >= 0x30 && byte <= 0x39
        ? byte - 0x30
        : byte >= 0x61 && byte <= 0x66
          ? byte - 0x61 + 10
          : byte >= 0x41 && byte <= 0x46
            ? byte - 0x41 + 10
            : -1
    if (digit < 0) {
      return null
    }
    length = length * 16 + digit
  }
  return length
}

/** Concatenate byte runs into one buffer. */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const chunk of chunks) {
    total += chunk.byteLength
  }
  const answer = new Uint8Array(total)
  let cursor = 0
  for (const chunk of chunks) {
    answer.set(chunk, cursor)
    cursor += chunk.byteLength
  }
  return answer
}

/**
 * Inflate an entry's stream only far enough to learn its size, its compressed length and the
 * first bytes of its output — never retaining the output.
 *
 * The output is counted as it arrives and the stream is destroyed the moment it passes
 * `limit`, so even a pack that lies about an object's size cannot allocate past the bound.
 */
function scanInflated(pack: Uint8Array, dataOffset: number, limit: number): Promise<InflatedFacts> {
  return new Promise((resolve, reject) => {
    const stream = createInflate()
    let size = 0
    let prefix: Uint8Array = new Uint8Array(0)
    let settled = false
    const settle = (action: () => void): void => {
      if (!settled) {
        settled = true
        action()
      }
    }
    stream.on('data', (chunk: Buffer) => {
      if (settled) {
        return
      }
      if (prefix.byteLength < 32) {
        const take = Math.min(32 - prefix.byteLength, chunk.byteLength)
        prefix = concat([prefix, chunk.subarray(0, take)])
      }
      size += chunk.byteLength
      if (size > limit) {
        settle(() => {
          stream.destroy()
          reject(new PackFormatError('a pack entry inflates past the size its header names'))
        })
      }
    })
    stream.on('error', (error: unknown) => {
      settle(() =>
        reject(
          new PackFormatError(
            error instanceof Error
              ? `a pack entry did not inflate: ${error.message}`
              : String(error),
          ),
        ),
      )
    })
    stream.on('end', () => {
      settle(() => resolve({ size, consumed: stream.bytesWritten, prefix }))
    })
    stream.end(pack.subarray(dataOffset))
  })
}

/** Where a delta's base lives: an offset in this pack, or the object's id in any pack. */
function locate(
  packs: readonly PackFile[],
  pack: PackFile,
  entryOffset: number,
  base: NonNullable<PackEntry['base']>,
): { pack: PackFile; offset: number } {
  if ('offset' in base) {
    if (base.offset < PACK_HEADER_BYTES || base.offset >= entryOffset) {
      throw new PackFormatError('the delta base offset is outside the pack')
    }
    return { pack, offset: base.offset }
  }
  for (const candidate of packs) {
    const found = candidate.offsets.get(base.oid)
    if (found !== undefined) {
      return { pack: candidate, offset: found }
    }
  }
  throw new PackFormatError('the delta base is not in the pack')
}
