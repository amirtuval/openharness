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
