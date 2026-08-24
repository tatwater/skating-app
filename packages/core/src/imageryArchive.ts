/**
 * What the freeze-up archive publishes, and which season an app should be showing (N6e §C2, D149).
 *
 * ## Why the producer's output type lives in core
 *
 * The archive is built by `@skating/imagery` — the ETL that drives the Fly granule cutter — and read
 * by both apps. If the shape lived with the producer, a client wanting to type the JSON it just
 * fetched would have to depend on a package that exists to shell out to GDAL and `fly machine run`.
 *
 * So the **producer declares its output type here**, in the package both sides already share. The same
 * reasoning `webMercator` gives for living in core rather than the web app: one definition, because a
 * second one is a second chance to disagree.
 *
 * This module is deliberately *only* the published shape. `FrameManifest` — what one cut Machine
 * writes beside its `.pmtiles` — stays in the ETL, because nothing outside the producer ever sees a
 * manifest. What a client sees is the index built from them.
 */

import type { MultiPolygon, Polygon } from 'geojson';

/**
 * One frame in a season's scrubber.
 *
 * `capturedAt` and `cloudCoverPct` are **content, not metadata** (D84, §C4): a timeline invites
 * inference far harder than a still image does, so every frame carries its own date and its own cloud
 * caveat, and they travel with the frame rather than sitting as furniture around the control.
 */
export interface IndexedFrame {
  granuleId: string;
  /** ISO instant the satellite took this picture. */
  capturedAt: string;
  /** Granule-wide cloud fraction, or `null` when the source did not report one — never a guess. */
  cloudCoverPct: number | null;
  /** How many corpus bodies this frame actually contains. */
  bodies: number;
  /** Which band the frame renders — `visual` is the true-colour composite. */
  band: string;
  /**
   * Key within the archive bucket.
   *
   * A key rather than a URL, so a client composes its own address from whatever base it was
   * configured with — the same split the basemap and bathymetry archives already use, and what lets
   * dev and prod point at different buckets without the artifact knowing.
   */
  key: string;
  /**
   * Where this frame has pixels — the satellite's own acquisition polygon, from the STAC item.
   *
   * **Without it a scrubber cannot tell "this lake was not photographed that day" from "this lake was
   * photographed and looked like nothing",** and the timeline degrades to showing every frame and
   * hoping. A Sentinel pass covers one ~110 km tile; a season's frames are scattered across ~54 of
   * them, so most frames are irrelevant to any given lake and saying so is the whole job.
   *
   * The **granule** footprint rather than the cut's raster extent, deliberately. The raster is sized
   * to the bounding box of every mask the granule touches, which can reach past the granule's own
   * edge — those pixels come back transparent. The acquisition polygon is the honest bound on where
   * imagery exists at all, and it is a real quadrilateral rather than a bbox, so it does not claim
   * the corners of a rotated swath.
   *
   * Optional because frames cut before 2026-08-24 predate the field. A reader with no footprint
   * should treat coverage as unknown and say so, never as universal.
   */
  footprint?: Polygon | MultiPolygon;
}

/** A season's frames, ascending by capture time — the axis a scrubber moves along. */
export interface SeasonIndex {
  season: string;
  frames: IndexedFrame[];
  /** The span the scrubber's ends snap to. `null` when the season has no frames. */
  firstCapturedAt: string | null;
  lastCapturedAt: string | null;
}

/** What `index/latest.json` holds — the pointer that *is* D149's turnover. */
export interface ArchivePointer {
  season: string;
}

/**
 * Which season the app should be showing — D149's turnover, as one function.
 *
 * > **D149 — the archive turns over on the first frame of the new season, never on a date.**
 *
 * **The most recent season that has frames.** Not the current calendar season, and not the newest
 * directory: ingest starts *looking* in September on the summit trigger (§C3), so an empty
 * `winter-2027-28` exists for weeks before its first frame lands. Turning over on the directory would
 * take away a scrubber that has been serving last winter perfectly well since April and replace it
 * with nothing.
 *
 * Seasons sort correctly as strings because the label is `winter-YYYY-YY`.
 *
 * Lives here beside the type it governs rather than with the producer that calls it, so a client that
 * ever lists seasons for itself applies the same rule instead of reinventing a near-miss of it.
 */
export function latestSeasonWithFrames(indexes: readonly SeasonIndex[]): string | null {
  const populated = indexes.filter((index) => index.frames.length > 0);
  if (populated.length === 0) return null;
  return populated.map((index) => index.season).sort()[populated.length - 1] ?? null;
}
