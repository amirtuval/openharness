import type { BedrockCredentialDetails } from './resources/provider-credential'

/**
 * Amazon Bedrock's regions, and the non-secret facts a Bedrock credential reports (epic #245,
 * A3c).
 *
 * A Bedrock request is addressed by **region**: `https://bedrock-runtime.<region>.amazonaws.com`
 * for a model call and `https://bedrock.<region>.amazonaws.com` for the control plane — AWS's
 * own hosts, derived from the region, never a URL a user typed. That is why this type has no
 * endpoint field and no `safeFetch`: there is no user-supplied address for an SSRF guard to
 * check. What a user *does* type is the region, and it goes straight into a hostname — so it is
 * validated against the list below rather than accepted as a string. An arbitrary region would
 * not resolve to an AWS host at all, and a hostile one (`evil.example`) would turn a stored
 * credential into a request to somewhere nobody chose.
 *
 * The list is every region where AWS serves the Bedrock control plane: each of these answers
 * `bedrock.<region>.amazonaws.com` with the service's own `Authorization header is missing`
 * refusal, which is what a region that has no Bedrock endpoint there does not do. AWS's
 * **gov-cloud** and China regions are deliberately out of v1: their endpoints are a different
 * partition, and `aws4fetch` (the AWS SDK's signer here) derives the signing partition from the
 * region's shape, so `us-gov-west-1` would be signed as a commercial request — a wrong
 * signature rather than a working one. Adding a partition is a change to this list and to the
 * signer's partition rule, which is a deliberate, separate step.
 *
 * // extension: Anthropic has no notion of a credential's region — it holds its users' keys.
 * The list is openharness's, like the provider list beside it.
 */

/**
 * How a region is spelled: an AWS region id, e.g. `us-east-1`.
 *
 * The shape is checked as well as the membership, so a value that reached the schema by hand
 * cannot be one only a human can tell from a region.
 */
export const BEDROCK_REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d+$/

/**
 * The regions a Bedrock credential may name, in AWS's own order: US, then the Americas, then
 * Europe, then Asia Pacific, then the rest.
 *
 * Every entry is a region AWS serves the Bedrock control plane in — the list is checked as a
 * whole by `bedrock.test.ts`, which asserts each one parses against
 * {@link BEDROCK_REGION_PATTERN} and that the list has no duplicate.
 */
export const BEDROCK_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'ca-central-1',
  'ca-west-1',
  'sa-east-1',
  'eu-central-1',
  'eu-central-2',
  'eu-north-1',
  'eu-south-1',
  'eu-south-2',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'ap-east-2',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
  'ap-south-1',
  'ap-south-2',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-southeast-3',
  'ap-southeast-4',
  'ap-southeast-5',
  'ap-southeast-6',
  'ap-southeast-7',
  'af-south-1',
  'il-central-1',
  'mx-central-1',
] as const

/** A region {@link BEDROCK_REGIONS} carries. */
export type BedrockRegion = (typeof BEDROCK_REGIONS)[number]

/**
 * The region a Bedrock credential takes when the user picks none: the oldest and the one AWS
 * documents every model in. A form preselects it; the schema still requires a region.
 */
export const DEFAULT_BEDROCK_REGION: BedrockRegion = 'us-east-1'

/** Whether `value` is a region a Bedrock credential may name. */
export function isBedrockRegion(value: string): value is BedrockRegion {
  return (BEDROCK_REGIONS as readonly string[]).includes(value)
}

/**
 * The `details` a Bedrock credential reports — its region, and nothing else — as the credential
 * type's own variant of {@link ProviderCredentialDetails} (`{ region }`, #245 A3c). The one
 * field of a stored Bedrock credential that is neither a secret nor its `last4`, and what a
 * settings list shows so two Bedrock rows are told apart.
 */
export function bedrockCredentialDetails(region: BedrockRegion): BedrockCredentialDetails {
  return { region }
}

/** The region a stored Bedrock credential reports, or `undefined` for one that reports none. */
export function bedrockRegionOf(details: BedrockCredentialDetails | undefined): string | undefined {
  const region = details?.region
  return region === undefined || region === '' ? undefined : region
}
