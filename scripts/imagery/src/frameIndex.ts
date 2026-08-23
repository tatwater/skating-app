/**
 * The archive's table of contents, and where D149's turnover actually happens (N6e §C2/§C4).
 *
 * > **D149 — the archive turns over on the first frame of the new season, never on a date.**
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
 *
 * ## The turnover is `latest.json`, and that is the whole mechanism
 *
 * > **Founder, 2026-08-21:** *"I'm tempted to show the past season's imagery from freeze to thaw all
 * > the way until it turns over again in November."*
 *
 * `latest` names the most recent season that **has frames**. Last winter's scrubber therefore stays
 * live all summer, and the moment the first frame of the new winter lands it flips — by itself, with
 * no cron, no date, and no calendar rule to be wrong about in a warm year. D63's season key still
 * labels the archive; it just stopped being the trigger.
 */

/** One cut granule, as its manifest records it. */
export interface FrameManifest {
  granuleId: string;
  capturedAt: string;
  cloudCoverPct?: number | null;
  season: string;
  collection?: string;
  bodies: number;
  band?: string;
}

/** A frame as the scrubber reads it. */
export interface IndexedFrame {
  granuleId: string;
  capturedAt: string;
  cloudCoverPct: number | null;
  bodies: number;
  band: string;
  /** Key within the bucket, so a client composes its own URL from whatever base it was given. */
  key: string;
}

export interface SeasonIndex {
  season: string;
  frames: IndexedFrame[];
  /** The span the scrubber's ends snap to. */
  firstCapturedAt: string | null;
  lastCapturedAt: string | null;
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

/**
 * Which season the app should be showing — D149's turnover, as one function.
 *
 * **The most recent season that has frames.** Not the current calendar season, and not the newest
 * directory: an empty `winter-2027-28` created the moment ingest started looking in September must
 * not blank out the scrubber that has been serving last winter perfectly well since April.
 *
 * Seasons sort correctly as strings because the label is `winter-YYYY-YY`.
 */
export function latestSeasonWithFrames(indexes: readonly SeasonIndex[]): string | null {
  const populated = indexes.filter((index) => index.frames.length > 0);
  if (populated.length === 0) return null;
  return populated.map((index) => index.season).sort()[populated.length - 1] ?? null;
}
