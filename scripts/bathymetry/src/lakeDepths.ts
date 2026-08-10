/**
 * **A depth per lake, out of the archives we already hold** (N7-3).
 *
 * ## Why this exists
 *
 * `state_agency` is rung 1 of D68's depth ladder — above LAGOS-US, above everything modelled — and
 * on 2026-08-09 it had **zero rows in the corpus**. Its own docstring said the rung was *"deferred to
 * N6b, where those datasets are fetched for their contours anyway"*. N6b fetched them and never came
 * back. So 298 MB and ~2,400 lakes of measured depth have been on disk, feeding a contour layer and
 * nothing else, while three global models supplied the numbers a skater actually reads.
 *
 * This is that rung's producer. It reads the same `ArchivedLake`s the contour build reads and emits
 * one depth record per lake, which `scripts/lake-depth`'s loader feeds to the ordinary join.
 *
 * ## A contour is a lower bound; a sounding is a measurement
 *
 * The two lanes do not make the same claim, and pretending they do would be the D3 failure in
 * miniature:
 *
 * - **Soundings** (ME, VT, Champlain) — somebody's transducer read that number at that point. The
 *   deepest sounding *is* the deepest measurement, and the true maximum is deeper only by however
 *   much the survey missed.
 * - **Contours** (NH, MA) — the deepest published isobath. If the deepest line on the map says 60 ft,
 *   the lake is *at least* 60 ft, and the basin inside that line is deeper by an unknown amount. So
 *   a contour-derived maximum **understates**, always, and by roughly the contour interval.
 *
 * Both are stored at the same rung anyway, because both are the agency's own measurement of that lake
 * and the alternative is a random forest. But the record says which lane it came from, and
 * `understatesMax` is the flag a caption or a review pass would read rather than re-deriving it.
 *
 * ## What is deliberately not here
 *
 * **Mean depth.** A contour set is not a volume, and a sounding cloud is a survey track rather than a
 * sample of the basin — averaging either gives a number weighted by where the boat went. Mean depth
 * needs *area between isobaths*, which only NH publishes (its polygon layer) and which the founder
 * settled separately on 2026-08-09: NH's published bands may yield a computed mean, our own
 * interpolated surfaces may not.
 */

import type { ArchivedLake, Lane } from './lakes';
import { maxDepthFt, representativePoint } from './lakes';

/** Feet per metre. Restated from `normalize.ts`, which keeps it private and emits feet. */
const FEET_PER_METRE = 3.28084;

/**
 * Deepest reading we will accept, in metres.
 *
 * **Lake Champlain's 122 m is the deepest water any of these sources covers** — Seneca Lake is
 * deeper and is in New York, which publishes no bathymetry at all. 250 m is more than twice
 * Champlain, which is the right direction for a backstop: it exists to catch a units error or a
 * sentinel read as a depth, not to adjudicate a real sounding.
 */
export const MAX_PLAUSIBLE_AGENCY_DEPTH_M = 250;

/**
 * One archived lake's maximum depth, in the shape `scripts/lake-depth`'s loader consumes.
 *
 * ⚠ **This must stay assignable to `DepthRecord` in `scripts/lake-depth/src/types.ts`.** The two
 * packages do not depend on each other — a file is the seam, the same one `exportSoundings.ts`
 * argues for — so nothing here type-checks against that definition. What catches a drift is the
 * load: Convex object validators are exact, so a renamed field fails the batch loudly rather than
 * writing a body with no depth.
 */
export interface AgencyDepthRecord {
  /** `<sourceKey>/<lakeKey>` — unique across sources, and traceable back to the archive. */
  key: string;
  point: { lat: number; lng: number };
  /** The agency's name for the lake. Corroborates a proximity match; never stored (D94). */
  name?: string;
  maxDepthM: number;
  maxDepthSource: 'state_agency';
}

/** What the export needs beyond the wire record — kept apart so the record stays the wire shape. */
export interface AgencyDepthDetail {
  record: AgencyDepthRecord;
  state: string;
  agency: string;
  sourceKey: string;
  lane: Lane;
  /** Measurements behind the number: soundings, or contour lines. */
  sampleCount: number;
  /**
   * True for the contour lanes. The deepest isobath is a floor on the real maximum, and a consumer
   * that wants to say "at least" rather than "is" needs to know without re-deriving it from `lane`.
   */
  understatesMax: boolean;
}

/**
 * Archives whose **depth** is produced by a better lane elsewhere, so this one must not also write it.
 *
 * `nh-granit-contours` is layer 0 of `EDP_Bathymetry_Lakes` — the contour lines, which N6b fetched
 * for the render. Layer 1 of the same service publishes the same survey as depth-**band polygons**
 * carrying `acres`, and `scripts/lake-depth`'s `nhBands.ts` reads those into a max *and* an
 * integrated mean (D133). Two producers writing one ladder rung for one lake is an ambiguity rather
 * than redundancy: whichever loaded second would win a tie the ladder cannot break, and the two do
 * not even agree — the bands give a real maximum (`40–47`), the lines only ever the deepest round
 * isobath.
 *
 * ⚠ **This list governs depth only.** The contour lanes are still what the layer renders from; this
 * is not a statement that the source is superseded, only that its *depth* is.
 */
export const SUPERSEDED_DEPTH_SOURCES: ReadonlySet<string> = new Set(['nh-granit-contours']);

/** Why a lake in the archive produced no depth. Named, never a silent filter. */
export type AgencyDepthSkip =
  /** Every reading was the shoreline zero, or the lake carried no records at all. */
  | 'no-positive-depth'
  /** No on-water point could be derived — a lake with no usable geometry. */
  | 'no-point'
  /** Past the backstop: a units error or a sentinel, not a lake. */
  | 'implausible'
  /** A better lane owns this source's depth — see `SUPERSEDED_DEPTH_SOURCES`. */
  | 'superseded';

export interface AgencyDepthResult {
  depths: AgencyDepthDetail[];
  skipped: Record<AgencyDepthSkip, number>;
  /** The lakes skipped, by key, so a gap is chased rather than inferred. */
  skippedKeys: { key: string; reason: AgencyDepthSkip }[];
}

/**
 * One archived lake → its maximum depth, or a named refusal.
 *
 * **The zero check is load-bearing, and it is why `maxDepthFt` returning 0 has to mean "nothing".**
 * `SHORELINE_DEPTH` rows are how three of these sources close their polygons — Champlain's archive is
 * 84,565 shoreline zeros against 20,345 real soundings — so a lake whose survey is *only* shoreline
 * would otherwise report a maximum depth of zero metres, which reads as a measurement rather than as
 * an absence.
 */
export function agencyDepthFor(
  lake: ArchivedLake,
): { ok: true; detail: AgencyDepthDetail } | { ok: false; reason: AgencyDepthSkip } {
  // **Checked first**, before anything is measured: a superseded source is not a lake that failed,
  // it is a lake somebody else is answering for, and computing a depth we then discard would put a
  // number in the log that never reaches the corpus.
  if (SUPERSEDED_DEPTH_SOURCES.has(lake.sourceKey)) return { ok: false, reason: 'superseded' };

  // The contour build's own helper, not a second one — `maxDepthFt` is what picks the interval and
  // frames the render, and a depth we store that disagreed with the depth we draw would be the worst
  // kind of quiet.
  const depthFt = maxDepthFt(lake);
  if (!(depthFt > 0)) return { ok: false, reason: 'no-positive-depth' };

  const maxDepthM = depthFt / FEET_PER_METRE;
  if (maxDepthM > MAX_PLAUSIBLE_AGENCY_DEPTH_M) return { ok: false, reason: 'implausible' };

  // The deepest sounding, or a mid-vertex of the deepest contour — guaranteed on water, and the
  // reasoning for that is `representativePoint`'s own: the deepest thing in a lake is furthest from
  // any shore, so it is the least likely to fall outside an outline a different survey drew.
  const point = representativePoint(lake);
  if (point === undefined) return { ok: false, reason: 'no-point' };

  const sampleCount = (lake.soundings ?? lake.contours ?? []).length;
  return {
    ok: true,
    detail: {
      record: {
        key: `${lake.sourceKey}/${lake.lakeKey}`,
        point,
        ...(lake.lakeName ? { name: lake.lakeName } : {}),
        maxDepthM,
        maxDepthSource: 'state_agency',
      },
      state: lake.state,
      agency: lake.agency,
      sourceKey: lake.sourceKey,
      lane: lake.lane,
      sampleCount,
      understatesMax: lake.lane === 'contours',
    },
  };
}

/** Every archived lake → its depth, with the refusals counted and named. */
export function agencyDepths(lakes: readonly ArchivedLake[]): AgencyDepthResult {
  const depths: AgencyDepthDetail[] = [];
  const skipped: Record<AgencyDepthSkip, number> = {
    'no-positive-depth': 0,
    'no-point': 0,
    implausible: 0,
    superseded: 0,
  };
  const skippedKeys: { key: string; reason: AgencyDepthSkip }[] = [];
  for (const lake of lakes) {
    const outcome = agencyDepthFor(lake);
    if (outcome.ok) {
      depths.push(outcome.detail);
      continue;
    }
    skipped[outcome.reason]++;
    skippedKeys.push({ key: `${lake.sourceKey}/${lake.lakeKey}`, reason: outcome.reason });
  }
  return { depths, skipped, skippedKeys };
}

/** Per-source tallies for the run row, so a source that went thin is visible rather than inferred. */
export function depthsBySource(
  depths: readonly AgencyDepthDetail[],
): { sourceKey: string; state: string; lakes: number; deepestM: number }[] {
  const by = new Map<
    string,
    { sourceKey: string; state: string; lakes: number; deepestM: number }
  >();
  for (const d of depths) {
    const row = by.get(d.sourceKey) ?? {
      sourceKey: d.sourceKey,
      state: d.state,
      lakes: 0,
      deepestM: 0,
    };
    row.lakes++;
    row.deepestM = Math.max(row.deepestM, d.record.maxDepthM);
    by.set(d.sourceKey, row);
  }
  return [...by.values()].sort((a, b) => b.lakes - a.lakes);
}
