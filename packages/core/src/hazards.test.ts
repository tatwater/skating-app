import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GONE_THRESHOLD,
  type HazardFreshness,
  hazardFreshness,
  isHazardVisibleByDefault,
  shouldArchiveHazard,
} from './hazards'

const HOUR = 3_600_000
const NOW = 1_700_000_000_000

describe('hazardFreshness (D15)', () => {
  it('classifies by elapsed hours', () => {
    expect(hazardFreshness(NOW, NOW)).toBe('fresh')
    expect(hazardFreshness(NOW - 23 * HOUR, NOW)).toBe('fresh')
    expect(hazardFreshness(NOW - 24 * HOUR, NOW)).toBe('aging')
    expect(hazardFreshness(NOW - 72 * HOUR, NOW)).toBe('aging')
    expect(hazardFreshness(NOW - 73 * HOUR, NOW)).toBe('stale')
  })

  it('treats a future confirmation as fresh (clock skew)', () => {
    expect(hazardFreshness(NOW + HOUR, NOW)).toBe('fresh')
  })
})

describe('isHazardVisibleByDefault', () => {
  it('hides only stale hazards', () => {
    expect(isHazardVisibleByDefault('fresh')).toBe(true)
    expect(isHazardVisibleByDefault('aging')).toBe(true)
    expect(isHazardVisibleByDefault('stale')).toBe(false)
  })
})

describe('shouldArchiveHazard', () => {
  it('archives at or above the threshold', () => {
    expect(shouldArchiveHazard(0)).toBe(false)
    expect(shouldArchiveHazard(DEFAULT_GONE_THRESHOLD - 1)).toBe(false)
    expect(shouldArchiveHazard(DEFAULT_GONE_THRESHOLD)).toBe(true)
    expect(shouldArchiveHazard(1, 1)).toBe(true)
  })
})

describe('freshness is monotonic in elapsed time (property)', () => {
  const rank: Record<HazardFreshness, number> = { fresh: 0, aging: 1, stale: 2 }

  it('more elapsed time never yields a fresher state', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 500 }), fc.integer({ min: 0, max: 500 }), (h1, h2) => {
        const [less, more] = h1 <= h2 ? [h1, h2] : [h2, h1]
        const fresher = hazardFreshness(NOW - less * HOUR, NOW)
        const older = hazardFreshness(NOW - more * HOUR, NOW)
        expect(rank[older]).toBeGreaterThanOrEqual(rank[fresher])
      }),
    )
  })
})
