import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  DISPLAY_AREA_MAX_SQM,
  DISPLAY_AREA_MIN_SQM,
  displayScore,
  MIN_VISIBLE_ZOOM_FLOOR,
  MIN_VISIBLE_ZOOM_WIDEST,
  minVisibleZoom,
} from './display'

describe('displayScore (D49)', () => {
  it('maps the area reference bounds to [0, 1]', () => {
    expect(displayScore({ surfaceAreaSqM: DISPLAY_AREA_MIN_SQM })).toBe(0)
    expect(displayScore({ surfaceAreaSqM: DISPLAY_AREA_MAX_SQM })).toBe(1)
  })

  it('clamps the area term outside the reference bounds', () => {
    expect(displayScore({ surfaceAreaSqM: DISPLAY_AREA_MIN_SQM / 10 })).toBe(0)
    expect(displayScore({ surfaceAreaSqM: DISPLAY_AREA_MAX_SQM * 10 })).toBe(1)
  })

  it('treats missing / invalid area as the minimum (lowest prominence)', () => {
    expect(displayScore({})).toBe(0)
    expect(displayScore({ surfaceAreaSqM: 0 })).toBe(0)
    expect(displayScore({ surfaceAreaSqM: -5 })).toBe(0)
    expect(displayScore({ surfaceAreaSqM: Number.NaN })).toBe(0)
    expect(displayScore({ surfaceAreaSqM: Number.POSITIVE_INFINITY })).toBe(0)
  })

  it('adds curatedBoost directly (can exceed 1 to force wider)', () => {
    expect(displayScore({ surfaceAreaSqM: DISPLAY_AREA_MIN_SQM, curatedBoost: 0.5 })).toBe(0.5)
    expect(displayScore({ surfaceAreaSqM: DISPLAY_AREA_MAX_SQM, curatedBoost: 0.5 })).toBe(1.5)
  })

  it('is monotonic non-decreasing in area (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 1e12, noNaN: true }),
        fc.double({ min: 1, max: 1e12, noNaN: true }),
        (a, b) => {
          const [smaller, larger] = a <= b ? [a, b] : [b, a]
          expect(displayScore({ surfaceAreaSqM: larger })).toBeGreaterThanOrEqual(
            displayScore({ surfaceAreaSqM: smaller }),
          )
        },
      ),
    )
  })
})

describe('minVisibleZoom (D49)', () => {
  it('maps score 0 to the floor and score 1 to the widest', () => {
    expect(minVisibleZoom(0)).toBe(MIN_VISIBLE_ZOOM_FLOOR)
    expect(minVisibleZoom(1)).toBe(MIN_VISIBLE_ZOOM_WIDEST)
  })

  it('clamps scores outside [0, 1]', () => {
    expect(minVisibleZoom(-3)).toBe(MIN_VISIBLE_ZOOM_FLOOR)
    expect(minVisibleZoom(5)).toBe(MIN_VISIBLE_ZOOM_WIDEST)
  })

  it('returns an integer within the bucket range (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: -5, max: 5, noNaN: true }), (score) => {
        const z = minVisibleZoom(score)
        expect(Number.isInteger(z)).toBe(true)
        expect(z).toBeGreaterThanOrEqual(MIN_VISIBLE_ZOOM_WIDEST)
        expect(z).toBeLessThanOrEqual(MIN_VISIBLE_ZOOM_FLOOR)
      }),
    )
  })

  it('is monotonic non-increasing in score (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -2, max: 2, noNaN: true }),
        fc.double({ min: -2, max: 2, noNaN: true }),
        (a, b) => {
          const [lower, higher] = a <= b ? [a, b] : [b, a]
          expect(minVisibleZoom(higher)).toBeLessThanOrEqual(minVisibleZoom(lower))
        },
      ),
    )
  })
})

describe('displayScore → minVisibleZoom (D49 end-to-end)', () => {
  it('a bigger body draws at an equal-or-wider zoom (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 1e12, noNaN: true }),
        fc.double({ min: 1, max: 1e12, noNaN: true }),
        (a, b) => {
          const [smaller, larger] = a <= b ? [a, b] : [b, a]
          const zSmall = minVisibleZoom(displayScore({ surfaceAreaSqM: smaller }))
          const zLarge = minVisibleZoom(displayScore({ surfaceAreaSqM: larger }))
          expect(zLarge).toBeLessThanOrEqual(zSmall)
        },
      ),
    )
  })

  it('curatedBoost raises prominence (never draws narrower)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 1e12, noNaN: true }),
        fc.double({ min: 0, max: 2, noNaN: true }),
        (area, boost) => {
          const base = minVisibleZoom(displayScore({ surfaceAreaSqM: area }))
          const boosted = minVisibleZoom(
            displayScore({ surfaceAreaSqM: area, curatedBoost: boost }),
          )
          expect(boosted).toBeLessThanOrEqual(base)
        },
      ),
    )
  })

  it('every body is visible by the floor zoom regardless of score (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1e12, noNaN: true }),
        fc.double({ min: -1, max: 3, noNaN: true }),
        (surfaceAreaSqM, curatedBoost) => {
          expect(
            minVisibleZoom(displayScore({ surfaceAreaSqM, curatedBoost })),
          ).toBeLessThanOrEqual(MIN_VISIBLE_ZOOM_FLOOR)
        },
      ),
    )
  })
})
