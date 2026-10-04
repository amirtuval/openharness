/**
 * The chat-model filter (epic #92, C2; issue #90): never hide a usable chat model, never show
 * a non-chat one.
 *
 * The catalogue must not offer embeddings, TTS, transcription, image or moderation models —
 * picking one in the agent form could only produce a failed turn — and it must not drop a
 * chat model just because its name is unfamiliar to a heuristic. The rule, in order:
 *
 * 1. **An explicit non-chat verdict drops the model.** The registry's classification, or the
 *    provider's own capability data — Gemini's `supportedGenerationMethods` without
 *    `generateContent` (`embedContent` and friends), the one payload this server currently
 *    reads that says "not chat" for a model it lists.
 * 2. **An explicit chat verdict keeps it.** The registry's classification, OpenRouter's
 *    chat-only catalogue, Gemini with `generateContent` in its method list.
 * 3. **Otherwise, the conservative name filter decides**: a model whose id names a known
 *    non-chat family is dropped, and every other model is kept. The filter is deliberately a
 *    deny-list of families — an id it does not recognise is listed — because the principle is
 *    asymmetric: showing one embedding model is a small annoyance, hiding a usable chat model
 *    is the failure the epic is about.
 *
 * The same rule filters the registry's own model list on a `fallback` (C3): the registry lists
 * every model a provider serves, chat and non-chat alike, and this module is what turns that
 * into the chat models a picker can offer.
 *
 * `@mastra/core@1.71.0`'s bundled registry carries model ids and provider configuration but
 * no chat flag, so in the installed version step 3 is what does the work; the two explicit
 * steps are what the rule degrades to when a verdict is there (Gemini, OpenRouter today; a
 * richer registry later). This ordering is the documented contract — keep it in step with
 * "The chat-model filter" in `apps/server/AGENTS.md`.
 */

/**
 * The families that are not chat, matched against the raw model id. Each pattern is word-like
 * on purpose: `embed` matches `text-embedding-3-large` and `nomic-embed-text`, `search`
 * matches `gpt-4o-search-preview` but not `deep-research` (a research model is a chat model).
 */
const NON_CHAT_FAMILIES: readonly RegExp[] = [
  /embed/i, // text-embedding-3-large, gemini-embedding-001, nomic-embed-text
  /(^|[-_./])tts([-_./]|$)/i, // tts-1, tts-1-hd, gpt-4o-mini-tts
  /whisper/i, // whisper-1, whisper-large-v3
  /transcri/i, // gpt-4o-transcribe, gpt-4o-transcribe-diarize, gpt-transcription
  /speech/i, // speech-synthesis families
  /dall[-_]?e/i, // dall-e-2, dall-e-3, dalle-3
  /gpt[-_]?image/i, // gpt-image-1, chatgpt-image-latest
  /(^|[-_./])image([-_./]|$)/i, // gemini-…-image, flux-image, image-generation
  /imagen/i, // imagen-3.0-generate-002
  /moderation/i, // omni-moderation-latest
  /realtime/i, // gpt-realtime, gpt-realtime-mini
  /(^|[-_./])audio([-_./]|$)/i, // gpt-audio, gpt-4o-audio-preview
  /(^|[-_./])search([-_./]|$)/i, // gpt-4o-search-preview, gpt-5-search-api
  /rerank/i, // rerank-v3.5
  /(^|[-_./])sora([-_./]|$)/i, // sora-2, sora-2-pro (video)
  /(^|[-_./])(babbage|davinci)([-_./]|$)/i, // the legacy completions models
  /(^|[-_./])instruct([-_./]|$)/i, // gpt-3.5-turbo-instruct
]

/** Whether a raw model id names a family that is never a chat model. */
export function isNonChatFamily(rawId: string): boolean {
  return NON_CHAT_FAMILIES.some((pattern) => pattern.test(rawId))
}

/** What the two sides that may classify a model say about it; either may stay silent. */
export interface ChatVerdicts {
  /** The raw model id, for the name filter's fallback. */
  readonly rawId: string
  /** The provider's own verdict, when its list carried one (`ProviderModel.chat`). */
  readonly providerChat?: boolean | undefined
  /** The registry's verdict, when the installed registry classifies the model. */
  readonly registryChat?: boolean | undefined
}

/**
 * Whether a listed model is a chat model — the rule documented at the top of this module.
 *
 * Any explicit "not chat" wins over any explicit "chat": the cost of dropping a model a chat
 * UI could have used is real, but streaming a reply is impossible for an embeddings model, so
 * a provider that says a model cannot generate content is believed. With no verdict at all,
 * the name filter decides.
 */
export function isChatModel(verdicts: ChatVerdicts): boolean {
  if (verdicts.providerChat === false || verdicts.registryChat === false) {
    return false
  }
  if (verdicts.providerChat === true || verdicts.registryChat === true) {
    return true
  }
  return !isNonChatFamily(verdicts.rawId)
}
