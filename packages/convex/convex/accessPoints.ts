/**
 * The access layer's server side (N6d / D72, D143) — the geometric join, and the reads that serve it.
 *
 * ## Why the join is here and not in the ETL
 *
 * The N6d plan's B2 says put-in candidates within ~30 m of a body's polygon boundary attach to that
 * body, which reads as transform work. It cannot be: the transform has no polygons, and post-N7 the
 * merge output is **not** the loaded corpus — bodies are pruned, deduped, re-keyed and retired after
 * it, so measuring locally would measure against a snapshot that has already moved.
 *
 * This is exactly what N6a discovered mid-build about the depth join, and it takes the same fix:
 * resolve against the N1 cell index through `listedBodiesNearCoord`, which costs one small indexed
 * lookup per access point. The benefit is the same too — an access point and the app's own "you're at
 * Lake X" resolution agree by construction, because both go through the same lookup.
 *
 * ## The two radii are not the same rule
 *
 * A launch is *on* the water by definition, so `PUTIN_SHORE_RADIUS_M` (30 m) is tight and the only
 * slack it needs is the disagreement between OSM's shoreline and ours. A lot is *near* the water, so
 * `PARKING_INFER_RADIUS_M` (250 m) is generous — and it caps **inference only**. A human may associate
 * a lot with a body at any distance whatsoever (D72 amendment); that path writes
 * `parkingAreaBodies.inferred = false` and this pass must never overwrite it.
 *
 * ## What the ladder protects
 *
 * `official` beats `osm` beats `derived`. A re-import updates its own rung and refuses to touch a
 * higher one, so an operator's correction survives every future run — the same discipline as the N6a
 * depth ladder, and for the same reason: a correction that a re-import can erase is not worth making.
 * A moderator-hidden coordinate is likewise never resurrected by an import.
 */

import {
  distanceToPolygonMeters,
  haversineMeters,
  type LatLng,
  PARKING_INFER_RADIUS_M,
  PUTIN_SHORE_RADIUS_M,
} from '@skating/core';
import { v } from 'convex/values';
import type { MultiPolygon, Polygon } from 'geojson';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx, type QueryCtx, query } from './_generated/server';
import { ACCESS_AMENITIES } from './lib/enums';
import { latLng, literals } from './lib/validators';
import { listedBodiesNearCoord } from './waterBodies';

/**
 * How far a moderator-hidden coordinate suppresses an imported access point.
 *
 * The same radius `putIns.listForBody` already uses to suppress derived clusters, and shared for the
 * reason that rule exists at all: a `hide` is a statement about *this launch*, and an import that
 * re-created it 40 m away with a fresh OSM id would make the moderator's action a game of
 * whack-a-mole. Re-stated here rather than imported because `putIns.ts` keeps it private, and the two
 * are the same number for the same reason — if they ever diverge it should be deliberate.
 */
export const IMPORT_SUPPRESS_METERS = 150;

/** The bodies a coordinate is close enough to, nearest first. Shared by both import lanes. */
async function bodiesWithin(
  ctx: MutationCtx,
  coord: LatLng,
  radiusMeters: number,
): Promise<{ body: Doc<'waterBodies'>; distance: number }[]> {
  const byId = await listedBodiesNearCoord(ctx, coord);
  const hits: { body: Doc<'waterBodies'>; distance: number }[] = [];
  for (const body of byId.values()) {
    const distance = distanceToPolygonMeters(coord, body.polygon as unknown as Polygon | MultiPolygon);
    if (distance <= radiusMeters) hits.push({ body, distance });
  }
  return hits.sort((a, b) => a.distance - b.distance);
}

/** Has a moderator hidden this spot? An import must not undo that (see `IMPORT_SUPPRESS_METERS`). */
async function isModeratorSuppressed(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
  coord: LatLng,
): Promise<boolean> {
  const rows = await ctx.db
    .query('putIns')
    .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
    .collect();
  return rows.some(
    (r) => r.status === 'hidden' && haversineMeters(coord, r.coord) <= IMPORT_SUPPRESS_METERS,
  );
}

/** Upsert one lot↔body association, never clobbering a human's assertion with an inference. */
async function linkParkingToBody(
  ctx: MutationCtx,
  parkingAreaId: Id<'parkingAreas'>,
  waterBodyId: Id<'waterBodies'>,
  inferred: boolean,
): Promise<'created' | 'kept' | 'promoted'> {
  const existing = await ctx.db
    .query('parkingAreaBodies')
    .withIndex('by_parking_area_water_body', (q) =>
      q.eq('parkingAreaId', parkingAreaId).eq('waterBodyId', waterBodyId),
    )
    .unique();
  if (!existing) {
    await ctx.db.insert('parkingAreaBodies', {
      parkingAreaId,
      waterBodyId,
      inferred,
      createdAt: Date.now(),
    });
    return 'created';
  }
  // A human's assertion outranks the pass's guess, in the one direction that matters: an inference
  // may be *promoted* to an assertion, never the reverse. Re-running the ETL over a lot an operator
  // has since confirmed must leave it confirmed.
  if (existing.inferred && !inferred) {
    await ctx.db.patch(existing._id, { inferred: false });
    return 'promoted';
  }
  return 'kept';
}

/**
 * Load a batch of parking areas and attach them to every body they plausibly serve (N6d B3).
 *
 * Runs **before** the put-in lane, because a put-in references its lot by OSM id and cannot be
 * resolved until the lot is a row. That ordering is why the transform emits two files rather than one
 * mixed stream: a mixed stream works right up until a pair straddles a batch boundary.
 *
 * A lot with no body in range is still stored. It may be a mile from the ice and paired to a launch
 * that *is* on the water, in which case the put-in lane attaches it — which is the case the whole
 * phase exists for, and dropping it here would be the phase deleting its own subject.
 */
export const matchAndImportParking = internalMutation({
  args: {
    lots: v.array(
      v.object({
        externalId: v.string(),
        point: latLng,
        name: v.optional(v.string()),
        amenities: v.array(literals(ACCESS_AMENITIES)),
        capacity: v.optional(v.number()),
        fee: v.optional(v.boolean()),
      }),
    ),
  },
  handler: async (ctx, { lots }) => {
    let created = 0;
    let updated = 0;
    let operatorHeld = 0;
    let linksCreated = 0;
    let linksPromoted = 0;
    let withoutBody = 0;
    const notes: { key: string; reason: string }[] = [];

    for (const lot of lots) {
      const existing = await ctx.db
        .query('parkingAreas')
        .withIndex('by_external_id', (q) => q.eq('externalId', lot.externalId))
        .unique();

      let parkingAreaId: Id<'parkingAreas'>;
      if (!existing) {
        parkingAreaId = await ctx.db.insert('parkingAreas', {
          coord: lot.point,
          name: lot.name,
          source: 'osm',
          status: 'visible',
          amenities: lot.amenities,
          capacity: lot.capacity,
          fee: lot.fee,
          externalId: lot.externalId,
          createdAt: Date.now(),
        });
        created++;
      } else if (existing.source === 'official') {
        // The ladder. An operator promoted this lot, so the import may not move its coordinate, its
        // name or its amenities — but the *associations* below still run, because "which lakes does
        // this serve" is a fact about geography that an operator promoting a lot never asserted.
        parkingAreaId = existing._id;
        operatorHeld++;
        notes.push({
          key: lot.externalId,
          reason: `an operator owns this lot${existing.name ? ` ("${existing.name}")` : ''} — fields untouched, associations still refreshed`,
        });
      } else {
        parkingAreaId = existing._id;
        await ctx.db.patch(existing._id, {
          coord: lot.point,
          name: lot.name,
          amenities: lot.amenities,
          capacity: lot.capacity,
          fee: lot.fee,
        });
        updated++;
      }

      const nearby = await bodiesWithin(ctx, lot.point, PARKING_INFER_RADIUS_M);
      if (nearby.length === 0) withoutBody++;
      for (const { body } of nearby) {
        const outcome = await linkParkingToBody(ctx, parkingAreaId, body._id, true);
        if (outcome === 'created') linksCreated++;
        if (outcome === 'promoted') linksPromoted++;
      }
    }

    return { created, updated, operatorHeld, linksCreated, linksPromoted, withoutBody, notes };
  },
});

/**
 * Load a batch of put-in candidates, attach each to its body, and link its lot (N6d B3).
 *
 * **Every rejection is counted and named**, on the N6a rule that an ETL matching 60% of its input
 * looks exactly like one that matched all of it. The two failure classes are kept apart on purpose:
 * `noBodyNearby` means the corpus has nothing here — a coastal slipway, a river landing, a pond below
 * the N7 admission floor — and is a scope boundary rather than a fault. `moderatorSuppressed` means we
 * found the body and declined to write, which is the only one worth a human's attention.
 */
export const matchAndImportPutIns = internalMutation({
  args: {
    putIns: v.array(
      v.object({
        externalId: v.string(),
        point: latLng,
        name: v.optional(v.string()),
        parkingExternalId: v.optional(v.string()),
        approachMeters: v.optional(v.number()),
        approachAscentM: v.optional(v.number()),
        approachRouted: v.optional(v.boolean()),
      }),
    ),
  },
  handler: async (ctx, { putIns }) => {
    let created = 0;
    let updated = 0;
    let operatorHeld = 0;
    let noBodyNearby = 0;
    let moderatorSuppressed = 0;
    let parkingLinked = 0;
    let parkingMissing = 0;
    const notes: { key: string; reason: string }[] = [];

    for (const candidate of putIns) {
      const nearby = await bodiesWithin(ctx, candidate.point, PUTIN_SHORE_RADIUS_M);
      const nearest = nearby[0];
      if (!nearest) {
        noBodyNearby++;
        continue;
      }
      const waterBodyId = nearest.body._id;

      if (await isModeratorSuppressed(ctx, waterBodyId, candidate.point)) {
        moderatorSuppressed++;
        notes.push({
          key: candidate.externalId,
          reason: `a moderator hid this access point on "${nearest.body.name}" — not re-created`,
        });
        continue;
      }

      // Resolve the lot first: an operator-held put-in still gets its association refreshed, for the
      // same reason an operator-held lot does. Where the car goes is a fact about the world; which
      // rung the row sits on is a statement about who last vouched for it.
      let parkingAreaId: Id<'parkingAreas'> | undefined;
      const parkingExternalId = candidate.parkingExternalId;
      if (parkingExternalId) {
        const lot = await ctx.db
          .query('parkingAreas')
          .withIndex('by_external_id', (q) => q.eq('externalId', parkingExternalId))
          .unique();
        if (lot) {
          parkingAreaId = lot._id;
          parkingLinked++;
          // The lot may sit beyond `PARKING_INFER_RADIUS_M` of any shoreline while serving a launch
          // that is on one — a mile-in trailhead is exactly that shape. The pairing already
          // established the relationship locally, so the association follows the launch's body.
          await linkParkingToBody(ctx, lot._id, waterBodyId, true);
        } else {
          parkingMissing++;
          notes.push({
            key: candidate.externalId,
            reason: `paired lot ${parkingExternalId} is not loaded — run the parking stage first`,
          });
        }
      }

      const existing = await ctx.db
        .query('putIns')
        .withIndex('by_external_id', (q) => q.eq('externalId', candidate.externalId))
        .unique();

      const fields = {
        waterBodyId,
        coord: candidate.point,
        name: candidate.name,
        parkingAreaId,
        approachMeters: candidate.approachMeters,
        approachAscentM: candidate.approachAscentM,
        approachRouted: candidate.approachRouted,
      };

      if (!existing) {
        await ctx.db.insert('putIns', {
          ...fields,
          source: 'osm',
          status: 'visible',
          externalId: candidate.externalId,
          createdAt: Date.now(),
        });
        created++;
      } else if (existing.source === 'official') {
        operatorHeld++;
        // The approach is measured, not asserted — an operator pinning a marker said "you can get on
        // the ice here", not "the walk is 40 m". So the routed numbers refresh while the coordinate,
        // the name and the rung stay exactly as the operator left them.
        await ctx.db.patch(existing._id, {
          parkingAreaId,
          approachMeters: candidate.approachMeters,
          approachAscentM: candidate.approachAscentM,
          approachRouted: candidate.approachRouted,
        });
        notes.push({
          key: candidate.externalId,
          reason: `an operator owns this put-in on "${nearest.body.name}" — coordinate and name untouched, approach refreshed`,
        });
      } else {
        await ctx.db.patch(existing._id, fields);
        updated++;
      }
    }

    return {
      created,
      updated,
      operatorHeld,
      noBodyNearby,
      moderatorSuppressed,
      parkingLinked,
      parkingMissing,
      notes,
    };
  },
});

/** A parking area as a client consumes it, with the walk from it already resolved. */
export interface ParkingMarker {
  id: Id<'parkingAreas'>;
  coord: LatLng;
  name?: string;
  source: 'osm' | 'official';
  amenities: readonly string[];
  capacity?: number;
  fee?: boolean;
}

/** Every visible parking area serving a body — the directions target and the drawer's access line. */
export async function loadParkingForBody(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<ParkingMarker[]> {
  const links = await ctx.db
    .query('parkingAreaBodies')
    .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
    .collect();
  const lots: ParkingMarker[] = [];
  for (const link of links) {
    const lot = await ctx.db.get(link.parkingAreaId);
    if (!lot || lot.status !== 'visible') continue;
    lots.push({
      id: lot._id,
      coord: lot.coord,
      name: lot.name,
      source: lot.source,
      amenities: lot.amenities,
      capacity: lot.capacity,
      fee: lot.fee,
    });
  }
  // Operator-set lots first — the same priority ordering `putIns.listForBody` gives official markers,
  // and for the same reason: a human vouched for this one.
  return lots.sort((a, b) => (a.source === b.source ? 0 : a.source === 'official' ? -1 : 1));
}

/** Public: the parking areas serving a body. Returns `[]` for an unknown body. */
export const listParkingForBody = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }): Promise<ParkingMarker[]> => {
    const body = await ctx.db.get(waterBodyId);
    if (!body) return [];
    return loadParkingForBody(ctx, waterBodyId);
  },
});
