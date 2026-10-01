/**
 * The model providers the pickers offer.
 *
 * Provider names are **Mastra router names** — the first half of a `provider/model` string —
 * and the API takes any string a router provider answers to. The list below is the common
 * ones the epic names as supported today (epic #65, A5: "any provider in Mastra's model
 * router that authenticates with one API key"), offered as a `<select>`; the Settings form
 * takes a free-text id for anything else, so this list is a convenience, not a limit.
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

/**
 * The provider a model id names: the segment before the first `/`.
 *
 * `anthropic/claude-sonnet-5` is the router's spelling, so this is the same string a saved
 * credential is keyed by — which is what lets the picker tell a model that will resolve from
 * one that cannot.
 */
export function providerOfModel(modelId: string): string {
  const [provider = ''] = modelId.split('/')
  return provider.trim()
}
