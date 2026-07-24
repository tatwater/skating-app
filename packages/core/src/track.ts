/**
 * GPS **track** recording + post-processing (Phase 8, the A-input) — pure, so the same filtering,
 * smoothing and encoding run on the phone, on the server, and in tests without a GPS radio.
 *
 * This is the front half of the A→B→C pipeline: the native recorder feeds raw OS fixes through
 * `appendPoint` into a durable buffer, and at session end the buffer is smoothed, trimmed, measured,
 * and encoded twice — as a GeoJSON `LineString` for our own store (`gpsActivities.path`, the repo's
 * "geometry is GeoJSON, never encoded-polyline" convention) and as **GPX** for the Strava upload.
 *
 * **Why the track is worth this care.** It's the trust signal that lets a skate create a water body
 * (D14/D36) and the extent drawn on a public report (D58) — a jittery, uncut track would inflate
 * distance, wander off the lake, and hand `pathToBody` a garbage polygon. Everything here is a
 * conservative filter: we drop fixes we don't believe, never invent ones we didn't get.
 *
 * Reuses the on-ice primitives rather than re-deriving geodesy: `haversineMeters` from `geometry.ts`
 * for every distance, and the **NaN-safe gate** idiom from `hazardProjection.ts` — comparisons are
 * written so a `NaN` or a missing value falls to the *reject* branch instead of silently passing.
 */

import type { LineString } from 'geojson';
import { haversineMeters, type LatLng } from './geometry';

/**
 * One recorded GPS fix. A superset of `hazardProjection.ts`'s `DirectionalFix` (same `LatLng`), with
 * the fields a track needs and an alert doesn't: a timestamp, an accuracy estimate, and elevation.
 */
export interface TrackPoint {
  lat: number;
  lng: number;
  /** Metres above the WGS84 ellipsoid, when the OS supplies it. */
  elevation?: number;
  /** Fix time, epoch ms. */
  t: number;
  /** Horizontal accuracy radius in metres — smaller is better. Absent ⇒ unknown. */
  accuracy?: number;
  /** Ground speed, m/s (`< 0` or absent ⇒ unknown). */
  speed?: number;
  /** Course over ground, degrees clockwise from north (`< 0` or absent ⇒ unknown). */
  heading?: number;
}

/** Why a fix was dropped — surfaced so the recorder UI can explain a stalled point count. */
export type TrackPointRejection =
  | 'bad_fix' // non-finite or out-of-range coordinates
  | 'poor_accuracy' // accuracy radius worse than the gate
  | 'out_of_order' // timestamp not after the previous kept fix (duplicate / replayed delivery)
  | 'stationary'; // hasn't moved far enough from the previous kept fix to be a new point

/** The verdict on one candidate fix. `accept: false` always carries a reason. */
export interface TrackPointDecision {
  accept: boolean;
  reason?: TrackPointRejection;
}

export interface TrackFilterOptions {
  /**
   * Drop fixes whose accuracy radius is worse than this (metres). The Record GPS profile targets ~5 m;
   * 50 m admits a cold-start or tree-line fix while still rejecting the wild ones a phone emits in the
   * first seconds. A fix with **unknown** accuracy is kept — fail-open, like every other
   * "we can't tell" branch in this codebase.
   */
  maxAccuracyMeters?: number;
  /**
   * Minimum movement from the previous kept fix (metres) for a new point. This is the stationary cull:
   * standing on the ice tightening a lace shouldn't accumulate a hairball of jitter at one spot, which
   * would both inflate distance and drag `pathToBody`'s hull.
   */
  minDistanceMeters?: number;
}

export const DEFAULT_MAX_ACCURACY_M = 50;
export const DEFAULT_MIN_DISTANCE_M = 5;

/** Is this a usable coordinate at all? Rejects `NaN`, `±Infinity`, and out-of-range degrees. */
function isValidCoord(p: TrackPoint): boolean {
  return (
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Number.isFinite(p.t) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    p.lng >= -180 &&
    p.lng <= 180
  );
}

/**
 * Decide whether a fix joins the track, given the previous **kept** fix (`null` for the first).
 *
 * Pure and O(1), so the recorder can call it on every OS delivery without walking the buffer. Note the
 * gate polarity: each test is written as `!(good)` so a `NaN` accuracy or timestamp lands in the reject
 * branch rather than sneaking through a `>` comparison that's false for `NaN` either way.
 */
export function evaluateTrackPoint(
  previous: TrackPoint | null,
  point: TrackPoint,
  opts: TrackFilterOptions = {},
): TrackPointDecision {
  const maxAccuracy = opts.maxAccuracyMeters ?? DEFAULT_MAX_ACCURACY_M;
  const minDistance = opts.minDistanceMeters ?? DEFAULT_MIN_DISTANCE_M;

  if (!isValidCoord(point)) return { accept: false, reason: 'bad_fix' };
  // Unknown accuracy is kept (fail-open); a *known* accuracy must be within the gate — and `!(x <= max)`
  // rejects NaN, where `x > max` would have admitted it.
  if (point.accuracy !== undefined && !(point.accuracy <= maxAccuracy)) {
    return { accept: false, reason: 'poor_accuracy' };
  }
  if (previous === null) return { accept: true };
  if (!(point.t > previous.t)) return { accept: false, reason: 'out_of_order' };
  if (!(haversineMeters(previous, point) >= minDistance)) {
    return { accept: false, reason: 'stationary' };
  }
  return { accept: true };
}

/**
 * Append a fix to a growing recording buffer, applying the gates. **Mutates `points`** — deliberately,
 * because this runs once per OS fix for hours and copying the buffer each time would be quadratic. The
 * decision logic itself is the pure `evaluateTrackPoint`; this is the thin push on top.
 *
 * A `stationary` rejection is also how the recorder detects "I forgot to stop it": no accepted point for
 * a long stretch means the phone hasn't moved.
 */
export function appendPoint(
  points: TrackPoint[],
  point: TrackPoint,
  opts: TrackFilterOptions = {},
): TrackPointDecision {
  const decision = evaluateTrackPoint(points.at(-1) ?? null, point, opts);
  if (decision.accept) points.push(point);
  return decision;
}

export interface SmoothOptions {
  /** Points averaged per output point (odd; clamped to ≥1). Larger = smoother and laggier. */
  windowSize?: number;
}

export const DEFAULT_SMOOTH_WINDOW = 5;

/**
 * Light **accuracy-weighted** smoothing over a centered sliding window.
 *
 * Weighting by `1/accuracy` means a confident fix pulls the line toward itself and a fuzzy one barely
 * moves it — better than a plain mean, which lets one bad fix at the edge of the gate yank the track.
 * Timestamps, speed, heading and elevation pass through untouched: we are de-jittering *position*, not
 * rewriting when things happened.
 *
 * Endpoints shrink their window rather than being dropped or duplicated, so `smoothTrack` always
 * returns exactly as many points as it was given, in order.
 */
export function smoothTrack(points: readonly TrackPoint[], opts: SmoothOptions = {}): TrackPoint[] {
  const window = Math.max(1, Math.floor(opts.windowSize ?? DEFAULT_SMOOTH_WINDOW));
  if (window <= 1 || points.length < 3) return [...points];
  const half = Math.floor(window / 2);

  return points.map((point, i) => {
    const from = Math.max(0, i - half);
    const to = Math.min(points.length - 1, i + half);
    let latSum = 0;
    let lngSum = 0;
    let weightSum = 0;
    for (let k = from; k <= to; k++) {
      const p = points[k] as TrackPoint;
      // Unknown or absurd accuracy still gets a finite weight — never let a missing field zero out a
      // real position, and never divide by zero on a (nonsensical) accuracy of 0.
      const accuracy = Number.isFinite(p.accuracy) ? Math.max(1, p.accuracy as number) : 10;
      const weight = 1 / accuracy;
      latSum += p.lat * weight;
      lngSum += p.lng * weight;
      weightSum += weight;
    }
    return { ...point, lat: latSum / weightSum, lng: lngSum / weightSum };
  });
}

/** Aggregate measurements over a finished track. */
export interface TrackStats {
  /** Total great-circle distance along the track, metres. */
  distanceMeters: number;
  /** Wall-clock span, seconds — `endTime − startTime`. */
  elapsedSeconds: number;
  /**
   * Time actually spent moving, seconds — segments slower than `minMovingSpeedMps` are excluded, so a
   * lunch stop on the ice doesn't count. This is what `gpsActivities.elapsedSeconds` stores (the schema
   * comment calls it the moving/elapsed time that *excludes pauses*), and what Strava shows as moving time.
   */
  movingSeconds: number;
  /** First fix time, epoch ms (`null` for an empty track). */
  startTime: number | null;
  /** Last fix time, epoch ms (`null` for an empty track). */
  endTime: number | null;
  /** Fixes in the track. */
  pointCount: number;
  /** Mean speed over the moving portion, m/s (`null` when nothing moved). */
  avgMovingSpeedMps: number | null;
}

export interface TrackStatsOptions {
  /** Segments below this implied speed count as stopped (m/s). ~walking pace, matching the on-ice floor. */
  minMovingSpeedMps?: number;
}

export const DEFAULT_MIN_MOVING_SPEED_MPS = 0.5;

/** Measure a finished track: distance, elapsed vs moving time, and the endpoints for the report window. */
export function trackStats(
  points: readonly TrackPoint[],
  opts: TrackStatsOptions = {},
): TrackStats {
  const minSpeed = opts.minMovingSpeedMps ?? DEFAULT_MIN_MOVING_SPEED_MPS;
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) {
    return {
      distanceMeters: 0,
      elapsedSeconds: 0,
      movingSeconds: 0,
      startTime: null,
      endTime: null,
      pointCount: 0,
      avgMovingSpeedMps: null,
    };
  }

  let distanceMeters = 0;
  let movingSeconds = 0;
  let movingMeters = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as TrackPoint;
    const b = points[i] as TrackPoint;
    const meters = haversineMeters(a, b);
    const seconds = (b.t - a.t) / 1000;
    distanceMeters += meters;
    // Implied speed from the segment itself, not the OS `speed` field — the OS value is per-fix and
    // often missing, while this is exactly the quantity "were they moving between these two points".
    if (seconds > 0 && meters / seconds >= minSpeed) {
      movingSeconds += seconds;
      movingMeters += meters;
    }
  }

  return {
    distanceMeters,
    elapsedSeconds: (last.t - first.t) / 1000,
    movingSeconds,
    startTime: first.t,
    endTime: last.t,
    pointCount: points.length,
    avgMovingSpeedMps: movingSeconds > 0 ? movingMeters / movingSeconds : null,
  };
}

export interface TrimTailOptions {
  /** Points within this distance of the final fix count as "the same place" (metres). */
  radiusMeters?: number;
  /** Only trim when the stationary run lasted at least this long (seconds). */
  minTailSeconds?: number;
}

export const DEFAULT_TAIL_RADIUS_M = 30;
export const DEFAULT_MIN_TAIL_SECONDS = 300;

/**
 * Trim a **left-recording tail** — the classic "took my skates off, drove home, remembered an hour
 * later." Walks back from the end while the fixes stay within `radiusMeters` of the final position and,
 * if that run lasted at least `minTailSeconds`, cuts it — keeping its **first** point, so the track
 * still ends where the skater actually stopped rather than at their last stride.
 *
 * Only trims a *trailing* stop. A mid-skate break is real information (and the skater did return to the
 * ice), so it stays; only `trackStats`' moving-time split accounts for it.
 */
export function trimStationaryTail(
  points: readonly TrackPoint[],
  opts: TrimTailOptions = {},
): TrackPoint[] {
  const radius = opts.radiusMeters ?? DEFAULT_TAIL_RADIUS_M;
  const minTail = opts.minTailSeconds ?? DEFAULT_MIN_TAIL_SECONDS;
  const last = points.at(-1);
  if (!last || points.length < 3) return [...points];

  let start = points.length - 1;
  while (start > 0 && haversineMeters(points[start - 1] as TrackPoint, last) <= radius) start--;
  const tailSeconds = (last.t - (points[start] as TrackPoint).t) / 1000;
  if (start === 0 || tailSeconds < minTail) return [...points];
  return points.slice(0, start + 1);
}

/**
 * Encode a track as a GeoJSON `LineString` — what `gpsActivities.path` stores and what both maps draw
 * straight from (no encoded-polyline transport; the repo keeps geometry as GeoJSON everywhere).
 *
 * Elevation rides along as the optional third ordinate where the OS gave us one, per the GeoJSON spec.
 * Returns `null` below two points: a one-fix "line" isn't a line, and every consumer (`pathToBody`,
 * `polygonBBox`, the map layers) would rather have an explicit absence than a degenerate geometry.
 */
export function toGeoJsonLineString(points: readonly TrackPoint[]): LineString | null {
  if (points.length < 2) return null;
  return {
    type: 'LineString',
    coordinates: points.map((p) =>
      p.elevation !== undefined && Number.isFinite(p.elevation)
        ? [p.lng, p.lat, p.elevation]
        : [p.lng, p.lat],
    ),
  };
}

/** The centre-ish point of a track — the coord we resolve to a water body first (D44). */
export function trackMidpoint(points: readonly TrackPoint[]): LatLng | null {
  if (points.length === 0) return null;
  const mid = points[Math.floor(points.length / 2)] as TrackPoint;
  return { lat: mid.lat, lng: mid.lng };
}

/** Metadata written into the GPX header for Strava. */
export interface GpxMeta {
  /** Activity name, e.g. "Afternoon skate on Lake Morey". */
  name: string;
  description?: string;
  /**
   * The GPX `<type>` on the track. Strava reads this as a hint, but GPX has no formal sport vocabulary,
   * so the upload flow **also** sets `sport_type: 'IceSkate'` via `PUT /activities/{id}` after
   * processing — this alone is not enough to land the activity as an ice skate.
   */
  type?: string;
}

/** XML-escape a text node / attribute value. A lake called "Ben & Jerry's" must not break the document. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Trim a coordinate to ~1 cm of precision — GPS noise past 7 decimals is fiction, and it halves the payload. */
function coord(value: number): string {
  return value.toFixed(7);
}

/**
 * Emit **GPX 1.1** for the Strava upload (`POST /api/v3/uploads`, `data_type=gpx`).
 *
 * Hand-rolled rather than pulling a dependency: GPX is a handful of elements, and a string emitter is
 * far easier to keep honest (and to test) than a generic XML library. GPX was chosen over FIT as the v1
 * format — trivial to emit, universally accepted; FIT's extra richness (laps, HR passthrough) is only
 * worth it if users ask for watch-parity metadata.
 *
 * Returns `null` for a track too short to be an activity, so callers never upload an empty file.
 */
export function toGpx(points: readonly TrackPoint[], meta: GpxMeta): string | null {
  if (points.length < 2) return null;
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Skating" xmlns="http://www.topografix.com/GPX/1/1" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
    '  <metadata>',
    `    <name>${escapeXml(meta.name)}</name>`,
    `    <time>${new Date((points[0] as TrackPoint).t).toISOString()}</time>`,
    '  </metadata>',
    '  <trk>',
    `    <name>${escapeXml(meta.name)}</name>`,
  ];
  if (meta.description) lines.push(`    <desc>${escapeXml(meta.description)}</desc>`);
  if (meta.type) lines.push(`    <type>${escapeXml(meta.type)}</type>`);
  lines.push('    <trkseg>');
  for (const p of points) {
    lines.push(`      <trkpt lat="${coord(p.lat)}" lon="${coord(p.lng)}">`);
    if (p.elevation !== undefined && Number.isFinite(p.elevation)) {
      lines.push(`        <ele>${p.elevation.toFixed(1)}</ele>`);
    }
    lines.push(`        <time>${new Date(p.t).toISOString()}</time>`);
    lines.push('      </trkpt>');
  }
  lines.push('    </trkseg>', '  </trk>', '</gpx>');
  return `${lines.join('\n')}\n`;
}

/** The full post-processing pass a finished recording goes through before it becomes a `gpsActivities` row. */
export interface ProcessedTrack {
  points: TrackPoint[];
  path: LineString | null;
  stats: TrackStats;
}

/**
 * Smooth → trim the left-recording tail → measure. One call so the recorder, the ingest mutation and
 * the tests can't apply the steps in different orders and get different numbers for the same skate.
 *
 * Order matters: smoothing first means the tail-trim compares de-jittered positions (raw jitter can
 * exceed the tail radius and defeat the trim), and measuring last means distance reflects what we
 * actually store and draw.
 */
export function processTrack(
  points: readonly TrackPoint[],
  opts: SmoothOptions & TrimTailOptions & TrackStatsOptions = {},
): ProcessedTrack {
  const processed = trimStationaryTail(smoothTrack(points, opts), opts);
  return {
    points: processed,
    path: toGeoJsonLineString(processed),
    stats: trackStats(processed, opts),
  };
}

/**
 * How much of each end of a track is withheld when its report didn't share a put-in (D58).
 *
 * The threat is specific and real: someone who skates from their own back yard, or from a friend's
 * dock, has a track whose first and last points are a home address. 150 m is enough to put the
 * endpoint somewhere on the ice rather than at a door, while leaving the part of the line that
 * actually says something about the lake.
 */
export const PUT_IN_CLIP_M = 150;

/**
 * Trim `clipMeters` from **both ends** of a path — the put-in-gated clipping the D58 aggregate layer
 * applies to any track whose report withheld its put-in (`showPutIn === false`).
 *
 * Returns `null` when there's nothing meaningful left, and that is a feature rather than an edge case:
 * a short skate that is *entirely* endpoints would otherwise render as a stub pointing straight at
 * where someone got on the ice. Dropping it is the correct answer — the aggregate is about where
 * people skate, and this track has nothing to contribute that isn't the thing we're protecting.
 *
 * Whole segments are dropped rather than interpolated: an interpolated point at exactly 150 m is a
 * fabricated coordinate, and "the first fix beyond the clip radius" is both simpler and a real
 * position the skater actually occupied.
 */
export function clipPathEnds(
  path: LineString,
  clipMeters: number = PUT_IN_CLIP_M,
): LineString | null {
  const coords = path.coordinates;
  if (coords.length < 2 || !(clipMeters > 0)) {
    return coords.length >= 2 ? path : null;
  }
  const at = (i: number): LatLng => {
    const [lng, lat] = coords[i] as number[];
    return { lat: lat as number, lng: lng as number };
  };

  let start = 0;
  let travelled = 0;
  while (start < coords.length - 1 && travelled < clipMeters) {
    travelled += haversineMeters(at(start), at(start + 1));
    start++;
  }

  let end = coords.length - 1;
  travelled = 0;
  while (end > 0 && travelled < clipMeters) {
    travelled += haversineMeters(at(end), at(end - 1));
    end--;
  }

  if (end - start < 1) return null;
  return { type: 'LineString', coordinates: coords.slice(start, end + 1) };
}
