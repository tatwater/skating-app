import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  buildFeedCardView,
  type FeedCardData,
  feedSectionForTime,
  formatPlaceLabel,
  formatRelativeTime,
  groupFeedSections,
} from './feed'

const DAY = 24 * 60 * 60 * 1000

describe('feedSectionForTime', () => {
  const now = Date.UTC(2026, 0, 20, 12)
  it('buckets by age relative to now', () => {
    expect(feedSectionForTime(now - 1000, now).key).toBe('today')
    expect(feedSectionForTime(now - 1.5 * DAY, now).key).toBe('yesterday')
    expect(feedSectionForTime(now - 4 * DAY, now).key).toBe('this-week')
    expect(feedSectionForTime(now - 15 * DAY, now).key).toBe('this-month')
    expect(feedSectionForTime(now - 90 * DAY, now).key).toBe('older')
  })

  it('treats a future instant (clock skew) as today, never a negative bucket', () => {
    expect(feedSectionForTime(now + DAY, now).key).toBe('today')
  })

  it('carries a human label for the header', () => {
    expect(feedSectionForTime(now - 1000, now).label).toBe('Today')
    expect(feedSectionForTime(now - 90 * DAY, now).label).toBe('Older than a month')
  })
})

describe('groupFeedSections', () => {
  const now = Date.UTC(2026, 0, 20, 12)
  it('partitions a newest-first list into contiguous recency sections, order preserved', () => {
    const items = [
      { id: 'a', t: now - 1000 },
      { id: 'b', t: now - 2000 },
      { id: 'c', t: now - 1.5 * DAY },
      { id: 'd', t: now - 40 * DAY },
    ]
    const sections = groupFeedSections(items, (i) => i.t, now)
    expect(sections.map((s) => s.key)).toEqual(['today', 'yesterday', 'older'])
    expect(sections[0]?.items.map((i) => i.id)).toEqual(['a', 'b'])
    expect(sections[1]?.items.map((i) => i.id)).toEqual(['c'])
  })

  it('is empty for an empty list', () => {
    expect(groupFeedSections([], () => 0, now)).toEqual([])
  })

  it('starts a fresh section whenever the bucket changes, even out of order', () => {
    // A non-monotonic list must not merge two "today" runs separated by a "yesterday" into one header.
    const items = [now - 1000, now - 1.5 * DAY, now - 2000]
    const sections = groupFeedSections(items, (t) => t, now)
    expect(sections.map((s) => s.key)).toEqual(['today', 'yesterday', 'today'])
  })
})

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
