import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { destinationPoint, type LatLng } from './geometry';
import { pointRadiusShape } from './hazardGeometry';
import {
  DEFAULT_LEAD_MAX_SEC,
  DEFAULT_LEAD_MIN_SEC,
  type DirectionalFix,
  evaluateDirectionalAlert,
} from './hazardProjection';
import type { ProximityHazard } from './hazardProximity';
import { HAZARD_TYPES, type HazardType } from './types';

const CENTRE: LatLng = { lat: 44.4759, lng: -73.2121 };
const NONE: ReadonlySet<string> = new Set();

/** A fix heading due north at a skating clip unless overridden. */
function fix(overrides: Partial<DirectionalFix> = {}): DirectionalFix {
  return { coord: CENTRE, headingDeg: 0, speedMps: 10, ...overrides };
}

/** A point+radius hazard whose *centre* sits `metres` away from CENTRE along `bearingDeg`. */
function hazardAt(
  id: string,
  bearingDeg: number,
  metres: number,
  overrides: Partial<ProximityHazard> = {},
): ProximityHazard {
  return {
    id,
    type: 'open_water',
    shape: pointRadiusShape(destinationPoint(CENTRE, bearingDeg, metres), 20),
    confirmCount: 1,
    ...overrides,
  };
}

describe('evaluateDirectionalAlert — the motion guard', () => {
  const ahead = [hazardAt('h', 0, 450)];

  it('stays silent when stopped (course over ground is meaningless at rest)', () => {
    expect(evaluateDirectionalAlert(fix({ speedMps: 0 }), ahead, NONE)).toEqual([]);
  });

  it('stays silent below the walking-pace floor', () => {
    expect(evaluateDirectionalAlert(fix({ speedMps: 0.3 }), ahead, NONE)).toEqual([]);
  });

  it('stays silent when the OS reports heading unknown (negative)', () => {
    expect(evaluateDirectionalAlert(fix({ headingDeg: -1 }), ahead, NONE)).toEqual([]);
  });

  it('stays silent on NaN speed or heading rather than letting it slip through', () => {
    expect(evaluateDirectionalAlert(fix({ speedMps: Number.NaN }), ahead, NONE)).toEqual([]);
    expect(evaluateDirectionalAlert(fix({ headingDeg: Number.NaN }), ahead, NONE)).toEqual([]);
  });
});

describe('evaluateDirectionalAlert — the lead-time window', () => {
  it('fires for a hazard dead ahead inside the window', () => {
    // ~450 m ahead at 10 m/s ≈ 45 s out (edge, ~43 s) — squarely in [30, 60].
    const alerts = evaluateDirectionalAlert(fix(), [hazardAt('h', 0, 450)], NONE);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.secondsToEncounter).toBeGreaterThanOrEqual(DEFAULT_LEAD_MIN_SEC);
    expect(alerts[0]?.secondsToEncounter).toBeLessThanOrEqual(DEFAULT_LEAD_MAX_SEC);
  });

  it('stays silent for a hazard too close — that is Layer 1’s job', () => {
    // ~150 m / 10 m/s ≈ 15 s < 30.
    expect(evaluateDirectionalAlert(fix(), [hazardAt('h', 0, 150)], NONE)).toEqual([]);
  });

  it('stays silent for a hazard too far out to project honestly', () => {
    // ~900 m / 10 m/s ≈ 90 s > 60 (and beyond the sampled path length entirely).
    expect(evaluateDirectionalAlert(fix(), [hazardAt('h', 0, 900)], NONE)).toEqual([]);
  });

  it('never returns an encounter time outside the window (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 50, max: 1500 }),
        fc.integer({ min: 3, max: 15 }),
        (metres, speed) => {
          for (const a of evaluateDirectionalAlert(
            fix({ speedMps: speed }),
            [hazardAt('h', 0, metres)],
            NONE,
          )) {
            expect(a.secondsToEncounter).toBeGreaterThanOrEqual(DEFAULT_LEAD_MIN_SEC);
            expect(a.secondsToEncounter).toBeLessThanOrEqual(DEFAULT_LEAD_MAX_SEC);
          }
        },
      ),
    );
  });
});

describe('evaluateDirectionalAlert — direction matters', () => {
  it('never fires for a hazard behind the heading, at any speed or distance (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 500 }),
        fc.integer({ min: 1, max: 15 }),
        fc.integer({ min: 0, max: 359 }),
        (metres, speed, heading) => {
          // Place the hazard directly behind the heading; radius (20) < distance, so its footprint is
          // entirely behind and no forward sample can land inside it.
          const behind = hazardAt('b', (heading + 180) % 360, metres);
          const alerts = evaluateDirectionalAlert(
            fix({ headingDeg: heading, speedMps: speed }),
            [behind],
            NONE,
          );
          expect(alerts).toEqual([]);
        },
      ),
    );
  });

  it('does not fire for a hazard off to the side of the path', () => {
    // Heading north; hazard 450 m due east never comes within its 20 m footprint of the northward path.
    expect(evaluateDirectionalAlert(fix(), [hazardAt('e', 90, 450)], NONE)).toEqual([]);
  });

  it('projects along an arbitrary heading, not just north', () => {
    const heading = 137;
    const alerts = evaluateDirectionalAlert(
      fix({ headingDeg: heading }),
      [hazardAt('h', heading, 450)],
      NONE,
    );
    expect(alerts).toHaveLength(1);
  });
});

describe('evaluateDirectionalAlert — the confirm gate (D54)', () => {
  it('surfaces an unconfirmed hazard ahead as a soft confirm request, never a warning', () => {
    const alerts = evaluateDirectionalAlert(
      fix(),
      [hazardAt('h', 0, 450, { confirmCount: 0 })],
      NONE,
    );
    expect(alerts[0]?.kind).toBe('confirm_request');
  });

  it('promotes to a warning once independently confirmed', () => {
    const alerts = evaluateDirectionalAlert(
      fix(),
      [hazardAt('h', 0, 450, { confirmCount: 1 })],
      NONE,
    );
    expect(alerts[0]?.kind).toBe('warning');
  });

  it('honors a tuned confirm threshold', () => {
    const h = [hazardAt('h', 0, 450, { confirmCount: 2 })];
    expect(evaluateDirectionalAlert(fix(), h, NONE, { confirmThreshold: 3 })[0]?.kind).toBe(
      'confirm_request',
    );
    expect(evaluateDirectionalAlert(fix(), h, NONE, { confirmThreshold: 2 })[0]?.kind).toBe(
      'warning',
    );
  });
});

describe('evaluateDirectionalAlert — ridge_crossing is a passage marker (research §4)', () => {
  it('never fires directionally, however dead-ahead or confirmed', () => {
    const alerts = evaluateDirectionalAlert(
      fix(),
      [hazardAt('rc', 0, 450, { type: 'ridge_crossing', confirmCount: 3 })],
      NONE,
    );
    expect(alerts).toEqual([]);
  });

  it('is the only type excluded from directional alerting', () => {
    for (const type of HAZARD_TYPES) {
      const alerts = evaluateDirectionalAlert(
        fix(),
        [hazardAt('h', 0, 450, { type: type as HazardType, confirmCount: 1 })],
        NONE,
      );
      expect(alerts.length === 0, type).toBe(type === 'ridge_crossing');
    }
  });
});

describe('evaluateDirectionalAlert — session + ordering', () => {
  it('excludes an already-alerted hazard', () => {
    const hazards = [hazardAt('h1', 0, 400), hazardAt('h2', 0, 500)];
    const ids = evaluateDirectionalAlert(fix(), hazards, new Set(['h1'])).map((a) => a.hazardId);
    expect(ids).toEqual(['h2']);
  });

  it('returns soonest-encounter first, so a single notification shows the most imminent', () => {
    const alerts = evaluateDirectionalAlert(
      fix(),
      [hazardAt('far', 0, 550), hazardAt('near', 0, 350), hazardAt('mid', 0, 450)],
      NONE,
    );
    expect(alerts.map((a) => a.hazardId)).toEqual(['near', 'mid', 'far']);
  });

  it('is pure — it never mutates the alerted set it is given', () => {
    const alerted = new Set(['x']);
    evaluateDirectionalAlert(fix(), [hazardAt('h', 0, 450)], alerted);
    expect([...alerted]).toEqual(['x']);
  });

  it('faster travel reaches the same hazard sooner (monotonic property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 7, max: 9 }),
        fc.integer({ min: 10, max: 12 }),
        (slow, fast) => {
          const hazard = [hazardAt('h', 0, 400)];
          const slower = evaluateDirectionalAlert(fix({ speedMps: slow }), hazard, NONE)[0];
          const faster = evaluateDirectionalAlert(fix({ speedMps: fast }), hazard, NONE)[0];
          // Both should fire in this speed band; the faster skater's encounter is sooner.
          if (slower && faster) {
            expect(faster.secondsToEncounter).toBeLessThan(slower.secondsToEncounter);
          }
        },
      ),
    );
  });
});

describe('evaluateDirectionalAlert — degenerate inputs', () => {
  it('returns nothing for an empty hazard set (and that is not an all-clear)', () => {
    expect(evaluateDirectionalAlert(fix(), [], NONE)).toEqual([]);
  });

  it('skips a row whose footprint math throws and still projects onto the rest', () => {
    const malformed: ProximityHazard = {
      id: 'bad',
      type: 'pressure_ridge',
      shape: {
        geometryKind: 'line',
        geometry: { type: 'LineString', coordinates: [[CENTRE.lng, CENTRE.lat]] },
        bufferMeters: 10,
      },
      confirmCount: 1,
    };
    const alerts = evaluateDirectionalAlert(fix(), [malformed, hazardAt('good', 0, 450)], NONE);
    expect(alerts.map((a) => a.hazardId)).toEqual(['good']);
  });

  it('does not loop forever on an absurd lead window (sample cap)', () => {
    // A pathological leadMaxSec would ask for millions of samples; the cap keeps it bounded.
    const alerts = evaluateDirectionalAlert(fix(), [hazardAt('h', 0, 450)], NONE, {
      leadMaxSec: 10_000_000,
    });
    expect(Array.isArray(alerts)).toBe(true);
  });

  it('falls back to the default sample step when handed a nonsense one', () => {
    // A zero/negative/NaN step would make the sample loop degenerate; the guard swaps in the default so
    // the projection still walks the path and fires the same as with no override.
    const ahead = [hazardAt('h', 0, 450)];
    for (const sampleStepMeters of [0, -5, Number.NaN]) {
      expect(evaluateDirectionalAlert(fix(), ahead, NONE, { sampleStepMeters })).toHaveLength(1);
    }
  });
});
