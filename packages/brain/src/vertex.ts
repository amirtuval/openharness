/**
 * Google Vertex: the two model families one credential serves, and where a request's endpoint
 * comes from (epic #245, A3d).
 *
 * A Vertex credential's models are `<credential name>/<model>` — `vertex/gemini-2.5-pro`,
 * `vertex/claude-sonnet-4-5@20250929` — and the model half decides which of the provider
 * package's two clients builds the request:
 *
 * - `@ai-sdk/google-vertex` for Google's own models, and
 * - `@ai-sdk/google-vertex/anthropic` for the Anthropic models Vertex also serves.
 *
 * Both take the same project, location and service-account credentials, so the rule below is
 * the only place the two are told apart.
 *
 * **The endpoint is never a request's to choose.** Unlike Azure — whose resource endpoint is a
 * URL a user typed, and therefore goes through the SSRF guard — Vertex's host is derived from
 * the stored **location** (`<location>-aiplatform.googleapis.com`), which the protocol
 * validates against Google's published list, and the project and location travel in the path.
 * There is nothing user-typed to guard, which is why a Vertex request carries no `safeFetch`.
 */

/**
 * Whether `id` — the half of a model id after the credential name — names an Anthropic model
 * served from Vertex.
 *
 * Google's own naming is the rule: every Anthropic model on Vertex is a `claude-*` id, the
 * versioned ones included (`claude-sonnet-4-5@20250929`). Nothing in Google's catalogue shares
 * the prefix.
 */
export function isVertexAnthropicModel(id: string): boolean {
  return id.startsWith('claude-')
}

/**
 * Whether `id` is a model **this build** can serve from a Vertex credential.
 *
 * The models.dev `google-vertex` entry carries more than the two families above — the MaaS
 * models Google resells on Vertex (`xai/…`, `meta/…`, `zai-org/…`, bare `codestral-2`) — and
 * the provider package exposes a client for those only through a subpath this package does not
 * build with, so a request for one would go to a publisher endpoint that does not serve it.
 * The catalogue lists what a request can actually run, so this is one half of its filter: a
 * `gemini-*` model goes to the Gemini client and a `claude-*` one to the Anthropic client.
 *
 * What it deliberately does **not** decide is whether the model is a chat model — Gemini's
 * image, speech and embedding models share the `gemini-` prefix, and it is the catalogue's own
 * name filter (`isChatModel`) that keeps them out of a model list, exactly as it does for
 * every other provider.
 */
export function isVertexModelId(id: string): boolean {
  return id.startsWith('gemini-') || isVertexAnthropicModel(id)
}
