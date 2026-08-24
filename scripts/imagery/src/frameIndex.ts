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
 * What stays here is the half only the producer ever sees: `FrameManifest`, which is what one cut
 * Machine writes beside its `.pmtiles`, and the fold that turns a pile of them into an index. No
 * client reads a manifest.
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

import type { IndexedFrame, SeasonIndex } from '@skating/core';
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
  bodies: number;
  band?: string;
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
    .filter((m) => m.season === season && m.bodies > 0)
    .map(
      (m): IndexedFrame => ({
        granuleId: m.granuleId,
        capturedAt: m.capturedAt,
        cloudCoverPct: m.cloudCoverPct ?? null,
        bodies: m.bodies,
        band: m.band ?? 'visual',
        key: `frames/${season}/${m.granuleId}.pmtiles`,
        // Omitted rather than nulled when absent: `footprint?` means "we do not know", and a reader
        // must distinguish that from a frame that covers nothing.
        ...(m.footprint ? { footprint: m.footprint } : {}),
      }),
    )
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));

  // Deduped by granule id. A re-run of the same granule overwrites its object in R2 but would list
  // twice if a manifest were ever written under two keys, and two identical dates in a scrubber is
  // the same correctness problem the superseded-reprocessing rule exists to prevent.
  const seen = new Set<string>();
  const deduped = frames.filter((f) => {
    if (seen.has(f.granuleId)) return false;
    seen.add(f.granuleId);
    return true;
  });

  return {
    season,
    frames: deduped,
    firstCapturedAt: deduped[0]?.capturedAt ?? null,
    lastCapturedAt: deduped[deduped.length - 1]?.capturedAt ?? null,
  };
}
