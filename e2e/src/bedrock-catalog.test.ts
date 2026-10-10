import { describe, expect, it } from 'vitest'

import {
  e2eHarness,
  personFor,
  seedBedrockCredential,
  startProviderStub,
  type ProviderStub,
} from './harness'

/**
 * Bedrock inference profiles in the catalogue, through a real server process (issue #274).
 *
 * Bedrock is the one credential type whose catalogue is two control-plane reads (`ListFoundationModels`
 * for the region's on-demand models, `ListInferenceProfiles` for the cross-region profiles), and
 * neither is reachable in CI — there is no AWS account, and the repository holds no key. The
 * harness's provider stub is the seam that makes the path real anyway: the server under test
 * reaches `bedrock.us-east-1.amazonaws.com` through the documented egress proxy (the stub's
 * fixture certificate carries that host as a SAN), so the two signed reads, the join and the
 * degrade path all run for real while the internet is a loopback handler the test wrote.
 *
 * The fixtures are written to AWS's documented shapes (see `apps/server/src/catalog/bedrock-profiles.test.ts`
 * for where the `ListInferenceProfiles` shape comes from). What is proven here is the wiring;
 * that AWS itself answers the real endpoint the way this stub does is not.
 */

const harness = e2eHarness('bedrock-catalog')

/** The region the stub's fixture certificate covers, and the credential is stored for. */
const REGION = 'us-east-1' as const
const HOST = `bedrock.${REGION}.amazonaws.com`

/** One on-demand text model AWS answers for the region. */
const ON_DEMAND_MODEL = 'anthropic.claude-3-5-haiku-20241022-v1:0'

const FOUNDATION_MODELS = {
  modelSummaries: [
    {
      modelId: ON_DEMAND_MODEL,
      modelName: 'Claude 3.5 Haiku',
      outputModalities: ['TEXT'],
      inferenceTypesSupported: ['ON_DEMAND'],
      modelLifecycle: { status: 'ACTIVE' },
    },
    {
      // Callable only through a profile: the on-demand list does not offer it.
      modelId: 'anthropic.claude-opus-4-7',
      modelName: 'Claude Opus 4.7',
      outputModalities: ['TEXT'],
      inferenceTypesSupported: ['INFERENCE_PROFILE'],
    },
  ],
}

const INFERENCE_PROFILES = {
  inferenceProfileSummaries: [
    {
      inferenceProfileId: 'us.anthropic.claude-opus-4-7',
      inferenceProfileArn:
        'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-7',
      inferenceProfileName: 'US Anthropic Claude Opus 4.7',
      models: [
        { modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-4-7' },
      ],
      status: 'ACTIVE',
      type: 'SYSTEM_DEFINED',
    },
  ],
}

/** Store a Bedrock credential for a person, the way the `PUT` route stores one. */
async function seedBedrock(userId: string): Promise<void> {
  await seedBedrockCredential(await harness.database(), {
    userId,
    name: 'bedrock',
    region: REGION,
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  })
}

/** Answer the region's two control-plane reads from the fixtures, or refuse the profile read. */
function answerControlPlane(
  stub: ProviderStub,
  profiles: { status?: number; json?: unknown },
): void {
  stub.answer(HOST, (request) =>
    request.path.startsWith('/inference-profiles')
      ? { status: profiles.status, json: profiles.json ?? INFERENCE_PROFILES }
      : { json: FOUNDATION_MODELS },
  )
}

describe('the Bedrock catalogue over the wire', () => {
  it('offers the region’s inference profiles beside its on-demand models', async () => {
    const stub = await startProviderStub()
    try {
      answerControlPlane(stub, {})
      const server = await harness.server({ env: stub.env })
      const me = personFor(
        server,
        await harness.user(server, { email: 'bedrock-profiles@e2e.test', password: 'pw-274' }),
      )
      await seedBedrock(me.signedIn.user.id)

      const catalog = await me.client.models.list()
      expect(catalog.data.map((entry) => entry.id)).toEqual([
        `bedrock/${ON_DEMAND_MODEL}`,
        'bedrock/us.anthropic.claude-opus-4-7',
      ])
      expect(catalog.data[1]).toMatchObject({
        provider: 'bedrock',
        name: 'Claude Opus 4.7 (US)',
        source: 'provider',
      })
      expect(catalog.providers[0]).toMatchObject({ provider: 'bedrock', status: 'ok' })

      // Both reads reached the region's control plane through the proxy, and neither key
      // leaked into the response.
      const paths = stub.requests
        .filter((request) => request.host === HOST)
        .map((request) => request.path.split('?')[0])
      expect(paths).toEqual(['/foundation-models', '/inference-profiles'])
      expect(JSON.stringify(catalog)).not.toContain('EXAMPLEKEY')
    } finally {
      await stub.stop()
    }
  })

  it('keeps the on-demand models when ListInferenceProfiles is refused', async () => {
    const stub = await startProviderStub()
    try {
      // What a key without `bedrock:ListInferenceProfiles` gets: a 403, and no profiles.
      answerControlPlane(stub, {
        status: 403,
        json: { message: 'User is not authorized to perform: bedrock:ListInferenceProfiles' },
      })
      const server = await harness.server({ env: stub.env })
      const me = personFor(
        server,
        await harness.user(server, { email: 'bedrock-degrade@e2e.test', password: 'pw-274' }),
      )
      await seedBedrock(me.signedIn.user.id)

      const catalog = await me.client.models.list()
      // The on-demand model survives, the credential is still `ok` — not turned into the
      // registry fallback — and the profile is simply absent.
      expect(catalog.data.map((entry) => entry.id)).toEqual([`bedrock/${ON_DEMAND_MODEL}`])
      expect(catalog.providers[0]).toMatchObject({
        provider: 'bedrock',
        status: 'ok',
        message: null,
      })
      // Both reads were attempted, so the degrade is the profile read's alone.
      expect(stub.requests.filter((request) => request.host === HOST)).toHaveLength(2)
    } finally {
      await stub.stop()
    }
  })
})
