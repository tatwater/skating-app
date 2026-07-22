import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { LatLng } from './geometry'
import { pointRadiusShape } from './hazardGeometry'
import {
  DEFAULT_ALERT_BUFFER_M,
  evaluateOnIceAlert,
  isInsideHazard,
  type ProximityHazard,
} from './hazardProximity'
import { HAZARD_TYPES, type HazardType } from './types'

const CENTRE: LatLng = { lat: 44.4759, lng: -73.2121 }

/** ~111 m per 0.001° of latitude at this latitude — handy for placing hazards a known distance away. */
function north(from: LatLng, metres: number): LatLng {
  return { lat: from.lat + metres / 111_320, lng: from.lng }
}

function hazard(id: string, at: LatLng, overrides: Partial<ProximityHazard> = {}): ProximityHazard {
  return {
    id,
    type: 'open_water',
    shape: pointRadiusShape(at, 20),
    confirmCount: 0,
    ...overrides,
  }
}

const NONE: ReadonlySet<string> = new Set()

describe('evaluateOnIceAlert — the confirm gate (D54)', () => {
  it('surfaces an unconfirmed hazard as a soft confirm request, never a warning', () => {
    const alerts = evaluateOnIceAlert(CENTRE, [hazard('h1', CENTRE, { confirmCount: 0 })], NONE)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.kind).toBe('confirm_request')
  })

  it('promotes to a warning once independently confirmed', () => {
    const alerts = evaluateOnIceAlert(CENTRE, [hazard('h1', CENTRE, { confirmCount: 1 })], NONE)
    expect(alerts[0]?.kind).toBe('warning')
  })

  // The blast radius of a fake pin: only people physically on that ice, and only as a soft question.
  it('never lets an unconfirmed hazard produce a warning, at any distance (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 300 }), (metres) => {
        const alerts = evaluateOnIceAlert(
          CENTRE,
          [hazard('h1', north(CENTRE, metres), { confirmCount: 0 })],
          NONE,
        )
        for (const alert of alerts) expect(alert.kind).toBe('confirm_request')
      }),
    )
  })

  it('honors a tuned confirm threshold', () => {
    const h = [hazard('h1', CENTRE, { confirmCount: 2 })]
    expect(evaluateOnIceAlert(CENTRE, h, NONE, { confirmThreshold: 3 })[0]?.kind).toBe(
      'confirm_request',
    )
    expect(evaluateOnIceAlert(CENTRE, h, NONE, { confirmThreshold: 2 })[0]?.kind).toBe('warning')
  })
})

describe('evaluateOnIceAlert — distance', () => {
  it('alerts inside the buffer and stays silent outside it', () => {
    const near = hazard('near', north(CENTRE, 50))
    const far = hazard('far', north(CENTRE, 5_000))
    const alerts = evaluateOnIceAlert(CENTRE, [near, far], NONE)
    expect(alerts.map((a) => a.hazardId)).toEqual(['near'])
  })

  it('returns nearest first, so a single-banner UI shows the most urgent', () => {
    const alerts = evaluateOnIceAlert(
      CENTRE,
      [
        hazard('mid', north(CENTRE, 90)),
        hazard('close', CENTRE),
        hazard('edge', north(CENTRE, 140)),
      ],
      NONE,
    )
    expect(alerts.map((a) => a.hazardId)).toEqual(['close', 'mid', 'edge'])
  })

  it('reports 0 distance when the skater is inside the footprint', () => {
    const alerts = evaluateOnIceAlert(CENTRE, [hazard('h1', CENTRE)], NONE)
    expect(alerts[0]?.distanceMeters).toBe(0)
  })

  it('respects a tuned alert buffer', () => {
    const h = [hazard('h1', north(CENTRE, 400))]
    expect(evaluateOnIceAlert(CENTRE, h, NONE)).toHaveLength(0)
    expect(evaluateOnIceAlert(CENTRE, h, NONE, { alertBufferMeters: 600 })).toHaveLength(1)
  })

  it('never reports a distance beyond the buffer (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2_000 }), (metres) => {
        for (const alert of evaluateOnIceAlert(
          CENTRE,
          [hazard('h', north(CENTRE, metres))],
          NONE,
        )) {
          expect(alert.distanceMeters).toBeLessThanOrEqual(DEFAULT_ALERT_BUFFER_M)
        }
      }),
    )
  })
})

describe('evaluateOnIceAlert — per-session dedup', () => {
  // Without this, skating laps on a pond re-fires the same alert every circuit and trains the skater
  // to ignore it — worse than not alerting at all.
  it('suppresses hazards already alerted this session', () => {
    const hazards = [hazard('h1', CENTRE), hazard('h2', north(CENTRE, 60))]
    expect(evaluateOnIceAlert(CENTRE, hazards, new Set(['h1'])).map((a) => a.hazardId)).toEqual([
      'h2',
    ])
    expect(evaluateOnIceAlert(CENTRE, hazards, new Set(['h1', 'h2']))).toHaveLength(0)
  })

  it('never returns an already-alerted id (property)', () => {
    fc.assert(
      fc.property(fc.subarray(['h1', 'h2', 'h3']), (alerted) => {
        const hazards = ['h1', 'h2', 'h3'].map((id) => hazard(id, CENTRE))
        const ids = evaluateOnIceAlert(CENTRE, hazards, new Set(alerted)).map((a) => a.hazardId)
        for (const id of alerted) expect(ids).not.toContain(id)
      }),
    )
  })
})

describe('evaluateOnIceAlert — ridge_crossing is a passage marker (research §4)', () => {
  // Warning someone away from the safest point on a ridge would be actively counterproductive.
  it('never alerts, however close or however confirmed', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 0, max: 5 }),
        (metres, confirmCount) => {
          const alerts = evaluateOnIceAlert(
            CENTRE,
            [
              hazard('rc', north(CENTRE, metres), {
                type: 'ridge_crossing',
                confirmCount,
              }),
            ],
            NONE,
          )
          expect(alerts).toHaveLength(0)
        },
      ),
    )
  })

  it('does not suppress a real hazard sitting next to it', () => {
    const alerts = evaluateOnIceAlert(
      CENTRE,
      [
        hazard('rc', CENTRE, { type: 'ridge_crossing', confirmCount: 3 }),
        hazard('ridge', north(CENTRE, 30), { type: 'pressure_ridge', confirmCount: 3 }),
      ],
      NONE,
    )
    expect(alerts.map((a) => a.hazardId)).toEqual(['ridge'])
  })

  it('is the only type excluded from alerting', () => {
    for (const type of HAZARD_TYPES) {
      const alerts = evaluateOnIceAlert(
        CENTRE,
        [hazard('h', CENTRE, { type: type as HazardType, confirmCount: 1 })],
        NONE,
      )
      expect(alerts.length === 0, type).toBe(type === 'ridge_crossing')
    }
  })
})

describe('evaluateOnIceAlert — degenerate inputs', () => {
  it('returns nothing for an empty hazard set (and that is not an all-clear)', () => {
    expect(evaluateOnIceAlert(CENTRE, [], NONE)).toEqual([])
  })

  it('is pure — it never mutates the alerted set it is given', () => {
    const alerted = new Set(['h1'])
    evaluateOnIceAlert(CENTRE, [hazard('h2', CENTRE)], alerted)
    expect([...alerted]).toEqual(['h1'])
  })

  // The safety-defensive path: a single malformed cached row (one whose distance can't be computed)
  // must be skipped, never take out the alerts for every *other* hazard on the lake. Losing one pin is
  // bad; going silent on a whole lake because one row is bad is a safety failure.
  it('skips a row whose distance throws and still alerts on the rest', () => {
    // A line shape with a degenerate (single-point) geometry makes the footprint math throw.
    const malformed: ProximityHazard = {
      id: 'bad',
      type: 'pressure_ridge',
      shape: {
        geometryKind: 'line',
        geometry: { type: 'LineString', coordinates: [[CENTRE.lng, CENTRE.lat]] },
        bufferMeters: 10,
      },
      confirmCount: 1,
    }
    const good = hazard('good', CENTRE, { confirmCount: 1 })
    const alerts = evaluateOnIceAlert(CENTRE, [malformed, good], NONE)
    expect(alerts.map((a) => a.hazardId)).toEqual(['good'])
  })
})

describe('isInsideHazard', () => {
  it('is true at the centre and false well outside', () => {
    expect(isInsideHazard(CENTRE, pointRadiusShape(CENTRE, 50))).toBe(true)
    expect(isInsideHazard(north(CENTRE, 500), pointRadiusShape(CENTRE, 50))).toBe(false)
  })
})
