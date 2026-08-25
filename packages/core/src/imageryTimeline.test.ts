import type { Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import type { IndexedFrame, SeasonIndex } from './imageryArchive';
import {
  buildBodyTimeline,
  FRAME_MAX_CLOUD_PCT,
  nearestLandableStop,
  type TimelineStop,
} from './imageryTimeline';
import type { ReferenceLinkBody } from './referenceLinks';

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
const CHAMPLAIN: ReferenceLinkBody = {
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
    const pond: ReferenceLinkBody = { ...CHAMPLAIN, surfaceAreaSqM: 4_107 };

    expect(buildBodyTimeline(season([frame()]), pond).stops).toEqual([]);
  });

  it("⚠ respects an operator's `off` even on a body that clears the floor", () => {
    // The override is takedown-shaped, so it has to win outright rather than be weighed.
    const suppressed: ReferenceLinkBody = { ...CHAMPLAIN, satelliteImagery: 'off' };

    expect(buildBodyTimeline(season([frame()]), suppressed).stops).toEqual([]);
  });

  it('tests coverage from the interior point, not the shoreline centroid', () => {
    // N6c-1's finding: `centroid` is Turf's pointOnFeature and sits 30.7 km off on Champlain — the one
    // point on the body most likely to fall the wrong side of a granule boundary. Here the stored
    // centroid is outside the granule and the interior point is inside; preferring the centroid would
    // drop a frame that covers the lake perfectly well.
    const body: ReferenceLinkBody = {
      ...CHAMPLAIN,
      centroid: { lat: 44.5, lng: -74.9 },
    };

    expect(buildBodyTimeline(season([frame()]), body).stops).toHaveLength(1);
  });

  it('returns an empty timeline when the body has no coordinate at all', () => {
    const placeless: ReferenceLinkBody = { name: 'nowhere', surfaceAreaSqM: 1_000_000 };

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
      ? { frame: frame(), landable: true }
      : { frame: frame(), landable: false, blockedBy: 'cloud' };

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
