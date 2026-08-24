/**
 * The corpus read that feeds the imagery reveal mask (N6e PR 2a, D148).
 *
 * ## Why this is its own module
 *
 * The natural home looked like `waterBodies.ts`, beside `listNeedingElevation` and
 * `listNeedingWindRose`, which take the same paged shape. It cannot live there: this query needs
 * `loadParkingForBody` from `accessPoints`, and `accessPoints` already imports
 * `listedBodiesNearCoord` **from** `waterBodies`. That is an import cycle — one that survives `tsc`
 * and would probably survive the bundler too, since both helpers are called inside handlers rather
 * than at module init, but "probably survives the bundler" is not a property worth relying on for a
 * pass that only ever runs once a season. A third module that imports both directions has no cycle
 * to reason about at all.
 */

import { belongsInCorpus } from '@skating/core';
import { v } from 'convex/values';
import { internalQuery } from './_generated/server';
import { loadParkingForBody } from './accessPoints';
import { isListed } from './lib/listing';
import { isSuppressed, loadPutInRows } from './putIns';

/**
 * Every corpus body's geometry and the way in, buffered later into the reveal mask.
 *
 * Feeds `pnpm --filter @skating/imagery bake-masks`, which pushes each of these through
 * `revealShape` and stages one spatially-indexed mask file the granule cutter clips against. Baked
 * **once per season** rather than per granule: ~1,000 granules a season clip against the identical
 * shapes, and the buffer-and-union is the expensive half.
 *
 * ## Why the access rows are read here rather than joined by the caller
 *
 * The alternative is one `accessForBody` round trip per body — 25,197 `convex run` invocations for a
 * job that has to finish before the season does. Two index reads inside a page the handler is already
 * holding cost nothing next to that. It is `listNeedingElevation`'s rule one table over: put the work
 * between the cheap read and the expensive step, never on the far side of it.
 *
 * ## What is deliberately left out
 *
 * **Report-derived put-in clusters.** `putIns.listForBody` composes stored markers with clusters
 * derived from recent reports; those are *not* here. They are recomputed constantly while this
 * artifact is baked once, so a mask built from them would be stale within days — and they cost
 * nothing to omit, because a cluster derived from reports *of skating* is on the water by
 * construction and already sits inside the water's own buffer. The stored put-in at the end of a
 * mile of trail is the case that actually needs the tentacle, and that one is here.
 *
 * ⚠ **Batches are small on purpose.** The payload is polygons — Champlain's alone runs to tens of
 * thousands of vertices — so this is nothing like the 500-row pages the elevation pass takes. 25
 * keeps a page inside Convex's 16 MB read bound with room for the outliers.
 */
export const listForImageryMask = internalQuery({
  args: {
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, { cursor, batchSize }) => {
    const numItems = Math.min(100, Math.max(1, batchSize ?? 25));
    const page = await ctx.db.query('waterBodies').paginate({ cursor: cursor ?? null, numItems });

    const masks = [];
    let belowFloor = 0;
    let unlisted = 0;
    for (const body of page.page) {
      // ⚠ **A body that is off the map must be off the photograph too** (D48, `lib/listing`).
      //
      // `removedAt` is an admin soft-delisting: a curation call or a **landowner takedown**. The
      // reveal mask is the shape a satellite frame is allowed to show through, so baking one for a
      // delisted body publishes an aerial photograph of exactly the ground somebody asked us to stop
      // showing — months later, in an archive nobody re-reads. The same applies to a moderator's
      // `rejected` body and to a `merged` duplicate, which would otherwise be masked twice.
      //
      // This is the one filter here whose omission fails *open*, which is why it runs before the
      // corpus floor rather than after it.
      if (!isListed(body)) {
        unlisted++;
        continue;
      }

      // The import's own predicate rather than a copied threshold — `listNeedingElevation` documents
      // why a parameterised floor drifts out of sync within hours of somebody changing the real rule.
      if (
        !belongsInCorpus({
          name: body.name ?? '',
          surfaceAreaSqM: body.surfaceAreaSqM ?? 0,
          includedByRequest: body.includedByRequest,
        })
      ) {
        belowFloor++;
        continue;
      }

      const putIns = await loadPutInRows(ctx, body._id);
      // `hidden` is a moderator suppressing a bad coordinate, so it must not pull the reveal out to
      // cover a place we have decided not to show.
      //
      // ⚠ **Status is only half of that, and the other half is the radius.** A hidden row suppresses
      // every marker within `HIDE_SUPPRESS_METERS` of it, not just itself — that is how a moderator
      // kills a bad access point that OSM and a report cluster both re-derive. Filtering on
      // `status === 'visible'` alone (which `loadPutInRows` has already done) would let the OSM
      // launch 30 m from the hidden coord buffer the very ground the hide was protecting, on the
      // one surface where nobody would ever notice.
      const visiblePutIns = [...putIns.official, ...putIns.osm, ...putIns.persisted].filter(
        (p) => !isSuppressed(p.coord, putIns.hidden),
      );
      const parking = await loadParkingForBody(ctx, body._id);

      masks.push({
        waterBodyId: body._id,
        name: body.name,
        polygon: body.polygon,
        // Only routed hike-in legs carry a path. A drive-up ramp's "walk" is a few metres already
        // inside the water's buffer, so it would add vertices and no shape (`ImageryMaskInput`).
        approachPaths: visiblePutIns.flatMap((p) =>
          p.approachPath && p.approachPath.length >= 2 ? [p.approachPath] : [],
        ),
        parkingCoords: parking.map((lot) => lot.coord),
        markerCoords: visiblePutIns.map((p) => p.coord),
      });
    }

    return {
      masks,
      scanned: page.page.length,
      // Counted so a run can say how much of the corpus it deliberately walked past, rather than
      // leaving "scanned 25,197, masked 18,400" reading as a 27% failure. Two numbers rather than
      // one because they mean different things: `belowFloor` is a body the import would never have
      // taken, `unlisted` is one somebody took *off* the map.
      belowFloor,
      unlisted,
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});
