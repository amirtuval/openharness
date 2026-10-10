import type { ModelConfig, StoredEvent } from '@openharness/protocol'
import { EVENT_TYPES } from '@openharness/protocol'
import type { ModelMessage } from 'ai'

/**
 * Turning the session log into the messages a model request is made with.
 *
 * The brain holds no conversation state: every turn rebuilds its context from the log it is
 * handed, which is what makes crash recovery and a second brain on a partition possible. How
 * that rebuild works — which events become messages, how long the history may get — is the one
 * part of the loop a host may want to change, so it is a strategy rather than a hardcoded
 * conversion.
 */

/**
 * Build the messages for one model request out of the session's log.
 *
 * Called once per model request, after the turn loop has claimed the pending user events, so
 * what it sees is the log as it will be answered — see {@link ContextStrategyOptions}.
 *
 * Implementations must not write: the store is the loop's to append to, and a strategy that
 * published events would put the transcript out of step with the request that produced it.
 */
export type ContextStrategy = (
  events: readonly StoredEvent[],
  options: ContextStrategyOptions,
) => ModelMessage[]

/** What a {@link ContextStrategy} is told about the session it is building a context for. */
export interface ContextStrategyOptions {
  /** The model the session runs, `{ id: 'provider/model' }`. What to budget for. */
  readonly model: ModelConfig
  /** The session's system prompt, or `null` when it has none. */
  readonly system: string | null
}

/** Characters per token in {@link estimateTokens}. Rough, and deliberately so. */
export const CHARS_PER_TOKEN = 4

/**
 * The history budget {@link createContextStrategy} trims to when a model has no budget of its
 * own. Conservative for a chat agent: it leaves room under a modern model's window for the
 * system prompt, the reply and the estimate's own error.
 */
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 32_768

/** How {@link createContextStrategy} budgets, per model and overall. */
export interface ContextStrategyConfig {
  /** Tokens of history every model gets, when `tokenBudgetFor` answers nothing for it. */
  readonly tokenBudget?: number
  /**
   * The budget for one model id, `provider/model`, overriding `tokenBudget`.
   *
   * A function rather than a record because the model space is not a handful of ids: the
   * server's registry holds hundreds (the bundled models.dev snapshot), and a record would
   * have to be built from all of them to answer for the one a request runs. The strategy asks
   * for that one id, and `undefined` means "budget it like every other model".
   */
  readonly tokenBudgetFor?: (modelId: string) => number | undefined
}

/**
 * The default strategy: the conversation so far, oldest first, trimmed to a token budget.
 *
 * `user.message` and `agent.message` become `user` and `assistant` messages in `seq` order —
 * which is the whole conversation the session has had, whatever happened to it in between:
 * `user.interrupt`, status transitions, spans and a `session.rewind` are bookkeeping, not
 * things the model said or was told (a rewind's *range* is not bookkeeping either: the log the
 * brain reads has already left out what it replaced, so the model is handed the conversation
 * as the reader left it, #238). The session's `system` prompt, when it has one, becomes the
 * leading system message.
 *
 * Messages with no text (an empty `content`, which is how a model that answered with nothing
 * is recorded) are left out rather than sent as empty turns.
 *
 * ## Trimming
 *
 * The oldest complete turns are dropped until the history fits the budget, and never the newest
 * turn: a request that dropped the question it is answering would be worse than an
 * over-budget one. A turn is two messages — one user, one assistant — so the cut lands on a
 * boundary a chat model can read, and a history that would start with an assistant message
 * loses that message too.
 *
 * @param config the per-model budgets; see {@link DEFAULT_CONTEXT_TOKEN_BUDGET}
 */
export function createContextStrategy(config: ContextStrategyConfig = {}): ContextStrategy {
  const defaultBudget = config.tokenBudget ?? DEFAULT_CONTEXT_TOKEN_BUDGET
  const budgetFor = config.tokenBudgetFor
  return (events, options) => {
    // Per request, from the model that request runs: the loop re-reads the session at every
    // request boundary, so a switch applies to the next request's budget as well as its model.
    const budget = budgetFor?.(options.model.id) ?? defaultBudget
    return trimToBudget(messagesFromEvents(events, options.system), budget)
  }
}

/**
 * The strategy every turn gets when it is not given one: the default, with the default budget.
 */
export const DEFAULT_CONTEXT_STRATEGY: ContextStrategy = createContextStrategy()

/**
 * Estimate the tokens a string costs, at {@link CHARS_PER_TOKEN} characters per token.
 *
 * A real tokenizer would be exact and would add a dependency, a model lookup and a hook that
 * changes when the model does. The budget this feeds is about not sending an unbounded history,
 * not about filling a context window to the byte, so the cheap estimate is the right one.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** The conversation the log holds, as model messages. */
function messagesFromEvents(events: readonly StoredEvent[], system: string | null): ModelMessage[] {
  const messages: ModelMessage[] = []
  if (system !== null && system.length > 0) {
    messages.push({ role: 'system', content: system })
  }
  for (const event of events) {
    if (event.type === EVENT_TYPES.userMessage) {
      const text = textOf(event.content)
      if (text.length > 0) {
        messages.push({ role: 'user', content: text })
      }
    } else if (event.type === EVENT_TYPES.agentMessage) {
      const text = textOf(event.content)
      if (text.length > 0) {
        messages.push({ role: 'assistant', content: text })
      }
    }
  }
  return messages
}

/** A message's blocks joined into the string a model reads. */
function textOf(content: readonly { readonly text: string }[]): string {
  return content.map((block) => block.text).join('')
}

/**
 * Drop the oldest turns until the history fits `budget`, keeping the system message and the
 * newest message always. See {@link createContextStrategy}.
 */
function trimToBudget(messages: readonly ModelMessage[], budget: number): ModelMessage[] {
  const system = messages.filter((message) => message.role === 'system')
  let history = messages.filter((message) => message.role !== 'system')
  const tokensOf = (list: readonly ModelMessage[]): number =>
    list.reduce((total, message) => total + estimateTokens(textOfMessage(message)), 0)
  let total = tokensOf(system) + tokensOf(history)
  while (total > budget && history.length > 2) {
    // Two at a time: a turn is a user message and the assistant reply to it.
    history = history.slice(2)
    total = tokensOf(system) + tokensOf(history)
  }
  if (history[0]?.role === 'assistant') {
    // A history that opens with a reply reads as an answer to nothing; drop it.
    history = history.slice(1)
  }
  return [...system, ...history]
}

/** The text of one message, whatever shape its content has. */
function textOfMessage(message: ModelMessage): string {
  const content = message.content
  if (typeof content === 'string') {
    return content
  }
  let text = ''
  for (const part of content) {
    if (part.type === 'text') {
      text += part.text
    }
  }
  return text
}
