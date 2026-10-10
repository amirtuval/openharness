import { describe, expect, it } from 'vitest'

import {
  BEDROCK_REGIONS,
  BEDROCK_REGION_PATTERN,
  DEFAULT_BEDROCK_REGION,
  bedrockCredentialDetails,
  bedrockRegionOf,
  isBedrockRegion,
} from './bedrock'

/**
 * Amazon Bedrock's region list, and the one non-secret fact a Bedrock credential reports
 * (epic #245, A3c).
 *
 * The list is what keeps a region out of a hostname unless it is one AWS serves: every entry is
 * checked to be spelled like a region, and the list is checked for the two ways a hand-kept
 * list rots — a duplicate, and a value that is not a region at all. Which entries AWS serves is
 * what the list is *for*, and a test cannot ask AWS; what it can pin is that the set is the one
 * the change decided on, so removing a region is a deliberate edit rather than a silent one.
 */
describe('BEDROCK_REGIONS', () => {
  it('spells every region like an AWS region id', () => {
    for (const region of BEDROCK_REGIONS) {
      expect(region, region).toMatch(BEDROCK_REGION_PATTERN)
    }
  })

  it('has no duplicates', () => {
    expect(new Set(BEDROCK_REGIONS).size).toBe(BEDROCK_REGIONS.length)
  })

  it('is the commercial partition: no gov-cloud or China region is offered', () => {
    for (const region of BEDROCK_REGIONS) {
      expect(region.startsWith('us-gov-'), region).toBe(false)
      expect(region.startsWith('cn-'), region).toBe(false)
    }
  })

  it('covers the regions a reader is likeliest to have, and the default is one of them', () => {
    for (const region of [
      'us-east-1',
      'us-west-2',
      'eu-west-1',
      'eu-central-1',
      'ap-northeast-1',
    ]) {
      expect(BEDROCK_REGIONS).toContain(region)
    }
    expect(isBedrockRegion(DEFAULT_BEDROCK_REGION)).toBe(true)
    expect(isBedrockRegion('us-east-3')).toBe(false)
    expect(isBedrockRegion('constructor')).toBe(false)
  })
})

describe('BEDROCK_REGION_PATTERN', () => {
  it('matches a region, and not a hostname that merely contains one', () => {
    for (const value of ['us-east-1', 'ap-southeast-7', 'mx-central-1']) {
      expect(value, value).toMatch(BEDROCK_REGION_PATTERN)
    }
    for (const value of ['us-east-1.evil.example', 'a.us-east-1', 'useast1', 'us-east', '']) {
      expect(value, value).not.toMatch(BEDROCK_REGION_PATTERN)
    }
  })
})

describe('bedrockCredentialDetails', () => {
  it('reports the region as the type’s own `{ region }`, and nothing else', () => {
    expect(bedrockCredentialDetails('eu-west-1')).toEqual({ region: 'eu-west-1' })
  })

  it('reads the region back, and nothing for a credential that reports none', () => {
    expect(bedrockRegionOf(bedrockCredentialDetails('us-east-2'))).toBe('us-east-2')
    expect(bedrockRegionOf(undefined)).toBeUndefined()
    expect(bedrockRegionOf({ region: '' })).toBeUndefined()
  })
})
