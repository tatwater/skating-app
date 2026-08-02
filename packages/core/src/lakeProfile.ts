/**
 * The caption's client-side assembly (N6c Workstream C) — turning a `waterBodies` row plus the
 * per-state decile basis into the single string both clients render.
 *
 * Lives in `@skating/core` rather than in either client for the reason rule 1 gives: web and
 * mobile must render **identical** prose. Two call sites assembling the same clauses is two call
 * sites that drift, and the drift would be invisible — nobody diffs a lake page across platforms.
 */

import { type CaptionBasis, type CaptionInput, lakeCaption, STATE_NAMES } from './lakeCaption';
import type { DecileBlock } from './regionStats';

/** One `regionStats` row, as the `regionStats.list` query returns it. */
export interface RegionStatsRow {
  state: string;
  metrics: {
    maxDepthM?: DecileBlock;
    meanDepthM?: DecileBlock;
    elevationM?: DecileBlock;
    surfaceAreaSqM?: DecileBlock;
    longAxisM?: DecileBlock;
  };
}

/** The subset of a water body a caption reads. Structural, so both clients' `Doc` shapes satisfy it. */
export interface CaptionBody {
  name?: string;
  states?: string[];
  surfaceAreaSqM?: number;
  meanDepthM?: number;
  maxDepthM?: number;
  meanDepthSource?: CaptionInput['meanDepthSource'];
  maxDepthSource?: CaptionInput['maxDepthSource'];
  elevationM?: number;
  shorelineM?: number;
  longAxisM?: number;
  shortAxisM?: number;
  longAxisBearingDeg?: number;
  fetchProfileM?: number[];
  windRose?: number[];
}

/**
 * Pick the state a body should be compared against.
 *
 * **The first of its `states`, which is alphabetical** because `importCanonical` sorts the union.
 * A border-spanning body genuinely belongs to several populations, and there is no principled way
 * to choose one from the row alone — Champlain is among the deepest in Vermont *and* in New York,
 * and both sentences are true. Alphabetical is arbitrary but **stable**, which is the property that
 * matters: the alternative is a caption whose comparison flips between renders.
 */
export function captionStateFor(body: CaptionBody): string | undefined {
  return body.states?.find((code) => STATE_NAMES[code] !== undefined);
}

/**
 * Assemble a body's caption, or `null` when there is nothing to say.
 *
 * `regionStats` is optional: without it the comparative clauses simply do not fire, which is the
 * correct degradation (a comparison we cannot support is a clause we omit) and also what every
 * body looks like before the first `regionStats.recompute` has run.
 */
export function buildLakeCaption(
  body: CaptionBody | null | undefined,
  regionStats: readonly RegionStatsRow[] | undefined,
): string | null {
  if (!body) return null;
  const stateCode = captionStateFor(body);
  const row = stateCode ? regionStats?.find((r) => r.state === stateCode) : undefined;
  const basis: CaptionBasis | undefined = row?.metrics;

  return lakeCaption({
    surfaceAreaSqM: body.surfaceAreaSqM,
    meanDepthM: body.meanDepthM,
    maxDepthM: body.maxDepthM,
    meanDepthSource: body.meanDepthSource,
    maxDepthSource: body.maxDepthSource,
    elevationM: body.elevationM,
    shorelineM: body.shorelineM,
    longAxisM: body.longAxisM,
    shortAxisM: body.shortAxisM,
    longAxisBearingDeg: body.longAxisBearingDeg,
    fetchProfileM: body.fetchProfileM,
    windRose: body.windRose,
    ...(stateCode ? { stateName: STATE_NAMES[stateCode] } : {}),
    ...(basis ? { basis } : {}),
  });
}
