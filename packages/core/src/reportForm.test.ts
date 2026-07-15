import { describe, expect, it } from 'vitest'
import {
  buildReportInput,
  emptyReportForm,
  emptyThicknessReading,
  type ReportFormState,
} from './reportForm'
import { cmToInches, cToF, kphToMph } from './units'

describe('emptyThicknessReading', () => {
  it('is a blank single measured reading (the "add reading" default)', () => {
    expect(emptyThicknessReading()).toEqual({
      mode: 'single',
      value: '',
      min: '',
      max: '',
      method: 'measured',
    })
  })
})

describe('emptyReportForm', () => {
  it('defaults skate time to now (ms), no ice fields required (D3)', () => {
    const now = Date.UTC(2026, 0, 5, 19, 30)
    const form = emptyReportForm(now)
    expect(form.skateTime).toBe(now)
    expect(form.iceTypes).toEqual([])
    expect(form.thickness).toEqual([])
  })
})

const NOW = Date.UTC(2026, 0, 5, 19, 30)
const BASE: ReportFormState = emptyReportForm(NOW)

describe('buildReportInput', () => {
  it('keeps a notes-only report minimal — no empty optional fields (D3)', () => {
    const input = buildReportInput({ ...BASE, notes: '  did not skate  ' }, 'wb1')
    expect(input).toEqual({
      waterBodyId: 'wb1',
      skateTime: NOW,
      notes: 'did not skate',
    })
    expect('iceTypes' in input).toBe(false)
    expect('conditions' in input).toBe(false)
  })

  it('converts a single measured thickness reading to metric (D25)', () => {
    const input = buildReportInput(
      {
        ...BASE,
        thickness: [{ mode: 'single', value: '4', min: '', max: '', method: 'measured' }],
      },
      'wb1',
    )
    const reading = input.iceThickness?.readings[0]
    expect(reading?.method).toBe('measured')
    expect(cmToInches(reading?.valueCm ?? 0)).toBeCloseTo(4)
    expect(reading && 'minCm' in reading).toBe(false)
  })

  it('converts a min–max range reading and never emits both value and range (XOR)', () => {
    const input = buildReportInput(
      {
        ...BASE,
        thickness: [{ mode: 'range', value: '', min: '2', max: '4', method: 'estimated' }],
      },
      'wb1',
    )
    const reading = input.iceThickness?.readings[0]
    expect(reading && 'valueCm' in reading).toBe(false)
    expect(cmToInches(reading?.minCm ?? 0)).toBeCloseTo(2)
    expect(cmToInches(reading?.maxCm ?? 0)).toBeCloseTo(4)
  })

  it('drops empty readings so an untouched reading row doesn’t break validation', () => {
    const input = buildReportInput(
      {
        ...BASE,
        thickness: [
          { mode: 'single', value: '', min: '', max: '', method: 'measured' },
          { mode: 'single', value: '3', min: '', max: '', method: 'measured' },
        ],
      },
      'wb1',
    )
    expect(input.iceThickness?.readings).toHaveLength(1)
  })

  it('assembles manual conditions in metric with source=user, omitting blank fields', () => {
    const input = buildReportInput(
      {
        ...BASE,
        conditions: { airTempF: '32', windMph: '10', windDir: 'NW', sky: 'overcast', precip: '' },
      },
      'wb1',
    )
    expect(input.conditions?.source).toBe('user')
    expect(cToF(input.conditions?.airTempC ?? 0)).toBeCloseTo(32)
    expect(kphToMph(input.conditions?.windSpeedKph ?? 0)).toBeCloseTo(10)
    expect(input.conditions?.windDir).toBe('NW')
    expect(input.conditions?.sky).toBe('overcast')
    expect(input.conditions && 'precip' in input.conditions).toBe(false)
  })

  it('drops non-numeric numeric inputs (e.g. a stray snow-cover value)', () => {
    const input = buildReportInput({ ...BASE, snowCover: 'lots' }, 'wb1')
    expect('snowCoverCm' in input).toBe(false)
  })

  it('supports a one-sided thickness range (max only)', () => {
    const input = buildReportInput(
      {
        ...BASE,
        thickness: [{ mode: 'range', value: '', min: '', max: '5', method: 'measured' }],
      },
      'wb1',
    )
    const reading = input.iceThickness?.readings[0]
    expect(reading && 'minCm' in reading).toBe(false)
    expect(cmToInches(reading?.maxCm ?? 0)).toBeCloseTo(5)
  })

  it('drops an empty range reading (neither min nor max entered)', () => {
    const input = buildReportInput(
      {
        ...BASE,
        thickness: [{ mode: 'range', value: '', min: '', max: '', method: 'measured' }],
      },
      'wb1',
    )
    expect('iceThickness' in input).toBe(false)
  })

  it('supports a one-sided thickness range (min only) and a precip-only condition', () => {
    const input = buildReportInput(
      {
        ...BASE,
        thickness: [{ mode: 'range', value: '', min: '3', max: '', method: 'measured' }],
        conditions: { airTempF: '', windMph: '', windDir: '', sky: '', precip: 'snow' },
      },
      'wb1',
    )
    const reading = input.iceThickness?.readings[0]
    expect(reading && 'minCm' in reading).toBe(true)
    expect(reading && 'maxCm' in reading).toBe(false)
    expect(input.conditions).toEqual({ precip: 'snow', source: 'user' })
  })

  it('includes ice types, surface tags, quality, snow cover, and a put-in point when present', () => {
    const input = buildReportInput(
      {
        ...BASE,
        iceTypes: ['black_ice'],
        surfaceTags: ['glass', 'orange_peel'],
        skateQuality: 'great',
        snowCover: '1.5',
      },
      'wb1',
      { lat: 44.4, lng: -73.2 },
    )
    expect(input.iceTypes).toEqual(['black_ice'])
    expect(input.surfaceTags).toEqual(['glass', 'orange_peel'])
    expect(input.skateQuality).toBe('great')
    expect(cmToInches(input.snowCoverCm ?? 0)).toBeCloseTo(1.5)
    expect(input.point).toEqual({ lat: 44.4, lng: -73.2 })
  })
})
