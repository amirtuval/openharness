import { AwsClient } from 'aws4fetch'

import type { BedrockModelCredential } from './model'

/**
 * Amazon Bedrock's endpoints, and how one request to them is signed (epic #245, A3c).
 *
 * Bedrock is the one provider here whose address is not a single host: a request goes to
 * `https://bedrock-runtime.<region>.amazonaws.com` and the control plane — the
 * `ListFoundationModels` call a save is validated with — to
 * `https://bedrock.<region>.amazonaws.com`. Both are **AWS's own hosts, derived from the
 * region**, which is why this type needs neither `safeFetch` nor a user-supplied URL: there is
 * no address a user typed for a guard to check. What a user does type is the region, and the
 * protocol validates it against its list before a credential can be stored (`BEDROCK_REGIONS`),
 * so a string that is not a real region never reaches this module.
 *
 * The two halves of signing live in two places, deliberately:
 *
 * - **The model path** is signed by `@ai-sdk/amazon-bedrock` itself, which is what
 *   {@link createProviderModelFactory} hands the region and the keys to. The provider package
 *   is given every setting explicitly — region, keys, session token, base URL — so nothing it
 *   needs is read from the environment (`AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_ENDPOINT_URL_*`
 *   in particular), which is the A5 rule this package follows for every provider.
 * - **The control-plane path** is the server's save-time check and its catalogue read, and it
 *   is signed here, by {@link signBedrockRequest}, because this package is where "how a Bedrock
 *   request is authenticated" lives. The AI SDK provider has no control-plane surface at all, so the
 *   server cannot borrow its signer; `aws4fetch` is the same signer the provider uses
 *   internally, so the two paths sign identically.
 *
 * The region is spliced into a hostname by {@link bedrockRuntimeBaseUrl} and
 * {@link bedrockControlPlaneUrl}, which are the only two places a Bedrock URL is built.
 */

/**
 * The SigV4 service name **every** Bedrock request is signed for — the runtime host included.
 *
 * AWS charges a request to `bedrock-runtime.<region>.amazonaws.com` against the `bedrock`
 * service in its signature scope, which is why there is one constant here and not one per host:
 * `@ai-sdk/amazon-bedrock` signs with the same string, so a model call and the control-plane
 * read a save is checked with differ in their host, not in their credential scope.
 */
export const BEDROCK_SERVICE = 'bedrock'

/** The host prefix of the runtime endpoint: where a model request goes. */
const RUNTIME_HOST_PREFIX = 'bedrock-runtime'

/**
 * The control-plane read the server makes twice — once to validate a credential on save, once to
 * list a region's models — as the path {@link bedrockControlPlaneUrl} is given.
 *
 * It lives here rather than in either caller because it has to be **one** string: the two reads
 * answer the same question ("which models can these keys use in this region"), and a query one
 * side narrowed without the other would let a credential save against a list the picker does not
 * show. AWS's `byOutputModality` and `byInferenceType` filters are its own, so what comes back
 * is already text-output and on-demand models.
 */
export const BEDROCK_FOUNDATION_MODELS_PATH =
  '/foundation-models?byOutputModality=TEXT&byInferenceType=ON_DEMAND'

/**
 * The other control-plane read the catalogue makes: the region's inference profiles (issue
 * #274).
 *
 * A model whose only access is a cross-region inference profile is not in the on-demand
 * foundation-model list — and in many regions that is where the newest Claude and Nova models
 * are — so `ListInferenceProfiles` is what names them. It is a plain `GET` with no required
 * query (the catalogue adds `maxResults`/`nextToken` for paging), signed for the same `bedrock`
 * service as {@link BEDROCK_FOUNDATION_MODELS_PATH}, against the same control-plane host.
 */
export const BEDROCK_INFERENCE_PROFILES_PATH = '/inference-profiles'

/**
 * The base URL `@ai-sdk/amazon-bedrock` talks to for one region.
 *
 * Passed as the provider's `baseURL` **explicitly** rather than left to its default: the
 * provider resolves its own base URL from `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` (and
 * `AWS_ENDPOINT_URL`) when one is not given, and a deployment with that variable set could
 * move a request — and the keys it is signed with — to a host nobody chose. The value here is
 * the provider's own default, pinned in the one place a region becomes a URL.
 */
export function bedrockRuntimeBaseUrl(region: string): string {
  return `https://${RUNTIME_HOST_PREFIX}.${region}.amazonaws.com`
}

/**
 * The control plane's URL for one region, with the path a read needs.
 *
 * `path` is appended as given (`/foundation-models`), so the two callers that exist — the
 * server's save-time check, and the catalogue's list — build one URL each from a constant.
 */
export function bedrockControlPlaneUrl(region: string, path = ''): string {
  return `https://${BEDROCK_SERVICE}.${region}.amazonaws.com${path}`
}

/** One SigV4-signed request, ready to be sent by whoever asked for it. */
export interface SignedBedrockRequest {
  /** The URL to call — the one that was passed in, normalized by the signer. */
  readonly url: string
  /** The method to use; `GET` unless the caller said otherwise. */
  readonly method: string
  /** Every header the request needs, the `Authorization` signature among them. */
  readonly headers: Record<string, string>
}

/** What {@link signBedrockRequest} takes beyond the credential. */
export interface BedrockRequestInput {
  /** The HTTP method; `GET` for the control-plane read a save makes. */
  readonly method?: string
  /** Headers to sign along with the request, if any. */
  readonly headers?: Record<string, string>
}

/**
 * Sign one request with a Bedrock credential, without sending it (epic #245, A3c).
 *
 * The server's save-time check and its catalogue read are the two callers: the control plane
 * has no AI SDK surface to borrow, so they sign the read themselves — through this function,
 * which is the one place that knows how a Bedrock request is authenticated. The model path
 * does not come here: `@ai-sdk/amazon-bedrock` signs its own requests, with the same
 * `aws4fetch` signer this uses, so a model call and a control-plane read carry the same shape
 * of signature.
 *
 * The credential is an argument and nothing else: nothing in this module reads
 * `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE` or a shared
 * credentials file, and the decoy test in `bedrock-model.test.ts` proves a signed request
 * carries none of them. Signing is pure — it returns the request rather than sending it — which
 * is what lets the server put the call through its own egress-proxy-aware provider client, and
 * lets the test read exactly what was signed.
 */
export async function signBedrockRequest(
  credential: BedrockModelCredential,
  url: string,
  input: BedrockRequestInput = {},
): Promise<SignedBedrockRequest> {
  const signer = new AwsClient({
    accessKeyId: credential.accessKeyId,
    secretAccessKey: credential.secretAccessKey,
    // An explicit `undefined` is what tells aws4fetch there is no session token, exactly as an
    // absent one does; passing it through keeps the two spellings from differing here.
    sessionToken: credential.sessionToken,
    service: BEDROCK_SERVICE,
    region: credential.region,
  })
  const signed = await signer.sign(url, {
    method: input.method ?? 'GET',
    headers: input.headers,
  })
  return {
    url: signed.url.toString(),
    method: signed.method,
    headers: Object.fromEntries(signed.headers.entries()),
  }
}
