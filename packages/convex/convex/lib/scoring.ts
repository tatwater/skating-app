/**
 * Display scoring for water bodies (D49, A06c §4.2), shared by every site that writes a body's
 * `displayScore` / `minVisibleZoom` — the import, the backfill, `create`, the curation mutations,
 * and the standing transitions in `./standing`.
 *
 * Lifted out of `waterBodies.ts` in A07b because standing needs to re-score and `waterBodies.ts`
 * already imports the standing helpers: a shared leaf module is the only shape without a cycle.
 *
 * ⚠ **`active` is a property of an *existing* row, and every caller that re-scores one has to pass
 * it.** It is the one input here that is not derivable from an incoming record, and an omission
 * does not fail — it silently lands a dormant body back on its browsable rung and nothing says so.
 * `importCanonical` is the dangerous caller: it patches a named field list, so `dormant`,
 * `publicAccess` and `removedAt` all survive by omission while the *rung* they imply would be
 * recomputed from area + boost alone. The A06f tests (`assertScoredWithAccess`) pin that this cannot
 * happen; `standingOf(existing)` is the input, never a hand-spelled boolean.
 */

import {
  displayScore,
  isActive,
  minVisibleZoomFor,
  type ProfileRichness,
  type StandingInput,
} from '@skating/core';
import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';

/**
 * Derived display-prominence fields from a body's area, admin boost, profile richness and
 * standing. `minVisibleZoom` is stored on the row AND denormalized onto its cell rows (see
 * `./cellIndex`), where it's the trailing field of `by_cell` — so a wide-zoom query returns the
 * most-prominent bodies first and never reads the rest at all.
 */
export function scoreFields(input: {
  surfaceAreaSqM?: number;
  curatedBoost?: number;
  richness?: ProfileRichness;
  /** `isActive(body)` for a stored row. A new canonical import passes what it will be stored as. */
  active: boolean;
}): { displayScore: number; minVisibleZoom: number } {
  const score = displayScore(input);
  return { displayScore: score, minVisibleZoom: minVisibleZoomFor(score, input.active) };
}

/**
 * A body's A06c §4.2 profile richness, read from what it actually has.
 *
 * **Costs two index reads per body**, which is why it is computed in `backfillCells` (paginated,
 * a few hundred bodies per transaction) and NOT in `importCanonical`, which already does the
 * heaviest work in the app and would pay this on all 116,070 rows mid-import.
 *
 * `hasContours` reads the `bathymetryCoverage` side table rather than a column, because contour
 * coverage is a property of the A06b TILESET rather than of the body — see that table's comment.
 */
export async function richnessFor(
  ctx: QueryCtx,
  body: Doc<'waterBodies'>,
): Promise<ProfileRichness> {
  const putIns = await ctx.db
    .query('putIns')
    .withIndex('by_water_body', (q) => q.eq('waterBodyId', body._id))
    .take(25);
  const visiblePutIns = putIns.filter((p) => p.status === 'visible');

  const report = await ctx.db
    .query('reports')
    .withIndex('by_water_body_skate_end_time', (q) => q.eq('waterBodyId', body._id))
    .first();
  const hazard = report
    ? null
    : await ctx.db
        .query('hazards')
        .withIndex('by_water_body_first_reported', (q) => q.eq('waterBodyId', body._id))
        .first();

  const coverage = await ctx.db
    .query('bathymetryCoverage')
    .withIndex('by_external_id', (q) =>
      q.eq('source', body.source === 'nhd' ? 'nhd' : 'osm').eq('externalId', body.externalId ?? ''),
    )
    .first();

  return {
    // A blank name is the 92% case; a name is a weak but real signal that someone cared.
    hasName: body.name.trim().length > 0,
    hasContours: coverage !== null,
    hasDepth: body.meanDepthM !== undefined || body.maxDepthM !== undefined,
    // ⚠ **`osm` counts as derived, not official** (D143, founder call 2026-08-10). An OSM slipway is
    // stored like an operator's pin and approximate like a report cluster, so neither term was the
    // obvious default — and the resemblance that matters is provenance, not storage. `official` means
    // *a human confirmed you can get on the ice here*, which is what makes it the strongest static
    // signal we have; letting an ETL reach it would not raise OSM's standing, it would lower
    // `official`'s, across the whole corpus in one pass. Both terms have never fired (dev carried 0
    // put-in rows before A06d), so the held `backfillCells` re-score bakes this choice in on its first
    // run with no incumbent to compare against — which is the argument for the conservative rung.
    hasDerivedPutIn: visiblePutIns.some((p) => p.source === 'derived' || p.source === 'osm'),
    hasOfficialPutIn: visiblePutIns.some((p) => p.source === 'official'),
    hasActivity: report !== null || hazard !== null,
  };
}

/**
 * A stored body's `minVisibleZoom` (D49), recomputed from area + boost + standing. Used when a
 * mutation re-cells a body without changing its score inputs (`approve`, `reject`, `merge`), so the
 * cell rows stay correct even for a legacy row missing the field.
 *
 * **Not the richness term**, which is `backfillCells`' and the standing transitions' — so these
 * paths already knowingly drop it. Standing is different: it is a decision rather than a derived
 * statistic, and dropping it would silently put a dormant body back on the browsable ladder every
 * time somebody approved or merged it.
 */
export function zoomSortKey(
  body: StandingInput & { surfaceAreaSqM?: number; curatedBoost?: number },
): number {
  return scoreFields({ ...body, active: isActive(body) }).minVisibleZoom;
}
