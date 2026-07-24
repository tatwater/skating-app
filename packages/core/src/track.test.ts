import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { haversineMeters } from './geometry';
import {
  appendPoint,
  clipPathEnds,
  DEFAULT_MAX_ACCURACY_M,
  DEFAULT_MIN_DISTANCE_M,
  evaluateTrackPoint,
  processTrack,
  smoothTrack,
  type TrackPoint,
  toGeoJsonLineString,
  toGpx,
  trackMidpoint,
  trackStats,
  trimStationaryTail,
} from './track';

const T0 = Date.UTC(2026, 0, 15, 14, 0, 0);
/** Lake Morey-ish. One degree of longitude here is ~78 km; 0.0001° ≈ 7.8 m. */
const LAT = 43.9;
const LNG = -72.15;

function pt(over: Partial<TrackPoint> = {}): TrackPoint {
  return { lat: LAT, lng: LNG, t: T0, accuracy: 5, ...over };
}

/** A straight eastward track: `n` points, `stepM` apart, one per `stepSec`. */
function straightTrack(n: number, stepM = 20, stepSec = 3): TrackPoint[] {
  const degPerM = 1 / (111_320 * Math.cos((LAT * Math.PI) / 180));
  return Array.from({ length: n }, (_, i) =>
    pt({ lng: LNG + i * stepM * degPerM, t: T0 + i * stepSec * 1000 }),
  );
}

describe('evaluateTrackPoint / appendPoint (the gates)', () => {
  it('accepts the first valid fix', () => {
    expect(evaluateTrackPoint(null, pt())).toEqual({ accept: true });
  });

  it('rejects non-finite and out-of-range coordinates', () => {
    for (const bad of [
      { lat: Number.NaN },
      { lng: Number.NaN },
      { t: Number.NaN },
      { lat: Number.POSITIVE_INFINITY },
      { lat: 91 },
      { lng: -181 },
    ]) {
      expect(evaluateTrackPoint(null, pt(bad))).toEqual({ accept: false, reason: 'bad_fix' });
    }
  });

  it('rejects a fix worse than the accuracy gate, but keeps one with UNKNOWN accuracy (fail-open)', () => {
    expect(evaluateTrackPoint(null, pt({ accuracy: DEFAULT_MAX_ACCURACY_M + 1 }))).toEqual({
      accept: false,
      reason: 'poor_accuracy',
    });
    expect(evaluateTrackPoint(null, pt({ accuracy: DEFAULT_MAX_ACCURACY_M }))).toEqual({
      accept: true,
    });
    expect(evaluateTrackPoint(null, pt({ accuracy: undefined })).accept).toBe(true);
  });

  it('rejects a NaN accuracy — the gate is written so NaN falls to the reject branch', () => {
    expect(evaluateTrackPoint(null, pt({ accuracy: Number.NaN }))).toEqual({
      accept: false,
      reason: 'poor_accuracy',
    });
  });

  it('rejects a duplicate or backwards timestamp (replayed background delivery)', () => {
    const first = pt();
    expect(evaluateTrackPoint(first, pt({ t: T0 })).reason).toBe('out_of_order');
    expect(evaluateTrackPoint(first, pt({ t: T0 - 1000 })).reason).toBe('out_of_order');
  });

  it('culls a fix that has not moved far enough — the stationary gate', () => {
    const first = pt();
    const degPerM = 1 / (111_320 * Math.cos((LAT * Math.PI) / 180));
    const barelyMoved = pt({ lng: LNG + 1 * degPerM, t: T0 + 3000 }); // ~1 m
    const moved = pt({ lng: LNG + 10 * degPerM, t: T0 + 3000 }); // ~10 m
    expect(evaluateTrackPoint(first, barelyMoved).reason).toBe('stationary');
    expect(evaluateTrackPoint(first, moved).accept).toBe(true);
  });

  it('appendPoint pushes only accepted fixes and reports why it dropped one', () => {
    const points: TrackPoint[] = [];
    expect(appendPoint(points, pt()).accept).toBe(true);
    expect(appendPoint(points, pt({ t: T0 + 1000 })).reason).toBe('stationary');
    expect(appendPoint(points, pt({ accuracy: 500, t: T0 + 2000 })).reason).toBe('poor_accuracy');
    expect(points).toHaveLength(1);
  });

  it('property: an accepted point is always at least minDistance from the previous kept one', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            dLat: fc.double({ min: -0.01, max: 0.01, noNaN: true }),
            dLng: fc.double({ min: -0.01, max: 0.01, noNaN: true }),
            dt: fc.integer({ min: -5000, max: 20_000 }),
            accuracy: fc.double({ min: 0, max: 200, noNaN: true }),
          }),
          { maxLength: 60 },
        ),
        (raw) => {
          const points: TrackPoint[] = [];
          let t = T0;
          for (const r of raw) {
            t += r.dt;
            appendPoint(points, { lat: LAT + r.dLat, lng: LNG + r.dLng, t, accuracy: r.accuracy });
          }
          for (let i = 1; i < points.length; i++) {
            const a = points[i - 1] as TrackPoint;
            const b = points[i] as TrackPoint;
            expect(haversineMeters(a, b)).toBeGreaterThanOrEqual(DEFAULT_MIN_DISTANCE_M);
            expect(b.t).toBeGreaterThan(a.t); // and time is strictly increasing
            expect(b.accuracy as number).toBeLessThanOrEqual(DEFAULT_MAX_ACCURACY_M);
          }
        },
      ),
    );
  });
});

describe('smoothTrack', () => {
  it('preserves length, order and timestamps', () => {
    const track = straightTrack(10);
    const smoothed = smoothTrack(track);
    expect(smoothed).toHaveLength(track.length);
    expect(smoothed.map((p) => p.t)).toEqual(track.map((p) => p.t));
  });

  it('leaves a track of fewer than 3 points alone', () => {
    const two = straightTrack(2);
    expect(smoothTrack(two)).toEqual(two);
  });

  it('pulls a single jittery outlier back toward the line', () => {
    const track = straightTrack(9);
    const outlierIndex = 4;
    const strayed = track.map((p, i) => (i === outlierIndex ? { ...p, lat: p.lat + 0.0005 } : p)); // ~55 m off
    const smoothed = smoothTrack(strayed);
    const before = Math.abs((strayed[outlierIndex] as TrackPoint).lat - LAT);
    const after = Math.abs((smoothed[outlierIndex] as TrackPoint).lat - LAT);
    expect(after).toBeLessThan(before);
  });

  it('weights by accuracy — a confident neighbour pulls harder than a fuzzy one', () => {
    const base = straightTrack(5);
    const withFuzzyNeighbour = base.map((p, i) =>
      i === 0 ? { ...p, lat: p.lat + 0.001, accuracy: 45 } : p,
    );
    const withSharpNeighbour = base.map((p, i) =>
      i === 0 ? { ...p, lat: p.lat + 0.001, accuracy: 1 } : p,
    );
    const fuzzyPull = (smoothTrack(withFuzzyNeighbour)[1] as TrackPoint).lat;
    const sharpPull = (smoothTrack(withSharpNeighbour)[1] as TrackPoint).lat;
    expect(sharpPull).toBeGreaterThan(fuzzyPull);
  });

  it('survives points with unknown or zero accuracy without producing NaN', () => {
    const track = straightTrack(6).map((p, i) => ({
      ...p,
      accuracy: i % 2 === 0 ? undefined : 0,
    }));
    for (const p of smoothTrack(track)) {
      expect(Number.isFinite(p.lat)).toBe(true);
      expect(Number.isFinite(p.lng)).toBe(true);
    }
  });
});

describe('trackStats', () => {
  it('is all-zero / null for an empty track', () => {
    expect(trackStats([])).toMatchObject({
      distanceMeters: 0,
      elapsedSeconds: 0,
      movingSeconds: 0,
      startTime: null,
      endTime: null,
      pointCount: 0,
      avgMovingSpeedMps: null,
    });
  });

  it('sums distance and spans the endpoints', () => {
    const track = straightTrack(11, 20, 3); // 10 segments × 20 m, 3 s apart
    const stats = trackStats(track);
    expect(stats.distanceMeters).toBeCloseTo(200, 0);
    expect(stats.elapsedSeconds).toBeCloseTo(30);
    expect(stats.startTime).toBe(T0);
    expect(stats.endTime).toBe(T0 + 30_000);
    expect(stats.pointCount).toBe(11);
  });

  it('excludes a mid-skate stop from moving time but not from elapsed', () => {
    const before = straightTrack(5, 20, 3); // 4 × 20 m in 12 s
    const lastBefore = before.at(-1) as TrackPoint;
    // A 30-minute break: same place, much later.
    const afterBreak: TrackPoint = {
      ...lastBefore,
      t: lastBefore.t + 30 * 60_000,
      lng: lastBefore.lng + 0.0003,
    };
    const stats = trackStats([...before, afterBreak]);
    expect(stats.elapsedSeconds).toBeCloseTo(12 + 1800);
    expect(stats.movingSeconds).toBeCloseTo(12); // the break segment is below the moving-speed floor
    expect(stats.avgMovingSpeedMps).toBeGreaterThan(0);
  });

  it('property: moving time never exceeds elapsed time', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            dLng: fc.double({ min: 0, max: 0.002, noNaN: true }),
            dt: fc.integer({ min: 1, max: 60_000 }),
          }),
          { minLength: 2, maxLength: 40 },
        ),
        (steps) => {
          let t = T0;
          let lng = LNG;
          const track = steps.map((s) => {
            t += s.dt;
            lng += s.dLng;
            return pt({ lng, t });
          });
          const stats = trackStats(track);
          expect(stats.movingSeconds).toBeLessThanOrEqual(stats.elapsedSeconds + 1e-6);
          expect(stats.distanceMeters).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});

describe('trimStationaryTail', () => {
  it('cuts a long parked tail, keeping the moment the skater actually stopped', () => {
    // 50 m strides, so the previous stride sits outside the 30 m tail radius and the cut point is
    // unambiguous. (With strides shorter than the radius the trim legitimately eats back a point or
    // two — that's the radius doing its job, not an off-by-one.)
    const skate = straightTrack(10, 50, 3);
    const end = skate.at(-1) as TrackPoint;
    // Forgot to stop: an hour of jitter within a few metres of the last stride.
    const tail = Array.from({ length: 12 }, (_, i) =>
      pt({ lat: end.lat + 0.00001 * i, lng: end.lng, t: end.t + (i + 1) * 5 * 60_000 }),
    );
    const trimmed = trimStationaryTail([...skate, ...tail]);
    expect(trimmed).toHaveLength(skate.length);
    expect(trimmed.at(-1)?.t).toBe(end.t);
  });

  it('leaves a short stop at the end alone', () => {
    const skate = straightTrack(10, 20, 3);
    const end = skate.at(-1) as TrackPoint;
    const shortPause = [pt({ lat: end.lat, lng: end.lng, t: end.t + 60_000 })];
    const track = [...skate, ...shortPause];
    expect(trimStationaryTail(track)).toHaveLength(track.length);
  });

  it('leaves a moving track untouched, and never empties a track', () => {
    const skate = straightTrack(20, 20, 3);
    expect(trimStationaryTail(skate)).toEqual(skate);
    // A track that never moved at all: everything is "the tail", so we keep it rather than return [].
    const parked = Array.from({ length: 20 }, (_, i) => pt({ t: T0 + i * 60_000 }));
    expect(trimStationaryTail(parked).length).toBeGreaterThan(0);
  });
});

describe('toGeoJsonLineString / trackMidpoint', () => {
  it('emits [lng, lat] positions in spec order', () => {
    const line = toGeoJsonLineString(straightTrack(3));
    expect(line?.type).toBe('LineString');
    expect(line?.coordinates[0]).toEqual([LNG, LAT]);
  });

  it('carries elevation as the third ordinate only where present', () => {
    const track = [pt({ elevation: 130.4 }), pt({ lng: LNG + 0.001, t: T0 + 3000 })];
    const line = toGeoJsonLineString(track);
    expect(line?.coordinates[0]).toHaveLength(3);
    expect(line?.coordinates[1]).toHaveLength(2);
  });

  it('returns null below two points rather than a degenerate line', () => {
    expect(toGeoJsonLineString([])).toBeNull();
    expect(toGeoJsonLineString([pt()])).toBeNull();
  });

  it('trackMidpoint returns a coord from the middle of the track', () => {
    expect(trackMidpoint([])).toBeNull();
    const track = straightTrack(5);
    expect(trackMidpoint(track)).toEqual({ lat: LAT, lng: (track[2] as TrackPoint).lng });
  });
});

describe('toGpx', () => {
  const track = [
    pt({ elevation: 130.44 }),
    pt({ lng: LNG + 0.001, t: T0 + 3000 }),
    pt({ lng: LNG + 0.002, t: T0 + 6000 }),
  ];

  it('emits a GPX 1.1 document with one trkseg and one trkpt per point', () => {
    const gpx = toGpx(track, { name: 'Afternoon skate', type: 'IceSkate' }) as string;
    expect(gpx).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(gpx).toContain('<gpx version="1.1"');
    expect(gpx).toContain('xmlns="http://www.topografix.com/GPX/1/1"');
    expect(gpx.match(/<trkpt /g)).toHaveLength(3);
    expect(gpx.match(/<trkseg>/g)).toHaveLength(1);
    expect(gpx).toContain('<type>IceSkate</type>');
    expect(gpx).toContain('<ele>130.4</ele>');
    expect(gpx).toContain(`<time>${new Date(T0).toISOString()}</time>`);
  });

  it('puts lat/lon in attributes in the right order', () => {
    const gpx = toGpx(track, { name: 'x' }) as string;
    expect(gpx).toContain(`<trkpt lat="${LAT.toFixed(7)}" lon="${LNG.toFixed(7)}">`);
  });

  it('XML-escapes names and descriptions', () => {
    const gpx = toGpx(track, {
      name: `Ben & Jerry's <lake>`,
      description: '"quoted"',
    }) as string;
    expect(gpx).toContain('Ben &amp; Jerry&apos;s &lt;lake&gt;');
    expect(gpx).toContain('&quot;quoted&quot;');
    expect(gpx).not.toMatch(/<name>[^<]*<lake>/);
  });

  it('returns null for a track too short to be an activity', () => {
    expect(toGpx([], { name: 'x' })).toBeNull();
    expect(toGpx([pt()], { name: 'x' })).toBeNull();
  });

  it('property: emits exactly one trkpt per point, always well-formed pairs of tags', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 50 }), (n) => {
        const gpx = toGpx(straightTrack(n), { name: 'skate' }) as string;
        expect(gpx.match(/<trkpt /g)).toHaveLength(n);
        expect(gpx.match(/<\/trkpt>/g)).toHaveLength(n);
      }),
    );
  });
});

describe('processTrack (the one canonical pipeline)', () => {
  it('smooths, trims the tail, and measures what it kept', () => {
    const skate = straightTrack(20, 20, 3);
    const end = skate.at(-1) as TrackPoint;
    const tail = Array.from({ length: 10 }, (_, i) =>
      pt({ lat: end.lat, lng: end.lng, t: end.t + (i + 1) * 5 * 60_000 }),
    );
    const result = processTrack([...skate, ...tail]);
    expect(result.points.length).toBeLessThan(skate.length + tail.length);
    expect(result.stats.pointCount).toBe(result.points.length);
    // The stats describe the *stored* geometry, not the raw buffer.
    expect(result.path?.coordinates).toHaveLength(result.points.length);
    expect(result.stats.endTime).toBe(result.points.at(-1)?.t);
  });

  it('handles a track too short to encode without throwing', () => {
    const result = processTrack([pt()]);
    expect(result.path).toBeNull();
    expect(result.stats.pointCount).toBe(1);
  });
});

describe('clipPathEnds (D58 put-in-gated clipping)', () => {
  it('removes at least the clip distance from each end', () => {
    const track = straightTrack(60, 20, 3); // 60 points, 20 m apart = ~1.18 km
    const clipped = clipPathEnds(
      toGeoJsonLineString(track) as NonNullable<ReturnType<typeof toGeoJsonLineString>>,
      150,
    );
    expect(clipped).not.toBeNull();
    if (!clipped) return;
    const first = clipped.coordinates[0] as number[];
    const last = clipped.coordinates.at(-1) as number[];
    const origin = { lat: LAT, lng: LNG };
    const originalEnd = { lat: LAT, lng: (track.at(-1) as TrackPoint).lng };
    expect(
      haversineMeters(origin, { lat: first[1] as number, lng: first[0] as number }),
    ).toBeGreaterThanOrEqual(150);
    expect(
      haversineMeters(originalEnd, { lat: last[1] as number, lng: last[0] as number }),
    ).toBeGreaterThanOrEqual(150);
  });

  it('drops a track that is ENTIRELY endpoints rather than rendering a stub at the put-in', () => {
    // A 200 m skate: clipping 150 m from each end leaves nothing worth drawing, and what it would
    // leave points straight at where someone got on the ice.
    const short = straightTrack(10, 20, 3);
    expect(clipPathEnds(toGeoJsonLineString(short) as never, 150)).toBeNull();
  });

  it('keeps only real recorded positions — it never fabricates an interpolated endpoint', () => {
    const track = straightTrack(60, 20, 3);
    const line = toGeoJsonLineString(track) as NonNullable<ReturnType<typeof toGeoJsonLineString>>;
    const clipped = clipPathEnds(line, 150);
    expect(clipped).not.toBeNull();
    if (!clipped) return;
    const originalPositions = new Set(line.coordinates.map((c) => JSON.stringify(c)));
    for (const coord of clipped.coordinates) {
      expect(originalPositions.has(JSON.stringify(coord))).toBe(true);
    }
  });

  it('is a no-op for a zero clip distance', () => {
    const line = toGeoJsonLineString(straightTrack(20)) as never;
    expect(clipPathEnds(line, 0)).toEqual(line);
  });
});
