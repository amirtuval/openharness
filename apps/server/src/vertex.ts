/**
 * The two Google-side facts a Vertex credential's save-time check needs (epic #245, A3d): an
 * OAuth token for its service account, and the URL that proves the account can reach the
 * project and location it was saved with.
 *
 * Both live here rather than inside `provider-validation.ts` because both are Google's rules
 * and neither is a policy of this server's: the check is one request built out of them, and a
 * second caller with the same need — a catalogue that listed a project's publisher models —
 * would otherwise restate them.
 *
 * **The token is signed with the stored key and nothing else.** `GoogleAuth` is constructed
 * with the parsed document as its `credentials`, which is the one path through
 * `google-auth-library` that never consults Application Default Credentials: no
 * `GOOGLE_APPLICATION_CREDENTIALS`, no well-known file, no gcloud config, no metadata server.
 * This is the same guarantee the brain's model path makes, made in the place the *save* is
 * checked — and it matters for the same reason, since this server runs on GCP.
 */

import { GoogleAuth } from 'google-auth-library'

/** The scope a Vertex request authenticates with. */
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'

/**
 * How a service-account document becomes a bearer token; injectable, so no test reaches
 * Google's token endpoint.
 */
export type VertexTokenProvider = (serviceAccount: string) => Promise<string>

/**
 * The production token provider: sign a JWT with the stored key, exchange it for an access
 * token.
 *
 * A rejected key surfaces Google's own reason — `invalid_grant: Invalid JWT Signature`,
 * `invalid_grant: Invalid grant: account not found`, an expired or revoked key — which the
 * caller turns into the 422 a failed save gets. Nothing of the document is echoed: the
 * library's message names the failure, never the key.
 *
 * The client is built per call, deliberately: a token belongs to the credential that asked for
 * it, and caching one across saves would mean a credential's second validation could be
 * answered by the first credential's token.
 */
export function createVertexTokenProvider(): VertexTokenProvider {
  return async (serviceAccount) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(serviceAccount)
    } catch (error) {
      throw new Error('the stored service account is not JSON; save the credential again', {
        cause: error,
      })
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        'the stored service account is not a key document Google Cloud issued; save the ' +
          'credential again',
      )
    }
    const auth = new GoogleAuth({
      scopes: [CLOUD_PLATFORM_SCOPE],
      credentials: parsed as Record<string, unknown>,
    })
    const token = await auth.getClient().then((client) => client.getAccessToken())
    if (token.token === null || token.token === undefined || token.token === '') {
      // A token client that answers nothing is a failure, not a credential that "worked".
      throw new Error('Google did not issue an access token for this service account')
    }
    return token.token
  }
}

/** The provider the server runs unless a host injects one. */
export const vertexTokenProvider: VertexTokenProvider = createVertexTokenProvider()

/**
 * Where a project's and location's **publisher models** are listed.
 *
 * This is the call the save-time check makes: it is the cheapest authenticated Vertex read
 * there is, it proves the service account can reach *this* project in *this* location, and it
 * fails with Google's own words when the Vertex AI API is not enabled for the project — the
 * one misconfiguration a key that is otherwise perfectly good will hit.
 *
 * The host is Google's, derived from the location exactly as the AI SDK derives it: the
 * `global` location is served from the apex host, and every other location from
 * `<location>-aiplatform.googleapis.com`. A user never types a host — the protocol validates
 * the location against Google's published list, and this is what turns it into an endpoint.
 */
export function vertexPublisherModelsUrl(input: {
  readonly project: string
  readonly location: string
}): string {
  const host =
    input.location === 'global'
      ? 'aiplatform.googleapis.com'
      : `${input.location}-aiplatform.googleapis.com`
  const path = `v1/projects/${encodeURIComponent(input.project)}/locations/${encodeURIComponent(
    input.location,
  )}/publishers/google/models`
  // One model is enough: the answer's *existence* is the proof, and asking for a page keeps
  // the response to a few hundred bytes.
  return `https://${host}/${path}?pageSize=1`
}
