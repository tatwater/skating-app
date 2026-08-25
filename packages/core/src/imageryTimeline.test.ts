import type { Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import type { IndexedFrame, SeasonIndex } from './imageryArchive';
import {
  buildBodyTimeline,
  candidateFramesFor,
  FRAME_MAX_CLOUD_PCT,
  frameToRender,
  MIN_BODY_CLEAR_FRACTION,
  MIN_BODY_COVERAGE,
  nearestLandableStop,
  SEAM_MAX_GAP_DAYS,
  SEAM_MIN_ADDED_COVERAGE,
  type TimelineBody,
  type TimelineStop,
} from './imageryTimeline';

/** A square granule footprint around a coordinate, in degrees. */
const boxAround = (lat: number, lng: number, half = 0.5): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [lng - half, lat - half],
      [lng + half, lat - half],
      [lng + half, lat + half],
      [lng - half, lat + half],
      [lng - half, lat - half],
    ],
  ],
});

/** Champlain-ish, and comfortably over `SATELLITE_MIN_AREA_SQM`. */
const CHAMPLAIN: TimelineBody = {
  _id: 'champlain',
  name: 'Lake Champlain',
  interiorPoint: { lat: 44.5, lng: -73.3 },
  surfaceAreaSqM: 1_127_000_000,
};

/** A granule over Champlain, and one over Moosehead — different tiles, different pass days. */
const OVER_CHAMPLAIN = boxAround(44.5, -73.3);
const OVER_MOOSEHEAD = boxAround(45.6, -69.7);

const frame = (over: Partial<IndexedFrame> = {}): IndexedFrame => ({
  granuleId: 'S2C_18TXP_20260215_0_L2A',
  capturedAt: '2026-02-15T15:51:05Z',
  cloudCoverPct: 7.6,
  bodies: 9,
  band: 'visual',
  key: 'frames/winter-2025-26/S2C_18TXP_20260215_0_L2A.pmtiles',
  footprint: OVER_CHAMPLAIN,
  ...over,
});

const season = (frames: IndexedFrame[]): SeasonIndex => ({
  season: 'winter-2025-26',
  frames,
  firstCapturedAt: frames[0]?.capturedAt ?? null,
  lastCapturedAt: frames[frames.length - 1]?.capturedAt ?? null,
});

describe('buildBodyTimeline — coverage decides the denominator', () => {
  it('drops a frame whose granule never covered this body, rather than greying it out', () => {
    // The founder's cross-lake question, and the reason the answer is "not a stop at all": a pass over
    // Moosehead is not a date Champlain was ever going to have. Drawing it disabled would tell a
    // Champlain skater that something was withheld from them, which is not what happened.
    const timeline = buildBodyTimeline(
      season([frame(), frame({ granuleId: 'moosehead', footprint: OVER_MOOSEHEAD })]),
      CHAMPLAIN,
    );

    expect(timeline.stops).toHaveLength(1);
    expect(timeline.stops[0]?.frame.granuleId).toBe('S2C_18TXP_20260215_0_L2A');
    expect(timeline.notCovered).toBe(1);
  });

  it('keeps a covered frame as a blocked stop when the granule was clouded over', () => {
    const timeline = buildBodyTimeline(
      season([frame({ granuleId: 'clouded', cloudCoverPct: 94 })]),
      CHAMPLAIN,
    );

    expect(timeline.stops).toHaveLength(1);
    expect(timeline.stops[0]?.landable).toBe(false);
    expect(timeline.stops[0]?.blockedBy).toBe('cloud');
    // The number travels with the stop so the caption can be specific (D84 — the date and its caveat
    // are content, not furniture).
    expect(timeline.stops[0]?.frame.cloudCoverPct).toBe(94);
    expect(timeline.landableCount).toBe(0);
  });

  it('⚠ an unreported cloud fraction leaves the stop landable', () => {
    // `null` is "the source did not report one", which the archive type is explicit is never a guess.
    // Reading it as 100% would silently drop frames on the strength of a missing field.
    const timeline = buildBodyTimeline(
      season([frame({ granuleId: 'unreported', cloudCoverPct: null })]),
      CHAMPLAIN,
    );

    expect(timeline.stops[0]?.landable).toBe(true);
  });

  it('gates on the display threshold, not the more generous ingest one', () => {
    // 50% is inside @skating/imagery's DEFAULT_MAX_CLOUD_PCT of 60 — so the frame is in the bucket —
    // and outside the display gate, which is the whole reason the two constants are separate.
    const timeline = buildBodyTimeline(
      season([
        frame({ granuleId: 'just-under', cloudCoverPct: FRAME_MAX_CLOUD_PCT }),
        frame({ granuleId: 'just-over', cloudCoverPct: FRAME_MAX_CLOUD_PCT + 0.1 }),
        frame({ granuleId: 'ingested-but-useless', cloudCoverPct: 50 }),
      ]),
      CHAMPLAIN,
    );

    expect(timeline.stops.map((s) => s.landable)).toEqual([true, false, false]);
  });

  it('honours an override of the gate, for the admin editor that sees everything', () => {
    const timeline = buildBodyTimeline(season([frame({ cloudCoverPct: 94 })]), CHAMPLAIN, {
      maxCloudPct: 100,
    });

    expect(timeline.landableCount).toBe(1);
  });
});

describe('buildBodyTimeline — the gates that run before coverage', () => {
  it('offers no scrubber to a body too small for a 10 m pixel', () => {
    // D70/D75's floor. A pond resolves to a handful of grey-green pixels, and the conclusion available
    // to a skater looking at those is "this is broken" rather than "this sensor is coarse".
    const pond: TimelineBody = { ...CHAMPLAIN, surfaceAreaSqM: 4_107 };

    expect(buildBodyTimeline(season([frame()]), pond).stops).toEqual([]);
  });

  it("⚠ respects an operator's `off` even on a body that clears the floor", () => {
    // The override is takedown-shaped, so it has to win outright rather than be weighed.
    const suppressed: TimelineBody = { ...CHAMPLAIN, satelliteImagery: 'off' };

    expect(buildBodyTimeline(season([frame()]), suppressed).stops).toEqual([]);
  });

  it('tests coverage from the interior point, not the shoreline centroid', () => {
    // N6c-1's finding: `centroid` is Turf's pointOnFeature and sits 30.7 km off on Champlain — the one
    // point on the body most likely to fall the wrong side of a granule boundary. Here the stored
    // centroid is outside the granule and the interior point is inside; preferring the centroid would
    // drop a frame that covers the lake perfectly well.
    const body: TimelineBody = {
      ...CHAMPLAIN,
      centroid: { lat: 44.5, lng: -74.9 },
    };

    expect(buildBodyTimeline(season([frame()]), body).stops).toHaveLength(1);
  });

  it('returns an empty timeline when the body has no coordinate at all', () => {
    const placeless: TimelineBody = { name: 'nowhere', surfaceAreaSqM: 1_000_000 };

    expect(buildBodyTimeline(season([frame()]), placeless).stops).toEqual([]);
  });
});

describe('buildBodyTimeline — footprints, bands and counting', () => {
  it('⚠ keeps a footprint-less frame and counts it rather than dropping it silently', () => {
    // Fails open, which is the opposite of what revealMasks does with a failed union — and the
    // difference is what failure costs. A blank frame is a disappointment; a scrubber quietly missing
    // half a winter is the complaint this module exists to answer.
    const timeline = buildBodyTimeline(
      season([frame({ granuleId: 'pre-footprint', footprint: undefined })]),
      CHAMPLAIN,
    );

    expect(timeline.stops).toHaveLength(1);
    expect(timeline.coverageUnknown).toBe(1);
  });

  it('builds one timeline per band, so a date does not appear four times over', () => {
    const frames = [
      frame({ granuleId: 'visual', band: 'visual' }),
      frame({ granuleId: 'ndsi', band: 'ndsi' }),
      frame({ granuleId: 'scl', band: 'scl' }),
    ];

    expect(buildBodyTimeline(season(frames), CHAMPLAIN).stops).toHaveLength(1);
    expect(buildBodyTimeline(season(frames), CHAMPLAIN, { band: 'ndsi' }).stops).toHaveLength(1);
    expect(
      buildBodyTimeline(season(frames), CHAMPLAIN, { band: 'ndsi' }).stops[0]?.frame.granuleId,
    ).toBe('ndsi');
  });

  it('defaults to the true-colour band, which is all the archive holds today', () => {
    expect(buildBodyTimeline(season([frame()]), CHAMPLAIN).stops).toHaveLength(1);
  });

  it('inherits the index order, which the producer already sorted by capture time', () => {
    const timeline = buildBodyTimeline(
      season([
        frame({ granuleId: 'jan', capturedAt: '2026-01-04T15:51:05Z' }),
        frame({ granuleId: 'feb', capturedAt: '2026-02-15T15:51:05Z' }),
        frame({ granuleId: 'mar', capturedAt: '2026-03-02T15:51:05Z' }),
      ]),
      CHAMPLAIN,
    );

    expect(timeline.stops.map((s) => s.frame.granuleId)).toEqual(['jan', 'feb', 'mar']);
  });

  it('carries the season through, including when nothing survives', () => {
    expect(buildBodyTimeline(season([]), CHAMPLAIN).season).toBe('winter-2025-26');
    expect(
      buildBodyTimeline(season([frame()]), { ...CHAMPLAIN, satelliteImagery: 'off' }).season,
    ).toBe('winter-2025-26');
  });
});

describe('nearestLandableStop', () => {
  const stop = (landable: boolean): TimelineStop =>
    landable
      ? { frame: frame(), landable: true, basis: 'inferred' }
      : { frame: frame(), landable: false, blockedBy: 'cloud', basis: 'inferred' };

  it('slides past a blocked stop to the nearest one with a picture behind it', () => {
    expect(nearestLandableStop([stop(true), stop(false), stop(true)], 1)).toBe(0);
  });

  it('breaks a tie earlier, because a winter is read forward', () => {
    // Equidistant either side. Landing before an ambiguous gap and reading toward it matches how the
    // archive is actually used, and makes the result independent of which way the drag came from.
    expect(nearestLandableStop([stop(true), stop(false), stop(true)], 1)).toBe(0);
    expect(nearestLandableStop([stop(true), stop(false), stop(false), stop(true)], 1)).toBe(0);
  });

  it('stays put when the position is already landable', () => {
    expect(nearestLandableStop([stop(true), stop(true)], 1)).toBe(1);
  });

  it('reaches across a long blocked run', () => {
    expect(nearestLandableStop([stop(false), stop(false), stop(false), stop(true)], 0)).toBe(3);
  });

  it('returns null for a season fully clouded over this body', () => {
    // A real outcome, not an error — the caller has to render something honest for it.
    expect(nearestLandableStop([stop(false), stop(false)], 0)).toBeNull();
    expect(nearestLandableStop([], 0)).toBeNull();
  });
});

const statsFor = (
  granuleId: string,
  bodies: { waterBodyId: string; coveragePct?: number | null; clearPct?: number | null }[],
) => {
  const map = new Map([
    [
      granuleId,
      {
        granuleId,
        capturedAt: '2026-02-15T15:51:05Z',
        bodies: bodies.map((b) => ({
          waterBodyId: b.waterBodyId,
          coveragePct: b.coveragePct ?? 1,
          clearPct: b.clearPct ?? 0.95,
          pixels: 4107,
        })),
      },
    ],
  ]);
  return (id: string) => map.get(id);
};

describe('buildBodyTimeline — exact coverage, once a manifest is in hand', () => {
  it('⚠ a manifest that omits this lake is a real answer, not a gap', () => {
    // The cut is the authority on what it cut. Before manifests, a footprint containing the lake was
    // the best available guess and this frame would have become a stop that renders nothing.
    const timeline = buildBodyTimeline(season([frame()]), CHAMPLAIN, {
      stats: statsFor('S2C_18TXP_20260215_0_L2A', [{ waterBodyId: 'someone-else' }]),
    });

    expect(timeline.stops).toEqual([]);
    expect(timeline.notCovered).toBe(1);
  });

  it('marks a measured stop as such, and carries the row for the caption', () => {
    const timeline = buildBodyTimeline(season([frame()]), CHAMPLAIN, {
      stats: statsFor('S2C_18TXP_20260215_0_L2A', [
        { waterBodyId: 'champlain', coveragePct: 0.92, clearPct: 0.88 },
      ]),
    });

    expect(timeline.stops[0]?.basis).toBe('measured');
    expect(timeline.stops[0]?.stats?.clearPct).toBe(0.88);
    expect(timeline.coverageInferred).toBe(0);
  });

  it('⚠ rescues a half-covering pass that the footprint test would have thrown away', () => {
    // Champlain straddles tiles. The interior point sits outside this granule, so inference calls it
    // "not covered" — but the manifest says the pass reached 60% of the lake, which is most of it.
    const timeline = buildBodyTimeline(season([frame({ footprint: OVER_MOOSEHEAD })]), CHAMPLAIN, {
      stats: statsFor('S2C_18TXP_20260215_0_L2A', [{ waterBodyId: 'champlain', coveragePct: 0.6 }]),
    });

    expect(timeline.stops).toHaveLength(1);
    expect(timeline.stops[0]?.landable).toBe(true);
    expect(timeline.notCovered).toBe(0);
  });

  it('falls back to footprint inference with no manifest, and says so', () => {
    const timeline = buildBodyTimeline(season([frame()]), CHAMPLAIN);

    expect(timeline.stops[0]?.basis).toBe('inferred');
    expect(timeline.coverageInferred).toBe(1);
    expect(timeline.stops[0]?.stats).toBeUndefined();
  });

  it('falls back to inference when the body carries no id to look up', () => {
    const { _id, ...anonymous } = CHAMPLAIN;
    const timeline = buildBodyTimeline(season([frame()]), anonymous, {
      stats: statsFor('S2C_18TXP_20260215_0_L2A', [{ waterBodyId: 'champlain' }]),
    });

    expect(timeline.stops[0]?.basis).toBe('inferred');
  });
});

describe('buildBodyTimeline — the gates, once they are per-body', () => {
  it('prefers this lake’s own clear fraction over the granule figure', () => {
    // The whole point of the per-body pass: a granule 94% clouded over the White Mountains says
    // nothing about Champlain, and the granule-wide gate would have blocked this date.
    const timeline = buildBodyTimeline(season([frame({ cloudCoverPct: 94 })]), CHAMPLAIN, {
      stats: statsFor('S2C_18TXP_20260215_0_L2A', [{ waterBodyId: 'champlain', clearPct: 0.97 }]),
    });

    expect(timeline.stops[0]?.landable).toBe(true);
  });

  it('blocks on the per-body figure even when the granule looked fine', () => {
    const timeline = buildBodyTimeline(season([frame({ cloudCoverPct: 3 })]), CHAMPLAIN, {
      stats: statsFor('S2C_18TXP_20260215_0_L2A', [{ waterBodyId: 'champlain', clearPct: 0.1 }]),
    });

    expect(timeline.stops[0]?.landable).toBe(false);
    expect(timeline.stops[0]?.blockedBy).toBe('cloud');
  });

  it('keeps the same strictness the granule gate had, so accuracy changes and tolerance does not', () => {
    expect(MIN_BODY_CLEAR_FRACTION).toBeCloseTo(1 - FRAME_MAX_CLOUD_PCT / 100);
  });

  it('blocks a sliver on coverage rather than dropping it or calling it cloudy', () => {
    const timeline = buildBodyTimeline(season([frame()]), CHAMPLAIN, {
      stats: statsFor('S2C_18TXP_20260215_0_L2A', [
        { waterBodyId: 'champlain', coveragePct: 0.15, clearPct: 0.99 },
      ]),
    });

    expect(timeline.stops).toHaveLength(1);
    expect(timeline.stops[0]?.blockedBy).toBe('coverage');
  });

  it('⚠ coverage outranks cloud, so a cloudy sliver explains the right problem', () => {
    const timeline = buildBodyTimeline(season([frame()]), CHAMPLAIN, {
      stats: statsFor('S2C_18TXP_20260215_0_L2A', [
        { waterBodyId: 'champlain', coveragePct: 0.1, clearPct: 0.05 },
      ]),
    });

    expect(timeline.stops[0]?.blockedBy).toBe('coverage');
  });

  it('does not block on coverage the granule never measured', () => {
    // `coveragePct: null` is "the granule shipped without SCL", which is unmeasured rather than zero.
    const timeline = buildBodyTimeline(season([frame()]), CHAMPLAIN, {
      stats: statsFor('S2C_18TXP_20260215_0_L2A', [
        { waterBodyId: 'champlain', coveragePct: null, clearPct: null },
      ]),
    });

    expect(timeline.stops[0]?.landable).toBe(true);
  });

  it('⚠ never gates radar on cloud, and needs no mission check to get that right', () => {
    // A `vh` frame carries no clearPct and a null cloudCoverPct — not because the figure is missing
    // but because Sentinel-1 sees through cloud. The data shape alone produces the right answer.
    const timeline = buildBodyTimeline(
      season([frame({ granuleId: 'S1A', band: 'vh', cloudCoverPct: null })]),
      CHAMPLAIN,
      {
        band: 'vh',
        stats: (id) =>
          id === 'S1A'
            ? {
                granuleId: 'S1A',
                capturedAt: '2026-02-15T22:51:23Z',
                mission: 's1',
                platform: 'S1A',
                orbitDirection: 'ascending',
                bodies: [
                  { waterBodyId: 'champlain', coveragePct: 0.98, vhDb: -21.4, pixels: 4107 },
                ],
              }
            : undefined,
      },
    );

    expect(timeline.stops[0]?.landable).toBe(true);
    expect(timeline.stops[0]?.stats?.vhDb).toBe(-21.4);
  });

  it('honours the coverage override, for the admin editor that sees everything', () => {
    const timeline = buildBodyTimeline(season([frame()]), CHAMPLAIN, {
      minCoverage: 0,
      stats: statsFor('S2C_18TXP_20260215_0_L2A', [
        { waterBodyId: 'champlain', coveragePct: 0.02 },
      ]),
    });

    expect(timeline.landableCount).toBe(1);
    expect(MIN_BODY_COVERAGE).toBeGreaterThan(0);
  });
});

describe('candidateFramesFor — what to fetch manifests for', () => {
  it('narrows a season to the frames whose footprint reaches this lake', () => {
    const frames = candidateFramesFor(
      season([frame(), frame({ granuleId: 'moosehead', footprint: OVER_MOOSEHEAD })]),
      CHAMPLAIN,
    );

    expect(frames.map((f) => f.granuleId)).toEqual(['S2C_18TXP_20260215_0_L2A']);
  });

  it('keeps a footprint-less frame, because it cannot be ruled out', () => {
    expect(candidateFramesFor(season([frame({ footprint: undefined })]), CHAMPLAIN)).toHaveLength(
      1,
    );
  });

  it('respects the band, so a radar sweep does not fetch optical manifests', () => {
    const frames = candidateFramesFor(
      season([frame(), frame({ granuleId: 'S1A', band: 'vh' })]),
      CHAMPLAIN,
      { band: 'vh' },
    );

    expect(frames.map((f) => f.granuleId)).toEqual(['S1A']);
  });

  it('offers nothing for a body that gets no scrubber at all', () => {
    expect(
      candidateFramesFor(season([frame()]), { ...CHAMPLAIN, satelliteImagery: 'off' }),
    ).toEqual([]);
  });
});

describe('the branches that only show up at the edges', () => {
  it('candidateFramesFor offers nothing for a body with no coordinate', () => {
    expect(candidateFramesFor(season([frame()]), { name: 'nowhere' })).toEqual([]);
  });

  it('⚠ a coverage-blocked stop with no manifest row carries no stats to caption from', () => {
    // Reachable only through the override, since without a row `coveragePct` is null and the gate
    // never fires. Worth pinning: the stop must still be well-formed rather than half-built.
    const timeline = buildBodyTimeline(season([frame()]), CHAMPLAIN, { minCoverage: 0.5 });

    expect(timeline.stops[0]?.landable).toBe(true);
    expect(timeline.stops[0]?.stats).toBeUndefined();
  });
});

describe('buildBodyTimeline — the split-body seam', () => {
  const pairStats = (
    a: { granuleId: string; coveragePct: number },
    b: { granuleId: string; coveragePct: number },
  ) => {
    const map = new Map(
      [a, b].map((g) => [
        g.granuleId,
        {
          granuleId: g.granuleId,
          capturedAt: '2026-02-15T15:51:05Z',
          bodies: [
            { waterBodyId: 'champlain', coveragePct: g.coveragePct, clearPct: 0.95, pixels: 4107 },
          ],
        },
      ]),
    );
    return (id: string) => map.get(id);
  };

  it('pairs a lake bisected by a tile boundary on the same pass', () => {
    // The common case, and the one with no ambiguity: two granules from one pass, split by the same
    // boundary, so their coverages really are complementary.
    const timeline = buildBodyTimeline(
      season([
        frame({ granuleId: 'west', capturedAt: '2026-02-15T15:51:05Z' }),
        frame({ granuleId: 'east', capturedAt: '2026-02-15T15:51:05Z' }),
      ]),
      CHAMPLAIN,
      {
        stats: pairStats(
          { granuleId: 'west', coveragePct: 0.55 },
          { granuleId: 'east', coveragePct: 0.45 },
        ),
      },
    );

    expect(timeline.stops[0]?.companion?.frame.granuleId).toBe('east');
    expect(timeline.stops[1]?.companion?.frame.granuleId).toBe('west');
  });

  it('⚠ makes a coverage-blocked sliver landable once its other half is attached', () => {
    // Without the seam this frame is drawn, blocked, and useless. With it, a skater sees the whole
    // lake — as two dated halves rather than as one picture pretending to be whole.
    const timeline = buildBodyTimeline(
      season([
        frame({ granuleId: 'sliver', capturedAt: '2026-02-15T15:51:05Z' }),
        frame({ granuleId: 'rest', capturedAt: '2026-02-17T15:51:05Z' }),
      ]),
      CHAMPLAIN,
      {
        stats: pairStats(
          { granuleId: 'sliver', coveragePct: 0.2 },
          { granuleId: 'rest', coveragePct: 0.8 },
        ),
      },
    );

    expect(timeline.stops[0]?.landable).toBe(true);
    expect(timeline.stops[0]?.blockedBy).toBeUndefined();
    expect(timeline.stops[0]?.companion?.frame.granuleId).toBe('rest');
  });

  it('prefers the nearest pass in time, so the two dates are as close as the archive allows', () => {
    const stats = (id: string) =>
      ({
        near: {
          granuleId: 'near',
          capturedAt: '2026-02-17T00:00:00Z',
          bodies: [{ waterBodyId: 'champlain', coveragePct: 0.5, clearPct: 0.9, pixels: 100 }],
        },
        far: {
          granuleId: 'far',
          capturedAt: '2026-02-25T00:00:00Z',
          bodies: [{ waterBodyId: 'champlain', coveragePct: 0.5, clearPct: 0.9, pixels: 100 }],
        },
        primary: {
          granuleId: 'primary',
          capturedAt: '2026-02-15T00:00:00Z',
          bodies: [{ waterBodyId: 'champlain', coveragePct: 0.5, clearPct: 0.9, pixels: 100 }],
        },
      })[id];

    const timeline = buildBodyTimeline(
      season([
        frame({ granuleId: 'primary', capturedAt: '2026-02-15T00:00:00Z' }),
        frame({ granuleId: 'near', capturedAt: '2026-02-17T00:00:00Z' }),
        frame({ granuleId: 'far', capturedAt: '2026-02-25T00:00:00Z' }),
      ]),
      CHAMPLAIN,
      { stats },
    );

    expect(timeline.stops[0]?.companion?.frame.granuleId).toBe('near');
  });

  it('⚠ refuses a pairing wider than the gap cap, so a seam does not become a collage', () => {
    // A December half beside an April half would be one picture of a lake that was never in that
    // state. The labels make a seam honest; the cap stops it being absurd.
    const stats = (id: string) =>
      ({
        a: {
          granuleId: 'a',
          capturedAt: '2025-12-01T00:00:00Z',
          bodies: [{ waterBodyId: 'champlain', coveragePct: 0.5, clearPct: 0.9, pixels: 100 }],
        },
        b: {
          granuleId: 'b',
          capturedAt: '2026-04-01T00:00:00Z',
          bodies: [{ waterBodyId: 'champlain', coveragePct: 0.5, clearPct: 0.9, pixels: 100 }],
        },
      })[id];

    const timeline = buildBodyTimeline(
      season([
        frame({ granuleId: 'a', capturedAt: '2025-12-01T00:00:00Z' }),
        frame({ granuleId: 'b', capturedAt: '2026-04-01T00:00:00Z' }),
      ]),
      CHAMPLAIN,
      { stats },
    );

    expect(timeline.stops[0]?.companion).toBeUndefined();
    expect(SEAM_MAX_GAP_DAYS).toBeLessThan(120);
  });

  it('does not seam a frame that already has the whole lake', () => {
    const timeline = buildBodyTimeline(
      season([frame({ granuleId: 'whole' }), frame({ granuleId: 'other' })]),
      CHAMPLAIN,
      {
        stats: pairStats(
          { granuleId: 'whole', coveragePct: 1 },
          { granuleId: 'other', coveragePct: 0.5 },
        ),
      },
    );

    expect(timeline.stops[0]?.companion).toBeUndefined();
  });

  it('refuses a companion that adds almost nothing', () => {
    const timeline = buildBodyTimeline(
      season([frame({ granuleId: 'most' }), frame({ granuleId: 'crumb' })]),
      CHAMPLAIN,
      {
        stats: pairStats(
          { granuleId: 'most', coveragePct: 0.96 },
          { granuleId: 'crumb', coveragePct: 0.9 },
        ),
      },
    );

    // 1 − 0.96 = 0.04 of new lake, under SEAM_MIN_ADDED_COVERAGE. A hairline across 4% of a shoreline
    // reads as an artifact rather than as two observations.
    expect(timeline.stops[0]?.companion).toBeUndefined();
    expect(SEAM_MIN_ADDED_COVERAGE).toBeGreaterThan(0.04);
  });

  it('never seams when coverage was never measured', () => {
    const timeline = buildBodyTimeline(
      season([frame({ granuleId: 'a' }), frame({ granuleId: 'b' })]),
      CHAMPLAIN,
    );
    expect(timeline.stops.every((s) => s.companion === undefined)).toBe(true);
  });
});

describe('buildBodyTimeline — radar holds one orbit direction', () => {
  const radarStats = (passes: { id: string; direction: string }[]) => {
    const map = new Map(
      passes.map((p) => [
        p.id,
        {
          granuleId: p.id,
          capturedAt: '2026-02-15T22:51:23Z',
          mission: 's1',
          platform: 'S1A',
          orbitDirection: p.direction,
          bodies: [{ waterBodyId: 'champlain', coveragePct: 0.98, vhDb: -21.4, pixels: 4107 }],
        },
      ]),
    );
    return (id: string) => map.get(id);
  };

  const radarSeason = (ids: string[]) =>
    season(ids.map((id) => frame({ granuleId: id, band: 'vh', cloudCoverPct: null })));

  it('⚠ drops the passes that would make the lake move between dates', () => {
    // Sentinel-1 is right-looking, so ascending views a lake from the east and descending from the
    // west. A GRD geocoded from GCPs at a reference height displaces higher ground along the range
    // direction, which flips sign between the two. Observed live 2026-08-25 on Mascoma: two islands
    // jumping east, then west, as the scrubber advanced through alternating passes.
    const timeline = buildBodyTimeline(radarSeason(['a', 'b', 'c']), CHAMPLAIN, {
      band: 'vh',
      stats: radarStats([
        { id: 'a', direction: 'descending' },
        { id: 'b', direction: 'ascending' },
        { id: 'c', direction: 'descending' },
      ]),
    });

    expect(timeline.stops.map((s) => s.frame.granuleId)).toEqual(['a', 'c']);
    expect(timeline.orbit).toEqual({
      showing: 'descending',
      available: ['ascending', 'descending'],
    });
  });

  it('defaults to whichever direction passed this lake most often', () => {
    const timeline = buildBodyTimeline(radarSeason(['a', 'b', 'c']), CHAMPLAIN, {
      band: 'vh',
      stats: radarStats([
        { id: 'a', direction: 'ascending' },
        { id: 'b', direction: 'ascending' },
        { id: 'c', direction: 'descending' },
      ]),
    });

    expect(timeline.orbit?.showing).toBe('ascending');
  });

  it('honours an explicit direction', () => {
    const timeline = buildBodyTimeline(radarSeason(['a', 'b']), CHAMPLAIN, {
      band: 'vh',
      orbitDirection: 'descending',
      stats: radarStats([
        { id: 'a', direction: 'ascending' },
        { id: 'b', direction: 'descending' },
      ]),
    });

    expect(timeline.stops.map((s) => s.frame.granuleId)).toEqual(['b']);
  });

  it('⚠ does not count a filtered pass as "not covered", because it did reach the lake', () => {
    // It is excluded for comparability, not for absence. Folding it into `notCovered` would misreport
    // the archive's reach over this body.
    const timeline = buildBodyTimeline(radarSeason(['a', 'b']), CHAMPLAIN, {
      band: 'vh',
      stats: radarStats([
        { id: 'a', direction: 'descending' },
        { id: 'b', direction: 'ascending' },
      ]),
    });

    expect(timeline.notCovered).toBe(0);
  });

  it('leaves an optical timeline alone, with no mission check needed', () => {
    // Only radar manifests carry `orbitDirection`, so the filter never engages on optical — the data
    // shape decides, exactly as it does for the cloud gate.
    const timeline = buildBodyTimeline(season([frame()]), CHAMPLAIN, {
      stats: statsFor('S2C_18TXP_20260215_0_L2A', [{ waterBodyId: 'champlain' }]),
    });

    expect(timeline.orbit).toBeNull();
    expect(timeline.stops).toHaveLength(1);
  });
});

describe('nearestLandableStop — the direction a finger was going', () => {
  const s = (landable: boolean): TimelineStop =>
    landable
      ? { frame: frame(), landable: true, basis: 'measured' }
      : { frame: frame(), landable: false, blockedBy: 'cloud', basis: 'measured' };

  const around = [s(true), s(false), s(true)];

  it('⚠ breaks an exact tie toward the way the drag was heading', () => {
    // A drag that stalls on a clouded date sits exactly between two usable ones about as often as
    // not. Resolving that backwards sends the skater to a date they had already scrubbed past.
    expect(nearestLandableStop(around, 1, 1)).toBe(2);
    expect(nearestLandableStop(around, 1, -1)).toBe(0);
  });

  it('still prefers the genuinely nearer stop over the direction of travel', () => {
    // Direction breaks ties; it does not override distance, or a flick would jump the length of a
    // winter to reach a date on the correct side of the finger.
    const lopsided = [s(true), s(false), s(false), s(false), s(true)];
    expect(nearestLandableStop(lopsided, 1, 1)).toBe(0);
  });

  it('keeps the old earlier-on-tie behaviour when no direction is given', () => {
    expect(nearestLandableStop(around, 1)).toBe(0);
  });
});

describe('frameToRender — the picture never goes away', () => {
  const good = (id: string): TimelineStop => ({
    frame: frame({ granuleId: id }),
    landable: true,
    basis: 'measured',
  });
  const clouded: TimelineStop = {
    frame: frame({ granuleId: 'clouded' }),
    landable: false,
    blockedBy: 'cloud',
    basis: 'measured',
  };

  it('⚠ holds the last good picture while the thumb sits on a clouded date', () => {
    // Dragging across a fortnight of cloud should feel like passing over dates, not like the feature
    // switching itself off and on. The flash back to a bare polygon reads as breakage every time,
    // however correct it is about that particular date.
    const stops = [good('a'), clouded, good('c')];
    expect(frameToRender(stops, 1, stops[0] ?? null)?.frame.granuleId).toBe('a');
  });

  it('takes over the moment a landable stop is chosen', () => {
    const stops = [good('a'), clouded, good('c')];
    expect(frameToRender(stops, 2, stops[0] ?? null)?.frame.granuleId).toBe('c');
  });

  it('holds through an out-of-range index rather than clearing', () => {
    // The stop list can shrink as manifests sharpen coverage, and a stale index must not blank the
    // map on the way through.
    expect(frameToRender([good('a')], 9, good('a'))?.frame.granuleId).toBe('a');
  });

  it('has nothing to show before anything has been chosen', () => {
    expect(frameToRender([good('a')], null, null)).toBeNull();
  });
});
