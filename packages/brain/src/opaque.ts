import type { JsonValue, OpaquePart, ProviderCredentialType } from '@openharness/protocol'
import type { ModelMessage } from 'ai'

import type { ModelOpaquePart } from './model'
import { providerOf } from './model'
import { asJsonObject } from './tools'
import { isVertexAnthropicModel } from './vertex'

/**
 * Provider-opaque content: the parts of a step that only the provider that produced them can
 * read back, and the rules under which they go out again (epic #303, X13; issue #334).
 *
 * Four families require part of an assistant turn to come back **exactly as it arrived**, and
 * the brain stores only what it can read — the reply's text, and its own tool events — so every
 * one of these was lost before this module existed:
 *
 * - **Anthropic** (`anthropic`, and a `claude-*` model on a Vertex credential): a `thinking`
 *   block's `signature` is checked against the conversation and the model that produced it, and
 *   a tool-use turn sent back without its thinking blocks is a request the API refuses. Current
 *   Claude models always think, so every tool turn in the stack was affected.
 * - **Bedrock** (`bedrock`): the same blocks, in Bedrock's own `reasoningContent` shape.
 * - **OpenAI and xAI** (`openai`, `xai`, the Responses API): a reasoning item's id (and, when
 *   the item is not stored server-side, its encrypted content) is what carries the step's
 *   reasoning into the next request. Losing it does not fail the turn, it costs quality.
 * - **The OpenAI-compatible family** (`openai-compatible`: an `openai_compatible` credential,
 *   and the `deepseek`, `groq` and `mistral` provider ids): the assistant message that made a
 *   tool call must carry the step's `reasoning_content` back, or DeepSeek's thinking mode
 *   rejects the next request outright — issue #330, the failure this was widened from.
 *
 * The AI SDK already does each provider's half: its clients turn an assistant `reasoning` part
 * (with that provider's per-part options) back into `thinking` + `signature`, a Responses
 * reasoning item, or `reasoning_content`. What was missing is that the brain threw the parts
 * away. So the mechanism is one: **capture** the step's opaque parts as the stream produced
 * them (`./model`), **store** them on the step's own `agent.opaque_content` event
 * (`@openharness/protocol`), and **re-attach** them to that step's assistant message when the
 * next request goes to the same client family and the same model (`./context`). Nothing is
 * shown as the reply, nothing is summarized, and nothing is ever sent to another provider.
 *
 * A fifth family needs the same treatment for a different reason (#335). A **provider-executed
 * tool call** — the web search a provider runs inside the request it was attached to — comes
 * back as the AI SDK's own `tool-call` / `tool-result` pair, and the provider needs that pair
 * handed back to continue the turn: Anthropic refuses a `server_tool_use` block replayed
 * without the `web_search_tool_result` that answers it, and both carry payload this build
 * cannot read (a search result's `encryptedContent`). So the pair is captured, stored and
 * replayed through the same table as a reasoning block, under the same family key — and it is
 * the same four families' clients that read it back, because the tool is attached through the
 * client the request already runs on.
 *
 * ## The rules, and why they are this narrow
 *
 * A family's client is what can read its parts back, so the gate is the family **and** the
 * model: every row of {@link OPAQUE_REPLAY} keeps `sameModel` true, because a signature, an
 * encrypted payload and a stored item id are bound to the model that produced them, and the one
 * family whose reasoning is plain text would be handed another model's thoughts if it were
 * sent across models. A provider switch, and a model switch within a provider, therefore drop
 * the entries — the assistant turn goes out without them, which is what the provider that
 * cannot read them wants.
 *
 * Every entry that **does** match is replayed, on the assistant message of the step that
 * produced it (see `./context`'s `conversationAfter`), and never only the newest one: the
 * OpenAI-compatible family needs the key on *every* assistant turn of a thinking-mode
 * conversation — its own client sends `reasoning_content` on each one, empty or not — and an
 * endpoint refuses the next request without it (that is issue #330's failure, one step later
 * than the first). It is also the one shape Anthropic's preserved-thinking check accepts: the
 * blocks of a conversation come back as a **contiguous window**, and replaying all of them is
 * that window whole — a block dropped from the middle, which replaying "the newest turn only"
 * would eventually amount to, fails the block after the gap.
 *
 * ## What a family needs beyond the parts
 *
 * Only where its payload lives, which is {@link OpaqueReplay.providerOptionsKey}: the AI SDK
 * provider package the family's client comes from, under which the part's options are filed
 * (`providerOptions.anthropic`, …). A family whose reasoning is plain text has none, and the
 * part is replayed as its text alone.
 *
 * Google's Gemini is deliberately **not** a family here. Its thought signatures ride on the
 * *tool call* part as well as on the reasoning part, and its grounding is left out of #335
 * altogether (`./native-search` has why), so a row for it would half-answer a question nothing
 * is asking. A Gemini request builds exactly what it built before, and the table says so by
 * having no row.
 */

/** The client families whose assistant turns carry parts only they can read back. */
export const OPAQUE_FAMILIES = [
  'anthropic',
  'bedrock',
  'openai',
  'xai',
  'openai-compatible',
] as const

/** One of them. */
export type OpaqueFamily = (typeof OPAQUE_FAMILIES)[number]

/** How one family's parts are written back into a request. */
export interface OpaqueReplay {
  /**
   * The AI SDK `providerOptions` key the part's payload is filed under — the name the family's
   * own client reads it by. `null` for a family that replays a step's reasoning as plain text
   * and carries no payload at all.
   */
  readonly providerOptionsKey: string | null
  /**
   * Whether a part may be replayed to a **different** model of the same family.
   *
   * `false` everywhere, which is the narrowest rule each API accepts: a signature, an encrypted
   * payload and a stored item id are bound to the model that produced them, and the family
   * whose reasoning is plain text would be handed another model's thoughts — a request nobody
   * wants even though its API would accept it.
   */
  readonly sameModel: boolean
  /**
   * Whether a part may be replayed **truncated** when it is too large to store.
   *
   * `false` everywhere: an Anthropic signature and an OpenAI encrypted payload are opaque to
   * this build, so a cut one is not one the provider would accept, and the compatible family's
   * reasoning is one string whose value is in being whole. An oversized part is dropped whole
   * and counted instead ({@link OPAQUE_MAX_TOKENS}) — never cut.
   */
  readonly truncatable: boolean
}

/**
 * What one family's parts need to go back out, per family.
 *
 * A small table rather than scattered branches: this is the one place a provider's requirement
 * is written down, and a family added to {@link OPAQUE_FAMILIES} without a row here is a
 * compile error.
 */
export const OPAQUE_REPLAY: Readonly<Record<OpaqueFamily, OpaqueReplay>> = {
  anthropic: { providerOptionsKey: 'anthropic', sameModel: true, truncatable: false },
  bedrock: { providerOptionsKey: 'bedrock', sameModel: true, truncatable: false },
  openai: { providerOptionsKey: 'openai', sameModel: true, truncatable: false },
  xai: { providerOptionsKey: 'xai', sameModel: true, truncatable: false },
  'openai-compatible': { providerOptionsKey: null, sameModel: true, truncatable: false },
}

/**
 * How many characters one step's parts may cost the log before they are dropped whole.
 *
 * A safety valve, not a budget — about 16k tokens at the four-characters-per-token estimate
 * every other measurement here uses. A thinking block is a few hundred to a few thousand
 * tokens and a signature or an encrypted payload a few kilobytes, so the cap is well past
 * anything a provider has produced, while still bounding a row a runaway payload could write.
 * What it must never do is *cut* a part: no family in {@link OPAQUE_REPLAY} may replay a
 * truncated payload, so a step over the cap keeps none of its parts and records how many it
 * dropped (`dropped`) — see {@link captureOpaque}.
 */
export const OPAQUE_MAX_CHARS = 65_536

/** The family a request's client belongs to, or `null` for a client that reads nothing back. */
export function opaqueFamilyOf(
  modelId: string,
  credentialType: ProviderCredentialType,
): OpaqueFamily | null {
  // The credential's type is what decides the client for a named credential — its model ids
  // carry the credential's *name*, not a provider id (epic #245, A3a) — exactly as
  // `createProviderModelFactory` reads it.
  switch (credentialType) {
    case 'openai_compatible':
      return 'openai-compatible'
    case 'bedrock':
      return 'bedrock'
    case 'vertex':
      // Vertex serves two families from one credential, and only the Anthropic one stores
      // anything this module can replay (see the module note on Gemini).
      return isVertexAnthropicModel(modelIdAfterName(modelId)) ? 'anthropic' : null
    case 'azure_openai':
      // The Azure client this build builds is the chat-completions one, and it reads no
      // reasoning part back at all.
      return null
    case 'api_key':
      break
  }
  // The fixed providers: the id's own client, or the compatible chat family whose clients
  // replay a step's reasoning as `reasoning_content`.
  switch (providerOf(modelId)) {
    case 'anthropic':
      return 'anthropic'
    case 'openai':
      return 'openai'
    case 'xai':
      return 'xai'
    case 'deepseek':
    case 'groq':
    case 'mistral':
      return 'openai-compatible'
    default:
      return null
  }
}

/** The half of a model id after the credential name or provider id — the model's own id. */
function modelIdAfterName(modelId: string): string {
  return modelId.slice(providerOf(modelId).length + 1)
}

/**
 * Where a request's opaque content may come from and go to: the family of its client, and the
 * model it runs.
 *
 * `null` means the request's client reads no opaque part back, so a step it produces stores
 * nothing and a step stored before it replays nothing — the request is built exactly as it was
 * before #334, which is what keeps every other provider's behaviour unchanged.
 */
export interface OpaqueTarget {
  /** The client family. */
  readonly provider: OpaqueFamily
  /** The model id the request runs, `provider/model`. */
  readonly model: string
}

/**
 * The replay target of the request about to be made, or `null` when its client reads nothing
 * back (see {@link opaqueFamilyOf}).
 *
 * @param modelId the model this request runs, `provider/model`
 * @param credentialType the type of the credential it is made with
 */
export function opaqueTargetOf(
  modelId: string,
  credentialType: ProviderCredentialType,
): OpaqueTarget | null {
  const provider = opaqueFamilyOf(modelId, credentialType)
  return provider === null ? null : { provider, model: modelId }
}

/** What one step's captured parts became, as the `agent.opaque_content` event carries them. */
export interface OpaqueCapture {
  /** The family the parts may be replayed to. */
  readonly provider: OpaqueFamily
  /** The model that produced them. */
  readonly model: string
  /** The parts kept, in the order the provider produced them. Empty when all were dropped. */
  readonly parts: readonly OpaquePart[]
  /** How many parts were dropped for size — every one of them, or none. */
  readonly dropped: number
}

/**
 * What one step's parts are written to the log as (epic #303, X13; #334).
 *
 * The payload is the provider's own metadata for the part, read off the stream exactly as it
 * arrived ({@link ModelOpaquePart}) and filed under the family — `metadata.anthropic` for an
 * Anthropic signature, `metadata.bedrock` for Bedrock's twin spelling of it. A part that cannot
 * be JSON (nothing a real provider sends, but a stream part is a value this build did not
 * write) is stored without its payload rather than as something no reader could read back.
 *
 * The cap is all-or-nothing, deliberately: dropping one part of a step and keeping the ones
 * after it would leave a *gap* in the sequence, which is the one shape Anthropic's
 * preserved-thinking check refuses — so a step with any oversized part keeps none of them and
 * records the count. Nothing is truncated ({@link OpaqueReplay.truncatable}).
 *
 * @param target the family and model the step ran under
 * @param parts the parts the stream carried, in the order it carried them
 */
export function captureOpaque(
  target: OpaqueTarget,
  parts: readonly ModelOpaquePart[],
): OpaqueCapture {
  const stored = parts.map((part) => opaquePartOf(target.provider, part))
  const size = stored.reduce((total, part) => total + opaquePartChars(part), 0)
  if (size > OPAQUE_MAX_CHARS) {
    return { provider: target.provider, model: target.model, parts: [], dropped: stored.length }
  }
  return { provider: target.provider, model: target.model, parts: stored, dropped: 0 }
}

/** One stream part as the log stores it: the AI SDK's part, with the family's payload. */
function opaquePartOf(provider: OpaqueFamily, part: ModelOpaquePart): OpaquePart {
  const payload = asJsonObject(part.providerMetadata?.[provider] ?? undefined)
  const data = asJsonObject(part.payload ?? undefined)
  return {
    type: part.type,
    text: part.text,
    ...(payload === undefined ? {} : { provider_options: payload }),
    ...(data === undefined ? {} : { payload: data }),
  }
}

/** What one stored part costs the log, in characters — the cap's own unit. */
function opaquePartChars(part: OpaquePart): number {
  const payload = part.provider_options === undefined ? '' : JSON.stringify(part.provider_options)
  return part.text.length + payload.length
}

/** One part of an assistant message, as the context strategy builds them. */
type AssistantParts = Extract<
  Extract<ModelMessage, { role: 'assistant' }>['content'],
  readonly unknown[]
>

/**
 * One opaque part as it goes back out: an assistant part, or the text a part stands for when
 * the request may not have the part itself.
 */
export type OpaqueMessagePart = AssistantParts[number]

/** The types {@link OpaqueMessagePart} takes when it is a part and not a conversion. */
type OpaqueReplayedPart = Extract<
  OpaqueMessagePart,
  { type: 'reasoning' | 'tool-call' | 'tool-result' }
>

/**
 * The part types a **provider-executed tool call and its answer** are stored as (epic #303,
 * X14; issue #335).
 *
 * The AI SDK's own two, always paired: a `tool-call` with `providerExecuted: true` and the
 * `tool-result` that answers it. They are what a provider reads back to continue a turn whose
 * search it ran itself — Anthropic turns the pair into `server_tool_use` and
 * `web_search_tool_result` blocks, OpenAI and xAI into the Responses items they came from — and
 * nothing else in the log can stand in for them: a search result's `encryptedContent` is
 * opaque to this build.
 */
export const PROVIDER_TOOL_PART_TYPES = ['tool-call', 'tool-result'] as const

/** A stored `agent.opaque_content`, as much of it as a replay needs to decide. */
export interface OpaqueEntry {
  /** The family that produced the parts. */
  readonly provider: string
  /** The model that produced them. */
  readonly model: string
  /** The parts themselves. */
  readonly parts: readonly OpaquePart[]
}

/**
 * The assistant parts one stored entry contributes to a request, or `[]` when it contributes
 * none (epic #303, X13; #334).
 *
 * One entry is one step's whole opaque half, and it is replayed whole or not at all: a family
 * needs the same client and (every family today) the same model, and a part whose payload is
 * missing — a keyed family's part without its signature — would go out as a block the client
 * drops with a warning, so the entry is refused rather than sent in part. That is the same
 * all-or-nothing rule {@link captureOpaque} applies on the way in, and the reason it holds on
 * both sides is the sequence: a provider that binds the parts to each other accepts a prefix,
 * never a hole.
 *
 * @param entry the stored entry
 * @param target the request's own family and model, or `null` when its client reads nothing back
 */
export function opaqueReplayParts(
  entry: OpaqueEntry,
  target: OpaqueTarget | null,
): readonly OpaqueMessagePart[] {
  const rule = replayRule(entry.provider)
  if (
    target === null ||
    entry.provider !== target.provider ||
    rule === undefined ||
    (rule.sameModel && entry.model !== target.model)
  ) {
    // Either the request's client cannot read these parts at all, or it is not the family the
    // entry names — a family this build does not know is one an entry from a later version
    // names, and guessing at its payload key would be worse than dropping it. What may still
    // be said is said as text ({@link convertedParts}).
    return convertedParts(entry)
  }
  const key = rule.providerOptionsKey
  const parts: OpaqueReplayedPart[] = []
  for (const part of entry.parts) {
    const options = providerOptionsFor(part, key)
    if (options === undefined) {
      // A keyed family's part without its payload — a signature the provider never sent — is a
      // block the client would drop with a warning, so the entry is refused rather than
      // half-sent (see above).
      return []
    }
    if (part.type === 'reasoning') {
      parts.push({ type: 'reasoning', text: part.text, ...options })
      continue
    }
    const tool = toolPartOf(part)
    if (tool === undefined || (part.type === 'tool-result' && tool.output === undefined)) {
      // A provider-executed part without the data it is made of — nothing this build writes,
      // but a log is a log — cannot be rebuilt, and the entry goes as a whole has gone.
      return []
    }
    if (part.type === 'tool-call') {
      // `providerExecuted` is what tells the provider's client this call is already answered,
      // and that its answer follows in this same assistant turn rather than in a `tool` message
      // of ours.
      parts.push({
        type: 'tool-call',
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
        input: tool.input ?? {},
        providerExecuted: true,
        ...options,
      })
      continue
    }
    if (part.type === 'tool-result') {
      parts.push({
        type: 'tool-result',
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
        output: tool.output as OpaqueToolOutput,
        ...options,
      })
      continue
    }
    // A type this build does not capture — an entry a later version wrote. Not this build's to
    // send, the same rule an unknown family gets.
    return []
  }
  return parts
}

/** One tool result's output, as the AI SDK's message part carries it. */
type OpaqueToolOutput = Extract<OpaqueReplayedPart, { type: 'tool-result' }>['output']

/**
 * One part's provider metadata, wrapped under the key its client reads it back with — or
 * `undefined` when the entry may not be replayed at all.
 *
 * A family whose parts are plain text (`key === null`) needs none and gets none, and a
 * provider-executed part is free to carry none: Anthropic's `server_tool_use` sends no
 * metadata, and only a `caller` ever would. A `reasoning` part of a keyed family without its
 * payload is the half-written block the caller refuses the entry over — the signature *is* what
 * the provider checks.
 */
function providerOptionsFor(
  part: OpaquePart,
  key: string | null,
): { providerOptions?: Record<string, Record<string, JsonValue>> } | undefined {
  if (key === null) {
    return {}
  }
  const payload = asJsonObject(part.provider_options)
  if (payload === undefined) {
    return part.type === 'reasoning' ? undefined : {}
  }
  return { providerOptions: { [key]: payload } }
}

/** A stored tool part's own data, as {@link OpaquePart.payload} carried it. */
function toolPartOf(
  part: OpaquePart,
): { toolCallId: string; toolName: string; input?: JsonValue; output?: JsonValue } | undefined {
  const payload = asJsonObject(part.payload)
  const toolCallId = payload?.toolCallId
  const toolName = payload?.toolName
  if (typeof toolCallId !== 'string' || typeof toolName !== 'string') {
    return undefined
  }
  return { toolCallId, toolName, input: payload?.input, output: payload?.output }
}

/**
 * The reading an entry contributes to a request that may not have its parts (epic #303, X14;
 * issue #335).
 *
 * One text block, or `[]` when the entry has nothing readable in it. Only a **provider-executed
 * tool result** is read this way, and only that part: it is the one part that is a fact about
 * the world — what the previous provider searched and found — which another provider may be
 * told. A reasoning block is never converted, however much text it carries: a model must not be
 * handed another model's thoughts, which is the rule #334 states and the reason the family gate
 * is the family **and** the model.
 *
 * The text is what the part was stored with (`./model`): the query, the titles and URLs found,
 * and the passage each was cited for. It is the rule #334 left room for — a part is replayed,
 * or it is its text — and it is why a provider switch keeps what the previous provider found
 * instead of losing it.
 */
function convertedParts(entry: OpaqueEntry): readonly OpaqueMessagePart[] {
  const text = entry.parts
    .filter((part) => part.type === 'tool-result')
    .map((part) => part.text)
    .filter((part) => part.length > 0)
    .join('\n')
  return text.length === 0 ? [] : [{ type: 'text', text }]
}

/** The rule for a stored entry's family, or `undefined` when this build has none for it. */
function replayRule(provider: string): OpaqueReplay | undefined {
  return Object.hasOwn(OPAQUE_REPLAY, provider)
    ? OPAQUE_REPLAY[provider as OpaqueFamily]
    : undefined
}
