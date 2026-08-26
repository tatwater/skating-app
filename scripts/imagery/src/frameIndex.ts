/**
 * Folding a season's manifests into the index a client reads (N6e §C2/§C4).
 *
 * ## What is here, and what moved to core
 *
 * The **published shape** — `IndexedFrame`, `SeasonIndex`, `ArchivePointer` and D149's
 * `latestSeasonWithFrames` — lives in `@skating/core`, because both apps read the archive and neither
 * should have to depend on the package that shells out to GDAL and `fly machine run` just to type the
 * JSON it fetched. See `packages/core/src/imageryArchive.ts`.
 *
 * What stays here is the **envelope** only the producer ever sees: `FrameManifest`'s bookkeeping —
 * stage timings, VM size, the mask season it was clipped against — and the fold that turns a pile of
 * them into an index.
 *
 * ⚠ **"No client reads a manifest" was true until 2026-08-25 and is not any more.** Per-lake coverage
 * and cloud live only in `bodies[]`, and the season index carries a body *count* rather than a body
 * *list* on purpose (millions of entries otherwise), so a scrubber has to fetch manifests lazily for
 * the few frames covering the lake on screen. That element type therefore moved to `@skating/core` as
 * `FrameBodyStats`, alongside `FrameStats` — the client-readable view of this envelope — and
 * `manifestKeyFor`, which is where a consumer gets the path.
 *
 * ## Why this is a file in R2 and not a Convex table
 *
 * Every other archive this app ships — the basemap, the bathymetry overlay — is a file in R2 whose
 * URL the clients hold, with nothing about it in the database. The frames are the same shape, plus
 * one thing those two do not need: a **list**, because a scrubber has to know which dates exist.
 *
 * A Convex table would buy queryability nobody has asked for, at the cost of a schema, a migration,
 * and a second place for the truth about the archive to live. An index file cannot disagree with the
 * bucket it was built by listing.
 */

import type { FrameBodyStats, IndexedFrame, SeasonIndex } from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';

/** One cut granule, as the Machine that cut it recorded. Producer-side only. */
export interface FrameManifest {
  granuleId: string;
  capturedAt: string;
  cloudCoverPct?: number | null;
  /** The season the *capture date* falls in — not the mask season it was clipped against. */
  season: string;
  maskSeason?: string;
  collection?: string;
  /**
   * How many corpus bodies the frame contains. This is what reaches the season index.
   */
  bodyCount: number;
  /**
   * Which bodies, and what each pass measured about them — written at cut time.
   *
   * ⚠ **This must never reach the season index.** ~4,500 frames a season × up to ~2,700 bodies per
   * granule is millions of entries in one JSON file that every client would download to draw one
   * lake. It stays in the per-granule manifest, which PR 3 fetches lazily for only the handful of
   * frames covering the lake on screen.
   *
   * The element type lives in `@skating/core` as {@link FrameBodyStats}, because unlike the rest of
   * this envelope it **is** read by a client — per-lake coverage and cloud exist nowhere else, and a
   * scrubber cannot be built without them. Optical and radar fill in different halves of it, which is
   * why every mission-specific field there is optional: `buildIndex` parses manifests with an
   * unchecked `as FrameManifest`, so a required-looking `clearPct` would be a promise TypeScript makes
   * to a consumer on behalf of a radar manifest that never had one. `mission` says which half to
   * expect.
   */
  bodies?: FrameBodyStats[];
  /**
   * Which frames this granule PUBLISHED — one `IndexedFrame` and one `.pmtiles` object each.
   *
   * ⚠ **Not the list of bands read.** A radar cut warps and measures both polarisations but renders
   * exactly one, so its `bands` is `["vh"]` while `polarizations` says `["VV","VH"]`. Listing both
   * here would put a key into the season index that nothing ever uploaded.
   */
  bands?: string[];
  band?: string;
  /** Radar acquisition geometry, recorded so a consumer can filter to comparable frames. */
  orbitDirection?: string;
  /** ⚠ The finer comparability key — see `FrameStats.relativeOrbit` in core. */
  relativeOrbit?: number | null;
  platform?: string;
  /**
   * The granule's acquisition polygon, copied from the STAC item at cut time.
   *
   * Recorded by the cutter rather than looked up when the index is built, because it is a statement
   * about *what we cut* — ESA reprocesses, and a footprint fetched months later could describe a
   * different granule than the one whose pixels are in the archive.
   */
  footprint?: Polygon | MultiPolygon;
}

/**
 * Fold a season's manifests into one index.
 *
 * Sorted by capture time, because that is the axis the scrubber moves along and any other order
 * would have to be re-sorted by every client that reads it.
 *
 * **A granule with zero bodies is dropped.** The cutter exits 0 on "nothing to cut" (plenty of
 * granules over five states cover only land or ocean) and may still leave a manifest; a frame with
 * nothing under it is an empty picture, and putting it in the scrubber would give a skater a date
 * that shows them nothing with no explanation.
 */
export function buildSeasonIndex(season: string, manifests: readonly FrameManifest[]): SeasonIndex {
  const frames = manifests
    .filter((m) => m.season === season && m.bodyCount > 0)
    // One published frame per band. A granule now yields true color AND ESA's scene classification,
    // and `<granuleId>.pmtiles` could only ever name one of them.
    .flatMap((m): IndexedFrame[] =>
      (m.bands ?? [m.band ?? 'visual']).map((band) => ({
        granuleId: m.granuleId,
        capturedAt: m.capturedAt,
        cloudCoverPct: m.cloudCoverPct ?? null,
        bodies: m.bodyCount,
        band,
        key: `frames/${season}/${m.granuleId}-${band}.pmtiles`,
        // Omitted rather than nulled when absent: `footprint?` means "we do not know", and a reader
        // must distinguish that from a frame that covers nothing.
        ...(m.footprint ? { footprint: m.footprint } : {}),
      })),
    )
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));

  // Deduped by granule AND band. A re-run overwrites its object in R2 but would list twice if a
  // manifest were ever written under two keys, and two identical dates in a scrubber is the same
  // correctness problem the superseded-reprocessing rule exists to prevent. Keying on granule alone
  // would now silently drop every SCL frame, since it shares its granule's id.
  const seen = new Set<string>();
  const deduped = frames.filter((f) => {
    const key = `${f.granuleId}:${f.band}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    season,
    frames: deduped,
    firstCapturedAt: deduped[0]?.capturedAt ?? null,
    lastCapturedAt: deduped[deduped.length - 1]?.capturedAt ?? null,
  };
}
