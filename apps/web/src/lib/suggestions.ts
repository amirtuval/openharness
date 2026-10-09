/**
 * The suggested prompts on New chat (epic #201, U10).
 *
 * A chat with nothing in it asks a reader to invent the first move. Four one-click openers
 * answer that without deciding anything for them: each one **fills the composer** and stops
 * there — nothing is sent, nothing is created, and the text is editable before it goes.
 *
 * They are deliberately about *kinds of work* rather than about this app's internals: the
 * catalog is whatever the reader's own keys list, so a prompt that named a model, a provider
 * or a file would be wrong for most accounts. A caller that wants fewer of them takes a slice;
 * the order is the order of usefulness for a first visit, so the first one is the one shown if
 * only one fits.
 */
export const SUGGESTED_PROMPTS: readonly string[] = [
  'Explain what this codebase does, and where I should start reading.',
  'Review the last thing I wrote and suggest improvements.',
  'Write a short README for a new TypeScript project.',
  'Summarise this error and tell me how to fix it.',
]
