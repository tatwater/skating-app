/**
 * Deciding which granules are worth booting a Machine for (N6e PR 2, §C1/§C3).
 *
 * ## ⚠ The cloud gate is OFF by default — founder override, 2026-08-24
 *
 * > *"Let's always cut & store all imagery regardless of cloud cover? Then we know we have everything
 * > from Copernicus and we can rerun whatever we want on it without hitting them again."*
 *
 * The reasoning below is kept as history rather than deleted, because it is still *true* — the gate
 * really does refuse ~70% of a window for the price of a query parameter. It is simply no longer what
 * we want. Owning the pixels means every later re-derivation (SCL thresholds, a better per-lake cloud
 * statistic, N6g's research) is free, where a gated archive would send us back to Copernicus for
 * frames we chose not to keep.
 *
 * `maxCloudPct` remains an option and still works; it just no longer has a default. **Measured cost of
 * the override:** one season goes from 2,560 granules to 8,892, a 3.47× multiplier.
 *
 * The cheap lever that replaced it is `emptyTiles` — see below. It removes ~44% of jobs without
 * discarding a single frame, which the cloud gate could not claim.
 *
 * ## The original argument, retained
 *
 * ## This is the cheapest lever in the phase, and it is not a compute lever
 *
 * Fly bills per machine-second, linearly — one Machine for 25 hours costs what 25 Machines cost for
 * an hour, and there is no spot tier. **Running a backfill slowly saves nothing.** What saves money
 * is never booting a Machine for a frame we would throw away, and STAC hands us the means for free:
 * `eo:cloud_cover` rides in the item metadata, so the filter runs in the *query*, before any compute
 * exists.
 *
 * Measured against Earth Search over Champlain, 1 Jan – 15 Mar 2026: **3 frames under 15% cloud in
 * ten weeks**, against many at 97–100%. If that ratio roughly holds, nine seasons' ~6,750 jobs
 * becomes closer to 1,000.
 *
 * ## The gate is deliberately generous
 *
 * §C3's asymmetry, one level up: an over-eager gate wastes a few dollars of granule reads, while a
 * strict one **silently drops the frame that showed freeze-up** — the single most valuable frame in
 * the season, gone with nothing to say it was ever there. So the default threshold is loose, and
 * every drop is counted and reported rather than filtered away in silence.
 *
 * A refinement worth knowing about but not building yet: `eo:cloud_cover` is granule-wide, while ESA's
 * SCL band knows cloud **over our specific lakes**. A granule 80% clouded over the White Mountains
 * may be perfectly clear over Champlain. That is a better gate and it costs a granule read to
 * evaluate, so it belongs after the first season has taught us what the crude one actually costs.
 */

import type { MultiPolygon, Polygon } from 'geojson';

/** One STAC item, reduced to what selection cares about. */
export interface GranuleCandidate {
  id: string;
  datetime: string;
  cloudCoverPct?: number;
  /**
   * The acquisition polygon, straight off the STAC item.
   *
   * Carried because the search already returned it and two later steps want it: the empty-tile survey
   * tests it against the mask file, and the cutter writes it into the manifest so a scrubber can say
   * "that lake was not photographed that day".
   */
  footprint?: Polygon | MultiPolygon;
}

/** A granule id decomposed. Sentinel-2 ids read `S2C_18TXP_20260215_0_L2A`. */
export interface GranuleKey {
  platform: string;
  tile: string;
  date: string;
  version: number;
}

const GRANULE_ID = /^(S2[A-D])_([0-9]{2}[A-Z]{3})_([0-9]{8})_([0-9]+)_(L2A|L1C)$/;

/** Parse a granule id, or `null` if it is not one we recognise. */
export function parseGranuleId(id: string): GranuleKey | null {
  const match = GRANULE_ID.exec(id);
  if (!match) return null;
  return {
    platform: match[1] as string,
    tile: match[2] as string,
    date: match[3] as string,
    version: Number(match[4]),
  };
}

export interface SelectionOptions {
  /**
   * Granules cloudier than this are not worth a Machine.
   *
   * **No default any more** (founder, 2026-08-24 — see the module note). Passing it still gates, which
   * is what a cheap experiment wants; leaving it off keeps everything, which is what an archive we
   * intend to re-derive from wants.
   */
  maxCloudPct?: number;
  /**
   * MGRS tiles known to contain no corpus body at all.
   *
   * **The lever that replaced the cloud gate, and a strictly better one.** A granule over the Gulf of
   * Maine or western New York is not a *cheap* frame we are choosing to skip — it is a frame with
   * nothing in it, and the cutter proves that by booting a Machine, reading a mask file and exiting 0.
   * Measured across one season: **44.3% of granules sit in tiles with zero bodies.**
   *
   * Unlike a cloud threshold this discards no data, so it does not have to be argued against §C3's
   * asymmetry — there is no frame here that could have shown freeze-up.
   */
  emptyTiles?: ReadonlySet<string>;
}

export interface SelectionResult {
  /** The granule ids to cut, in a stable order. */
  selected: string[];
  /** Everything the gate refused, with a reason — never a silent drop. */
  rejected: {
    id: string;
    reason: 'cloud' | 'superseded' | 'unparseable' | 'empty-tile';
    detail?: string;
  }[];
  counts: {
    considered: number;
    selected: number;
    cloud: number;
    superseded: number;
    unparseable: number;
    emptyTile: number;
  };
}

/**
 * Apply the gate, drop superseded reprocessings, and return a stable order.
 *
 * ## Why superseded versions have to go
 *
 * ESA reprocesses. The same tile on the same day appears as `..._0_L2A` and `..._1_L2A`, and the
 * higher number is the newer processing baseline. Cutting both would put **two frames on the same
 * date** into the scrubber — which is not a rendering glitch but a correctness one, because C4 makes
 * the date the content: a skater scrubbing to 15 February would see two different pictures of that
 * day with nothing to say which is current.
 *
 * Ordering is by date then tile, which makes a fan-out's logs readable and, more usefully, makes a
 * partial backfill resumable by eye — you can see how far it got.
 */
export function selectGranules(
  candidates: readonly GranuleCandidate[],
  options: SelectionOptions = {},
): SelectionResult {
  const maxCloud = options.maxCloudPct;
  const emptyTiles = options.emptyTiles;
  const rejected: SelectionResult['rejected'] = [];
  const best = new Map<string, { key: GranuleKey; candidate: GranuleCandidate }>();

  for (const candidate of candidates) {
    const key = parseGranuleId(candidate.id);
    if (!key) {
      rejected.push({ id: candidate.id, reason: 'unparseable' });
      continue;
    }

    // An item with no cloud figure is kept, not dropped. Absent metadata is not a cloudy scene, and
    // the generous direction is the safe one — the cutter records whatever it finds in the manifest.
    if (emptyTiles?.has(key.tile)) {
      rejected.push({ id: candidate.id, reason: 'empty-tile', detail: key.tile });
      continue;
    }

    if (
      maxCloud !== undefined &&
      candidate.cloudCoverPct !== undefined &&
      candidate.cloudCoverPct > maxCloud
    ) {
      rejected.push({
        id: candidate.id,
        reason: 'cloud',
        detail: `${candidate.cloudCoverPct.toFixed(1)}% > ${maxCloud}%`,
      });
      continue;
    }

    const slot = `${key.platform}_${key.tile}_${key.date}`;
    const incumbent = best.get(slot);
    if (!incumbent) {
      best.set(slot, { key, candidate });
      continue;
    }
    const [winner, loser] =
      key.version > incumbent.key.version
        ? [{ key, candidate }, incumbent]
        : [incumbent, { key, candidate }];
    best.set(slot, winner);
    rejected.push({
      id: loser.candidate.id,
      reason: 'superseded',
      detail: `by ${winner.candidate.id}`,
    });
  }

  const selected = [...best.values()]
    .sort((a, b) =>
      a.key.date === b.key.date
        ? a.key.tile.localeCompare(b.key.tile)
        : a.key.date.localeCompare(b.key.date),
    )
    .map((entry) => entry.candidate.id);

  return {
    selected,
    rejected,
    counts: {
      considered: candidates.length,
      selected: selected.length,
      cloud: rejected.filter((r) => r.reason === 'cloud').length,
      superseded: rejected.filter((r) => r.reason === 'superseded').length,
      unparseable: rejected.filter((r) => r.reason === 'unparseable').length,
      emptyTile: rejected.filter((r) => r.reason === 'empty-tile').length,
    },
  };
}
