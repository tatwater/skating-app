/**
 * A GPX file on its way to `gpsActivities.ingestTrack` from the web sheet (B03 §5, 5.2): read,
 * planned by core's `planGpxImport` (the parse and the cleaning both surfaces share), then
 * **downsampled** to what the server can store — Convex refuses an array past 8,192 values, so a
 * long watch file would otherwise fail at the insert with an error no skater can read.
 *
 * D239: the imported track is trusted as a recording is, for now. Nothing here, and no copy that
 * shows its result, calls it verified — it is the route the file describes.
 */

import { gpxSizeRefusal, planGpxImport } from '@skating/core';
import type { LineString } from 'geojson';

/** The server's `MAX_TRACK_POINTS` (`gpsActivities.ts`): the most positions a stored track holds. */
export const GPX_MAX_POINTS = 8192;

/**
 * At most `max` items, evenly spaced by index: the first and the last always kept, the order kept,
 * nothing invented. A subsequence, so whatever was monotone in the input (timestamps) stays so.
 */
export function downsample<T>(items: readonly T[], max: number): T[] {
  const cap = Math.max(2, Math.floor(max));
  const n = items.length;
  if (n <= cap) return [...items];
  // The step is over 1 here (n > cap), so the rounded indices strictly increase: no repeats.
  const step = (n - 1) / (cap - 1);
  const out: T[] = [];
  for (let i = 0; i < cap; i += 1) out.push(items[Math.round(i * step)] as T);
  return out;
}

/** The ingest call's arguments, or the sentence to show the author verbatim. */
export type GpxIngestPlan =
  | {
      ok: true;
      path: LineString;
      startTime: number;
      endTime: number;
      elapsedSeconds: number;
      idempotencyKey: string;
      /** The cleaned track's size before it was thinned — what the event buckets. */
      pointCount: number;
    }
  | { ok: false; message: string };

/** Plan an import from the file's text: core's plan, its path thinned to what the server stores. */
export function planGpxIngest(xml: string, reportId: string): GpxIngestPlan {
  const plan = planGpxImport(xml, reportId);
  if (!plan.ok) return plan;
  const pointCount = plan.path.coordinates.length;
  return {
    ...plan,
    path: { ...plan.path, coordinates: downsample(plan.path.coordinates, GPX_MAX_POINTS) },
    pointCount,
  };
}

/** A picked file, refused before it is read when it is too big to be one skate. */
export async function planGpxFile(file: File, reportId: string): Promise<GpxIngestPlan> {
  const tooBig = gpxSizeRefusal(file.size);
  if (tooBig !== null) return { ok: false, message: tooBig };
  return planGpxIngest(await file.text(), reportId);
}
