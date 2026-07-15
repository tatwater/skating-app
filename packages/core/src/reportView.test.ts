import { describe, expect, it } from 'vitest'
import {
  formatConditions,
  formatSkateTime,
  formatSnowCoverInches,
  formatThicknessReading,
  humanizeEnum,
  PRECIP_LABELS,
  SKATE_QUALITY_LABELS,
  SKY_LABELS,
  THICKNESS_METHOD_LABELS,
} from './reportView'
import { inchesToCm } from './units'

describe('humanizeEnum', () => {
  it('sentence-cases a snake_case token', () => {
    expect(humanizeEnum('black_ice')).toBe('Black ice')
    expect(humanizeEnum('orange_peel')).toBe('Orange peel')
  })

  it('handles a single-word token', () => {
    expect(humanizeEnum('glass')).toBe('Glass')
  })
})

describe('label maps', () => {
  it('cover every level with reader-facing wording', () => {
    expect(SKATE_QUALITY_LABELS.great).toBe('Great')
    expect(SKY_LABELS.partly_cloudy).toBe('Partly cloudy')
    expect(PRECIP_LABELS.none).toBe('None')
    expect(THICKNESS_METHOD_LABELS.estimated).toBe('estimated')
  })
})

describe('formatThicknessReading', () => {
  it('formats a single measured value in inches', () => {
    // 4″ exactly → 10.16 cm stored; round-trips to "4″ (measured)".
    expect(formatThicknessReading({ valueCm: inchesToCm(4), method: 'measured' })).toBe(
      '4″ (measured)',
    )
  })

  it('formats a min–max range in inches with the method', () => {
    expect(
      formatThicknessReading({ minCm: inchesToCm(2), maxCm: inchesToCm(4), method: 'estimated' }),
    ).toBe('2–4″ (estimated)')
  })

  it('prefers the single value when (defensively) both value and range are present', () => {
    expect(
      formatThicknessReading({ valueCm: inchesToCm(3), minCm: 1, maxCm: 2, method: 'measured' }),
    ).toBe('3″ (measured)')
  })

  it('returns null for a reading with neither a value nor a full range', () => {
    expect(formatThicknessReading({ method: 'measured' })).toBeNull()
    expect(formatThicknessReading({ minCm: inchesToCm(2), method: 'measured' })).toBeNull()
  })
})

describe('formatSnowCoverInches', () => {
  it('renders depth in inches', () => {
    expect(formatSnowCoverInches(inchesToCm(1.5))).toBe('1.5″')
    expect(formatSnowCoverInches(0)).toBe('0″')
  })
})

describe('formatConditions', () => {
  it('renders only the populated fields, imperial + humanized', () => {
    const rows = formatConditions({
      airTempC: 0,
      windSpeedKph: 16.09344, // 10 mph
      windDir: 'NW',
      sky: 'overcast',
      precip: 'snow',
      source: 'user',
    })
    expect(rows).toEqual([
      { label: 'Air temp', value: '32°F' },
      { label: 'Wind', value: '10 mph NW' },
      { label: 'Sky', value: 'Overcast' },
      { label: 'Precip', value: 'Snow' },
    ])
  })

  it('omits wind direction when absent and skips blank fields', () => {
    const rows = formatConditions({ windSpeedKph: 16.09344, source: 'user' })
    expect(rows).toEqual([{ label: 'Wind', value: '10 mph' }])
  })

  it('returns an empty list when nothing was recorded', () => {
    expect(formatConditions({ source: 'user' })).toEqual([])
  })
})

describe('formatSkateTime', () => {
  it('formats a timestamp deterministically in a fixed zone', () => {
    // 2026-01-05T19:30:00Z → 2:30 PM in America/New_York.
    const ms = Date.UTC(2026, 0, 5, 19, 30)
    expect(formatSkateTime(ms, 'America/New_York')).toBe('Jan 5, 2026, 2:30 PM')
  })

  it('renders in the local zone when none is given', () => {
    const ms = Date.UTC(2026, 0, 5, 19, 30)
    // Exact wording is locale/zone-dependent; assert it produced a non-empty string.
    expect(formatSkateTime(ms)).toMatch(/2026/)
  })
})
