import { z } from 'zod'

/**
 * Message content blocks.
 *
 * v1 carries text and nothing else. Anthropic's user messages also accept image, document
 * and file blocks, and its agent messages can contain a `redacted` placeholder; both are out
 * of scope here, so {@link ContentBlockSchema} rejects them (see `AGENTS.md`).
 */

/** A block of plain text. Matches Anthropic's `text` block, including its non-empty rule. */
export const TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string().min(1),
})

export type TextBlock = z.infer<typeof TextBlockSchema>

/**
 * One content block of a message.
 *
 * A discriminated union with a single member in v1 — new block types are added here, and
 * every schema built on it picks them up.
 */
export const ContentBlockSchema = z.discriminatedUnion('type', [TextBlockSchema])

export type ContentBlock = z.infer<typeof ContentBlockSchema>

/**
 * The `content` array of a `user.message` or `agent.message` event.
 *
 * Not bounded below: a model can legitimately answer with no text at all, and an empty
 * `content` is how that is represented.
 */
export const ContentBlocksSchema = z.array(ContentBlockSchema)

export type ContentBlocks = z.infer<typeof ContentBlocksSchema>

/**
 * // extension: one web source a reply is built on (epic #303, X14; issue #335).
 *
 * Every provider that can search the web normalizes what it found its own way — Anthropic sends
 * a `web_search_result_location` citation on a text block, OpenAI a `url_citation` annotation,
 * Gemini a `groundingMetadata` chunk — and each spelling carries different extras (an encrypted
 * index, a character range, a page age). What a reader is owed is the same three things from all
 * of them: where it came from, what it was called, and the sentence the reply leans on.
 *
 * So this is the one `sources` list a client renders. It is a **readable** record and nothing
 * else: it is never sent back to a provider (the provider's own unreadable form — an encrypted
 * index, an encrypted result body — is replayed from
 * `agent.opaque_content` instead), and it carries no cost of its own.
 */
export const SourceSchema = z.object({
  /** The page's URL, absolute, as the provider gave it. */
  url: z.string().min(1),
  /** The page's title, when the provider gave one. */
  title: z.string().optional(),
  /**
   * The passage of the reply this source supports, when the provider said which — the cited
   * text of an Anthropic citation, or nothing for a provider that cites the whole message.
   */
  cited_text: z.string().optional(),
})

export type Source = z.infer<typeof SourceSchema>

/** The `sources` a reply cites, in the order the provider gave them. */
export const SourcesSchema = z.array(SourceSchema)

export type Sources = z.infer<typeof SourcesSchema>
