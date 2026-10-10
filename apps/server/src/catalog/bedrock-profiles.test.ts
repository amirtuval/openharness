import { describe, expect, it } from 'vitest'

import {
  bedrockFoundationModelId,
  bedrockInferenceProfilePage,
  bedrockProfileDisplayName,
  bedrockProfileScope,
  bedrockUnderlyingModelId,
  type BedrockInferenceProfile,
} from './bedrock-profiles'

/**
 * AWS's `ListInferenceProfiles` shape, on its own (issue #274).
 *
 * The fixtures are written to the shape the AWS Bedrock API reference documents for
 * `ListInferenceProfiles` (`inferenceProfileSummaries[]` with `inferenceProfileId`,
 * `inferenceProfileArn`, `inferenceProfileName`, `models[].modelArn`, `status` and `type`;
 * paged by `nextToken`), which the AWS SDK for JavaScript v3's `@aws-sdk/client-bedrock` types
 * agree with. No AWS account is involved: this file pins the parser, and the real-AWS evidence
 * (that the endpoint path and the SigV4 signing are right) is a separate, recorded check.
 */

/** One summary in AWS's shape, with the fields a test cares about filled in. */
function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inferenceProfileId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    inferenceProfileArn:
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    inferenceProfileName: 'US Anthropic Claude Sonnet 4.5',
    models: [
      {
        modelArn:
          'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
      },
    ],
    status: 'ACTIVE',
    type: 'SYSTEM_DEFINED',
    ...overrides,
  }
}

describe('bedrockInferenceProfilePage', () => {
  it('maps a summary to the profile the catalogue offers, resolving the wrapped model', () => {
    const { profiles, nextToken } = bedrockInferenceProfilePage({
      inferenceProfileSummaries: [summary()],
    })

    expect(nextToken).toBeNull()
    expect(profiles).toEqual([
      {
        profileId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        profileName: 'US Anthropic Claude Sonnet 4.5',
        modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
        type: 'SYSTEM_DEFINED',
      },
    ] satisfies BedrockInferenceProfile[])
  })

  it('reads the next page token, and answers null for an absent or empty one', () => {
    expect(
      bedrockInferenceProfilePage({ inferenceProfileSummaries: [], nextToken: 'eyJwYWdlIjoyfQ==' })
        .nextToken,
    ).toBe('eyJwYWdlIjoyfQ==')
    expect(bedrockInferenceProfilePage({ nextToken: '' }).nextToken).toBeNull()
    expect(bedrockInferenceProfilePage({}).nextToken).toBeNull()
  })

  it('keeps only ACTIVE profiles, and only a status AWS actually contradicts', () => {
    const { profiles } = bedrockInferenceProfilePage({
      inferenceProfileSummaries: [
        summary({ inferenceProfileId: 'active-one' }),
        // Being created, or retired: a request to it would fail.
        summary({ inferenceProfileId: 'creating-one', status: 'CREATING' }),
        // No status at all is not read as "not active": AWS always sets it, and the catalogue
        // never drops a usable model over a field it could not see.
        summary({ inferenceProfileId: 'unstated', status: undefined }),
      ],
    })

    expect(profiles.map((profile) => profile.profileId)).toEqual(['active-one', 'unstated'])
  })

  it('drops a summary it cannot turn into an entry, rather than guessing', () => {
    const { profiles } = bedrockInferenceProfilePage({
      inferenceProfileSummaries: [
        // No id: the id is the whole of the entry's model id.
        summary({ inferenceProfileId: undefined }),
        summary({ inferenceProfileId: '' }),
        // Only an inference-profile ARN: nothing here names the foundation model it wraps, and
        // reading the last path segment would invent one.
        summary({
          inferenceProfileId: 'no-foundation-model',
          models: [
            {
              modelArn:
                'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5',
            },
          ],
        }),
        // An empty or absent `models` array.
        summary({ inferenceProfileId: 'no-models', models: [] }),
        summary({ inferenceProfileId: 'models-absent', models: undefined }),
        // Not an object at all.
        'nonsense',
      ],
    })

    expect(profiles).toEqual([])
  })

  it('keeps a profile whose own id models.dev will never carry — an application profile', () => {
    const { profiles } = bedrockInferenceProfilePage({
      inferenceProfileSummaries: [
        {
          inferenceProfileId: 'my-claude-profile',
          inferenceProfileName: 'My Claude',
          models: [
            {
              modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-4-7',
            },
          ],
          status: 'ACTIVE',
          type: 'APPLICATION',
        },
      ],
    })

    expect(profiles).toEqual([
      {
        profileId: 'my-claude-profile',
        profileName: 'My Claude',
        modelId: 'anthropic.claude-opus-4-7',
        type: 'APPLICATION',
      },
    ])
  })

  it('answers an empty page for a payload that is not the documented shape', () => {
    for (const payload of [null, 'nope', 42, {}, { inferenceProfileSummaries: 'no' }]) {
      expect(bedrockInferenceProfilePage(payload)).toEqual({ profiles: [], nextToken: null })
    }
  })
})

describe('bedrockFoundationModelId', () => {
  it('reads the model id out of a foundation-model ARN', () => {
    expect(
      bedrockFoundationModelId(
        'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
      ),
    ).toBe('anthropic.claude-sonnet-4-5-20250929-v1:0')
  })

  it('answers null when there is no foundation-model marker to read', () => {
    expect(
      bedrockFoundationModelId('arn:aws:bedrock:us-east-1:123:inference-profile/us.anthropic.x'),
    ).toBeNull()
    expect(bedrockFoundationModelId('not-an-arn')).toBeNull()
    expect(bedrockFoundationModelId('arn:aws:bedrock:us-east-1::foundation-model/')).toBeNull()
  })
})

describe('bedrockProfileScope', () => {
  it('reads the geography prefix AWS gives a system-defined profile', () => {
    expect(bedrockProfileScope('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('US')
    expect(bedrockProfileScope('eu.anthropic.claude-fable-5')).toBe('EU')
    expect(bedrockProfileScope('apac.amazon.nova-micro-v1:0')).toBe('APAC')
    expect(bedrockProfileScope('global.openai.gpt-6-astra')).toBe('Global')
    expect(bedrockProfileScope('us-gov.openai.gpt-oss-20b-1:0')).toBe('US Gov')
    expect(bedrockProfileScope('jp.anthropic.claude-opus-5-5')).toBe('JP')
    expect(bedrockProfileScope('au.anthropic.claude-opus-5')).toBe('AU')
    expect(bedrockProfileScope('ca.amazon.nova-lite-v1:0')).toBe('CA')
    expect(bedrockProfileScope('in.anthropic.claude-opus-5')).toBe('IN')
  })

  it('answers null for a vendor-prefixed foundation id and a user-named profile', () => {
    expect(bedrockProfileScope('anthropic.claude-sonnet-5-v1:0')).toBeNull()
    expect(bedrockProfileScope('openai.gpt-oss-safeguard-20b')).toBeNull()
    expect(bedrockProfileScope('my-claude-profile')).toBeNull()
    expect(bedrockProfileScope('.leading-dot')).toBeNull()
  })
})

describe('bedrockUnderlyingModelId', () => {
  it('strips the geography prefix to the model the profile wraps', () => {
    expect(bedrockUnderlyingModelId('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(
      'anthropic.claude-sonnet-4-5-20250929-v1:0',
    )
    expect(bedrockUnderlyingModelId('global.openai.gpt-6-astra')).toBe('openai.gpt-6-astra')
    expect(bedrockUnderlyingModelId('us-gov.openai.gpt-oss-20b-1:0')).toBe('openai.gpt-oss-20b-1:0')
  })

  it('answers undefined for an id that carries no recognised scope', () => {
    expect(bedrockUnderlyingModelId('anthropic.claude-sonnet-5-v1:0')).toBeUndefined()
    expect(bedrockUnderlyingModelId('my-claude-profile')).toBeUndefined()
  })
})

describe('bedrockProfileDisplayName', () => {
  const profile: BedrockInferenceProfile = {
    profileId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    profileName: 'US Anthropic Claude Sonnet 4.5',
    modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
    type: 'SYSTEM_DEFINED',
  }

  it('names a cross-region profile as the wrapped model plus its scope', () => {
    // The point of the suffix: `Claude Sonnet 4.5 (US)` sits beside the on-demand
    // `Claude Sonnet 4.5`, so a reader can tell the two apart and see the geography.
    expect(bedrockProfileDisplayName(profile, 'Claude Sonnet 4.5')).toBe('Claude Sonnet 4.5 (US)')
  })

  it('falls back to the foundation model id when the registry has no name', () => {
    expect(bedrockProfileDisplayName(profile, undefined)).toBe(
      'anthropic.claude-sonnet-4-5-20250929-v1:0 (US)',
    )
  })

  it('reads an application profile as the name its creator gave it', () => {
    const application: BedrockInferenceProfile = {
      profileId: 'my-claude-profile',
      profileName: 'My Claude',
      modelId: 'anthropic.claude-opus-4-7',
      type: 'APPLICATION',
    }
    expect(bedrockProfileDisplayName(application, 'Claude Opus 4.7')).toBe('My Claude')
    // No name of its own: the underlying model's, then the id.
    expect(
      bedrockProfileDisplayName({ ...application, profileName: undefined }, 'Claude Opus 4.7'),
    ).toBe('Claude Opus 4.7')
    expect(bedrockProfileDisplayName({ ...application, profileName: undefined }, undefined)).toBe(
      'anthropic.claude-opus-4-7',
    )
  })
})
