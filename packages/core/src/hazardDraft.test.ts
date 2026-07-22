import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { LatLng } from './geometry';
import {
  applyDraftMapClick,
  draftForType,
  draftPlacementCount,
  draftToShape,
  draftVertices,
  HAZARD_BUFFER_STEPS_M,
  HAZARD_RADIUS_STEPS_M,
  type HazardDraft,
  isDraftSubmittable,
  pointDraftForType,
  resizeDraft,
  retypeDraft,
  stepSize,
  switchDraftKind,
  undoDraftPlacement,
} from './hazardDraft';
import {
  HAZARD_DEFAULT_BUFFER_M,
  HAZARD_DEFAULT_GEOMETRY_KIND,
  HAZARD_DEFAULT_RADIUS_M,
  isValidHazardShape,
} from './hazardGeometry';
import { HAZARD_TYPES } from './types';

const A: LatLng = { lat: 44.4759, lng: -73.2121 };
const B: LatLng = { lat: 44.481, lng: -73.208 };
const C: LatLng = { lat: 44.486, lng: -73.204 };

const arbCoord: fc.Arbitrary<LatLng> = fc.record({
  lat: fc.double({ min: 44.4, max: 44.55, noNaN: true }),
  lng: fc.double({ min: -73.3, max: -73.1, noNaN: true }),
});
const arbType = fc.constantFrom(...HAZARD_TYPES);

describe('draftForType', () => {
  it('starts the genuinely linear types as a line and everything else as a circle (D51)', () => {
    for (const type of HAZARD_TYPES) {
      const draft = draftForType(type);
      expect(draft.geometryKind, type).toBe(
        HAZARD_DEFAULT_GEOMETRY_KIND[type] === 'line' ? 'line' : 'point_radius',
      );
    }
  });

  it('adopts the type’s own default size', () => {
    const ridge = draftForType('pressure_ridge');
    expect(ridge).toEqual({
      geometryKind: 'line',
      vertices: [],
      bufferMeters: HAZARD_DEFAULT_BUFFER_M.pressure_ridge,
    });
    const hole = draftForType('drilled_hole');
    expect(hole).toEqual({
      geometryKind: 'point_radius',
      coord: null,
      radiusMeters: HAZARD_DEFAULT_RADIUS_M.drilled_hole,
    });
  });

  // On the ice, "committable after two taps" outranks primitive purity: one GPS fix is one vertex,
  // and a one-vertex line isn't storable, so a ridge flagged from the ice starts as a circle and
  // upgrades only if the skater chooses to trace it.
  it('starts every type as a circle on the on-ice path, including the linear ones', () => {
    for (const type of HAZARD_TYPES) {
      const draft = pointDraftForType(type);
      expect(draft.geometryKind, type).toBe('point_radius');
      expect(isDraftSubmittable(applyDraftMapClick(draft, A)), type).toBe(true);
    }
  });

  // The point of the state machine: a freshly-picked type is a legal value that simply isn't
  // storable yet. Nothing may crash on it, and nothing may offer to post it.
  it('is never submittable before anything has been placed', () => {
    fc.assert(
      fc.property(arbType, (type) => {
        const draft = draftForType(type);
        expect(isDraftSubmittable(draft)).toBe(false);
        expect(draftToShape(draft)).toBeNull();
        expect(draftPlacementCount(draft)).toBe(0);
        expect(draftVertices(draft)).toEqual([]);
      }),
    );
  });
});

describe('applyDraftMapClick', () => {
  it('sets, then moves, a circle’s centre', () => {
    const placed = applyDraftMapClick(draftForType('open_water'), A);
    expect(draftPlacementCount(placed)).toBe(1);
    const moved = applyDraftMapClick(placed, B);
    expect(moved).toMatchObject({ coord: B });
    expect(draftPlacementCount(moved)).toBe(1);
  });

  it('exposes the placed centre as a vertex, so a lone circle click is still visible', () => {
    expect(draftVertices(applyDraftMapClick(draftForType('open_water'), A))).toEqual([A]);
  });

  it('appends vertices to a line in tap order', () => {
    let draft = draftForType('pressure_ridge');
    for (const coord of [A, B, C]) draft = applyDraftMapClick(draft, coord);
    expect(draftVertices(draft)).toEqual([A, B, C]);
  });

  it('keeps the tuned size across a placement', () => {
    const sized = resizeDraft(resizeDraft(draftForType('thin_ice'), 1), 1);
    const placed = applyDraftMapClick(sized, A);
    expect(placed).toMatchObject({
      radiusMeters: (sized as { radiusMeters: number }).radiusMeters,
    });
  });

  it('never mutates the draft it was given', () => {
    const draft = draftForType('pressure_ridge');
    const before = structuredClone(draft);
    applyDraftMapClick(draft, A);
    expect(draft).toEqual(before);
  });
});

describe('submittability', () => {
  // A circle is committable the instant it has a centre — the two-tap guarantee the on-ice flow
  // depends on (a mitten-fumble that hits Done early must still produce a useful pin).
  it('accepts a circle as soon as it has a centre', () => {
    expect(isDraftSubmittable(applyDraftMapClick(draftForType('open_water'), A))).toBe(true);
  });

  it('rejects a line until it has two distinct vertices', () => {
    let draft = draftForType('wet_crack');
    expect(isDraftSubmittable(draft)).toBe(false);
    draft = applyDraftMapClick(draft, A);
    expect(isDraftSubmittable(draft)).toBe(false);
    draft = applyDraftMapClick(draft, B);
    expect(isDraftSubmittable(draft)).toBe(true);
  });

  // Two taps in the same spot is exactly what a stationary GPS or a double-click produces, and it's
  // the degenerate input Turf's buffer throws on rather than returning empty.
  it('rejects a line whose vertices are all the same point', () => {
    let draft = draftForType('wet_crack');
    draft = applyDraftMapClick(draft, A);
    draft = applyDraftMapClick(draft, A);
    expect(isDraftSubmittable(draft)).toBe(false);
  });

  it('only ever produces shapes the storage validator accepts', () => {
    fc.assert(
      fc.property(arbType, fc.array(arbCoord, { maxLength: 6 }), (type, coords) => {
        let draft = draftForType(type);
        for (const coord of coords) draft = applyDraftMapClick(draft, coord);
        const shape = draftToShape(draft);
        if (shape !== null) expect(isValidHazardShape(shape)).toBe(true);
      }),
    );
  });

  it('carries the tuned size into the shape it produces', () => {
    const draft = resizeDraft(applyDraftMapClick(draftForType('open_water'), A), 1);
    expect(draftToShape(draft)).toMatchObject({
      geometryKind: 'point_radius',
      radiusMeters: (draft as { radiusMeters: number }).radiusMeters,
    });
    let line = draftForType('pressure_ridge');
    line = applyDraftMapClick(applyDraftMapClick(line, A), B);
    expect(draftToShape(resizeDraft(line, -1))).toMatchObject({
      geometryKind: 'line',
      bufferMeters:
        HAZARD_BUFFER_STEPS_M[
          HAZARD_BUFFER_STEPS_M.indexOf(
            HAZARD_DEFAULT_BUFFER_M.pressure_ridge as (typeof HAZARD_BUFFER_STEPS_M)[number],
          ) - 1
        ],
    });
  });
});

describe('undoDraftPlacement', () => {
  it('drops one vertex at a time and bottoms out empty', () => {
    let draft: HazardDraft = draftForType('pressure_ridge');
    draft = applyDraftMapClick(applyDraftMapClick(draft, A), B);
    draft = undoDraftPlacement(draft);
    expect(draftVertices(draft)).toEqual([A]);
    draft = undoDraftPlacement(draft);
    expect(draftVertices(draft)).toEqual([]);
    expect(undoDraftPlacement(draft)).toEqual(draft); // undoing nothing is a no-op, not a crash
  });

  it('clears a circle’s centre without losing its size', () => {
    const draft = resizeDraft(applyDraftMapClick(draftForType('thin_ice'), A), 1);
    const undone = undoDraftPlacement(draft);
    expect(undone).toEqual({
      geometryKind: 'point_radius',
      coord: null,
      radiusMeters: (draft as { radiusMeters: number }).radiusMeters,
    });
  });

  it('undo after a click returns to the previous state', () => {
    fc.assert(
      fc.property(arbType, arbCoord, (type, coord) => {
        const draft = draftForType(type);
        expect(undoDraftPlacement(applyDraftMapClick(draft, coord))).toEqual(draft);
      }),
    );
  });
});

describe('switchDraftKind', () => {
  it('is a no-op when the primitive is unchanged', () => {
    const draft = applyDraftMapClick(draftForType('open_water'), A);
    expect(switchDraftKind(draft, 'point_radius', 'open_water')).toBe(draft);
  });

  it('seeds a line with the circle’s centre — the spot you already knew', () => {
    const draft = applyDraftMapClick(draftForType('open_water'), A);
    expect(switchDraftKind(draft, 'line', 'open_water')).toEqual({
      geometryKind: 'line',
      vertices: [A],
      bufferMeters: HAZARD_DEFAULT_BUFFER_M.open_water,
    });
  });

  // The *first* vertex, not the last: it's where the person started describing the hazard, so it
  // survives undoing everything drawn after it.
  it('collapses a line to its first vertex', () => {
    let draft = draftForType('pressure_ridge');
    draft = applyDraftMapClick(applyDraftMapClick(draft, A), B);
    expect(switchDraftKind(draft, 'point_radius', 'pressure_ridge')).toEqual({
      geometryKind: 'point_radius',
      coord: A,
      radiusMeters: HAZARD_DEFAULT_RADIUS_M.pressure_ridge,
    });
  });

  it('leaves an unplaced draft unplaced in either direction', () => {
    expect(
      switchDraftKind(draftForType('pressure_ridge'), 'point_radius', 'pressure_ridge'),
    ).toEqual({
      geometryKind: 'point_radius',
      coord: null,
      radiusMeters: HAZARD_DEFAULT_RADIUS_M.pressure_ridge,
    });
    expect(switchDraftKind(draftForType('open_water'), 'line', 'open_water')).toEqual({
      geometryKind: 'line',
      vertices: [],
      bufferMeters: HAZARD_DEFAULT_BUFFER_M.open_water,
    });
  });

  it('always lands on the primitive it was asked for', () => {
    fc.assert(
      fc.property(
        arbType,
        fc.constantFrom('point_radius' as const, 'line' as const),
        fc.array(arbCoord, { maxLength: 4 }),
        (type, kind, coords) => {
          let draft = draftForType(type);
          for (const coord of coords) draft = applyDraftMapClick(draft, coord);
          expect(switchDraftKind(draft, kind, type).geometryKind).toBe(kind);
        },
      ),
    );
  });
});

describe('retypeDraft', () => {
  it('keeps the placement and adopts the new type’s size within one primitive', () => {
    const draft = applyDraftMapClick(draftForType('drilled_hole'), A);
    expect(retypeDraft(draft, 'thawed_rotten')).toEqual({
      geometryKind: 'point_radius',
      coord: A,
      radiusMeters: HAZARD_DEFAULT_RADIUS_M.thawed_rotten,
    });
  });

  it('converts the primitive when the new type is linear', () => {
    const draft = applyDraftMapClick(draftForType('open_water'), A);
    expect(retypeDraft(draft, 'pressure_ridge')).toEqual({
      geometryKind: 'line',
      vertices: [A],
      bufferMeters: HAZARD_DEFAULT_BUFFER_M.pressure_ridge,
    });
  });

  it('changes the buffer when re-typing between two linear types', () => {
    let draft = draftForType('wet_crack');
    draft = applyDraftMapClick(applyDraftMapClick(draft, A), B);
    expect(retypeDraft(draft, 'pressure_ridge')).toEqual({
      geometryKind: 'line',
      vertices: [A, B],
      bufferMeters: HAZARD_DEFAULT_BUFFER_M.pressure_ridge,
    });
  });

  it('leaves the draft at the new type’s default primitive and size for any type pair', () => {
    fc.assert(
      fc.property(arbType, arbType, (from, to) => {
        const retyped = retypeDraft(applyDraftMapClick(draftForType(from), A), to);
        expect(retyped.geometryKind).toBe(
          HAZARD_DEFAULT_GEOMETRY_KIND[to] === 'line' ? 'line' : 'point_radius',
        );
        expect(retyped.geometryKind === 'line' ? retyped.bufferMeters : retyped.radiusMeters).toBe(
          retyped.geometryKind === 'line'
            ? HAZARD_DEFAULT_BUFFER_M[to]
            : HAZARD_DEFAULT_RADIUS_M[to],
        );
      }),
    );
  });
});

describe('stepSize / resizeDraft', () => {
  it('walks the ladder in both directions', () => {
    expect(stepSize(25, HAZARD_RADIUS_STEPS_M, 1)).toBe(50);
    expect(stepSize(25, HAZARD_RADIUS_STEPS_M, -1)).toBe(10);
  });

  it('clamps at the ends rather than wrapping', () => {
    const [first] = HAZARD_RADIUS_STEPS_M;
    const last = HAZARD_RADIUS_STEPS_M[HAZARD_RADIUS_STEPS_M.length - 1] ?? first;
    expect(stepSize(first, HAZARD_RADIUS_STEPS_M, -1)).toBe(first);
    expect(stepSize(last, HAZARD_RADIUS_STEPS_M, 1)).toBe(last);
  });

  // Per-type defaults (5, 15, 20, 30, 60 m …) deliberately don't all sit on the ladder, so the
  // first press has to snap to the neighbouring rung instead of jumping to an end or standing still.
  it('snaps an off-ladder default inward on the first press', () => {
    expect(stepSize(60, HAZARD_RADIUS_STEPS_M, 1)).toBe(100);
    expect(stepSize(60, HAZARD_RADIUS_STEPS_M, -1)).toBe(50);
    expect(stepSize(3, HAZARD_BUFFER_STEPS_M, 1)).toBe(4);
    expect(stepSize(3, HAZARD_BUFFER_STEPS_M, -1)).toBe(2);
  });

  it('always yields a positive size, so a resized draft never becomes unstorable', () => {
    fc.assert(
      fc.property(
        arbType,
        fc.array(fc.constantFrom(1 as const, -1 as const), { maxLength: 12 }),
        (type, presses) => {
          let draft = applyDraftMapClick(applyDraftMapClick(draftForType(type), A), B);
          for (const press of presses) draft = resizeDraft(draft, press);
          const size = draft.geometryKind === 'line' ? draft.bufferMeters : draft.radiusMeters;
          expect(size).toBeGreaterThan(0);
          expect(isDraftSubmittable(draft)).toBe(true);
        },
      ),
    );
  });

  it('resizes the buffer on a line and the radius on a circle', () => {
    const line = resizeDraft(draftForType('pressure_ridge'), 1);
    expect(line).toMatchObject({ geometryKind: 'line' });
    expect((line as { bufferMeters: number }).bufferMeters).toBeGreaterThan(
      HAZARD_DEFAULT_BUFFER_M.pressure_ridge,
    );
    const circle = resizeDraft(draftForType('open_water'), 1);
    expect((circle as { radiusMeters: number }).radiusMeters).toBeGreaterThan(
      HAZARD_DEFAULT_RADIUS_M.open_water,
    );
  });

  it('returns the input unchanged for an empty ladder', () => {
    expect(stepSize(12, [], 1)).toBe(12);
    expect(stepSize(12, [], -1)).toBe(12);
  });
});
