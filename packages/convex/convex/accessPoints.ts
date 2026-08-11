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
  HIKE_IN_ASSERT_M,
  haversineMeters,
  isMinor,
  type LatLng,
  MAX_ACCESS_PHOTOS,
  PARKING_INFER_RADIUS_M,
  PUTIN_SHORE_RADIUS_M,
  requiresHikeInAssertion,
  resolvePutInName,
  straightLineApproach,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { MultiPolygon, Polygon } from 'geojson';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalMutation,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from './_generated/server';
import { loadLiveAlertsForBody } from './accessAlerts';
import { requireContributor, requireContributorRole } from './lib/auth';
import { ACCESS_ALERT_TARGETS, ACCESS_AMENITIES, APPROACH_KINDS } from './lib/enums';
import { assertOwnedPhotos, resolvePhotoUrls } from './lib/photoAccess';
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
    const distance = distanceToPolygonMeters(
      coord,
      body.polygon as unknown as Polygon | MultiPolygon,
    );
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
    if (lot?.status !== 'visible') continue;
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Photos (Workstream D / D88) — infrastructure, not conditions
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Attach a photo to a put-in or parking area.
 *
 * **No new permission** (D88). Access photos ride D57's existing report/hazard posting right, because
 * they sit *below* reports and hazards in risk rather than beside them: a bad ice report is a safety
 * problem, a bad photo of a parking lot is wrong but not dangerous. A permission that is always equal
 * to another permission is one that drifts out of sync and confuses somebody in a year.
 *
 * Two inherited constraints do the protective work instead — the `MAX_ACCESS_PHOTOS` cap bounds any
 * single point's abuse surface, and minors are read-only (Phase 3), so the population that can upload
 * is already the population trusted with reports.
 */
export const attachPhoto = mutation({
  args: {
    targetType: literals(ACCESS_ALERT_TARGETS),
    putInId: v.optional(v.id('putIns')),
    parkingAreaId: v.optional(v.id('parkingAreas')),
    photoId: v.id('photos'),
  },
  handler: async (ctx, { targetType, putInId, parkingAreaId, photoId }) => {
    const profile = await requireContributor(ctx);
    if (isMinor(profile.dateOfBirth, Date.now())) {
      throw new ConvexError('Users under 18 cannot upload access-point photos');
    }
    // The same ownership rule reports and hazards hold. It is not merely defensive here: it is what
    // keeps `photoOrphans`' scan-by-author sound, since a photo attached by someone other than its
    // uploader would be referenced by a row no scan of that uploader could reach.
    await assertOwnedPhotos(ctx, [photoId], profile._id);

    const existing = await loadAccessPhotoRows(ctx, targetType, putInId, parkingAreaId);
    if (existing.some((row) => row.photoId === photoId))
      return existing.find((r) => r.photoId === photoId)?._id;
    if (existing.length >= MAX_ACCESS_PHOTOS) {
      throw new ConvexError(`An access point carries at most ${MAX_ACCESS_PHOTOS} photos`);
    }

    if (targetType === 'put_in') {
      if (!putInId) throw new ConvexError('A put-in is required');
      const putIn = await ctx.db.get(putInId);
      if (putIn?.status !== 'visible') throw new ConvexError('Put-in not found');
    } else {
      if (!parkingAreaId) throw new ConvexError('A parking area is required');
      const lot = await ctx.db.get(parkingAreaId);
      if (lot?.status !== 'visible') throw new ConvexError('Parking area not found');
    }

    return ctx.db.insert('accessPhotos', {
      targetType,
      putInId,
      parkingAreaId,
      photoId,
      uploaderId: profile._id,
      createdAt: Date.now(),
    });
  },
});

/**
 * Detach a photo. The uploader may remove their own; a moderator may remove anyone's.
 *
 * **Detaching is not deleting.** The `photos` row survives, and whether the image itself goes is left
 * to the orphan sweep — which, now that this attachment is gone, will find nothing referencing it and
 * remove it after the grace window. Deleting here would duplicate a decision `lib/photoOrphans` exists
 * to make in exactly one place.
 */
export const detachPhoto = mutation({
  args: { accessPhotoId: v.id('accessPhotos'), reason: v.optional(v.string()) },
  handler: async (ctx, { accessPhotoId, reason }) => {
    const profile = await requireContributor(ctx);
    const row = await ctx.db.get(accessPhotoId);
    if (!row) throw new ConvexError('Photo attachment not found');

    const isUploader = row.uploaderId === profile._id;
    const isModerator = profile.role === 'moderator' || profile.role === 'admin';
    if (!isUploader && !isModerator) {
      throw new ConvexError('Only the uploader or a moderator can remove this photo');
    }

    await ctx.db.delete(accessPhotoId);

    if (isModerator && !isUploader) {
      await ctx.db.insert('moderationActions', {
        actorId: profile._id,
        action: 'remove',
        targetType: row.targetType === 'put_in' ? 'putIn' : 'parkingArea',
        targetId: (row.putInId ?? row.parkingAreaId) as string,
        reason: reason ?? 'Removed an access-point photo',
        metadata: { photoId: row.photoId },
        createdAt: Date.now(),
      });
    }
  },
});

/** The attachment rows for one access point. Shared by the cap check and the read path. */
async function loadAccessPhotoRows(
  ctx: QueryCtx,
  targetType: 'put_in' | 'parking_area',
  putInId: Id<'putIns'> | undefined,
  parkingAreaId: Id<'parkingAreas'> | undefined,
) {
  if (targetType === 'put_in') {
    if (!putInId) return [];
    return ctx.db
      .query('accessPhotos')
      .withIndex('by_put_in', (q) => q.eq('putInId', putInId))
      .collect();
  }
  if (!parkingAreaId) return [];
  return ctx.db
    .query('accessPhotos')
    .withIndex('by_parking_area', (q) => q.eq('parkingAreaId', parkingAreaId))
    .collect();
}

/**
 * Serving URLs for one access point's photos.
 *
 * **No visibility gate beyond the access point's own**, unlike a report's photos — and that is a
 * deliberate difference rather than an omission. A report's photos inherit its moderation status
 * because they document a claim about ice; a picture of a gravel pull-off is public infrastructure and
 * has no private referent to protect. The same reasoning that put these under redact-don't-erase.
 */
export const listPhotos = query({
  args: {
    targetType: literals(ACCESS_ALERT_TARGETS),
    putInId: v.optional(v.id('putIns')),
    parkingAreaId: v.optional(v.id('parkingAreas')),
  },
  handler: async (ctx, { targetType, putInId, parkingAreaId }) => {
    const rows = await loadAccessPhotoRows(ctx, targetType, putInId, parkingAreaId);
    const resolved = await resolvePhotoUrls(
      ctx,
      rows.map((r) => r.photoId),
    );
    return resolved.map((photo, i) => ({ ...photo, accessPhotoId: rows[i]?._id }));
  },
});

/**
 * Everything the drawer needs to describe getting onto this lake, in **one round trip**.
 *
 * Put-ins, the lots that serve them, and the live alerts that annotate either — assembled server-side
 * rather than left to three client queries, because the answer the client actually wants is a single
 * choice (`chooseAccessTarget`) computed over all three. Three subscriptions would render a directions
 * button that changes target as they resolve.
 *
 * The put-in list is the **stored** rows only, not `putIns.listForBody`'s derived clusters: a cluster
 * has no id to hang an alert or a photo on, and no parking. Callers that want the map's full marker
 * set still use that query — this one answers "where do I park and how far is the walk".
 */
export const accessForBody = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    const body = await ctx.db.get(waterBodyId);
    if (!body) return { putIns: [], parking: [], blockedIds: [] };

    const rows = await ctx.db
      .query('putIns')
      .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
      .collect();
    const parking = await loadParkingForBody(ctx, waterBodyId);
    const alerts = await loadLiveAlertsForBody(ctx, waterBodyId);

    const interior = (body.interiorPoint ?? body.centroid) as LatLng | undefined;
    const putIns = rows
      .filter((r) => r.status === 'visible')
      .map((r) => ({
        id: r._id,
        coord: r.coord,
        // Resolved here so both clients get the same fallback label — a compass side derived from the
        // body's *interior* point, never its `centroid`, which is Turf's `pointOnFeature` and lands on
        // the shoreline (a bearing taken from there is noise).
        name: resolvePutInName(r.name, r.coord, interior),
        source: r.source,
        parkingAreaId: r.parkingAreaId,
        approachMeters: r.approachMeters,
        approachAscentM: r.approachAscentM,
        approachRouted: r.approachRouted,
        approachKindOverride: r.approachKindOverride,
      }));

    return {
      putIns,
      parking,
      // Flattened to the ids the resolver tests against, so the client does not re-derive "is this
      // launch blocked" from two shapes and get it subtly different from the server.
      blockedIds: alerts
        .map((a) => a.putInId ?? a.parkingAreaId)
        .filter((id): id is NonNullable<typeof id> => id !== undefined),
      alerts,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The operator write path — where D72's amendment actually lives
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Create or update an `official` parking area (moderator).
 *
 * This is rung 1 of the ladder, and the ETL will never overwrite what it writes. It is also the path
 * the D72 amendment was made for: **a human's association has no distance limit.** The ~250 m radius
 * bounds what the OSM pass is willing to *guess*; a mile-away trailhead lot is not an edge case to
 * tolerate here, it is the case the phase exists for, and this mutation deliberately performs no
 * distance check at all.
 *
 * The associations written here are `inferred: false`, which is what protects them: a later ETL run
 * may promote an inference to an assertion but never the reverse.
 */
export const setOfficialParking = mutation({
  args: {
    parkingAreaId: v.optional(v.id('parkingAreas')),
    coord: latLng,
    name: v.optional(v.string()),
    amenities: v.array(literals(ACCESS_AMENITIES)),
    capacity: v.optional(v.number()),
    fee: v.optional(v.boolean()),
    waterBodyIds: v.array(v.id('waterBodies')),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    const now = Date.now();
    const name = args.name?.trim() || undefined;

    let parkingAreaId = args.parkingAreaId;
    if (parkingAreaId) {
      const existing = await ctx.db.get(parkingAreaId);
      if (!existing) throw new ConvexError('Parking area not found');
      await ctx.db.patch(parkingAreaId, {
        coord: args.coord,
        name,
        source: 'official',
        amenities: args.amenities,
        capacity: args.capacity,
        fee: args.fee,
      });
    } else {
      parkingAreaId = await ctx.db.insert('parkingAreas', {
        coord: args.coord,
        name,
        source: 'official',
        status: 'visible',
        amenities: args.amenities,
        capacity: args.capacity,
        fee: args.fee,
        createdByUserId: actor._id,
        createdAt: now,
      });
    }

    // Reconcile the association set. An association this pass does not name is removed **only if it
    // was itself asserted** — an OSM inference the operator simply didn't think about is left alone,
    // because silently deleting the ETL's work on every hand edit would make the two paths fight.
    const existingLinks = await ctx.db
      .query('parkingAreaBodies')
      .withIndex('by_parking_area', (q) =>
        q.eq('parkingAreaId', parkingAreaId as Id<'parkingAreas'>),
      )
      .collect();
    const wanted = new Set(args.waterBodyIds.map(String));
    for (const link of existingLinks) {
      if (!wanted.has(String(link.waterBodyId)) && !link.inferred) await ctx.db.delete(link._id);
    }
    for (const waterBodyId of args.waterBodyIds) {
      await linkParkingToBody(ctx, parkingAreaId, waterBodyId, false);
    }

    await ctx.db.insert('moderationActions', {
      actorId: actor._id,
      action: 'set_parking_area',
      targetType: 'parkingArea',
      targetId: parkingAreaId,
      reason: args.reason ?? 'Set an official parking area',
      metadata: { coord: args.coord, waterBodyIds: args.waterBodyIds, name },
      createdAt: now,
    });
    return parkingAreaId;
  },
});

/**
 * Attach a put-in to a parking area, and/or override its derived approach kind (moderator).
 *
 * **The D144 assertion gate lives here, and it is a gate on the *caller*, not a validation.** Above
 * `HIKE_IN_ASSERT_M` the mutation refuses an association that does not also assert `hike_in`, because
 * a far-flung association is the one input in this phase that costs its author nothing and costs a
 * stranger a night. It is enforced server-side as well as in the UI for the ordinary reason: a rule
 * only the form knows is a rule the next form forgets.
 *
 * It refuses rather than defaults — silently stamping `hike_in` would be the system making the
 * assertion on the author's behalf, which is exactly what D144 says must not happen.
 */
export const setPutInAccess = mutation({
  args: {
    putInId: v.id('putIns'),
    parkingAreaId: v.optional(v.id('parkingAreas')),
    clearParking: v.optional(v.boolean()),
    approachKindOverride: v.optional(literals(APPROACH_KINDS)),
    clearApproachOverride: v.optional(v.boolean()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    const putIn = await ctx.db.get(args.putInId);
    if (!putIn) throw new ConvexError('Put-in not found');

    let approachMeters = putIn.approachMeters;
    let approachRouted = putIn.approachRouted;
    let approachAscentM = putIn.approachAscentM;
    let parkingAreaId = putIn.parkingAreaId;

    if (args.clearParking) {
      parkingAreaId = undefined;
      // The measurements described a walk from a lot that is no longer associated. Keeping them would
      // leave a distance with nothing to walk from — the same reasoning N6a used for retracting the
      // losing half of a contradictory depth pair.
      approachMeters = undefined;
      approachAscentM = undefined;
      approachRouted = undefined;
    } else if (args.parkingAreaId) {
      const lot = await ctx.db.get(args.parkingAreaId);
      if (!lot) throw new ConvexError('Parking area not found');
      parkingAreaId = args.parkingAreaId;
      // Straight-line, flagged. A hand association gets no ORS call — this is a request path, and
      // "never route from a request path" is the one rule D87 asks to be written at the call site.
      // The ETL's next pass replaces it with a routed figure.
      const leg = straightLineApproach(lot.coord, putIn.coord);
      approachMeters = Math.round(leg.meters);
      approachAscentM = undefined;
      approachRouted = false;
    }

    const override = args.clearApproachOverride
      ? undefined
      : (args.approachKindOverride ?? putIn.approachKindOverride);

    if (requiresHikeInAssertion(approachMeters) && override !== 'hike_in') {
      throw new ConvexError(
        `An approach this long must be asserted as hike-in (over ${HIKE_IN_ASSERT_M} m) — set the approach kind explicitly rather than letting it be derived.`,
      );
    }

    await ctx.db.patch(args.putInId, {
      parkingAreaId,
      approachMeters,
      approachAscentM,
      approachRouted,
      approachKindOverride: override,
    });

    await ctx.db.insert('moderationActions', {
      actorId: actor._id,
      action:
        args.approachKindOverride || args.clearApproachOverride
          ? 'set_approach_kind'
          : 'set_parking_area',
      targetType: 'putIn',
      targetId: args.putInId,
      reason: args.reason ?? 'Set put-in access',
      metadata: { parkingAreaId, approachMeters, approachKindOverride: override },
      createdAt: Date.now(),
    });
  },
});
