/**
 * A real AWS event stream, built frame by frame — the wire shape a Bedrock Converse response
 * arrives in (epic #245, A3c).
 *
 * `@ai-sdk/amazon-bedrock` does not speak SSE: a streaming Converse reply is the **AWS event
 * stream** protocol — length-prefixed binary frames, each with a CRC-32 prelude and trailer —
 * and a test that wants a genuine reply has to write that shape rather than a chunk of JSON.
 * The alternative is a mocked model, which would prove nothing about the path this epic adds:
 * the point of the happy-path test is that a turn reaches AWS's host, signed with the user's
 * stored keys, and comes back with a reply.
 *
 * The frames here carry the events the provider reads: `messageStart`, one
 * `contentBlockDelta` per text chunk, `contentBlockStop`, `messageStop` and `metadata` (the
 * token counts). Header names are the protocol's `:event-type` family, the payload is the
 * JSON the provider parses, and the CRCs are what make the decoder accept a frame — a frame
 * with a wrong CRC is dropped by the codec, not passed through.
 *
 * Nothing here ships: `src/test-support/` is not reached from `src/index.ts` (see the folder's
 * own note). It is written by hand rather than by importing `@smithy/eventstream-codec` for
 * that reason: a dependency of a dependency, taken on only to write a fixture, is not a
 * dependency this package has.
 */

/** What one frame carries: the event name, and the JSON payload under it. */
export interface BedrockStreamEvent {
  readonly type: string
  readonly payload: unknown
  /** The `:exception-type` header, for an error frame. Absent for an ordinary event. */
  readonly exception?: string
}

/** A reply's tokens, as the `metadata` event reports them. */
export interface BedrockUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

/**
 * The frame checksum: **CRC-32** (the gzip polynomial, `0xedb88320` reversed), which is what
 * the AWS event stream specifies and what `@smithy/eventstream-codec` verifies. It is not the
 * Castagnoli variant, and a frame written with that one is dropped by the decoder.
 */
const CRC32_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let crc = index
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
    table[index] = crc >>> 0
  }
  return table
})()

/** The CRC-32 of a byte range, as the four bytes the frame writes big-endian. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = (CRC32_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Big-endian writers, because a frame is a byte layout rather than a value. */
function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, false)
}

function writeUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, false)
}

/** One header of a frame: its name, its type byte (`7` is a string) and its value. */
function encodeHeader(name: string, value: string): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder()
  const nameBytes = encoder.encode(name)
  const valueBytes = encoder.encode(value)
  const header = new Uint8Array(new ArrayBuffer(1 + nameBytes.length + 1 + 2 + valueBytes.length))
  header[0] = nameBytes.length
  header.set(nameBytes, 1)
  header[1 + nameBytes.length] = 7
  writeUint16(new DataView(header.buffer), 1 + nameBytes.length + 1, valueBytes.length)
  header.set(valueBytes, 1 + nameBytes.length + 3)
  return header
}

/** One whole frame: prelude, headers, payload, trailer. */
function encodeFrame(event: BedrockStreamEvent): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder()
  const payload = encoder.encode(JSON.stringify(event.payload))
  const headers = concat([
    encodeHeader(':message-type', event.exception === undefined ? 'event' : 'exception'),
    encodeHeader(
      event.exception === undefined ? ':event-type' : ':exception-type',
      event.exception ?? event.type,
    ),
    encodeHeader(':content-type', 'application/json'),
  ])

  // The prelude is the total length, the header length and a CRC over those eight bytes; the
  // trailer is a CRC over everything before it — per the AWS event stream specification.
  const totalLength = 4 + 4 + 4 + headers.length + payload.length + 4
  const frame = new Uint8Array(new ArrayBuffer(totalLength))
  const view = new DataView(frame.buffer)
  writeUint32(view, 0, totalLength)
  writeUint32(view, 4, headers.length)
  writeUint32(view, 8, crc32(frame.subarray(0, 8)))
  frame.set(headers, 12)
  frame.set(payload, 12 + headers.length)
  writeUint32(view, totalLength - 4, crc32(frame.subarray(0, totalLength - 4)))
  return frame
}

/** Several byte arrays, one after another. */
function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((length, part) => length + part.length, 0)
  // Backed by a real `ArrayBuffer` rather than anything shared: a `BodyInit` may not be
  // backed by a `SharedArrayBuffer`, and the type says so.
  const joined = new Uint8Array(new ArrayBuffer(total))
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  return joined
}

/** Every frame of a stream, joined: what a response body is. */
export function bedrockEventStream(events: readonly BedrockStreamEvent[]): Uint8Array<ArrayBuffer> {
  return concat(events.map(encodeFrame))
}

/** The events one successful Converse reply is made of, in the order AWS sends them. */
export function bedrockReplyEvents(
  chunks: readonly string[],
  usage: BedrockUsage = { inputTokens: 11, outputTokens: 7 },
): BedrockStreamEvent[] {
  return [
    { type: 'messageStart', payload: { role: 'assistant' } },
    ...chunks.map((text) => ({
      type: 'contentBlockDelta',
      payload: { contentBlockIndex: 0, delta: { text } },
    })),
    { type: 'contentBlockStop', payload: { contentBlockIndex: 0 } },
    { type: 'messageStop', payload: { stopReason: 'end_turn' } },
    {
      type: 'metadata',
      payload: {
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.inputTokens + usage.outputTokens,
        },
      },
    },
  ]
}

/** A one-chunk reply, as the `Response` the provider reads: the common case in a test. */
export function bedrockReplyResponse(text: string, usage?: BedrockUsage): Response {
  return new Response(bedrockEventStream(bedrockReplyEvents([text], usage)), {
    status: 200,
    headers: { 'content-type': 'application/vnd.amazon.eventstream' },
  })
}
