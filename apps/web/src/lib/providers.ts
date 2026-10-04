/**
 * The model providers the *credentials form* offers.
 *
 * Provider names are **Mastra router names** — the first half of a `provider/model` string —
 * and the API takes any string a router provider answers to. The list below is the common
 * ones the epic names as supported today (epic #65, A5: "any provider in Mastra's model
 * router that authenticates with one API key"), offered as a `<select>`; the Settings form
 * takes a free-text id for anything else, so this list is a convenience, not a limit.
 *
 * The model picker (#91) does not read this list: it offers exactly what
 * `client.models.list()` answers — the providers the caller has a key for — so a provider
 * this list has never heard of shows up the moment its key is saved.
 */
export const PROVIDER_IDS = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'groq',
  'fireworks',
  'deepseek',
] as const
