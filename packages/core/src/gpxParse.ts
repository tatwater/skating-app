/**
 * A GPX file read back into track points (A10-7 / §4.2's GPX door). Strava, Garmin and most
 * watches export one; this reads `<trkpt lat lon>` with its `<time>` and `<ele>`, in document
 * order, and nothing else, with or without a namespace prefix. Hand-rolled like `toGpx`: GPX is a
 * handful of elements, and a regex over the one element that matters is easier to keep honest than
 * an XML library. A file with fewer than two timed points is not a track.
 */

import type { LineString } from 'geojson';
import { processTrack, type TrackPoint } from './track';

export interface ParsedGpx {
  points: TrackPoint[];
  /** The `<name>` of the track or the file, when there is one. */
  name?: string;
}

/**
 * The largest GPX file either surface reads. A three-hour skate logged every second is ~2 MB, and a
 * watch's extensions (heart rate, cadence) might triple that; a file past this is not one skate.
 * Checked **before** the file is read — the parse is synchronous on the UI thread.
 */
export const GPX_MAX_BYTES = 20 * 1024 * 1024;

/** The sentence for a file over `GPX_MAX_BYTES`, or `null` for one that may be read. */
export function gpxSizeRefusal(bytes: number | undefined): string | null {
  return bytes !== undefined && bytes > GPX_MAX_BYTES
    ? "That file is too big to be one skate's track."
    : null;
}

// Every element may carry a namespace prefix (`<gpx:trkpt>` from a writer that declares GPX as a
// prefixed namespace rather than the default one); a closing tag must repeat the opening's prefix.
const NS = '((?:[A-Za-z_][\\w.-]*:)?)';
// A self-closing `<trkpt …/>` (an untimed point some tools write) is its own match, not an opening
// tag: otherwise the lazy body would run on through the *next* point's `</trkpt>` and swallow it.
const TRKPT = new RegExp(`<${NS}trkpt\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/\\1trkpt>)`, 'gi');
const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i');
const tag = (name: string) => new RegExp(`<${NS}${name}\\b[^>]*>([^<]*)<\\/\\1${name}>`, 'i');
const GPX_ROOT = new RegExp(`<${NS}gpx\\b`, 'i');
// Built once: `exec` on a non-global regex is stateless, and a watch's file has thousands of points.
const LAT = attr('lat');
const LON = attr('lon');
const TIME = tag('time');
const ELE = tag('ele');
const NAME = tag('name');

export function parseGpx(xml: string): ParsedGpx | null {
  if (!GPX_ROOT.test(xml)) return null;
  const points: TrackPoint[] = [];
  for (const m of xml.matchAll(TRKPT)) {
    const attrs = m[2] ?? '';
    const body = m[3] ?? '';
    const lat = Number(LAT.exec(attrs)?.[1]);
    const lng = Number(LON.exec(attrs)?.[1]);
    const time = TIME.exec(body)?.[2];
    const t = time ? Date.parse(time.trim()) : Number.NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(t)) continue;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    const ele = Number(ELE.exec(body)?.[2]);
    points.push({ lat, lng, t, ...(Number.isFinite(ele) ? { elevation: ele } : {}) });
  }
  if (points.length < 2) return null;
  points.sort((a, b) => a.t - b.t);
  const name = NAME.exec(xml)?.[2]?.trim();
  return { points, ...(name ? { name } : {}) };
}

/** A GPX file as the ingest mutation wants it, or the sentence to show — one plan for both surfaces. */
export type GpxImportPlan =
  | {
      ok: true;
      path: LineString;
      startTime: number;
      endTime: number;
      elapsedSeconds: number;
      /**
       * The ingest's idempotency key: the same file for the same Report resolves to the same
       * activity on a retry after a lost ack, rather than a second row (`gpsActivities.ingestTrack`
       * dedupes on it per user).
       */
      idempotencyKey: string;
    }
  | { ok: false; message: string };

/** Parse, clean like a recording (`processTrack`), and shape the ingest call. Pure. */
export function planGpxImport(xml: string, reportId: string): GpxImportPlan {
  const parsed = parseGpx(xml);
  if (!parsed) return { ok: false, message: "That file isn't a GPX track with times in it." };
  const processed = processTrack(parsed.points);
  const first = processed.points[0];
  const last = processed.points[processed.points.length - 1];
  if (!processed.path || first === undefined || last === undefined || !(last.t > first.t)) {
    return { ok: false, message: 'That track has too few usable points.' };
  }
  return {
    ok: true,
    path: processed.path,
    startTime: first.t,
    endTime: last.t,
    elapsedSeconds: Math.round(processed.stats.movingSeconds),
    idempotencyKey: `gpx:${reportId}:${first.t}:${last.t}:${processed.path.coordinates.length}`,
  };
}
