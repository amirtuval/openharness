/**
 * The model suggestions the agent form offers.
 *
 * Suggestions only: the field is free text, because `model.id` is whatever the configured
 * Mastra model router understands (`provider/model`) and v1 has no `/v1/models` endpoint to
 * ask. The list is a `<datalist>`, so any value is still allowed.
 */
export const MODEL_SUGGESTIONS = [
  'anthropic/claude-sonnet-5',
  'anthropic/claude-opus-5-5',
  'anthropic/claude-haiku-4-5',
  'openai/gpt-5.1',
  'google/gemini-3-pro',
] as const
