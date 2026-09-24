/**
 * A GPX file read back into track points (A10-7 / §4.2's GPX door). Strava, Garmin and most
 * watches export one; this reads `<trkpt lat lon>` with its `<time>` and `<ele>`, in document
 * order, and nothing else. Hand-rolled like `toGpx`: GPX is a handful of elements, and a regex
 * over the one element that matters is easier to keep honest than an XML library. A file with
 * fewer than two timed points is not a track.
 */

import type { TrackPoint } from './track';

export interface ParsedGpx {
  points: TrackPoint[];
  /** The `<name>` of the track or the file, when there is one. */
  name?: string;
}

const TRKPT = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/gi;
const ATTR = (name: string) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i');
const TAG = (name: string) => new RegExp(`<${name}\\b[^>]*>([^<]*)<\\/${name}>`, 'i');

export function parseGpx(xml: string): ParsedGpx | null {
  if (!/<gpx\b/i.test(xml)) return null;
  const points: TrackPoint[] = [];
  for (const m of xml.matchAll(TRKPT)) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    const lat = Number(ATTR('lat').exec(attrs)?.[1]);
    const lng = Number(ATTR('lon').exec(attrs)?.[1]);
    const time = TAG('time').exec(body)?.[1];
    const t = time ? Date.parse(time.trim()) : Number.NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(t)) continue;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    const ele = Number(TAG('ele').exec(body)?.[1]);
    points.push({ lat, lng, t, ...(Number.isFinite(ele) ? { elevation: ele } : {}) });
  }
  if (points.length < 2) return null;
  points.sort((a, b) => a.t - b.t);
  const name = TAG('name').exec(xml)?.[1]?.trim();
  return { points, ...(name ? { name } : {}) };
}
