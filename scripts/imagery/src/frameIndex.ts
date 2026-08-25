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
  /**
   * How many corpus bodies the frame contains. This is what reaches the season index.
   */
  bodyCount: number;
  /**
   * Which bodies, and how much of each was unobscured — from SCL, at cut time.
   *
   * ⚠ **This must never reach the season index.** ~4,500 frames a season × up to ~2,700 bodies per
   * granule is millions of entries in one JSON file that every client would download to draw one
   * lake. It stays in the per-granule manifest, which PR 3 fetches lazily for only the handful of
   * frames covering the lake on screen.
   */
  bodies?: {
    waterBodyId: string;
    /** Unobscured fraction of the pixels this granule actually saw. `null` = we could not see it. */
    clearPct: number | null;
    /**
     * How much of the body this granule reached, 0–1 — the weight `clearPct` carries.
     *
     * **This is what makes the split-body seam drawable.** A body bisected by a granule edge appears
     * in two frames and neither is wrong; the ratio says which side came from which pass. `null` when
     * the granule shipped without SCL, because coverage is then unmeasured rather than zero.
     */
    coveragePct: number | null;
    /**
     * Fraction of the pixels this granule saw that SCL called snow/ice (class 11), and water
     * (class 6). Both over the same denominator as `clearPct`, never over each other.
     *
     * **This is the freeze-up series, recorded as a by-product of the cut.** The classifier is
     * already read per pixel per body to compute `clearPct`, so these cost nothing — and deriving
     * them afterwards would mean re-reading every granule of a season.
     *
     * ⚠ **A measurement, not a verdict.** Class 11 does not separate lake ice from snow lying on it
     * and is known to confuse with cloud; nothing here sees thickness, and D147 is explicit that
     * 10 m imagery cannot see a pressure ridge. D150 governs every claim built on it.
     *
     * `null` when the granule shipped without SCL — unmeasured, not zero.
     */
    icePct: number | null;
    waterPct: number | null;
    pixels: number;
  }[];
  /** Which bands this granule produced — one published frame each. */
  bands?: string[];
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
    .filter((m) => m.season === season && m.bodyCount > 0)
    // One published frame per band. A granule now yields true colour AND ESA's scene classification,
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
