import { describe, expect, it } from 'vitest'
import {
  type FeedFilters,
  type FilterableReport,
  type FilterContext,
  matchesFilters,
  SNOW_SURFACE_TAGS,
  sanitizeFeedFilters,
} from './feedFilters'

const NOW = 1_700_000_000_000
const HOUR = 60 * 60 * 1000

/** A minimal report at `now`, no optional attributes — the include-unknown baseline. */
function report(overrides: Partial<FilterableReport> = {}): FilterableReport {
  return { skateEndTime: NOW, ...overrides }
}

function ctx(overrides: Partial<FilterContext> = {}): FilterContext {
  return { band: null, isFavorite: false, now: NOW, ...overrides }
}

describe('matchesFilters — permissive default', () => {
  it('matches every report when no filters are set', () => {
    expect(matchesFilters(report(), {}, ctx())).toBe(true)
    expect(matchesFilters(report({ skateQuality: 'poor' }), {}, ctx())).toBe(true)
  })
})

describe('matchesFilters — distance (hard filter)', () => {
  const filters: FeedFilters = { radiusMinutes: 60 }

  it('includes a lake within the radius', () => {
    expect(matchesFilters(report(), filters, ctx({ band: 30 }))).toBe(true)
    expect(matchesFilters(report(), filters, ctx({ band: 60 }))).toBe(true)
  })

  it('excludes a lake beyond the radius', () => {
    expect(matchesFilters(report(), filters, ctx({ band: 90 }))).toBe(false)
  })

  it('excludes an out-of-range (null band) lake', () => {
    expect(matchesFilters(report(), filters, ctx({ band: null }))).toBe(false)
  })

  it('exempts favorites from the distance filter', () => {
    expect(matchesFilters(report(), filters, ctx({ band: null, isFavorite: true }))).toBe(true)
    expect(matchesFilters(report(), filters, ctx({ band: 90, isFavorite: true }))).toBe(true)
  })
})

describe('matchesFilters — recency', () => {
  const filters: FeedFilters = { recencyHours: 48 }

  it('includes a report within the window', () => {
    expect(matchesFilters(report({ skateEndTime: NOW - 24 * HOUR }), filters, ctx())).toBe(true)
  })

  it('excludes a report older than the window', () => {
    expect(matchesFilters(report({ skateEndTime: NOW - 72 * HOUR }), filters, ctx())).toBe(false)
  })

  it('applies to favorites too (recency is not distance)', () => {
    expect(
      matchesFilters(report({ skateEndTime: NOW - 72 * HOUR }), filters, ctx({ isFavorite: true })),
    ).toBe(false)
  })
})

describe('matchesFilters — quality floor (include-unknown)', () => {
  const filters: FeedFilters = { qualityFloor: 'good' }

  it('includes reports meeting or exceeding the floor', () => {
    expect(matchesFilters(report({ skateQuality: 'good' }), filters, ctx())).toBe(true)
    expect(matchesFilters(report({ skateQuality: 'great' }), filters, ctx())).toBe(true)
  })

  it('excludes reports below the floor', () => {
    expect(matchesFilters(report({ skateQuality: 'fair' }), filters, ctx())).toBe(false)
    expect(matchesFilters(report({ skateQuality: 'poor' }), filters, ctx())).toBe(false)
  })

  it('includes reports missing a quality (unknown ⇒ pass)', () => {
    expect(matchesFilters(report(), filters, ctx())).toBe(true)
  })
})

describe('matchesFilters — thickness floor (include-unknown)', () => {
  const filters: FeedFilters = { thicknessFloorCm: 10 }

  it('includes a report with a value reading at/above the floor', () => {
    expect(
      matchesFilters(report({ iceThickness: { readings: [{ valueCm: 12 }] } }), filters, ctx()),
    ).toBe(true)
  })

  it('uses the upper end of a range reading', () => {
    expect(
      matchesFilters(
        report({ iceThickness: { readings: [{ minCm: 5, maxCm: 11 }] } }),
        filters,
        ctx(),
      ),
    ).toBe(true)
  })

  it('excludes a report whose readings are all below the floor', () => {
    expect(
      matchesFilters(
        report({ iceThickness: { readings: [{ valueCm: 4 }, { minCm: 2, maxCm: 6 }] } }),
        filters,
        ctx(),
      ),
    ).toBe(false)
  })

  it('takes the max across multiple readings', () => {
    expect(
      matchesFilters(
        report({ iceThickness: { readings: [{ valueCm: 4 }, { valueCm: 15 }] } }),
        filters,
        ctx(),
      ),
    ).toBe(true)
  })

  it('includes a report with no readings (unknown ⇒ pass)', () => {
    expect(matchesFilters(report(), filters, ctx())).toBe(true)
    expect(matchesFilters(report({ iceThickness: { readings: [] } }), filters, ctx())).toBe(true)
  })

  it('includes a report whose readings carry no numeric value (unknown ⇒ pass)', () => {
    expect(
      matchesFilters(report({ iceThickness: { readings: [{ minCm: 3 }] } }), filters, ctx()),
    ).toBe(true)
  })
})

describe('matchesFilters — no snow', () => {
  it('excludes reports tagged snow-covered or drifted', () => {
    for (const tag of SNOW_SURFACE_TAGS) {
      expect(matchesFilters(report({ surfaceTags: [tag] }), { noSnow: true }, ctx())).toBe(false)
    }
  })

  it('includes reports with other surface tags', () => {
    expect(matchesFilters(report({ surfaceTags: ['glass'] }), { noSnow: true }, ctx())).toBe(true)
  })

  it('includes reports with no surface tags (unknown ⇒ pass)', () => {
    expect(matchesFilters(report(), { noSnow: true }, ctx())).toBe(true)
  })
})

describe('matchesFilters — ideal ice / surface types (include-unknown intersection)', () => {
  it('includes a report sharing at least one wanted ice type', () => {
    expect(
      matchesFilters(
        report({ iceTypes: ['black_ice', 'snow_ice'] }),
        { iceTypes: ['black_ice'] },
        ctx(),
      ),
    ).toBe(true)
  })

  it('excludes a report whose ice types miss the wanted set', () => {
    expect(
      matchesFilters(report({ iceTypes: ['snow_ice'] }), { iceTypes: ['black_ice'] }, ctx()),
    ).toBe(false)
  })

  it('includes a report with no ice type declared (unknown ⇒ pass)', () => {
    expect(matchesFilters(report(), { iceTypes: ['black_ice'] }, ctx())).toBe(true)
  })

  it('ignores an empty wanted list', () => {
    expect(matchesFilters(report({ iceTypes: ['snow_ice'] }), { iceTypes: [] }, ctx())).toBe(true)
  })

  it('applies the same intersection rule to surface types', () => {
    expect(
      matchesFilters(
        report({ surfaceTags: ['glass'] }),
        { surfaceTags: ['glass', 'smooth'] },
        ctx(),
      ),
    ).toBe(true)
    expect(
      matchesFilters(report({ surfaceTags: ['rough'] }), { surfaceTags: ['glass'] }, ctx()),
    ).toBe(false)
    expect(matchesFilters(report(), { surfaceTags: ['glass'] }, ctx())).toBe(true)
    expect(matchesFilters(report({ surfaceTags: ['rough'] }), { surfaceTags: [] }, ctx())).toBe(
      true,
    )
  })
})

describe('matchesFilters — combined gates', () => {
  it('requires every active filter to pass', () => {
    const filters: FeedFilters = { radiusMinutes: 60, qualityFloor: 'great', noSnow: true }
    const good = report({ skateQuality: 'great', surfaceTags: ['glass'] })
    expect(matchesFilters(good, filters, ctx({ band: 30 }))).toBe(true)
    // Same report, but out of range → excluded.
    expect(matchesFilters(good, filters, ctx({ band: 90 }))).toBe(false)
  })
})

describe('sanitizeFeedFilters', () => {
  it('returns an empty object for junk / nullish input', () => {
    expect(sanitizeFeedFilters(undefined)).toEqual({})
    expect(sanitizeFeedFilters(null)).toEqual({})
    expect(
      sanitizeFeedFilters({ radiusMinutes: 45, qualityFloor: 'amazing', recencyHours: -3 }),
    ).toEqual({})
  })

  it('keeps well-formed fields', () => {
    expect(
      sanitizeFeedFilters({
        radiusMinutes: 60,
        qualityFloor: 'good',
        thicknessFloorCm: 10,
        noSnow: true,
        iceTypes: ['black_ice', 'nonsense', 'black_ice'],
        surfaceTags: ['glass'],
        recencyHours: 48,
      }),
    ).toEqual({
      radiusMinutes: 60,
      qualityFloor: 'good',
      thicknessFloorCm: 10,
      noSnow: true,
      iceTypes: ['black_ice'],
      surfaceTags: ['glass'],
      recencyHours: 48,
    })
  })

  it('drops a zero-length enum list rather than storing []', () => {
    expect(sanitizeFeedFilters({ iceTypes: ['nope'], surfaceTags: 'notarray' })).toEqual({})
  })

  it('accepts a zero thickness floor but rejects a negative one', () => {
    expect(sanitizeFeedFilters({ thicknessFloorCm: 0 })).toEqual({ thicknessFloorCm: 0 })
    expect(sanitizeFeedFilters({ thicknessFloorCm: -1 })).toEqual({})
  })

  it('drops noSnow when not exactly true', () => {
    expect(sanitizeFeedFilters({ noSnow: 'yes' })).toEqual({})
    expect(sanitizeFeedFilters({ noSnow: false })).toEqual({})
  })
})
