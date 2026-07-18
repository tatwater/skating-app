import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { buildFeedCardView, type FeedCardData, formatPlaceLabel, formatRelativeTime } from './feed'

describe('formatPlaceLabel', () => {
  it('prefers the town, joined to the state', () => {
    expect(formatPlaceLabel({ town: 'Stowe', county: 'Lamoille County', state: 'VT' })).toBe(
      'Stowe, VT',
    )
  })

  it('falls back to the county when there is no town', () => {
    expect(formatPlaceLabel({ county: 'Chittenden County', state: 'VT' })).toBe(
      'Chittenden County, VT',
    )
  })

  it('falls back to the bare state when only a state resolved', () => {
    expect(formatPlaceLabel({ state: 'NY' })).toBe('NY')
  })

  it('returns null when nothing resolved (ocean / no-match)', () => {
    expect(formatPlaceLabel(undefined)).toBeNull()
    expect(formatPlaceLabel({})).toBeNull()
    expect(formatPlaceLabel({ town: '  ', state: '  ' })).toBeNull()
  })

  it('returns just the place name when a state is somehow absent', () => {
    expect(formatPlaceLabel({ town: 'Burlington' })).toBe('Burlington')
  })
})

describe('formatRelativeTime', () => {
  const now = Date.UTC(2026, 0, 5, 12, 0)

  it('labels sub-minute, minute, hour, day, and week buckets', () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe('just now')
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago')
    expect(formatRelativeTime(now - 3 * 60 * 60_000, now)).toBe('3h ago')
    expect(formatRelativeTime(now - 2 * 24 * 60 * 60_000, now)).toBe('2d ago')
    expect(formatRelativeTime(now - 21 * 24 * 60 * 60_000, now)).toBe('3w ago')
  })

  it('reads a future instant (clock skew) as just now, never negative', () => {
    expect(formatRelativeTime(now + 10 * 60_000, now)).toBe('just now')
  })

  it('never produces a negative magnitude (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 400 * 24 * 60 * 60_000 }), (ageMs) => {
        const label = formatRelativeTime(now - ageMs, now)
        expect(label).not.toMatch(/-/)
      }),
    )
  })
})

const CARD: FeedCardData = {
  reportId: 'r1',
  waterBodyId: 'wb1',
  bodyName: 'Lake Champlain',
  place: { town: 'Burlington', county: 'Chittenden County', state: 'VT' },
  skateEndTime: Date.UTC(2026, 0, 5, 11, 0),
  skateStartTime: Date.UTC(2026, 0, 5, 9, 30),
  iceTypes: ['black_ice'],
  surfaceTags: ['glass', 'orange_peel'],
  skateQuality: 'great',
  photoThumbUrls: ['https://x/thumb1.jpg'],
  author: { displayName: 'Ada Skater', username: 'ada' },
  blocked: false,
}

describe('buildFeedCardView', () => {
  const now = Date.UTC(2026, 0, 5, 12, 0)

  it('shapes a full card: label, relative time, duration, quality, humanized chips', () => {
    const view = buildFeedCardView(CARD, now)
    expect(view.bodyName).toBe('Lake Champlain')
    expect(view.placeLabel).toBe('Burlington, VT')
    expect(view.relativeTime).toBe('1h ago')
    expect(view.durationLabel).toBe('1h 30m')
    expect(view.qualityLabel).toBe('Great')
    expect(view.chips).toEqual(['Black ice', 'Glass', 'Orange peel'])
    expect(view.photoThumbUrls).toEqual(['https://x/thumb1.jpg'])
    expect(view.author).toEqual({ displayName: 'Ada Skater', username: 'ada' })
    expect(view.blocked).toBe(false)
    expect(view.isFavorite).toBe(false) // defaults false when the server omits it
  })

  it('carries the favorite flag through to the view (Phase 4)', () => {
    expect(buildFeedCardView({ ...CARD, isFavorite: true }, now).isFavorite).toBe(true)
  })

  it('handles an end-only report with no place, quality, or photos', () => {
    const view = buildFeedCardView(
      {
        ...CARD,
        place: undefined,
        skateStartTime: undefined,
        skateQuality: undefined,
        iceTypes: [],
        surfaceTags: [],
        photoThumbUrls: [],
        blocked: true,
      },
      now,
    )
    expect(view.placeLabel).toBeNull()
    expect(view.durationLabel).toBeNull()
    expect(view.qualityLabel).toBeNull()
    expect(view.chips).toEqual([])
    expect(view.photoThumbUrls).toEqual([])
    expect(view.blocked).toBe(true)
  })
})
