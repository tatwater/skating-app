/**
 * Body-level shallowness for the D69 decay amplifier (N6a).
 *
 * Two independent paths to the same bit, because they cover different halves of the corpus:
 *  - **depth data** (`isShallowDepth`), which reaches ~7% of bodies — but essentially all of the ones
 *    prominent enough to draw at regional zoom, where "it's big so it's deep" is a bad inference
 *    (Shelburne Pond: 194 km²-scale prominence, ~1.5 m mean);
 *  - a **`shallow_early_thaw` `bodyFeature`**, which is how a local flags a pond nobody has ever
 *    sounded. 73% of the corpus sits under 1 ha, below the floor of every global depth source, so this
 *    path is permanent infrastructure rather than the stand-in the roadmap called it — and it is the
 *    reason shallowness is a boolean and not a curve (a moderator's flag carries no number).
 *
 * OR, not precedence: either one saying "shallow" is enough. A local who flags a bay knows something the
 * modelled mean depth of the whole lake does not.
 */

import { isShallowDepth } from '@skating/core';
import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';

/**
 * Whether a body is shallow for decay purposes. Costs one indexed read of the body's active features,
 * and **only when the depth data hasn't already answered yes** — the cheap path short-circuits, which
 * matters because the caller runs this per hazard-carrying body on an hourly cron.
 */
export async function isShallowBody(ctx: QueryCtx, body: Doc<'waterBodies'>): Promise<boolean> {
  if (isShallowDepth(body)) return true;
  const features = await ctx.db
    .query('bodyFeatures')
    .withIndex('by_water_body_active', (q) => q.eq('waterBodyId', body._id).eq('active', true))
    .collect();
  return features.some((f) => f.type === 'shallow_early_thaw');
}
