import fc from 'fast-check';
import type { Polygon, Position } from 'geojson';
import { describe, expect, it } from 'vitest';
import { pointInPolygon } from './geometry';
import {
  areasReached,
  capsuleInterval,
  countyKeyOfSubdivision,
  createReach,
  FRAME_STEP_DEG,
  isUndefinedSubdivision,
  REACH_TOUCH_M,
  REGION_SHORE_M,
  type ReachArea,
  type ReachCache,
  type ReachResult,
} from './regionReach';

// ── A frame in meters around (44°N, 72°W), the same one the rule measures in ─────────────────

const M_PER_DEG = 6_371_008.8 * (Math.PI / 180);
const LAT0 = 44;
const KX = M_PER_DEG * Math.cos((LAT0 * Math.PI) / 180);
const X0 = -72 * KX;
const Y0 = LAT0 * M_PER_DEG;

/** A point `x` meters east and `y` meters north of the origin, as `[lng, lat]`. */
const at = (x: number, y: number): Position => [(X0 + x) / KX, (Y0 + y) / M_PER_DEG];

/** A polygon from rings of meter points (closed for you). */
function poly(...rings: [number, number][][]): Polygon {
  return {
    type: 'Polygon',
    coordinates: rings.map((r) => [
      ...r.map(([x, y]) => at(x, y)),
      at(r[0]?.[0] ?? 0, r[0]?.[1] ?? 0),
    ]),
  };
}

const rect = (x0: number, y0: number, x1: number, y1: number): Polygon =>
  poly([
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]);

/** Pinned seeds, then one random run — a failure under a pinned seed reproduces exactly. */
const SEEDS = [1, 42, 2026];
function check<T>(arb: fc.Arbitrary<T>, pred: (v: T) => void, numRuns = 60): void {
  for (const seed of SEEDS) fc.assert(fc.property(arb, pred), { seed, numRuns });
  fc.assert(fc.property(arb, pred), { numRuns });
}

/** A 2×2 town grid over [0, 2s]² — A B on the bottom row, C D on top. */
function grid(s: number): ReachArea[] {
  return [
    { id: 'A', polygon: rect(0, 0, s, s) },
    { id: 'B', polygon: rect(s, 0, 2 * s, s) },
    { id: 'C', polygon: rect(0, s, s, 2 * s) },
    { id: 'D', polygon: rect(s, s, 2 * s, 2 * s) },
  ];
}

const sorted = (r: ReachResult) => [...r.ids].sort();

// ── The brute-force reference: the same rule, no grid, no bands, no box tests, Turf's PIP ─────

function reference(body: Polygon, areas: readonly ReachArea[], need: number): ReachResult {
  const r = REACH_TOUCH_M;
  const lats = body.coordinates.flat().map((p) => p[1] as number);
  const lat0 =
    Math.round(lats.reduce((a, b) => a + b, 0) / lats.length / FRAME_STEP_DEG) * FRAME_STEP_DEG;
  const kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  const proj = (p: Position) => [(p[0] as number) * kx, (p[1] as number) * M_PER_DEG] as const;
  const unproj = (x: number, y: number) => ({ lng: x / kx, lat: y / M_PER_DEG });
  const segs = (g: Polygon) =>
    g.coordinates
      .flatMap((ring) =>
        ring.slice(1).map((p, i) => [...proj(ring[i] as Position), ...proj(p)] as const),
      )
      .filter(([a, b, c, d]) => a !== c || b !== d);
  const bodySegs = segs(body);
  const lens = bodySegs.map(([ax, ay, bx, by]) => Math.hypot(bx - ax, by - ay));
  const leftover = bodySegs.map(() => [[0, 1]] as [number, number][]);
  const shore = new Map<string, number>();
  for (const area of areas) {
    const areaSegs = segs(area.polygon as Polygon);
    let inside = 0;
    bodySegs.forEach(([ax, ay, bx, by], i) => {
      const cov: [number, number][] = [];
      for (const [cx, cy, ex, ey] of areaSegs) {
        const h = capsuleInterval(ax, ay, bx - ax, by - ay, cx, cy, ex, ey, r);
        if (h) cov.push(h);
      }
      cov.sort((p, q) => p[0] - q[0]);
      const gaps: [number, number][] = [];
      let t = 0;
      for (const [s0, e0] of cov) {
        if (s0 - t > 1e-12) gaps.push([t, s0]);
        t = Math.max(t, e0);
      }
      if (1 - t > 1e-12) gaps.push([t, 1]);
      const len = lens[i] as number;
      inside += (1 - gaps.reduce((n, [s0, e0]) => n + e0 - s0, 0)) * len;
      const out: [number, number][] = [];
      for (const [s0, e0] of gaps) {
        const m = (s0 + e0) / 2;
        if (pointInPolygon(unproj(ax + (bx - ax) * m, ay + (by - ay) * m), area.polygon)) {
          inside += (e0 - s0) * len;
        } else out.push([s0, e0]);
      }
      const next: [number, number][] = [];
      for (const [s0, e0] of leftover[i] ?? []) {
        for (const [s1, e1] of out) {
          const s2 = Math.max(s0, s1);
          const e2 = Math.min(e0, e1);
          if (e2 - s2 > 1e-12) next.push([s2, e2]);
        }
      }
      leftover[i] = next;
    });
    shore.set(area.id, inside);
  }
  const ranked = [...shore.entries()]
    .filter(([, m]) => m > 0)
    .sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1));
  const held = ranked.filter(([, m]) => m >= need).map(([id]) => id);
  if (held.length) return { ids: held, basis: 'shore' };
  const out = leftover.reduce(
    (n, l, i) => n + l.reduce((m, [s0, e0]) => m + (e0 - s0), 0) * (lens[i] as number),
    0,
  );
  const total = lens.reduce((a, b) => a + b, 0);
  if (out >= need || ranked.length === 0 || total === 0) return { ids: [], basis: 'outside' };
  return { ids: [(ranked[0] as [string, number])[0]], basis: 'small' };
}

// ── Arbitraries ──────────────────────────────────────────────────────────────────────────────

/** A star-shaped (so simple) polygon around `(cx, cy)`: 5–12 vertices at radii in [rMin, rMax]. */
const star = (cx: fc.Arbitrary<number>, cy: fc.Arbitrary<number>, rMin: number, rMax: number) =>
  fc
    .record({
      cx,
      cy,
      radii: fc.array(fc.double({ min: rMin, max: rMax, noNaN: true }), {
        minLength: 5,
        maxLength: 12,
      }),
      turn: fc.double({ min: 0, max: Math.PI * 2, noNaN: true }),
    })
    .map(({ cx: x, cy: y, radii, turn }) =>
      poly(
        radii.map((r, i) => {
          const a = turn + (i / radii.length) * Math.PI * 2;
          return [x + r * Math.cos(a), y + r * Math.sin(a)] as [number, number];
        }),
      ),
    );

/** A jittered 3×3 town tiling over [0, 3s]²: shared vertices, so the towns tile exactly. */
const tiling = (s: number) =>
  fc
    .array(
      fc.tuple(
        fc.double({ min: -0.3, max: 0.3, noNaN: true }),
        fc.double({ min: -0.3, max: 0.3, noNaN: true }),
      ),
      {
        minLength: 16,
        maxLength: 16,
      },
    )
    .map((jit) => {
      const v = (i: number, j: number): [number, number] => {
        const inner = i > 0 && i < 3 && j > 0 && j < 3;
        const [jx, jy] = inner ? (jit[i * 4 + j] as [number, number]) : [0, 0];
        return [(i + jx) * s, (j + jy) * s];
      };
      const areas: ReachArea[] = [];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          areas.push({
            id: `T${i}${j}`,
            polygon: poly([v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1)]),
          });
        }
      }
      return areas;
    });

/** The same polygon with every ring reversed and started at another vertex. */
function reorder(p: Polygon, shift: number, reverse: boolean): Polygon {
  return {
    type: 'Polygon',
    coordinates: p.coordinates.map((ring) => {
      let open = ring.slice(0, -1);
      if (reverse) open = open.reverse();
      const k = shift % open.length;
      open = [...open.slice(k), ...open.slice(0, k)];
      return [...open, open[0] as Position];
    }),
  };
}

// ── The rule ─────────────────────────────────────────────────────────────────────────────────

describe('areasReached', () => {
  const S = 1_000;
  const N = REGION_SHORE_M;

  it('a body wholly inside one town is in it; wholly outside every town is in none', () => {
    check(
      star(
        fc.double({ min: 200, max: 800, noNaN: true }),
        fc.double({ min: 200, max: 800, noNaN: true }),
        20,
        150,
      ),
      (body) => {
        expect(areasReached(body, grid(S))).toEqual({ ids: ['A'], basis: 'shore' });
      },
    );
    check(
      star(
        fc.double({ min: 2_300, max: 4_000, noNaN: true }),
        fc.double({ min: -2_000, max: 4_000, noNaN: true }),
        20,
        150,
      ),
      (body) => {
        expect(areasReached(body, grid(S))).toEqual({ ids: [], basis: 'outside' });
      },
    );
  });

  it('a town holding the constant’s worth of shoreline is in; one holding less is not', () => {
    // A long body lying outside the grid's west edge, poking `d` meters into town A: the shoreline in
    // A is its two sides of `d` and its end of `h`.
    const poke = (d: number, h: number) => rect(-600, 400, d, 400 + h);
    check(
      fc
        .record({
          d: fc.double({ min: 0.5, max: 300, noNaN: true }),
          h: fc.double({ min: 5, max: 300, noNaN: true }),
        })
        .filter(({ d, h }) => 2 * d + h >= N + 0.5),
      ({ d, h }) => {
        expect(areasReached(poke(d, h), grid(S))).toEqual({ ids: ['A'], basis: 'shore' });
      },
    );
    check(
      fc
        .record({
          d: fc.double({ min: 0.05, max: 10, noNaN: true }),
          h: fc.double({ min: 0.5, max: 24, noNaN: true }),
        })
        .filter(({ d, h }) => 2 * d + h <= N - 0.5),
      ({ d, h }) => {
        expect(areasReached(poke(d, h), grid(S))).toEqual({ ids: [], basis: 'outside' });
      },
    );
  });

  it('a body split by a town line lists both towns', () => {
    check(
      fc.record({
        west: fc.double({ min: N, max: 400, noNaN: true }),
        east: fc.double({ min: N, max: 400, noNaN: true }),
        y: fc.double({ min: 100, max: 600, noNaN: true }),
      }),
      ({ west, east, y }) => {
        const r = areasReached(rect(S - west, y, S + east, y + 200), grid(S));
        expect(r.basis).toBe('shore');
        expect(sorted(r)).toEqual(['A', 'B']);
      },
    );
  });

  it('a shore near a town line counts for the town it lies in; one on the line counts for both', () => {
    check(
      fc.record({
        off: fc.double({ min: 0.05, max: 10, noNaN: true }),
        side: fc.constantFrom(-1, 1),
        y: fc.double({ min: 100, max: 600, noNaN: true }),
      }),
      ({ off, side, y }) => {
        // The east shore runs along the A/B line, `off` meters to one side of it.
        const r = areasReached(rect(300, y, S + side * off, y + 200), grid(S));
        if (side < 0) expect(r).toEqual({ ids: ['A'], basis: 'shore' });
        // Pushed `off` into B: B holds 2·off of the shore plus the 200 m east side.
        else expect(sorted(r)).toEqual(['A', 'B']);
      },
    );
    // Exactly on the line: both abut the water, so both count.
    expect(sorted(areasReached(rect(300, 300, S, 500), grid(S)))).toEqual(['A', 'B']);
  });

  it('a body whose whole shoreline is short counts for the town holding the most of it', () => {
    // A 6 m pond on the A/B line, two thirds of it in B.
    expect(areasReached(rect(S - 2, 500, S + 4, 506), grid(S))).toEqual({
      ids: ['B'],
      basis: 'small',
    });
    // Its shore split into pieces each under the constant, but nothing of it outside the towns.
    expect(areasReached(rect(S - 8, S - 8, S + 8, S + 8), grid(S))).toMatchObject({
      basis: 'small',
    });
  });

  it('a body in no town, its shore in one for less than the constant, is outside', () => {
    expect(areasReached(rect(-30, 500, -5, 520), grid(S))).toEqual({ ids: [], basis: 'outside' });
    expect(areasReached(rect(-300, 500, 5, 510), grid(S))).toEqual({ ids: [], basis: 'outside' });
  });

  it('open water alone lists no town; an island’s shore counts for the town it is in', () => {
    // A lake holding a whole water unit: the unit holds none of the shoreline.
    const lake = rect(-500, -500, 2_500, 2_500);
    const unit: ReachArea = { id: 'U', polygon: rect(800, 800, 1_200, 1_200) };
    expect(areasReached(lake, [unit])).toEqual({ ids: [], basis: 'outside' });
    // An island (a hole in the lake) inside the unit: its shore is the unit's.
    const ringed = poly(
      [
        [-500, -500],
        [2_500, -500],
        [2_500, 2_500],
        [-500, 2_500],
      ],
      [
        [900, 900],
        [900, 1_100],
        [1_100, 1_100],
        [1_100, 900],
      ],
    );
    expect(areasReached(ringed, [unit]).ids).toEqual(['U']);
  });

  it('lists the town holding the most shore first, and reports what each holds', () => {
    const run = createReach(rect(S - 100, 300, S + 600, 500));
    run.add(grid(S));
    expect(run.result().ids).toEqual(['B', 'A']);
    // A holds 100 + 200 + 100 m, B 600 + 200 + 600 m (each crossing adds its 2 cm on the line).
    expect(run.shore().get('A')).toBeCloseTo(400, 1);
    expect(run.shore().get('B')).toBeCloseTo(1_400, 1);
  });

  it('does not depend on vertex order or where a ring starts', () => {
    check(
      fc.record({
        areas: tiling(S),
        body: star(
          fc.double({ min: 0, max: 3 * S, noNaN: true }),
          fc.double({ min: 0, max: 3 * S, noNaN: true }),
          30,
          900,
        ),
        shift: fc.nat(20),
        reverse: fc.boolean(),
      }),
      ({ areas, body, shift, reverse }) => {
        const a = areasReached(body, areas);
        const b = areasReached(
          reorder(body, shift, reverse),
          areas.map((t) => ({ ...t, polygon: reorder(t.polygon as Polygon, shift + 1, !reverse) })),
        );
        expect(sorted(b)).toEqual(sorted(a));
        expect(b.basis).toBe(a.basis);
      },
    );
  });

  it('a body anywhere inside the towns is never in none', () => {
    check(
      fc.record({
        areas: tiling(S),
        body: star(
          fc.double({ min: 900, max: 2_100, noNaN: true }),
          fc.double({ min: 900, max: 2_100, noNaN: true }),
          2,
          800,
        ),
      }),
      ({ areas, body }) => {
        expect(areasReached(body, areas).ids.length).toBeGreaterThan(0);
      },
    );
  });

  it('is monotone in the constant: a larger one never lists a town a smaller one did not', () => {
    const held = (r: ReachResult) => (r.basis === 'shore' ? new Set(r.ids) : new Set<string>());
    check(
      fc.record({
        areas: tiling(S),
        body: star(
          fc.double({ min: 0, max: 3 * S, noNaN: true }),
          fc.double({ min: 0, max: 3 * S, noNaN: true }),
          10,
          600,
        ),
        n1: fc.double({ min: 0.5, max: 200, noNaN: true }),
        dn: fc.double({ min: 0, max: 400, noNaN: true }),
      }),
      ({ areas, body, n1, dn }) => {
        const small = held(areasReached(body, areas, { shoreM: n1 }));
        const large = held(areasReached(body, areas, { shoreM: n1 + dn }));
        for (const id of large) expect(small.has(id)).toBe(true);
      },
    );
  });

  it('equals a brute-force reference on small random cases', () => {
    check(
      fc.record({
        areas: tiling(300),
        body: star(
          fc.double({ min: -100, max: 1_000, noNaN: true }),
          fc.double({ min: -100, max: 1_000, noNaN: true }),
          2,
          400,
        ),
        need: fc.constantFrom(1, 10, REGION_SHORE_M, 200),
      }),
      ({ areas, body, need }) => {
        const got = areasReached(body, areas, { shoreM: need });
        expect(got).toEqual(reference(body, areas, need));
      },
      40,
    );
  });

  it('pages: any split of the candidates, in any order, gives the one-page answer', () => {
    check(
      fc.record({
        areas: tiling(S),
        body: star(
          fc.double({ min: 0, max: 3 * S, noNaN: true }),
          fc.double({ min: 0, max: 3 * S, noNaN: true }),
          10,
          900,
        ),
        cut: fc.nat(9),
        flip: fc.boolean(),
      }),
      ({ areas, body, cut, flip }) => {
        const run = createReach(body);
        const order = flip ? [...areas].reverse() : areas;
        run.add(order.slice(0, cut));
        run.add(order.slice(cut));
        run.add(order.slice(0, 2)); // a repeat is skipped
        expect(run.result()).toEqual(areasReached(body, areas));
      },
    );
  });

  it('shares prepared towns through a cache without changing an answer', () => {
    const cache: ReachCache = new Map();
    const first = areasReached(rect(S - 100, 300, S + 600, 500), grid(S), { cache });
    expect(cache.size).toBe(4);
    expect(areasReached(rect(S - 100, 300, S + 600, 500), grid(S), { cache })).toEqual(first);
    expect(cache.size).toBe(4);
  });

  it('handles the degenerate: no towns, an empty town, a body with no area, a multipolygon', () => {
    const body = rect(100, 100, 200, 200);
    expect(areasReached(body, [])).toEqual({ ids: [], basis: 'outside' });
    const empty: ReachArea = {
      id: 'E',
      polygon: { type: 'Polygon', coordinates: [[at(0, 0), at(0, 0)]] },
    };
    expect(areasReached(body, [empty])).toEqual({ ids: [], basis: 'outside' });
    expect(areasReached({ type: 'Polygon', coordinates: [] }, grid(S))).toEqual({
      ids: [],
      basis: 'outside',
    });
    // An unclosed ring bounds the same area as its closed form.
    const open: Polygon = {
      type: 'Polygon',
      coordinates: [[at(100, 100), at(200, 100), at(200, 200), at(100, 200)]],
    };
    expect(areasReached(open, grid(S))).toEqual({ ids: ['A'], basis: 'shore' });
    const multi = {
      type: 'MultiPolygon' as const,
      coordinates: [rect(100, 100, 200, 200).coordinates, rect(1_500, 100, 1_600, 200).coordinates],
    };
    expect(sorted(areasReached(multi, grid(S)))).toEqual(['A', 'B']);
  });
});

describe('capsuleInterval', () => {
  it('finds where a segment comes within r of an edge, and nothing when it never does', () => {
    // Along the x axis from 0 to 100, against a vertical edge at x = 50 from y = 10 to 20.
    expect(capsuleInterval(0, 0, 100, 0, 50, 10, 50, 20, 5)).toBeNull();
    const hit = capsuleInterval(0, 0, 100, 0, 50, 10, 50, 20, 12) as [number, number];
    expect(hit[0]).toBeCloseTo((50 - Math.sqrt(44)) / 100, 9);
    expect(hit[1]).toBeCloseTo((50 + Math.sqrt(44)) / 100, 9);
    // A crossing at the 1 cm touch margin is a small interval around the crossing.
    const x = capsuleInterval(0, 0, 100, 0, 50, -10, 50, 10, REACH_TOUCH_M) as [number, number];
    expect(x[0]).toBeLessThan(0.5);
    expect(x[1]).toBeGreaterThan(0.5);
    // Parallel and inside the slab: the whole overlap.
    const par = capsuleInterval(0, 0, 100, 0, 20, 1, 80, 1, 2) as [number, number];
    expect(par[0]).toBeCloseTo(0.2 - Math.sqrt(3) / 100, 12);
    expect(par[1]).toBeCloseTo(0.8 + Math.sqrt(3) / 100, 12);
    // A degenerate edge is its one disk.
    const dot = capsuleInterval(0, 0, 100, 0, 50, 0, 50, 0, 1) as [number, number];
    expect(dot[0]).toBeCloseTo(0.49, 12);
    expect(dot[1]).toBeCloseTo(0.51, 12);
    // Parallel and outside the slab.
    expect(capsuleInterval(0, 0, 100, 0, 20, 5, 80, 5, 2)).toBeNull();
  });
});

describe('the town layer keys', () => {
  it('reads a subdivision county from its GEOID', () => {
    expect(countyKeyOfSubdivision('tiger/5000704375')).toBe('tiger/50007');
    expect(countyKeyOfSubdivision('tiger/50007')).toBeNull();
    expect(countyKeyOfSubdivision('relation/123')).toBeNull();
  });

  it('tells the not-defined water units from towns', () => {
    expect(isUndefinedSubdivision('tiger/3607500000')).toBe(true);
    expect(isUndefinedSubdivision('tiger/5000704375')).toBe(false);
    expect(isUndefinedSubdivision('tiger/36075')).toBe(false);
    expect(isUndefinedSubdivision('way/1')).toBe(false);
  });
});
