import type { ProviderCredentialType } from '@openharness/protocol'
import { WEB_SEARCH_TOOL_NAME } from '@openharness/protocol'
import { anthropic } from '@ai-sdk/anthropic'
import { openai } from '@ai-sdk/openai'
import { xai } from '@ai-sdk/xai'
import type { ToolSet } from 'ai'

import { providerOf } from './model'
import type { ToolSettings } from './tools'

/**
 * Provider-native web search: `web_search`, offered by attaching the chat model's own
 * provider's search tool to the request (epic #303, X14; issue #335).
 *
 * #305 built `web_search` on one operator-paid search API (Brave) with a daily cap per user.
 * #335 removes that and takes the other road: the search runs on the **user's own model key**,
 * with the provider's own index, inside the model request itself — so there is no operator bill,
 * no key to inject and no call of ours to run, and nothing for the crash rule or the approval
 * flow to act on (the provider runs the search while the request is in flight).
 *
 * The price is reach. A provider with no native search tool has no `web_search` at all, and
 * models.dev records nothing about which models have one, so {@link SEARCH_FAMILIES} is a small
 * table written down here: a family, and the model ids that may search. It is deliberately
 * generous within a family and explicit about the generations that predate the tool — a model
 * this table wrongly includes is caught by the provider's own refusal, which the loop answers by
 * dropping the tool and retrying once (`./turn`), while a model it wrongly excludes simply has
 * no search.
 *
 * | credential / provider    | native tool                                  | models            |
 * | ------------------------ | -------------------------------------------- | ----------------- |
 * | `anthropic`              | `webSearch_20260318` (`_20260209`, `_20250305`) | `claude-3.5` and newer |
 * | a Vertex Claude model    | `webSearch_20250305` only                    | `claude-*`        |
 * | `openai` (Responses)     | `webSearch`                                  | `gpt-4o`, `gpt-4.1`, `gpt-5`, `o*`, `chatgpt-4o` |
 * | `xai` (Responses)        | `webSearch`                                  | `grok-3`, `grok-4` |
 * | anything else            | none                                         | —                 |
 *
 * **Google is deliberately not in the table.** Its grounding comes with terms this build cannot
 * meet in both frontends — the "search suggestions" element (`groundingMetadata.searchEntryPoint`
 * in the AI SDK, an HTML widget) has to be shown to the end user wherever the grounded answer
 * is, and `oh` is a terminal that cannot render it — and the terms also restrict what may be
 * done with the results. Rather than offer a search one of the two clients cannot present
 * honestly, a Gemini chat has no `web_search`.
 *
 * **Azure is not either**, and for a different reason: this build's Azure client is the
 * chat-completions one (`./model`), which has no `web_search` tool to attach, and moving every
 * Azure deployment to the Responses API to gain one is a change the issue leaves to be decided
 * rather than assumed. Bedrock, Groq, Mistral, DeepSeek, OpenRouter and every custom
 * OpenAI-compatible endpoint have no native search tool at all.
 */

/** The families whose provider has a native web search tool this build can attach. */
export const SEARCH_FAMILIES = ['anthropic', 'openai', 'xai'] as const

/** One of them. */
export type SearchFamily = (typeof SEARCH_FAMILIES)[number]

/**
 * The model ids of each family that may search, as a prefix rule.
 *
 * Written down rather than read from models.dev, which does not record it. A family's list is
 * the generations that have the tool: Anthropic's from Claude 3.5 on, OpenAI's from `gpt-4o`
 * on (the Responses API is what carries the tool), and xAI's from `grok-3` on.
 */
const SEARCH_MODEL_PATTERNS: Readonly<Record<SearchFamily, RegExp>> = {
  anthropic: /^claude-(3-[5-9]|(opus|sonnet|haiku)-[4-9])/,
  openai: /^(gpt-4o|gpt-4\.1|gpt-5|o[134]|chatgpt-4o)/,
  xai: /^grok-[3-9]/,
}

/**
 * The most searches one request may run, on the providers that take a bound.
 *
 * The tool has no `count` argument of ours to honour any more, so this is what keeps one
 * request from becoming a research session: Anthropic's `maxUses` is per conversation-turn and
 * defaults to unlimited. Ten is past what an answer needs and well inside what one request
 * should cost (Anthropic bills $10 per 1,000 searches on top of tokens).
 */
export const MAX_SEARCHES_PER_REQUEST = 10

/** The provider tool {@link nativeSearchFor} answers with, and what it is offered as. */
export interface NativeSearchTool {
  /** The family whose client can read this tool's calls back. */
  readonly family: SearchFamily
  /** The name the model calls it by: {@link WEB_SEARCH_TOOL_NAME}, always. */
  readonly name: typeof WEB_SEARCH_TOOL_NAME
  /** The tools to attach to the request, keyed by that name. */
  readonly tools: ToolSet
}

/**
 * The family a `provider/model` id and credential belong to, or `null` for one that has no
 * native search tool this build offers.
 *
 * The credential's type decides where a **named** credential's id is concerned — its model ids
 * carry the credential's *name*, not a provider id (epic #245, A3a), exactly as
 * `createProviderModelFactory` reads it — and only Vertex serves a searchable family that way.
 * Everything the other types serve either has no native tool or is Google, which is out of the
 * table.
 *
 * @param modelId the model the request runs, `provider/model`
 * @param credentialType the type of the credential it is made with, when the caller knows it
 */
export function searchFamilyOf(
  modelId: string,
  credentialType?: ProviderCredentialType,
): SearchFamily | null {
  const provider = providerOf(modelId)
  const model = modelId.slice(provider.length + 1)
  if (credentialType !== undefined && credentialType !== 'api_key') {
    // A Vertex id names a model, not a provider: only its Claude family has a search tool, and
    // only the basic version (`webSearch_20250305` — see `SEARCH_MODEL_PATTERNS`). A Bedrock,
    // Azure or custom endpoint id has none whatever it is called.
    return credentialType === 'vertex' && SEARCH_MODEL_PATTERNS.anthropic.test(model)
      ? 'anthropic'
      : null
  }
  if (!isSearchFamily(provider) || !SEARCH_MODEL_PATTERNS[provider].test(model)) {
    return null
  }
  return provider
}

/**
 * Whether a model id can search a **named** credential's model: the one case a caller without
 * the credential's type can still answer.
 *
 * `searchFamilyOf` reads the credential's type before the model id, because a named credential's
 * id carries its name. A read that has only the model id — the settings route, which is asked
 * about a chat's model rather than about one request (`./resources/tool-settings`) — cannot know
 * the type, so it takes the one case where the model's own name decides: a Claude model.
 */
function namedClaudeSearches(model: string): boolean {
  return SEARCH_MODEL_PATTERNS.anthropic.test(model)
}

/** Whether `value` is one of {@link SEARCH_FAMILIES}. */
function isSearchFamily(value: string): value is SearchFamily {
  return Object.hasOwn(SEARCH_MODEL_PATTERNS, value)
}

/**
 * The native search tool a request is offered, or `null` when its model has none (epic #303,
 * X14; issue #335).
 *
 * The tool is built from the provider package's own factory and carries no credential: what
 * authenticates the search is the model the request runs on, which `./model` built with this
 * request's key already. There is nothing of the user's to pass and nothing of the operator's
 * to hide, which is the whole point of the change.
 *
 * @param modelId the model the request runs, `provider/model`
 * @param credentialType the type of the credential it is made with
 */
export function nativeSearchFor(
  modelId: string,
  credentialType: ProviderCredentialType,
): NativeSearchTool | null {
  const family = searchFamilyOf(modelId, credentialType)
  if (family === null) {
    return null
  }
  return { family, name: WEB_SEARCH_TOOL_NAME, tools: searchToolsFor(family, credentialType) }
}

/**
 * Whether a failure is a provider refusing the native search tool it was handed (epic #303,
 * X14; issue #335).
 *
 * A narrow reading on purpose, because the answer costs a retry: the request must have failed
 * with a **4xx** — a provider that does not know a tool says so as a bad request, never as a
 * server error — and its message must name the tool. Everything else goes down the ordinary
 * paths (`./errors`): retrying a request a 500 refused, or one an unknown model was refused for,
 * with the same request minus its search would be guessing.
 *
 * @param error what the request failed with, in whatever shape it arrived
 */
export function searchWasRejected(error: unknown): boolean {
  const record = asRecord(error)
  const status = asCount(record?.statusCode)
  if (status === undefined || status < 400 || status >= 500) {
    return false
  }
  const message = record?.message
  return typeof message === 'string' && /web[ _]?search/i.test(message)
}

/** A value as a record, or `null` for anything that is not one. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** A value as a count, or `undefined` when it carries no number. */
function asCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Whether a request should be offered the native search tool (epic #303, X14; issue #335).
 *
 * Two things decide it, and both have to say yes:
 *
 * - **the model** — {@link nativeSearchFor} answers that, and a model whose provider has no
 *   search tool is offered none;
 * - **the settings in force** — a `web_search` the user turned off is not attached, and neither
 *   is one a **mode** turned off (the resolver has already applied the override), which is what
 *   keeps "offered" and the `/v1/me/tools` listing the same fact.
 *
 * A `deny` policy is the third case and it is the subtle one: an ordinary tool with `deny` is
 * still *offered*, because the model may call it and be told no. A provider-executed tool
 * cannot be — the provider runs it inside the request, so there is no moment at which this build
 * could refuse a call — so `deny` means "do not attach it", which is the only meaning left that
 * keeps the user's decision. An `ask` policy is refused at the settings route (#335) and, for a
 * stored one written before that, read as `allow` here: the alternative is a switch that says
 * "ask me" and can never ask.
 */
export function webSearchOffered(
  modelId: string,
  credentialType: ProviderCredentialType,
  settings?: ToolSettings,
): boolean {
  const decision = settings?.[WEB_SEARCH_TOOL_NAME]
  if (decision !== undefined && (!decision.enabled || decision.permission === 'deny')) {
    return false
  }
  return searchFamilyOf(modelId, credentialType) !== null
}

/**
 * Whether a chat running `modelId` could search, when the caller knows the model id and nothing
 * else — the settings listing's question.
 *
 * The same answer as `nativeSearchFor` for the three fixed providers, plus the one named-credential
 * case a model id alone decides (a Claude model, which is what a Vertex credential's ids look
 * like). `false` everything else, including a model id whose provider half is a credential name
 * this read cannot resolve — a custom endpoint, an Azure deployment.
 */
export function modelSearches(modelId: string): boolean {
  const provider = providerOf(modelId)
  const model = modelId.slice(provider.length + 1)
  if (isSearchFamily(provider)) {
    return SEARCH_MODEL_PATTERNS[provider].test(model)
  }
  return namedClaudeSearches(model)
}

/**
 * The provider tool one family's request is offered, as the `ToolSet` `streamText` takes.
 *
 * Keyed by {@link WEB_SEARCH_TOOL_NAME}, which is the name every one of these clients answers a
 * call with — so the log records the same `web_search` the settings are keyed by, and a reader
 * never has to know which provider produced the call to read it.
 */
function searchToolsFor(family: SearchFamily, credentialType: ProviderCredentialType): ToolSet {
  switch (family) {
    case 'anthropic':
      // Vertex serves Claude through Google's API, which accepts the basic tool and not the
      // later revisions; the direct API gets the newest, whose dynamic filtering keeps a search
      // from pulling in more of the page than the answer needs.
      return nativeToolSet(
        credentialType === 'vertex'
          ? anthropic.tools.webSearch_20250305({ maxUses: MAX_SEARCHES_PER_REQUEST })
          : anthropic.tools.webSearch_20260318({ maxUses: MAX_SEARCHES_PER_REQUEST }),
      )
    case 'openai':
      // `medium` is OpenAI's own middle setting: enough context to answer from, not a page of
      // excerpts per result.
      return nativeToolSet(openai.tools.webSearch({ searchContextSize: 'medium' }))
    case 'xai':
      // `xSearch` is deliberately not offered: it searches X's own posts rather than the web,
      // which is a different tool with a different answer, and offering both under one name no
      // model could tell apart would be worse than offering the one everybody means by
      // "search".
      return nativeToolSet(xai.tools.webSearch())
  }
}

/**
 * One provider tool, as the `ToolSet` a request is built with takes it.
 *
 * The cast is version skew and nothing else: `ai`'s `ToolSet` is expressed in the
 * `@ai-sdk/provider-utils` copy `ai` resolves, and a provider package may resolve a different
 * one — the installed tree carries both — so a tool the provider package built is not
 * *structurally* assignable to the option here even though it is exactly what the option takes
 * (`streamText` passes it straight to the provider's own client). Naming it once is what keeps
 * the mismatch from spreading into the loop's own types.
 */
function nativeToolSet(tool: unknown): ToolSet {
  return { [WEB_SEARCH_TOOL_NAME]: tool } as ToolSet
}
