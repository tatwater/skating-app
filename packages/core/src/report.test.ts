import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  type ReportInput,
  SKATE_TIME_FUTURE_TOLERANCE_MS,
  type ThicknessReadingInput,
  validateReportInput,
} from './report'

const NOW = 1_700_000_000_000
const CTX = { now: NOW }

/** A minimal valid report; override fields per test. */
function base(overrides: Partial<ReportInput> = {}): ReportInput {
  return { waterBodyId: 'wb1', skateEndTime: NOW - 1000, ...overrides }
}

/** Assert failure and return the set of error fields. */
function fieldsOf(input: ReportInput, ctx = CTX): string[] {
  const result = validateReportInput(input, ctx)
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected failure')
  return result.errors.map((e) => e.field)
}

describe('validateReportInput — valid reports', () => {
  it('accepts a minimal notes-only observation (D3) and defaults the arrays', () => {
    const result = validateReportInput(base({ notes: '  do not skate — open leads  ' }), CTX)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.normalized.iceTypes).toEqual([])
    expect(result.normalized.surfaceTags).toEqual([])
    expect(result.normalized.iceThickness).toBeUndefined()
    expect(result.normalized.notes).toBe('do not skate — open leads')
    expect(result.normalized.skateQuality).toBeUndefined()
    expect(result.normalized.conditions).toBeUndefined()
    expect(result.normalized.point).toBeUndefined()
    expect(result.normalized.snowCoverCm).toBeUndefined()
    expect(result.normalized.skateStartTime).toBeUndefined()
  })

  it('accepts and preserves an optional start time before the end (Phase 5)', () => {
    const result = validateReportInput(base({ skateStartTime: NOW - 60 * 60 * 1000 }), CTX)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.normalized.skateStartTime).toBe(NOW - 60 * 60 * 1000)
    expect(result.normalized.skateEndTime).toBe(NOW - 1000)
  })

  it('accepts a start equal to the end (zero-length window)', () => {
    const end = NOW - 1000
    const result = validateReportInput(base({ skateEndTime: end, skateStartTime: end }), CTX)
    expect(result.ok).toBe(true)
  })

  it('normalizes a full report (readings, conditions, point, trimming)', () => {
    const result = validateReportInput(
      base({
        iceTypes: ['black_ice'],
        surfaceTags: ['glass', 'orange_peel'],
        skateQuality: 'good',
        iceThickness: {
          readings: [
            { valueCm: 10, method: 'measured' },
            {
              minCm: 5,
              maxCm: 8,
              method: 'estimated',
              coord: { lat: 44, lng: -73 },
              note: ' NE bay ',
            },
          ],
        },
        snowCoverCm: 0,
        conditions: {
          airTempC: -5,
          windSpeedKph: 12,
          windDir: '  NW  ',
          sky: 'clear',
          precip: 'none',
          source: 'user',
        },
        point: { lat: 44.2, lng: -72.5 },
      }),
      CTX,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const n = result.normalized
    expect(n.iceThickness?.readings).toEqual([
      { method: 'measured', valueCm: 10 },
      { method: 'estimated', minCm: 5, maxCm: 8, coord: { lat: 44, lng: -73 }, note: 'NE bay' },
    ])
    expect(n.conditions).toEqual({
      source: 'user',
      airTempC: -5,
      windSpeedKph: 12,
      windDir: 'NW',
      sky: 'clear',
      precip: 'none',
    })
    expect(n.point).toEqual({ lat: 44.2, lng: -72.5 })
    expect(n.snowCoverCm).toBe(0)
  })

  it('defaults conditions.source to user (manual entry, D19) and drops absent fields', () => {
    const result = validateReportInput(base({ conditions: { airTempC: -2 } }), CTX)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.normalized.conditions).toEqual({ source: 'user', airTempC: -2 })
  })

  it('allows a skate time within the clock-skew tolerance', () => {
    const soon = base({ skateEndTime: NOW + SKATE_TIME_FUTURE_TOLERANCE_MS - 1 })
    expect(validateReportInput(soon, CTX).ok).toBe(true)
  })

  it('drops an empty thickness section', () => {
    const result = validateReportInput(base({ iceThickness: { readings: [] } }), CTX)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.normalized.iceThickness).toBeUndefined()
  })

  it('drops whitespace-only notes', () => {
    const result = validateReportInput(base({ notes: '   ' }), CTX)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.normalized.notes).toBeUndefined()
  })
})

describe('validateReportInput — required fields', () => {
  it('rejects a missing or whitespace water body', () => {
    expect(fieldsOf(base({ waterBodyId: '' }))).toContain('waterBodyId')
    expect(fieldsOf(base({ waterBodyId: '   ' }))).toContain('waterBodyId')
  })

  it('rejects a missing / non-positive skate-end time', () => {
    expect(fieldsOf(base({ skateEndTime: Number.NaN }))).toContain('skateEndTime')
    expect(fieldsOf(base({ skateEndTime: 0 }))).toContain('skateEndTime')
    expect(fieldsOf(base({ skateEndTime: -5 }))).toContain('skateEndTime')
  })

  it('rejects an implausibly-future skate-end time', () => {
    const future = base({ skateEndTime: NOW + SKATE_TIME_FUTURE_TOLERANCE_MS + 60_000 })
    const result = validateReportInput(future, CTX)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toContainEqual({
      field: 'skateEndTime',
      message: 'cannot be in the future',
    })
  })

  it('rejects a start after the end, and a non-positive start (Phase 5)', () => {
    const end = NOW - 1000
    expect(fieldsOf(base({ skateEndTime: end, skateStartTime: end + 1000 }))).toContain(
      'skateStartTime',
    )
    expect(fieldsOf(base({ skateStartTime: 0 }))).toContain('skateStartTime')
    expect(fieldsOf(base({ skateStartTime: Number.NaN }))).toContain('skateStartTime')
  })
})

describe('validateReportInput — enum membership', () => {
  it('rejects unknown ice types / surface tags / quality', () => {
    expect(fieldsOf(base({ iceTypes: ['lava' as never] }))).toContain('iceTypes[0]')
    expect(fieldsOf(base({ surfaceTags: ['sticky' as never] }))).toContain('surfaceTags[0]')
    expect(fieldsOf(base({ skateQuality: 'amazing' as never }))).toContain('skateQuality')
  })
})

describe('validateReportInput — thickness readings (D22)', () => {
  it('rejects a non-array readings list', () => {
    const bad = base({ iceThickness: { readings: 'nope' as unknown as ThicknessReadingInput[] } })
    expect(fieldsOf(bad)).toContain('iceThickness.readings')
  })

  it('rejects an unknown method', () => {
    const bad = base({ iceThickness: { readings: [{ valueCm: 5, method: 'guessed' as never }] } })
    expect(fieldsOf(bad)).toContain('iceThickness.readings[0].method')
  })

  it('rejects both a value and a range', () => {
    const bad = base({
      iceThickness: { readings: [{ valueCm: 5, minCm: 1, maxCm: 9, method: 'measured' }] },
    })
    expect(fieldsOf(bad)).toContain('iceThickness.readings[0]')
  })

  it('rejects a negative / non-finite single value', () => {
    expect(
      fieldsOf(base({ iceThickness: { readings: [{ valueCm: -1, method: 'measured' }] } })),
    ).toContain('iceThickness.readings[0].valueCm')
    expect(
      fieldsOf(
        base({
          iceThickness: { readings: [{ valueCm: Number.POSITIVE_INFINITY, method: 'measured' }] },
        }),
      ),
    ).toContain('iceThickness.readings[0].valueCm')
  })

  it('rejects a half-range, a negative range, and an inverted range', () => {
    expect(
      fieldsOf(base({ iceThickness: { readings: [{ minCm: 3, method: 'measured' }] } })),
    ).toContain('iceThickness.readings[0]')
    expect(
      fieldsOf(base({ iceThickness: { readings: [{ minCm: -1, maxCm: 5, method: 'measured' }] } })),
    ).toContain('iceThickness.readings[0]')
    expect(
      fieldsOf(base({ iceThickness: { readings: [{ minCm: 9, maxCm: 4, method: 'measured' }] } })),
    ).toContain('iceThickness.readings[0]')
  })

  it('rejects a reading with neither a value nor a range', () => {
    expect(fieldsOf(base({ iceThickness: { readings: [{ method: 'measured' }] } }))).toContain(
      'iceThickness.readings[0]',
    )
  })

  it('rejects an invalid reading coord', () => {
    const bad = base({
      iceThickness: { readings: [{ valueCm: 5, method: 'measured', coord: { lat: 200, lng: 0 } }] },
    })
    expect(fieldsOf(bad)).toContain('iceThickness.readings[0].coord')
  })

  it('value XOR range determines validity (property)', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.double({ min: 0, max: 100, noNaN: true }),
        (hasValue, hasRange, a, b) => {
          const lo = Math.min(a, b)
          const hi = Math.max(a, b)
          const reading: ThicknessReadingInput = { method: 'measured' }
          if (hasValue) reading.valueCm = a
          if (hasRange) {
            reading.minCm = lo
            reading.maxCm = hi
          }
          const result = validateReportInput(base({ iceThickness: { readings: [reading] } }), CTX)
          // Valid iff exactly one of {single value, min/max range} is present.
          expect(result.ok).toBe(hasValue !== hasRange)
        },
      ),
    )
  })
})

describe('validateReportInput — snow + conditions', () => {
  it('rejects negative snow cover', () => {
    expect(fieldsOf(base({ snowCoverCm: -1 }))).toContain('snowCoverCm')
  })

  it('rejects bad condition fields', () => {
    expect(fieldsOf(base({ conditions: { airTempC: Number.NaN } }))).toContain(
      'conditions.airTempC',
    )
    expect(fieldsOf(base({ conditions: { windSpeedKph: -3 } }))).toContain(
      'conditions.windSpeedKph',
    )
    expect(fieldsOf(base({ conditions: { sky: 'foggy' as never } }))).toContain('conditions.sky')
    expect(fieldsOf(base({ conditions: { precip: 'hail' as never } }))).toContain(
      'conditions.precip',
    )
    expect(fieldsOf(base({ conditions: { source: 'noaa' as never } }))).toContain(
      'conditions.source',
    )
  })
})

describe('validateReportInput — put-in pin coordinate bounds', () => {
  const invalid = [
    { lat: Number.NaN, lng: 0 },
    { lat: 0, lng: Number.NaN },
    { lat: -91, lng: 0 },
    { lat: 91, lng: 0 },
    { lat: 0, lng: -181 },
    { lat: 0, lng: 181 },
  ]
  it.each(invalid)('rejects out-of-range coord %o', (point) => {
    expect(fieldsOf(base({ point }))).toContain('point')
  })
})

describe('validateReportInput — error collection', () => {
  it('reports every problem at once, not just the first', () => {
    const result = validateReportInput(
      base({ waterBodyId: '', skateQuality: 'amazing' as never, snowCoverCm: -1 }),
      CTX,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.length).toBeGreaterThanOrEqual(3)
  })
})
