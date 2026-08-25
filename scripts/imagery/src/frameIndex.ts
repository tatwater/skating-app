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
   *
   * ## ⚠ Optical and radar manifests fill in different halves of this
   *
   * `zonal-clear.py` writes the SCL statistics; `sar-zonal.py` writes `vvDb`/`vhDb` and **neither**
   * `clearPct` nor `waterPct` nor `snowIcePct` — there is no scene classification on a radar pass and
   * no cloud to be clear of. Only `waterBodyId`, `coveragePct` and `pixels` are common to both.
   *
   * So every mission-specific field is optional, and it has to be: `buildIndex` parses manifests with
   * an unchecked `as FrameManifest`, so a required-looking `clearPct` is a promise TypeScript will
   * make to a consumer on behalf of a radar manifest that never had one. `mission` is what says which
   * half to expect.
   */
  bodies?: {
    waterBodyId: string;
    /**
     * Unobscured fraction of the pixels this granule actually saw. `null` = we could not see it.
     *
     * Optical only — absent on radar manifests, where there is nothing to be obscured by.
     */
    clearPct?: number | null;
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
     * ## ⚠ It is `snowIcePct` because it measures SNOW, and the old name lied
     *
     * SCL's class 11 finds *bright* frozen surfaces. **Black ice is transparent** — the light comes
     * back off the dark lake bottom — so the classifier calls it **water**, correctly by its own
     * lights and uselessly by ours. Measured: Mascoma Lake, 22 December 2025, 98% clear, **2.3%
     * "ice", 82.5% water** — and the founder skated its full length the next morning. Lake Morey the
     * same day read 45% ice, because Morey had snow on it.
     *
     * So a high number means *snow-covered ice*, a low number means *water **or** the best skating
     * ice of the year*, and anything reading this as "is it frozen" will be wrong in December.
     * See `docs/reading-ice-from-orbit.md`.
     *
     * ⚠ **A measurement, not a verdict.** Nothing here sees thickness, and D147 is explicit that
     * 10 m imagery cannot see a pressure ridge. D150 governs every claim built on it.
     *
     * `null` when the granule shipped without SCL — unmeasured, not zero.
     */
    snowIcePct?: number | null;
    /**
     * @deprecated The pre-2026-08-25 name for `snowIcePct`. Identical measurement, misleading label.
     *
     * ⚠ **Both fields are optional and exactly one will be present**, decided by when the frame was
     * cut. The 4,381 optical frames of winter 2025-26 predate the rename and carry this; everything
     * cut since carries `snowIcePct`. A reader wants `snowIcePct ?? icePct` until the archive is
     * re-cut, at which point this field disappears and the `?` on `snowIcePct` should go with it.
     *
     * The rename landed without a re-run deliberately: it is a *contract* change, so its cost grows
     * with every consumer written against the wrong name, while the re-run it needs is owed to a
     * batch of additive work (NDSI) that blocks nothing. See *The batched re-run queue* in
     * `plans/phase-N6e-satellite-imagery.md`.
     */
    icePct?: number | null;
    /** Fraction SCL called water. Optical only. */
    waterPct?: number | null;
    /**
     * Mean `sigma0` over the body, in decibels, per polarisation — **radar only** (`sar-zonal.py`).
     *
     * `VH` is the informative channel: it separates open water from midwinter ice by ~2 dB where
     * `VV` manages 0.6–0.8. `null` when the pass reached the body but no pixel was usable.
     *
     * ⚠ Comparable only across frames of the same orbit direction and platform — see the manifest's
     * `orbitDirection`/`platform`, which exist for exactly this filter.
     *
     * **Measured, not assumed** (2026-08-25, all 503 radar passes of winter 2025-26): calibration
     * leaves an S1A−S1C offset of −0.52 dB VH ascending and +1.53 dB VH descending, against a ~2 dB
     * ice signal. Pooled across directions it reads −0.03 dB, which is the two biases cancelling —
     * so a consumer that drops these filters will see agreement that is not there.
     */
    vvDb?: number | null;
    vhDb?: number | null;
    pixels: number;
  }[];
  /**
   * Which frames this granule PUBLISHED — one `IndexedFrame` and one `.pmtiles` object each.
   *
   * ⚠ **Not the list of bands read.** A radar cut warps and measures both polarisations but renders
   * exactly one, so its `bands` is `["vh"]` while `polarizations` says `["VV","VH"]`. Listing both
   * here would put a key into the season index that nothing ever uploaded.
   */
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
