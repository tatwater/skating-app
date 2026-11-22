/**
 * **The unmerge of a body merge, row by row** (B01-5d, `unmerge.ts`). For every kind of row a merge
 * moves, deletes, unions or rewrites (the brief's *The unmerge, row by row*): build a world, merge,
 * unmerge, run every scheduled job to its end, and compare the whole database with the world before —
 * the rows themselves and every stored fact (the body-names rows, `inboxCounts`, People's stored
 * counts, cells, library rows, summaries, region states, `searchText`).
 *
 * **The comparison excludes, by name** ({@link census}): the audit table and its snapshots (asserted
 * apart: one unmerge row, each side row undone), the queues the jobs drain, re-created favorites' ids
 * (compared by owner, body, bay and `createdAt`), every `updatedAt`, and the survivor's `changedAt`
 * (forward only: the unmerge stamps it again) — plus the timestamps a recompute writes as it runs
 * ({@link VOLATILE}), each named with why.
 *
 * **The merge here is the real one** ({@link mergeV2}): S4a's `mergeBodyInto` writes the `version: 2`
 * change set itself. The fixture writer that stood in for it until then is gone, and a merge that
 * writes anything else fails every test here.
 */

import { bodySearchTextFor } from '@skating/core';
import { convexTest } from 'convex-test';
import { describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id, TableNames } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { readSnapshot, writeAudit, writeSnapshot } from './lib/audit';
import { queueLibraryRefresh } from './lib/bodyLibrary';
import { refreshBodyNames } from './lib/bodyNames';
import { recomputeBodySummary } from './lib/bodySummary';
import {
  bodySource,
  fileMember,
  flagSource,
  inboxBatch,
  PAGE_SEAM,
  RECONCILE_COST,
  requestSource,
  type TxCost,
} from './lib/inboxItems';
import { OWN_FILING_REFUSAL } from './lib/inboxRules';
import { noteLandmarksNamed } from './lib/landmarkRows';
import { undoState } from './lib/undo';
import { UNMERGING_REFUSAL } from './lib/unmergeState';
import schema from './schema';
import { scheduleRestamp, syncCellsForParent } from './subAreas';
import {
  type LeftKind,
  PAGE_TIME,
  PHASES,
  UNMERGE_ABANDON_REASON,
  UNMERGE_ABANDONED,
  UNMERGE_CANT_RESUME,
  UNMERGE_FAULT,
  UNMERGE_LOSER_MOVED,
  UNMERGE_PARTS_MISSING,
  UNMERGE_PREDATES,
  UNMERGE_RESUME_DONE,
  UNMERGE_RESUME_RUNNING,
  UNMERGE_ROW_STEPS,
  UNMERGE_SURVIVOR_GONE,
  type UnmergeLeft,
  type UnmergeStallCode,
  unmergeBodyBusy,
  unmergeSurvivorMerged,
} from './unmerge';
import { byMeaning, type MergeChangeSet, mergeBodyInto } from './waterBodies';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

/**
 * Whether this file is the one vitest is running (the property test imports this world, and must not
 * run these tests a second time).
 */
const ENTRY = expect.getState().testPath?.endsWith('unmerge.test.ts') ?? true;
/** A suite registered only when this file is the one running. */
const suite = (name: string, fn: () => void) => {
  if (ENTRY) describe(name, fn);
};

const PREFS = {
  activityDetected: true,
  bountyRequest: true,
  hazardConfirmation: true,
  bountyAnswered: true,
  reportRated: true,
  reportCommented: true,
  contentFlagResolved: true,
  favoriteReport: true,
  nearbyReportDigest: false,
  greatReportNearby: false,
  moderatorDecision: true,
};

/** A rectangle as a body's or a bay's outline. */
function rect(minLng: number, minLat: number, maxLng: number, maxLat: number) {
  return {
    polygon: {
      type: 'Polygon' as const,
      coordinates: [
        [
          [minLng, minLat],
          [minLng, maxLat],
          [maxLng, maxLat],
          [maxLng, minLat],
          [minLng, minLat],
        ],
      ],
    },
    bbox: { minLat, minLng, maxLat, maxLng },
    centroid: { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 },
  };
}

/** The kinds of row a world can carry, one round trip each (the brief's table, rows 3–12). */
const KINDS = [
  'partners',
  'content',
  'favorites',
  'favoritesBoth',
  'asks',
  'loserBays',
  'clashingBay',
  'survivorBays',
  'landmarks',
  'skates',
  'lists',
] as const;
type Kind = (typeof KINDS)[number];

interface World {
  t: T;
  actor: { id: Id<'profiles'>; as: ReturnType<T['withIdentity']> };
  colleague: { id: Id<'profiles'>; as: ReturnType<T['withIdentity']> };
  drawer: { id: Id<'profiles'>; as: ReturnType<T['withIdentity']> };
  skater: { id: Id<'profiles'>; as: ReturnType<T['withIdentity']> };
  survivor: Id<'waterBodies'>;
  loser: Id<'waterBodies'>;
  partner: Id<'waterBodies'>;
  /** A body that has nothing to do with the merge — where an unrelated edit moves a row. */
  elsewhere: Id<'waterBodies'>;
  rows: Partial<Record<string, string[]>>;
}

/** A person, staff or not. */
async function person(t: T, subject: string, role: 'member' | 'moderator' | 'admin') {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: `${subject} Test-Person`,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

const now = () => Date.now();

/** A bay on `waterBodyId` with `outline`'s shape. */
function bay(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
  name: string,
  shape: ReturnType<typeof rect>,
  by: Id<'profiles'>,
) {
  return ctx.db.insert('waterBodySubAreas', {
    waterBodyId,
    name,
    aliases: [],
    searchText: name,
    ...shape,
    surfaceAreaSqM: 40_000,
    displayScore: 1,
    minVisibleZoom: 10,
    createdByUserId: by,
    createdAt: now(),
    updatedAt: now(),
  });
}

function landmark(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
  name: string,
  point: { lat: number; lng: number },
) {
  return ctx.db.insert('bodyLandmarks', {
    waterBodyId,
    name,
    kind: 'island' as const,
    point,
    source: 'osm' as const,
    externalIds: [`osm/${name}/${waterBodyId}`],
    aliases: [],
    createdAt: now(),
    updatedAt: now(),
  });
}

/**
 * **A world for a merge**: the survivor (Lake Morey), the loser (a skater's pending drawing over its
 * east half, duplicate-flagged against the survivor and a partner), the partner, and a body elsewhere;
 * with the rows of each kind asked for on them. Every scheduled job is run to its end, so the world
 * stands as a deployment would hold it.
 */
async function world(
  kinds: readonly Kind[] = KINDS,
  /** The survivor a skater's approved drawing (the seed's second pair), not a catalog body. */
  opts: { survivorDrawn?: boolean } = {},
): Promise<World> {
  const t = harness();
  const has = (k: Kind) => kinds.includes(k);
  const actor = await person(t, 'actor', 'moderator');
  const colleague = await person(t, 'colleague', 'moderator');
  const drawer = await person(t, 'drawer', 'moderator');
  const skater = await person(t, 'skater', 'member');
  const fan = await person(t, 'fan', 'member');
  const rows: World['rows'] = {};
  const add = (key: string, id: string) => {
    rows[key] = [...(rows[key] ?? []), id];
  };
  const ids = await t.run(async (ctx) => {
    const base = {
      type: 'lakePond' as const,
      createdAt: now(),
    };
    const survivor = await ctx.db.insert('waterBodies', {
      ...base,
      name: 'Lake Morey',
      searchText: has('lists')
        ? bodySearchTextFor({ name: 'Lake Morey', moderatorAliases: ['Morey', 'Fairlee Lake'] })
        : 'Lake Morey',
      ...(opts.survivorDrawn
        ? {
            source: 'user' as const,
            reviewStatus: 'approved' as const,
            createdByUserId: skater.id,
          }
        : { source: 'osm' as const }),
      ...rect(0, 0, 1, 1),
      dedupStatus: 'clean' as const,
      ...(has('lists')
        ? {
            moderatorAliases: ['Morey', 'Fairlee Lake'],
            referenceLinks: [{ label: 'Town', url: 'https://example.invalid/town' }],
          }
        : {}),
    });
    const loser = await ctx.db.insert('waterBodies', {
      ...base,
      name: 'Morey East Bay',
      searchText: has('lists')
        ? bodySearchTextFor({
            name: 'Morey East Bay',
            moderatorAliases: ['East Morey', 'fairlee lake'],
          })
        : 'Morey East Bay',
      source: 'user' as const,
      reviewStatus: 'pending' as const,
      createdByUserId: drawer.id,
      ...rect(0.5, 0, 1, 1),
      dedupStatus: 'clean' as const,
      ...(has('lists')
        ? {
            moderatorAliases: ['East Morey', 'fairlee lake'],
            referenceLinks: [
              { label: 'Town', url: 'https://example.invalid/town' },
              { label: 'Club', url: 'https://example.invalid/club' },
            ],
          }
        : {}),
    });
    const partner = await ctx.db.insert('waterBodies', {
      ...base,
      name: 'Morey Pond',
      searchText: 'Morey Pond',
      source: 'osm' as const,
      ...rect(0.9, 0.9, 1.4, 1.4),
      dedupStatus: 'clean' as const,
    });
    const elsewhere = await ctx.db.insert('waterBodies', {
      ...base,
      name: 'Far Pond',
      searchText: 'Far Pond',
      source: 'osm' as const,
      ...rect(5, 5, 6, 6),
      dedupStatus: 'clean' as const,
    });
    // The duplicate flags: the drawing names the survivor (and the partner, with `partners`); each
    // names it back, as the reconciliation flags a group mutually.
    await ctx.db.patch(loser, {
      dedupStatus: 'suspected_duplicate',
      duplicateCandidateIds: has('partners') ? [survivor, partner] : [survivor],
    });
    await ctx.db.patch(survivor, {
      dedupStatus: 'suspected_duplicate',
      duplicateCandidateIds: [loser],
    });
    if (has('partners')) {
      await ctx.db.patch(partner, {
        dedupStatus: 'suspected_duplicate',
        duplicateCandidateIds: [loser, elsewhere],
      });
    }
    return { survivor, loser, partner, elsewhere };
  });
  const { survivor, loser, partner, elsewhere } = ids;
  await t.mutation(internal.waterBodies.backfillCells, {});
  await t.run(async (ctx) => {
    // The Bodies library holds every body, as on a deployment.
    await queueLibraryRefresh(ctx, [survivor, loser, partner, elsewhere]);
    await fileMember(ctx, bodySource(loser));
    if (has('content')) {
      add(
        'reports',
        await ctx.db.insert('reports', {
          authorId: skater.id,
          waterBodyId: loser,
          point: { lat: 0.5, lng: 0.75 },
          skateEndTime: now(),
          reportTime: now(),
          source: 'native',
          iceTypes: [{ type: 'black_ice' }],
          surfaceTags: [],
          photoIds: [],
          moderationStatus: 'visible',
          hazardIdsCreated: [],
          createdAt: now(),
          updatedAt: now(),
        }),
      );
      add(
        'hazards',
        await ctx.db.insert('hazards', {
          waterBodyId: loser,
          type: 'open_water',
          geometryKind: 'point_radius',
          geometry: { type: 'Point', coordinates: [0.75, 0.5] },
          radiusMeters: 30,
          bbox: { minLat: 0.49, minLng: 0.74, maxLat: 0.51, maxLng: 0.76 },
          createdByUserId: skater.id,
          photoIds: [],
          status: 'active',
          moderationStatus: 'visible',
          firstReportedAt: now(),
          lastConfirmedAt: now(),
          confirmCount: 0,
          goneCount: 0,
          createdAt: now(),
        }),
      );
      add(
        'bounties',
        await ctx.db.insert('bounties', {
          requesterId: skater.id,
          waterBodyId: loser,
          windowHours: 48,
          status: 'open',
          rewardPoints: 10,
          fulfillingReportIds: [],
          createdAt: now(),
          expiresAt: now() + 86_400_000,
        }),
      );
      add(
        'bodyFeatures',
        await ctx.db.insert('bodyFeatures', {
          waterBodyId: loser,
          type: 'spring_current',
          geometryKind: 'point_radius',
          geometry: { type: 'Point', coordinates: [0.8, 0.5] },
          bbox: { minLat: 0.49, minLng: 0.79, maxLat: 0.51, maxLng: 0.81 },
          addedByUserId: actor.id,
          active: true,
          createdAt: now(),
        }),
      );
      add(
        'putIns',
        await ctx.db.insert('putIns', {
          waterBodyId: loser,
          coord: { lat: 0.1, lng: 0.9 },
          source: 'official',
          status: 'visible',
          createdAt: now(),
        }),
      );
    }
    if (has('favorites')) {
      add(
        'favorites',
        await ctx.db.insert('waterBodyFavorites', {
          userId: skater.id,
          waterBodyId: loser,
          createdAt: now() - 5_000,
        }),
      );
    }
    if (has('favoritesBoth')) {
      // The fan holds both: the merge drops the drawing's row, the unmerge makes it again.
      add(
        'deletedFavorites',
        await ctx.db.insert('waterBodyFavorites', {
          userId: fan.id,
          waterBodyId: loser,
          createdAt: now() - 9_000,
        }),
      );
      add(
        'keptFavorites',
        await ctx.db.insert('waterBodyFavorites', {
          userId: fan.id,
          waterBodyId: survivor,
          createdAt: now() - 8_000,
        }),
      );
    }
    if (has('asks')) {
      const ask = await ctx.db.insert('waterBodyRequests', {
        kind: 'name_bay',
        status: 'open',
        requesterId: skater.id,
        coord: { lat: 0.5, lng: 0.75 },
        waterBodyId: loser,
        name: 'Sunny Cove',
        createdAt: now(),
      });
      await fileMember(ctx, requestSource(ask));
      add('requests', ask);
      add(
        'placeNames',
        await ctx.db.insert('corpusPlaceNames', {
          name: 'Sunny Cove',
          askKey: 'sunny cove',
          aliases: [],
          messages: 3,
          skatedMessages: 1,
          states: ['VT'],
          status: 'open',
          waterBodyId: loser,
          createdAt: now(),
          updatedAt: now(),
        }),
      );
      const flag = await ctx.db.insert('contentFlags', {
        flaggerId: fan.id,
        targetType: 'waterbody',
        targetId: loser,
        reason: 'no_public_access',
        status: 'open',
        origin: 'user',
        createdAt: now(),
      });
      await fileMember(ctx, flagSource(flag));
      add('flags', flag);
    }
    if (has('loserBays')) {
      add('loserBays', await bay(ctx, loser, 'East Cove', rect(0.8, 0.1, 0.95, 0.3), actor.id));
      // A report inside it: its bay join (`reportSubAreas`) follows the report's body both ways.
      add(
        'reports',
        await ctx.db.insert('reports', {
          authorId: skater.id,
          waterBodyId: loser,
          point: { lat: 0.2, lng: 0.85 },
          skateEndTime: now() - 60_000,
          reportTime: now(),
          source: 'native',
          iceTypes: [],
          surfaceTags: [],
          photoIds: [],
          moderationStatus: 'visible',
          hazardIdsCreated: [],
          createdAt: now(),
          updatedAt: now(),
        }),
      );
    }
    if (has('clashingBay')) {
      add(
        'survivorBays',
        await bay(ctx, survivor, 'North Bay', rect(0.1, 0.7, 0.4, 0.95), actor.id),
      );
      // Its namesake on the drawing: the merge delists it by the clash (a side row).
      add('loserBays', await bay(ctx, loser, 'North Bay', rect(0.6, 0.7, 0.9, 0.95), actor.id));
    }
    if (has('survivorBays')) {
      // A bay whose stored outline spills past the survivor's (as after a refined shoreline): the
      // merge's re-clip changes it, and the change set keeps it as it stood.
      add(
        'survivorBays',
        await bay(ctx, survivor, 'West Arm', rect(-0.2, 0.2, 0.3, 0.5), actor.id),
      );
    }
    if (has('landmarks')) {
      // A twin across the two lakes: the drawing's folds into the survivor's.
      add('landmarks', await landmark(ctx, survivor, 'Big Rock', { lat: 0.5, lng: 0.7 }));
      add('landmarks', await landmark(ctx, loser, 'Big Rock', { lat: 0.5, lng: 0.7001 }));
      add('landmarks', await landmark(ctx, loser, 'Gull Island', { lat: 0.3, lng: 0.85 }));
    }
    if (has('skates')) {
      add(
        'gpsActivities',
        await ctx.db.insert('gpsActivities', {
          userId: drawer.id,
          provider: 'native',
          providerActivityId: 'founding',
          sportType: 'IceSkate',
          startTime: now() - 7_200_000,
          endTime: now() - 3_600_000,
          elapsedSeconds: 3_000,
          path: {
            type: 'LineString',
            coordinates: [
              [0.6, 0.5],
              [0.9, 0.5],
            ],
          },
          waterBodyId: loser,
          waterBodyIds: [loser],
          promptState: 'pending',
          detectedAt: now(),
        }),
      );
    }
  });
  // Every derived fact built by the path that keeps it — summaries, name lists, recurrence — so the
  // world stands as a deployment holds it.
  await t.run(async (ctx) => {
    for (const id of [survivor, loser, partner, elsewhere]) {
      await syncCellsForParent(ctx, id, (await ctx.db.get(id)) as Doc<'waterBodies'>);
      await recomputeBodySummary(ctx, id);
      await refreshBodyNames(ctx, id);
      await scheduleRestamp(ctx, id);
      await ctx.scheduler.runAfter(0, internal.recurrence.enqueueBody, { waterBodyId: id });
    }
  });
  await settle(t);
  return { t, actor, colleague, drawer, skater, survivor, loser, partner, elsewhere, rows };
}

/**
 * Every scheduled job run to its end (restamps, recurrence, name rebuilds, the unmerge's own pages),
 * then the Bodies library's queue drained — as a deployment's crons would leave it.
 */
async function settle(t: T): Promise<void> {
  for (let round = 0; round < 50; round++) {
    await t.finishAllScheduledFunctions(() => {});
    const queued = await t.run((ctx) => ctx.db.query('bodyLibraryQueue').first());
    if (queued === null) return;
    await t.mutation(internal.bodyLibrary.drainQueue, {});
  }
  throw new Error('the library queue never drained');
}

// ── The merge (the real one: S4a's merge writes version 2) ─────────────────────────────────────

/**
 * **Merge `loser` into `survivor` through the real `mergeBodyInto`**, returning the merge's row. The
 * fixture writer that stood in for S4a's merge is gone: a merge that writes anything but a `version:
 * 2` change set fails here, so nothing below can pass on a change set the real merge didn't write.
 * `chunked` re-stores the merge's own change set in three parts, as a busy body's merge stores it.
 */
async function mergeV2(
  w: Pick<World, 't' | 'survivor' | 'loser'> & { actor: { id: Id<'profiles'> } },
  opts: { chunked?: boolean } = {},
): Promise<Id<'moderationActions'>> {
  const id = await w.t.run(async (ctx) => {
    const survivor = (await ctx.db.get(w.survivor)) as Doc<'waterBodies'>;
    const loser = (await ctx.db.get(w.loser)) as Doc<'waterBodies'>;
    const { actionId } = await mergeBodyInto(ctx, {
      survivor,
      loser,
      actorId: w.actor.id,
      reason: `Merged into ${survivor.name}`,
    });
    const cs = (await readSnapshot<MergeChangeSet>(ctx, actionId)) as MergeChangeSet;
    if (cs.version !== 2) throw new Error('The real merge wrote no version-2 change set');
    if (opts.chunked) {
      for (const row of await ctx.db
        .query('auditSnapshots')
        .withIndex('by_action', (q) => q.eq('actionId', actionId))
        .collect()) {
        await ctx.db.delete(row._id);
      }
      const json = JSON.stringify(cs);
      const size = Math.ceil(json.length / 3);
      for (let part = 0; part < 3; part++) {
        await ctx.db.insert('auditSnapshots', {
          actionId,
          part,
          payload: { chunk: json.slice(part * size, (part + 1) * size), of: 3 },
          createdAt: Date.now(),
        });
      }
    }
    return actionId;
  });
  await settle(w.t);
  return id;
}

// ── The census: the database as the comparison reads it ───────────────────────────────────────────

/** Tables the census leaves out, each with why. */
const SKIPPED: Partial<Record<TableNames, string>> = {
  moderationActions: 'the audit table: asserted apart (one unmerge row, each side row undone)',
  auditSnapshots: 'the merge’s change set: what the unmerge reads, not what it restores',
  auditBodyLinks: 'the audit table’s index by body: a row per audit row, the unmerge’s among them',
  bodyLibraryQueue: 'drained by `settle`',
  notificationQueue: 'the merged message: asserted apart (told once, or dropped inside the window)',
  peopleJobRuns: 'job bookkeeping',
  inboxJobRuns: 'job bookkeeping',
  jobPositions: 'job bookkeeping',
  bodySummaryRefreshes: 'a recompute’s log of itself',
  geoInputMarks: 'a recompute’s log of itself',
};

/**
 * Fields a recompute writes as of the moment it runs, never restored, by name — each the time of a
 * write, not a fact about the body: `updatedAt` everywhere; the survivor's `changedAt` (forward only)
 * and a library row's copies of it (`changedAsc`, `changedDesc`); an Inbox item's `refreshedAt` and
 * `lastActivityAt` (the time its reconcile ran); a library row's `refreshedAt`; the geometry facts'
 * marks (`staleAt`, `staleSince`, `computedAt`, `markedAt`).
 */
const VOLATILE = new Set([
  'updatedAt',
  'changedAt',
  'refreshedAt',
  'lastActivityAt',
  'staleSince',
  'computedAt',
  'markedAt',
  'staleAt',
  'summaryUpdatedAt',
  // A library row's copy of `changedAt`, the survivor's forward-only stamp.
  'changedAsc',
  'changedDesc',
]);

/**
 * Tables whose rows come back with new ids, compared without them: a favorite the merge dropped is
 * made again (the brief's row 6); and what is recomputed, not restored, is deleted and made again by
 * the path that keeps it: the library's rows and counts as a body leaves and rejoins it, a body's
 * and its bays' cells as it is delisted and listed again, the recurrence clusters as they are
 * re-clustered.
 */
const REMADE: Partial<Record<TableNames, true>> = {
  waterBodyFavorites: true,
  bodyLibraryRows: true,
  bodyLibraryCounts: true,
  waterBodyCells: true,
  waterBodySubAreaCells: true,
  hazardRecurrence: true,
  // An Inbox item is its key's question: one left with no member is deleted, and a member re-keyed to
  // it makes it again. Its members are compared by their item's key (below).
  inboxItems: true,
};

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      if (VOLATILE.has(k) || k === '_creationTime') continue;
      out[k] = strip(v);
    }
    return out;
  }
  return value;
}

/** Tables of counters, whose rows at zero read as absent. */
const COUNTERS: Partial<Record<TableNames, true>> = {
  inboxCounts: true,
  bodyLibraryCounts: true,
  peopleCounts: true,
  imageryCounts: true,
};

/** Every table but {@link SKIPPED}, each row stripped of the volatile fields, in a stable order. */
async function census(t: T): Promise<Record<string, unknown[]>> {
  return t.run(async (ctx) => {
    const out: Record<string, unknown[]> = {};
    const keyOf = new Map(
      (await ctx.db.query('inboxItems').collect()).map((item) => [item._id as string, item.key]),
    );
    for (const table of Object.keys(schema.tables) as TableNames[]) {
      if (SKIPPED[table]) continue;
      // A derived fact read by meaning: never computed and computed over nothing are alike
      // (`byMeaning` — the dev proof's ruling), so a row that means "absent" is left out.
      const meant = (await ctx.db.query(table).collect())
        .map((row) => byMeaning(table, row as unknown as Record<string, unknown>))
        .filter((row): row is Record<string, unknown> => row !== null);
      const rows = meant.map((row) => {
        const s = strip(row) as Record<string, unknown>;
        if (REMADE[table]) delete s._id;
        if (table === 'inboxItemMembers') s.itemId = keyOf.get(s.itemId as string) ?? s.itemId;
        return s;
      });
      // A counter at zero reads as no counter: a count row is made at its first count and kept.
      const counted = COUNTERS[table] ? rows.filter((r) => r.count !== 0) : rows;
      if (counted.length === 0) continue;
      out[table] = counted
        .map((r) => JSON.stringify(r))
        .sort()
        .map((r) => JSON.parse(r));
    }
    return out;
  });
}

/** The unmerge's row (`unmerge_waterbody` on the loser), as it stands. */
async function unmergeRowOf(
  t: T,
  loser: Id<'waterBodies'>,
): Promise<Doc<'moderationActions'> | null> {
  return t.run(async (ctx) => {
    const rows = await ctx.db
      .query('moderationActions')
      .withIndex('by_target', (q) => q.eq('targetType', 'waterbody').eq('targetId', loser))
      .collect();
    return rows.find((r) => r.action === 'unmerge_waterbody') ?? null;
  });
}

/** What the unmerge says it left. */
async function leftOf(t: T, loser: Id<'waterBodies'>): Promise<UnmergeLeft> {
  const row = await unmergeRowOf(t, loser);
  return (row?.metadata?.left ?? { count: 0, byKind: {}, rows: [] }) as UnmergeLeft;
}

/** Undo the merge as `as` (the engine's own `undo.run`), then run every job to its end. */
async function unmerge(
  w: World,
  mergeId: Id<'moderationActions'>,
  as: ReturnType<T['withIdentity']> = w.colleague.as,
): Promise<void> {
  await as.mutation(api.undo.run, { actionId: mergeId, reason: 'Not the same water' });
  await settle(w.t);
}

/** The refusal the run gives, in words (or `null` when it ran). */
async function refusalOf(
  _w: World,
  mergeId: Id<'moderationActions'>,
  as: ReturnType<T['withIdentity']>,
): Promise<string | null> {
  try {
    await as.mutation(api.undo.run, { actionId: mergeId, reason: 'Checked' });
    return null;
  } catch (err) {
    const data = (err as { data?: unknown }).data;
    return data !== undefined ? String(data) : String((err as Error).message);
  }
}

/** The audit side of a round trip: one unmerge row, and every side row the merge wrote undone. */
async function assertAudit(w: World, mergeId: Id<'moderationActions'>): Promise<void> {
  const { unmerges, sides, cs } = await w.t.run(async (ctx) => {
    const all = await ctx.db.query('moderationActions').collect();
    const cs = (await readSnapshot<MergeChangeSet>(ctx, mergeId)) as MergeChangeSet;
    return { unmerges: all.filter((r) => r.action === 'unmerge_waterbody'), sides: all, cs };
  });
  const lead = unmerges.filter((r) => r.targetType === 'waterbody');
  expect(lead).toHaveLength(1);
  expect(lead[0]?.undoesActionId).toBe(mergeId);
  expect(lead[0]?.metadata?.done).toBe(true);
  for (const side of cs.sideActions ?? []) {
    const undone = sides.filter((r) => r.undoesActionId === side);
    expect(undone, `side row ${side}`).toHaveLength(1);
    expect(undone[0]?.action).toBe('unmerge_waterbody');
  }
}

// ── The round trips ────────────────────────────────────────────────────────────────────────────────

suite('a merge and its unmerge: the state equals the state before', () => {
  test.each([...KINDS.map((k) => [k, [k]] as const), ['every kind at once', KINDS] as const])(
    '%s',
    async (_name, kinds) => {
      const w = await world(kinds as readonly Kind[]);
      const before = await census(w.t);
      const mergeId = await mergeV2(w);
      // The merge moved something (else the comparison proves nothing): the drawing is merged.
      expect((await w.t.run((ctx) => ctx.db.get(w.loser)))?.dedupStatus).toBe('merged');
      await unmerge(w, mergeId);
      expect(await leftOf(w.t, w.loser)).toEqual({ count: 0, byKind: {}, rows: [] });
      expect(await census(w.t)).toEqual(before);
      await assertAudit(w, mergeId);
    },
  );

  test('into a skater’s approved drawing (the seed’s second pair), every kind at once', async () => {
    const w = await world(KINDS, { survivorDrawn: true });
    const before = await census(w.t);
    const mergeId = await mergeV2(w);
    await unmerge(w, mergeId);
    expect(await leftOf(w.t, w.loser)).toEqual({ count: 0, byKind: {}, rows: [] });
    expect(await census(w.t)).toEqual(before);
    await assertAudit(w, mergeId);
  });

  test('a survivor whose derived facts were never computed: absent before, computed over nothing after — alike', async () => {
    // The dev proof's case: the survivor's summary was null before the merge (never computed) and
    // the card over nothing after the unmerge (recomputed) — ruled the same. Its name list and its
    // geometry facts too: none before; an empty list and a stale mark after.
    const w = await world(['favorites']);
    await w.t.run(async (ctx) => {
      await ctx.db.patch(w.survivor, { summary: undefined });
      for (const table of ['bodyNameLists', 'bodyGeoFacts'] as const) {
        for (const row of await ctx.db.query(table).collect()) {
          if (row.waterBodyId === w.survivor) await ctx.db.delete(row._id);
        }
      }
    });
    const before = await census(w.t);
    const mergeId = await mergeV2(w);
    await unmerge(w, mergeId);
    // The case is real: each fact is present now where none stood.
    const now = await w.t.run(async (ctx) => ({
      summary: (await ctx.db.get(w.survivor))?.summary,
      names: (await ctx.db.query('bodyNameLists').collect()).filter(
        (r) => r.waterBodyId === w.survivor,
      ),
      geo: (await ctx.db.query('bodyGeoFacts').collect()).filter(
        (r) => r.waterBodyId === w.survivor,
      ),
    }));
    expect(now.summary).toMatchObject({ recentReportCount: 0, topHazardTypes: [] });
    expect(now.names).toHaveLength(1);
    expect(now.geo).toHaveLength(1);
    expect(await census(w.t)).toEqual(before);
  });

  test('the dev proof’s census reads those facts by meaning too', async () => {
    const w = await world(['favorites']);
    await w.t.run(async (ctx) => {
      await ctx.db.patch(w.survivor, { summary: undefined });
      for (const table of ['bodyNameLists', 'bodyGeoFacts'] as const) {
        for (const row of await ctx.db.query(table).collect()) {
          if (row.waterBodyId === w.survivor) await ctx.db.delete(row._id);
        }
      }
      // What a recompute over nothing leaves: an empty name list, a facts row with only its mark.
      await ctx.db.insert('bodyNameLists', {
        waterBodyId: w.survivor,
        capped: false,
        landmarks: [],
        bays: [],
        updatedAt: 1,
      });
      await ctx.db.insert('bodyGeoFacts', { waterBodyId: w.survivor, staleAt: 1 });
    });
    const out = JSON.parse(
      await w.t.query(internal.waterBodies.mergeProofCensus, { ids: [w.survivor] }),
    ) as Record<
      string,
      {
        body: { summary: unknown };
        bodyNames: { rows: unknown[] };
        bodyGeoFacts: { rows: unknown[] };
      }
    >;
    const survivor = out[w.survivor];
    expect(survivor?.body.summary).toEqual({ recentReportCount: 0, topHazardTypes: [] });
    expect(survivor?.bodyNames.rows).toEqual([]);
    expect(survivor?.bodyGeoFacts.rows).toEqual([]);
    // A fact that is there is read as it is.
    expect(byMeaning('bodyGeoFacts', { waterBodyId: 'b', staleAt: 1, towns: [] })).not.toBeNull();
    expect(byMeaning('names', { capped: true, landmarks: [], bays: [] })).not.toBeNull();
    const card = { recentReportCount: 2, topHazardTypes: [] };
    expect(byMeaning('waterBodies', { summary: card })).toEqual({ summary: card });
    expect(byMeaning('reports', { a: 1 })).toEqual({ a: 1 });
  });

  test('a moved report’s bay join follows it in the page that moves it, before any restamp runs', async () => {
    const w = await world(['loserBays']);
    const mergeId = await mergeV2(w);
    await w.colleague.as.mutation(api.undo.run, { actionId: mergeId, reason: 'Two lakes' });
    // Nothing scheduled has run yet: the join was re-mirrored by the unmerge's own page.
    const joins = await w.t.run((ctx) => ctx.db.query('reportSubAreas').collect());
    expect(joins.length).toBeGreaterThan(0);
    expect(joins.every((j) => j.waterBodyId === w.loser)).toBe(true);
  });

  test('the change set split in parts unmerges the same', async () => {
    const w = await world();
    const before = await census(w.t);
    const mergeId = await mergeV2(w, { chunked: true });
    await unmerge(w, mergeId);
    expect(await census(w.t)).toEqual(before);
  });

  test('the merge moved what the world holds, and the side rows exist (the table is not vacuous)', async () => {
    const w = await world();
    const mergeId = await mergeV2(w);
    const cs = await w.t.run(
      async (ctx) => (await readSnapshot<MergeChangeSet>(ctx, mergeId)) as MergeChangeSet,
    );
    const tables = new Set(cs.moved.map((m) => m.table));
    for (const table of [
      'reports',
      'hazards',
      'bounties',
      'bodyFeatures',
      'putIns',
      'waterBodyFavorites',
      'waterBodyRequests',
      'corpusPlaceNames',
      'contentFlags',
    ] as const) {
      expect(tables.has(table), table).toBe(true);
    }
    expect(cs.deletedFavorites).toHaveLength(1);
    expect(cs.subAreasDelisted).toHaveLength(1);
    expect(cs.survivorSubAreasBefore?.length).toBeGreaterThan(0);
    expect(cs.landmarksAfter.length).toBeGreaterThan(0);
    expect(cs.sideActions?.length).toBeGreaterThanOrEqual(2);
    expect(cs.movedActivities).toHaveLength(1);
    expect(cs.dedupAfter?.length).toBe(2);
    expect(cs.loserReview).toEqual({ reviewStatus: 'pending', decidedItem: true });
  });
});

// ── The refusals: each says its sentence and writes nothing ────────────────────────────────────────

/** The audit rows and the census together: what "writes nothing" compares. */
async function everything(t: T) {
  return {
    census: await census(t),
    audit: await t.run((ctx) => ctx.db.query('moderationActions').collect()),
  };
}

suite('the unmerge refuses at the body level, before any write', () => {
  const cases: {
    name: string;
    setup: (w: World, mergeId: Id<'moderationActions'>) => Promise<void>;
    says: (w: World) => Promise<string | RegExp>;
  }[] = [
    {
      name: 'a merge recorded before version 2',
      setup: async (w, mergeId) => {
        await w.t.run(async (ctx) => {
          const cs = (await readSnapshot<MergeChangeSet>(ctx, mergeId)) as MergeChangeSet;
          const { version: _v, ...old } = cs;
          for (const r of await ctx.db
            .query('auditSnapshots')
            .withIndex('by_action', (q) => q.eq('actionId', mergeId))
            .collect()) {
            await ctx.db.delete(r._id);
          }
          await writeSnapshot(ctx, mergeId, old);
        });
      },
      says: async () => UNMERGE_PREDATES,
    },
    {
      name: 'a merge with no change set at all',
      setup: async (w, mergeId) => {
        await w.t.run(async (ctx) => {
          for (const r of await ctx.db
            .query('auditSnapshots')
            .withIndex('by_action', (q) => q.eq('actionId', mergeId))
            .collect()) {
            await ctx.db.delete(r._id);
          }
        });
      },
      says: async () => UNMERGE_PREDATES,
    },
    {
      name: 'a part of the change set missing',
      setup: async (w, mergeId) => {
        await w.t.run(async (ctx) => {
          const part = await ctx.db
            .query('auditSnapshots')
            .withIndex('by_action', (q) => q.eq('actionId', mergeId).eq('part', 1))
            .first();
          if (part) await ctx.db.delete(part._id);
        });
      },
      says: async () => UNMERGE_PARTS_MISSING,
    },
    {
      name: 'a version-2 field missing',
      setup: async (w, mergeId) => {
        await w.t.run(async (ctx) => {
          const row = await ctx.db
            .query('auditSnapshots')
            .withIndex('by_action', (q) => q.eq('actionId', mergeId))
            .first();
          if (row?.payload && !('chunk' in row.payload)) {
            const { loserReview: _r, ...rest } = row.payload as MergeChangeSet;
            await ctx.db.patch(row._id, { payload: rest });
          }
        });
      },
      says: async () => UNMERGE_PARTS_MISSING,
    },
    {
      // R10: without which fields the merge wrote to each bay and label, the unmerge would have to
      // write rows back whole — refused instead.
      name: 'the field-by-field record (rowsAfter) missing',
      setup: async (w, mergeId) => {
        await w.t.run(async (ctx) => {
          const row = await ctx.db
            .query('auditSnapshots')
            .withIndex('by_action', (q) => q.eq('actionId', mergeId))
            .first();
          if (row?.payload && !('chunk' in row.payload)) {
            const { rowsAfter: _r, ...rest } = row.payload as MergeChangeSet;
            await ctx.db.patch(row._id, { payload: rest });
          }
        });
      },
      says: async () => UNMERGE_PARTS_MISSING,
    },
    {
      name: 'overtaken by a later row on the loser',
      setup: async (w) => {
        await w.t.run((ctx) =>
          writeAudit(ctx, {
            actorId: w.actor.id,
            action: 'set_public_access',
            targetType: 'waterbody',
            targetId: w.loser,
            reason: 'A later write',
            createdAt: Date.now(),
          }),
        );
      },
      says: async () => 'Something changed this since; open its history to see what',
    },
    {
      name: 'the loser re-pointed since',
      setup: async (w) => {
        await w.t.run((ctx) => ctx.db.patch(w.loser, { mergedIntoId: w.partner }));
      },
      says: async () => UNMERGE_LOSER_MOVED,
    },
    {
      name: 'the survivor merged into another body since',
      setup: async (w) => {
        await w.t.run(async (ctx) => {
          const survivor = (await ctx.db.get(w.survivor)) as Doc<'waterBodies'>;
          const into = (await ctx.db.get(w.elsewhere)) as Doc<'waterBodies'>;
          await mergeBodyInto(ctx, { survivor: into, loser: survivor, reason: 'Again' });
        });
      },
      says: async () => unmergeSurvivorMerged('Lake Morey', 'Far Pond'),
    },
    {
      name: 'the survivor gone',
      setup: async (w) => {
        await w.t.run((ctx) => ctx.db.delete(w.survivor));
      },
      says: async () => UNMERGE_SURVIVOR_GONE,
    },
  ];

  test.each(cases)('$name', async (c) => {
    const w = await world();
    const mergeId = await mergeV2(w, { chunked: c.name === 'a part of the change set missing' });
    await c.setup(w, mergeId);
    await settle(w.t);
    const before = await everything(w.t);
    const offer = await w.t.run(async (ctx) =>
      undoState(
        ctx,
        (await ctx.db.get(w.colleague.id)) as Doc<'profiles'>,
        (await ctx.db.get(mergeId)) as Doc<'moderationActions'>,
        'one',
      ),
    );
    const said = await refusalOf(w, mergeId, w.colleague.as);
    const expected = await c.says(w);
    expect(said).toEqual(expected);
    // The offer says the same, before anything runs.
    expect(offer.state).not.toBe('available');
    if (offer.state === 'unavailable') expect(offer.why).toBe(expected);
    expect(await everything(w.t)).toEqual(before);
  });

  test('the drawer of a merged drawing, and anyone without the capability, are refused', async () => {
    const w = await world();
    const mergeId = await mergeV2(w);
    const before = await everything(w.t);
    expect(await refusalOf(w, mergeId, w.drawer.as)).toBe(OWN_FILING_REFUSAL);
    // A skater holds no corpus lever: the mutation refuses before the engine.
    expect(await refusalOf(w, mergeId, w.skater.as)).not.toBeNull();
    const offer = await w.t.run(async (ctx) =>
      undoState(
        ctx,
        (await ctx.db.get(w.skater.id)) as Doc<'profiles'>,
        (await ctx.db.get(mergeId)) as Doc<'moderationActions'>,
        'one',
      ),
    );
    expect(offer).toEqual({
      state: 'unavailable',
      why: 'Undoing this takes a role you do not hold.',
    });
    expect(await everything(w.t)).toEqual(before);
  });

  test('an unmerge has no undo of its own: merge them again', async () => {
    const w = await world(['content']);
    const mergeId = await mergeV2(w);
    await unmerge(w, mergeId);
    const row = (await unmergeRowOf(w.t, w.loser)) as Doc<'moderationActions'>;
    expect(await refusalOf(w, row._id, w.actor.as)).toBe(
      'To put them back together, merge them again.',
    );
  });
});

// ── Drift: a row that moved again since the merge is left, counted, and named ──────────────────────

suite('a row that has drifted since the merge is left where it is, and said', () => {
  const cases: {
    name: string;
    kinds: Kind[];
    kind: LeftKind;
    edit: (w: World, mergeId: Id<'moderationActions'>) => Promise<string>;
    /** What the left row still reads after the unmerge. */
    stays: (w: World, id: string) => Promise<void>;
  }[] = [
    {
      name: 'a report moved to another body since',
      kinds: ['content'],
      kind: 'reports',
      edit: async (w) => {
        const id = w.rows.reports?.[0] as Id<'reports'>;
        await w.t.run((ctx) => ctx.db.patch(id, { waterBodyId: w.elsewhere }));
        return id;
      },
      stays: async (w, id) => {
        expect((await w.t.run((ctx) => ctx.db.get(id as Id<'reports'>)))?.waterBodyId).toBe(
          w.elsewhere,
        );
      },
    },
    {
      name: 'a hazard gone since',
      kinds: ['content'],
      kind: 'hazards',
      edit: async (w) => {
        const id = w.rows.hazards?.[0] as Id<'hazards'>;
        await w.t.run((ctx) => ctx.db.delete(id));
        return id;
      },
      stays: async (w, id) => {
        expect(await w.t.run((ctx) => ctx.db.get(id as Id<'hazards'>))).toBeNull();
      },
    },
    {
      name: 'a re-pointed favorite moved since',
      kinds: ['favorites'],
      kind: 'waterBodyFavorites',
      edit: async (w) => {
        const id = w.rows.favorites?.[0] as Id<'waterBodyFavorites'>;
        await w.t.run((ctx) => ctx.db.patch(id, { waterBodyId: w.elsewhere }));
        return id;
      },
      stays: async (w, id) => {
        expect(
          (await w.t.run((ctx) => ctx.db.get(id as Id<'waterBodyFavorites'>)))?.waterBodyId,
        ).toBe(w.elsewhere);
      },
    },
    {
      name: 'a dropped favorite whose kept row is gone (unfavorited)',
      kinds: ['favoritesBoth'],
      kind: 'deletedFavorites',
      edit: async (w) => {
        await w.t.run((ctx) =>
          ctx.db.delete(w.rows.keptFavorites?.[0] as Id<'waterBodyFavorites'>),
        );
        return w.rows.deletedFavorites?.[0] as string;
      },
      stays: async (w) => {
        const onLoser = await w.t.run((ctx) =>
          ctx.db
            .query('waterBodyFavorites')
            .withIndex('by_water_body', (q) => q.eq('waterBodyId', w.loser))
            .collect(),
        );
        expect(onLoser).toEqual([]);
      },
    },
    {
      name: 'an ask decided since',
      kinds: ['asks'],
      kind: 'waterBodyRequests',
      edit: async (w) => {
        const id = w.rows.requests?.[0] as Id<'waterBodyRequests'>;
        await w.t.run((ctx) =>
          ctx.db.patch(id, { status: 'declined', decidedAt: Date.now() + 1_000 }),
        );
        return id;
      },
      stays: async (w, id) => {
        expect(
          (await w.t.run((ctx) => ctx.db.get(id as Id<'waterBodyRequests'>)))?.waterBodyId,
        ).toBe(w.survivor);
      },
    },
    {
      name: 'a flag decided since',
      kinds: ['asks'],
      kind: 'contentFlags',
      edit: async (w) => {
        const id = w.rows.flags?.[0] as Id<'contentFlags'>;
        await w.t.run((ctx) => ctx.db.patch(id, { status: 'dismissed' }));
        return id;
      },
      stays: async (w, id) => {
        expect((await w.t.run((ctx) => ctx.db.get(id as Id<'contentFlags'>)))?.targetId).toBe(
          w.survivor,
        );
      },
    },
    {
      name: 'a place name placed since',
      kinds: ['asks'],
      kind: 'corpusPlaceNames',
      edit: async (w) => {
        const id = w.rows.placeNames?.[0] as Id<'corpusPlaceNames'>;
        await w.t.run((ctx) => ctx.db.patch(id, { status: 'placed' }));
        return id;
      },
      stays: async (w, id) => {
        expect(
          (await w.t.run((ctx) => ctx.db.get(id as Id<'corpusPlaceNames'>)))?.waterBodyId,
        ).toBe(w.survivor);
      },
    },
    {
      // The merge wrote the bay's body; it has moved again since (no timestamp asked).
      name: 'a moved bay moved again since',
      kinds: ['loserBays'],
      kind: 'waterBodySubAreas',
      edit: async (w) => {
        const id = w.rows.loserBays?.[0] as Id<'waterBodySubAreas'>;
        await w.t.run((ctx) => ctx.db.patch(id, { waterBodyId: w.elsewhere }));
        return id;
      },
      stays: async (w, id) => {
        const row = await w.t.run((ctx) => ctx.db.get(id as Id<'waterBodySubAreas'>));
        expect(row?.waterBodyId).toBe(w.elsewhere);
      },
    },
    {
      // The merge's re-clip wrote the outline; a redraw has changed it again since.
      name: 'a survivor bay redrawn since its re-clip',
      kinds: ['survivorBays'],
      kind: 'waterBodySubAreas',
      edit: async (w) => {
        const id = w.rows.survivorBays?.[0] as Id<'waterBodySubAreas'>;
        await w.t.run((ctx) => ctx.db.patch(id, { polygon: rect(0.1, 0.25, 0.25, 0.45).polygon }));
        return id;
      },
      stays: async (w, id) => {
        const row = await w.t.run((ctx) => ctx.db.get(id as Id<'waterBodySubAreas'>));
        expect(row?.polygon).toEqual(rect(0.1, 0.25, 0.25, 0.45).polygon);
      },
    },
    {
      // The merge wrote the label's body; it has moved again since.
      name: 'a moved landmark moved again since',
      kinds: ['landmarks'],
      kind: 'bodyLandmarks',
      edit: async (w) => {
        const id = w.rows.landmarks?.[2] as Id<'bodyLandmarks'>;
        await w.t.run((ctx) => ctx.db.patch(id, { waterBodyId: w.elsewhere }));
        return id;
      },
      stays: async (w, id) => {
        const row = await w.t.run((ctx) => ctx.db.get(id as Id<'bodyLandmarks'>));
        expect(row?.waterBodyId).toBe(w.elsewhere);
      },
    },
    {
      name: 'a partner whose flag a moderator changed since',
      kinds: ['partners'],
      kind: 'partners',
      edit: async (w) => {
        await w.t.run((ctx) =>
          ctx.db.patch(w.partner, {
            dedupStatus: 'suspected_duplicate',
            duplicateCandidateIds: [w.elsewhere, w.survivor],
          }),
        );
        return w.partner;
      },
      stays: async (w) => {
        expect((await w.t.run((ctx) => ctx.db.get(w.partner)))?.duplicateCandidateIds).toEqual([
          w.elsewhere,
          w.survivor,
        ]);
      },
    },
    {
      name: 'a founding skate moved since',
      kinds: ['skates'],
      kind: 'gpsActivities',
      edit: async (w) => {
        const id = w.rows.gpsActivities?.[0] as Id<'gpsActivities'>;
        await w.t.run((ctx) =>
          ctx.db.patch(id, { waterBodyId: w.elsewhere, waterBodyIds: [w.elsewhere] }),
        );
        return id;
      },
      stays: async (w, id) => {
        expect((await w.t.run((ctx) => ctx.db.get(id as Id<'gpsActivities'>)))?.waterBodyId).toBe(
          w.elsewhere,
        );
      },
    },
  ];

  test.each(cases)('$name', async (c) => {
    const w = await world(c.kinds);
    const mergeId = await mergeV2(w);
    const id = await c.edit(w, mergeId);
    await settle(w.t);
    await unmerge(w, mergeId);
    const left = await leftOf(w.t, w.loser);
    // Counted once, named on the unmerge's row; the run still completed.
    expect(left.count).toBe(1);
    expect(left.byKind).toEqual({ [c.kind]: 1 });
    expect(left.rows).toEqual([{ kind: c.kind, id }]);
    expect((await unmergeRowOf(w.t, w.loser))?.metadata?.done).toBe(true);
    // The body itself came back.
    expect((await w.t.run((ctx) => ctx.db.get(w.loser)))?.dedupStatus).not.toBe('merged');
    await c.stays(w, id);
  });

  test('the survivor’s lists come apart by difference: what it gained since stays, the loser’s go back', async () => {
    const w = await world(['lists']);
    const mergeId = await mergeV2(w);
    // Since the merge, a moderator gave the survivor an alias of its own and a link of its own.
    await w.t.run((ctx) =>
      ctx.db.patch(w.survivor, {
        moderatorAliases: ['Morey', 'Fairlee Lake', 'East Morey', 'Lake Fairlee'],
        referenceLinks: [
          { label: 'Town', url: 'https://example.invalid/town' },
          { label: 'Club', url: 'https://example.invalid/club' },
          { label: 'Map', url: 'https://example.invalid/map' },
        ],
      }),
    );
    await unmerge(w, mergeId);
    const [survivor, loser] = await w.t.run(async (ctx) => [
      await ctx.db.get(w.survivor),
      await ctx.db.get(w.loser),
    ]);
    // Only the loser's own ("East Morey"; "fairlee lake" was the survivor's already, case aside) and
    // its club link left the survivor; what the survivor gained since stayed.
    expect(survivor?.moderatorAliases).toEqual(['Morey', 'Fairlee Lake', 'Lake Fairlee']);
    expect(survivor?.referenceLinks?.map((l) => l.url)).toEqual([
      'https://example.invalid/town',
      'https://example.invalid/map',
    ]);
    expect(survivor?.searchText).toBe(
      bodySearchTextFor({ name: 'Lake Morey', moderatorAliases: survivor?.moderatorAliases }),
    );
    expect(loser?.moderatorAliases).toEqual(['East Morey', 'fairlee lake']);
  });

  test('the receipt reads what was left, live: the first page’s count at once, the total once done', async () => {
    const w = await world(['content', 'partners']);
    const mergeId = await mergeV2(w);
    const read = () => w.colleague.as.query(api.unmerge.receipt, { mergeActionId: mergeId });
    expect(await read()).toBeNull();
    // Two rows drift: the partner (put back in the first transaction) and the putIn (a later page).
    await w.t.run(async (ctx) => {
      await ctx.db.patch(w.partner, { duplicateCandidateIds: [w.elsewhere, w.survivor] });
      await ctx.db.patch(w.rows.putIns?.[0] as Id<'putIns'>, { waterBodyId: w.elsewhere });
    });
    const was = PAGE_SEAM.sources;
    PAGE_SEAM.sources = 1;
    try {
      await w.colleague.as.mutation(api.undo.run, { actionId: mergeId, reason: 'Two lakes' });
      const first = await read();
      expect(first?.done).toBe(false);
      expect(first?.left.byKind).toEqual({ partners: 1 });
      await settle(w.t);
    } finally {
      PAGE_SEAM.sources = was;
    }
    const last = await read();
    expect(last?.done).toBe(true);
    expect(last?.left).toEqual({
      count: 2,
      byKind: { partners: 1, putIns: 1 },
      rows: [
        { kind: 'partners', id: w.partner },
        { kind: 'putIns', id: w.rows.putIns?.[0] },
      ],
    });
    expect(last?.unmergeActionId).toBe((await unmergeRowOf(w.t, w.loser))?._id);
    // The receipt is staff's to read.
    await expect(
      w.skater.as.query(api.unmerge.receipt, { mergeActionId: mergeId }),
    ).rejects.toThrow();
  });

  test('a delisted bay listed again since stays as it is, and its side row is left live', async () => {
    const w = await world(['clashingBay']);
    const mergeId = await mergeV2(w);
    const id = w.rows.loserBays?.[0] as Id<'waterBodySubAreas'>;
    // Someone restored the merged copy by hand since: a field the merge wrote (its delisting) changed.
    await w.t.run((ctx) =>
      ctx.db.patch(id, {
        removedAt: undefined,
        removedByUserId: undefined,
        systemDelistReason: undefined,
      }),
    );
    await unmerge(w, mergeId);
    const left = await leftOf(w.t, w.loser);
    expect(left.byKind).toEqual({ waterBodySubAreas: 1, sideActions: 1 });
    const side = await w.t.run(async (ctx) => {
      const all = await ctx.db.query('moderationActions').collect();
      const remove = all.find((r) => r.action === 'remove' && r.targetId === id);
      return { remove, undone: all.filter((r) => r.undoesActionId === remove?._id) };
    });
    expect(side.remove).toBeDefined();
    expect(side.undone).toEqual([]);
  });

  // ── R10: a later write to a field the merge didn't touch survives; one to a field it did, leaves ──

  test('a moved landmark a report names since: back on the drawing with its count (the reviewer’s case)', async () => {
    const w = await world(['landmarks']);
    const mergeId = await mergeV2(w);
    const id = w.rows.landmarks?.[2] as Id<'bodyLandmarks'>;
    // The real write a report makes (`reportWrite`): a count bumped, no timestamp.
    await w.t.run(async (ctx) =>
      noteLandmarksNamed(ctx, [(await ctx.db.get(id)) as Doc<'bodyLandmarks'>]),
    );
    await unmerge(w, mergeId);
    const row = await w.t.run((ctx) => ctx.db.get(id));
    expect(row?.waterBodyId).toBe(w.loser);
    expect(row?.reportCount).toBe(1);
    expect((await leftOf(w.t, w.loser)).count).toBe(0);
  });

  test('a folded twin a report names since: the merge wrote its count, so it is left and counted', async () => {
    const w = await world(['landmarks']);
    // The drawing's twin carries a count: the fold sums it into the survivor's label.
    await w.t.run((ctx) =>
      ctx.db.patch(w.rows.landmarks?.[1] as Id<'bodyLandmarks'>, { reportCount: 2 }),
    );
    const mergeId = await mergeV2(w);
    const twin = w.rows.landmarks?.[0] as Id<'bodyLandmarks'>;
    expect((await w.t.run((ctx) => ctx.db.get(twin)))?.reportCount).toBe(2);
    await w.t.run(async (ctx) =>
      noteLandmarksNamed(ctx, [(await ctx.db.get(twin)) as Doc<'bodyLandmarks'>]),
    );
    await unmerge(w, mergeId);
    const left = await leftOf(w.t, w.loser);
    expect(left.rows).toEqual([{ kind: 'bodyLandmarks', id: twin }]);
    // Left exactly as it is now, the later count included.
    expect((await w.t.run((ctx) => ctx.db.get(twin)))?.reportCount).toBe(3);
  });

  test('a moved bay renamed since, and noted by a re-import: back on the drawing, both kept', async () => {
    const w = await world(['loserBays']);
    const mergeId = await mergeV2(w);
    const id = w.rows.loserBays?.[0] as Id<'waterBodySubAreas'>;
    await w.t.run((ctx) =>
      ctx.db.patch(id, { name: 'Renamed Cove', updatedAt: Date.now() + 1_000 }),
    );
    // A re-import's note writes no timestamp (`noteRederivation`).
    await w.t.run((ctx) => ctx.db.patch(id, { mouthStale: 'The shoreline moved' }));
    await unmerge(w, mergeId);
    const row = await w.t.run((ctx) => ctx.db.get(id));
    expect(row?.waterBodyId).toBe(w.loser);
    expect(row?.name).toBe('Renamed Cove');
    expect(row?.mouthStale).toBe('The shoreline moved');
    expect((await leftOf(w.t, w.loser)).count).toBe(0);
  });

  test('a survivor bay renamed since its re-clip: its outline back, its new name kept', async () => {
    const w = await world(['survivorBays']);
    const before = await w.t.run((ctx) =>
      ctx.db.get(w.rows.survivorBays?.[0] as Id<'waterBodySubAreas'>),
    );
    const mergeId = await mergeV2(w);
    const id = w.rows.survivorBays?.[0] as Id<'waterBodySubAreas'>;
    await w.t.run((ctx) => ctx.db.patch(id, { name: 'West Reach' }));
    await unmerge(w, mergeId);
    const row = await w.t.run((ctx) => ctx.db.get(id));
    expect(row?.polygon).toEqual(before?.polygon);
    expect(row?.name).toBe('West Reach');
    expect((await leftOf(w.t, w.loser)).count).toBe(0);
  });

  test('a moved report and hazard counted on since: back on the drawing, the counts kept', async () => {
    const w = await world(['content']);
    const mergeId = await mergeV2(w);
    const hazard = w.rows.hazards?.[0] as Id<'hazards'>;
    const report = w.rows.reports?.[0] as Id<'reports'>;
    await w.t.run(async (ctx) => {
      await ctx.db.patch(hazard, { confirmCount: 4 });
      await ctx.db.patch(report, { notes: 'Seen again' });
    });
    await unmerge(w, mergeId);
    const [h, r] = await w.t.run(async (ctx) => [
      await ctx.db.get(hazard),
      await ctx.db.get(report),
    ]);
    expect(h?.waterBodyId).toBe(w.loser);
    expect(h?.confirmCount).toBe(4);
    expect(r?.waterBodyId).toBe(w.loser);
    expect((r as Doc<'reports'>).notes).toBe('Seen again');
  });

  test('a skate whose list was re-resolved since: left, counted (both fields judged by value)', async () => {
    const w = await world(['skates']);
    const mergeId = await mergeV2(w);
    const id = w.rows.gpsActivities?.[0] as Id<'gpsActivities'>;
    // Its body still the survivor, its list changed since: the old check passed it and wrote the list back.
    await w.t.run((ctx) => ctx.db.patch(id, { waterBodyIds: [w.survivor, w.elsewhere] }));
    await unmerge(w, mergeId);
    expect((await leftOf(w.t, w.loser)).rows).toEqual([{ kind: 'gpsActivities', id }]);
    expect((await w.t.run((ctx) => ctx.db.get(id)))?.waterBodyIds).toEqual([
      w.survivor,
      w.elsewhere,
    ]);
  });

  test('a skate’s list comes back as it was — empty as empty, absent as absent — and its prompt kept', async () => {
    const w = await world(['skates']);
    const id = w.rows.gpsActivities?.[0] as Id<'gpsActivities'>;
    const other = await w.t.run(async (ctx) => {
      const row = (await ctx.db.get(id)) as Doc<'gpsActivities'>;
      const { _id, _creationTime, ...rest } = row;
      await ctx.db.patch(id, { waterBodyIds: [] });
      return ctx.db.insert('gpsActivities', {
        ...rest,
        providerActivityId: 'second',
        waterBodyIds: undefined,
      });
    });
    const mergeId = await mergeV2(w);
    await w.t.run((ctx) => ctx.db.patch(id, { promptState: 'dismissed' }));
    await unmerge(w, mergeId);
    const [a, b] = await w.t.run(async (ctx) => [await ctx.db.get(id), await ctx.db.get(other)]);
    expect(a?.waterBodyId).toBe(w.loser);
    expect(a?.waterBodyIds).toEqual([]);
    expect(a?.promptState).toBe('dismissed');
    expect(b?.waterBodyId).toBe(w.loser);
    expect(b && 'waterBodyIds' in b).toBe(false);
    expect((await leftOf(w.t, w.loser)).count).toBe(0);
  });

  test('a partner renamed since: its flags back, its name kept', async () => {
    const w = await world(['partners']);
    const mergeId = await mergeV2(w);
    await w.t.run((ctx) => ctx.db.patch(w.partner, { name: 'Morey Pond (east)' }));
    await unmerge(w, mergeId);
    const p = await w.t.run((ctx) => ctx.db.get(w.partner));
    expect(p?.name).toBe('Morey Pond (east)');
    expect(p?.duplicateCandidateIds).toEqual([w.loser, w.elsewhere]);
  });
});

// ── Paging: a change set past one page drains, one page an execution ───────────────────────────────

suite('a heavy unmerge pages', () => {
  test('past one page (the page seam at two rows): every page its own execution, the state as before', async () => {
    const w = await world();
    const before = await census(w.t);
    const mergeId = await mergeV2(w);
    const was = PAGE_SEAM.sources;
    PAGE_SEAM.sources = 2;
    try {
      await w.colleague.as.mutation(api.undo.run, { actionId: mergeId, reason: 'Two lakes' });
      // The first transaction stopped after its page and scheduled the rest.
      const pending = await w.t.run((ctx) =>
        ctx.db.system
          .query('_scheduled_functions')
          .filter((q) => q.eq(q.field('name'), 'unmerge:unmergeRest'))
          .collect(),
      );
      expect(pending.length).toBe(1);
      await settle(w.t);
      const pages = await w.t.run((ctx) =>
        ctx.db.system
          .query('_scheduled_functions')
          .filter((q) => q.eq(q.field('name'), 'unmerge:unmergeRest'))
          .collect(),
      );
      // Ten moved rows, a skate, a favorite, three bays, three landmarks, two side rows, the derive.
      expect(pages.length).toBeGreaterThanOrEqual(8);
      expect(pages.every((p) => p.state.kind === 'success')).toBe(true);
    } finally {
      PAGE_SEAM.sources = was;
    }
    expect(await census(w.t)).toEqual(before);
    await assertAudit(w, mergeId);
  });

  test('under the harness’s real limits: the unmerge of a merge at the estimate’s edge completes, every row back', async () => {
    const w = await world([]);
    // 500 favorites of the drawing — at the corrected estimate's edge for them (S4a's time axis: the
    // pinned ceiling for two small bodies is 511; 1,800 merged before it and can't now). One merge
    // moves them at two index ranges each, and putting each back costs the same, so the unmerge's
    // pages hold them under Convex's real limits; whether that takes one execution or more is the
    // page's own call (pages past one are held by "past one page", below).
    const N = 500;
    await w.t.run(async (ctx) => {
      for (let i = 0; i < N; i++) {
        const userId = await ctx.db.insert('profiles', {
          clerkUserId: `fav${i}`,
          displayName: `fav${i} Test-Person`,
          username: `fav${i}`,
          driveTimePrefMinutes: 60,
          profileVisibility: 'public' as const,
          notificationPrefs: PREFS,
          dateOfBirth: Date.UTC(1990, 0, 1),
          reputationPoints: 0,
          role: 'member' as const,
          status: 'active' as const,
          createdAt: 1,
        });
        await ctx.db.insert('waterBodyFavorites', { userId, waterBodyId: w.loser, createdAt: i });
      }
    });
    // A merge the estimate accepts: the fixture stays inside what a real merge may do.
    const preview = await w.actor.as.query(api.bodyConsole.mergePreview, {
      loserId: w.loser,
      survivorId: w.survivor,
    });
    expect(preview).toMatchObject({ ok: true, tooBig: false });
    // (At the estimate's edge the change set fits one part; a change set stored in parts unmerges
    // the same — "the change set split in parts" holds that.)
    const mergeId = await mergeV2(w);
    // The boundary this test reads is the metrics' alone: the page's time cap off (a contended runner
    // could otherwise end a page sooner).
    const wasTime = PAGE_TIME.ms;
    PAGE_TIME.ms = Number.POSITIVE_INFINITY;
    try {
      await w.colleague.as.mutation(api.undo.run, { actionId: mergeId, reason: 'Two lakes' });
    } finally {
      PAGE_TIME.ms = wasTime;
    }
    const onLoser = async () =>
      (
        await w.t.run((ctx) =>
          ctx.db
            .query('waterBodyFavorites')
            .withIndex('by_water_body', (q) => q.eq('waterBodyId', w.loser))
            .collect(),
        )
      ).length;
    // A restored favorite costs what the merge spent moving it (two ranges), so the rows fit the first
    // page as they fit the merge's one transaction.
    expect(await onLoser()).toBe(N);
    await settle(w.t);
    expect(await onLoser()).toBe(N);
    const pages = await w.t.run((ctx) =>
      ctx.db.system
        .query('_scheduled_functions')
        .filter((q) => q.eq(q.field('name'), 'unmerge:unmergeRest'))
        .collect(),
    );
    expect(pages.every((p) => p.state.kind === 'success')).toBe(true);
    expect((await unmergeRowOf(w.t, w.loser))?.metadata?.done).toBe(true);
    // Each back as it was: on the drawing, with its own first instant.
    const back = await w.t.run((ctx) =>
      ctx.db
        .query('waterBodyFavorites')
        .withIndex('by_water_body', (q) => q.eq('waterBodyId', w.loser))
        .collect(),
    );
    expect(back.map((f) => f.createdAt).sort((x, y) => x - y)).toEqual(
      Array.from({ length: N }, (_, i) => i),
    );
    // Its point is the real size, so it keeps the real limits and a timeout with 5x headroom over its
    // time when every package's suite runs at once (CI's `pnpm test`: 129 s under the range-counting
    // harness, 60 s before it; 3.6 s alone).
  }, 650_000);

  // R10-A: a second merge between pages once stranded the rows the later pages had still to move. A
  // body mid-unmerge takes no merge — as loser or as survivor — preview and write alike, until done.
  test('a body mid-unmerge takes no merge until the unmerge is done; then the round trip holds', async () => {
    const w = await world(['content']);
    const before = await census(w.t);
    const mergeId = await mergeV2(w);
    const was = PAGE_SEAM.sources;
    PAGE_SEAM.sources = 1;
    // The scheduler held still: a later page runs only when the test lets it (convex-test's scheduler
    // runs on the clock), so "mid-unmerge" is a state, not a race the next page can win.
    vi.useFakeTimers();
    try {
      await w.colleague.as.mutation(api.undo.run, { actionId: mergeId, reason: 'Two lakes' });
      // The real unmerge's first transaction marks both bodies (`unmergeActionId`), nothing here.
      const unmergeId = (await unmergeRowOf(w.t, w.loser))?._id as Id<'moderationActions'>;
      expect(unmergeId).toBeDefined();
      const marked = await w.t.run(async (ctx) => [
        (await ctx.db.get(w.loser))?.unmergeActionId ?? null,
        (await ctx.db.get(w.survivor))?.unmergeActionId ?? null,
      ]);
      expect(marked).toEqual([unmergeId, unmergeId]);
      const said = { refusal: UNMERGING_REFUSAL, code: 'unmerging' };
      // As loser: merged into its survivor again, refused — the preview first, then the write.
      expect(
        await w.actor.as.query(api.bodyConsole.mergePreview, {
          loserId: w.loser,
          survivorId: w.survivor,
        }),
      ).toEqual({ ok: false, ...said });
      await expect(
        w.actor.as.mutation(api.waterBodies.merge, { survivorId: w.survivor, loserId: w.loser }),
      ).rejects.toThrow(UNMERGING_REFUSAL);
      // As survivor: merged away into another body mid-unmerge, refused too.
      expect(
        await w.actor.as.query(api.bodyConsole.mergePreview, {
          loserId: w.survivor,
          survivorId: w.elsewhere,
        }),
      ).toEqual({ ok: false, ...said });
      await expect(
        w.actor.as.mutation(api.waterBodies.merge, {
          survivorId: w.elsewhere,
          loserId: w.survivor,
        }),
      ).rejects.toThrow(UNMERGING_REFUSAL);
      // Now the later pages run, to the end.
      await w.t.finishAllScheduledFunctions(vi.runAllTimers);
      vi.useRealTimers();
      await settle(w.t);
    } finally {
      vi.useRealTimers();
      PAGE_SEAM.sources = was;
    }
    // The later pages ran to the end: every row back, nothing left.
    expect((await unmergeRowOf(w.t, w.loser))?.metadata?.done).toBe(true);
    expect((await leftOf(w.t, w.loser)).count).toBe(0);
    // Done: both bodies free again (the unmerge clears its own marker), and the round trip holds.
    const markers = await w.t.run(async (ctx) => [
      (await ctx.db.get(w.loser))?.unmergeActionId ?? null,
      (await ctx.db.get(w.survivor))?.unmergeActionId ?? null,
    ]);
    expect(markers).toEqual([null, null]);
    expect(await census(w.t)).toEqual(before);
    // And a merge is offered and taken again.
    const preview = await w.actor.as.query(api.bodyConsole.mergePreview, {
      loserId: w.loser,
      survivorId: w.survivor,
    });
    expect(preview).toMatchObject({ ok: true, tooBig: false });
    await w.actor.as.mutation(api.waterBodies.merge, { survivorId: w.survivor, loserId: w.loser });
    expect((await w.t.run((ctx) => ctx.db.get(w.loser)))?.mergedIntoId).toBe(w.survivor);
  });

  test('a page stops on its time, as on its metrics: with no time each page takes one row, and the state comes back', async () => {
    const w = await world(['content', 'favorites', 'asks']);
    const before = await census(w.t);
    const mergeId = await mergeV2(w);
    const was = PAGE_TIME.ms;
    PAGE_TIME.ms = 0;
    try {
      await w.colleague.as.mutation(api.undo.run, { actionId: mergeId, reason: 'Two lakes' });
      // The first page took its one row (a page always advances) and scheduled the rest.
      const lead = (await unmergeRowOf(w.t, w.loser))?.metadata as {
        cursor?: unknown;
        done?: boolean;
      };
      expect(lead.done).toBe(false);
      expect(lead.cursor).toEqual({ phase: 'moved', from: 1 });
      await settle(w.t);
    } finally {
      PAGE_TIME.ms = was;
    }
    expect((await unmergeRowOf(w.t, w.loser))?.metadata?.done).toBe(true);
    expect(await census(w.t)).toEqual(before);
  });

  test('an undone unmerge’s later pages do nothing', async () => {
    const w = await world(['content']);
    const mergeId = await mergeV2(w);
    const was = PAGE_SEAM.sources;
    PAGE_SEAM.sources = 1;
    try {
      await w.colleague.as.mutation(api.undo.run, { actionId: mergeId, reason: 'Two lakes' });
      const lead = (await unmergeRowOf(w.t, w.loser)) as Doc<'moderationActions'>;
      // Something undoes the unmerge between its pages.
      await w.t.run((ctx) =>
        writeAudit(ctx, {
          actorId: w.actor.id,
          action: 'merge_waterbody',
          targetType: 'waterbody',
          targetId: w.loser,
          reason: 'Undone',
          undoesActionId: lead._id,
          createdAt: Date.now(),
        }),
      );
      await settle(w.t);
    } finally {
      PAGE_SEAM.sources = was;
    }
    const still = await w.t.run((ctx) =>
      ctx.db
        .query('reports')
        .withIndex('by_water_body_skate_end_time', (q) => q.eq('waterBodyId', w.survivor))
        .collect(),
    );
    // The first page moved one row (the report, first in the change set); nothing after it ran.
    expect(still).toHaveLength(0);
    const hazards = await w.t.run((ctx) =>
      ctx.db
        .query('hazards')
        .withIndex('by_water_body', (q) => q.eq('waterBodyId', w.survivor))
        .collect(),
    );
    expect(hazards).toHaveLength(1);
    expect((await unmergeRowOf(w.t, w.loser))?.metadata?.done).toBe(false);
    // Stopped, and said: never a silent return (R10).
    expect(
      (await w.colleague.as.query(api.unmerge.receipt, { mergeActionId: mergeId }))?.stalled,
    ).toEqual({
      code: 'undone',
      resumable: false,
      notReached: { phase: 'moved', from: 1, remaining: { moved: 4 } },
    });
  });
});

// ── R10: the marker, and a stalled unmerge resumed ─────────────────────────────────────────────────

suite('an unmerge marks both bodies while it runs, and a stalled one is seen and resumed', () => {
  const markers = (w: World) =>
    w.t.run(async (ctx) => [
      (await ctx.db.get(w.loser))?.unmergeActionId ?? null,
      (await ctx.db.get(w.survivor))?.unmergeActionId ?? null,
    ]);
  const receiptOf = (w: World, mergeId: Id<'moderationActions'>) =>
    w.colleague.as.query(api.unmerge.receipt, { mergeActionId: mergeId });
  const pendingPages = (w: World) =>
    w.t.run(
      async (ctx) =>
        (
          await ctx.db.system
            .query('_scheduled_functions')
            .filter((q) =>
              q.and(
                q.eq(q.field('name'), 'unmerge:unmergeRest'),
                q.eq(q.field('state.kind'), 'pending'),
              ),
            )
            .collect()
        ).length,
    );
  /** Run with one row a page, so every phase starts in a page of its own. */
  const paged = async <R>(fn: () => Promise<R>): Promise<R> => {
    const was = PAGE_SEAM.sources;
    PAGE_SEAM.sources = 1;
    try {
      return await fn();
    } finally {
      PAGE_SEAM.sources = was;
    }
  };

  test('the marker is on both bodies after the first page, and on neither once done', async () => {
    const w = await world(['content']);
    const mergeId = await mergeV2(w);
    expect(await markers(w)).toEqual([null, null]);
    await paged(async () => {
      await w.colleague.as.mutation(api.undo.run, { actionId: mergeId, reason: 'Two lakes' });
      const lead = (await unmergeRowOf(w.t, w.loser)) as Doc<'moderationActions'>;
      expect(await markers(w)).toEqual([lead._id, lead._id]);
      await settle(w.t);
    });
    expect(await markers(w)).toEqual([null, null]);
  });

  test.each([...PHASES])(
    'a page of %s that fails: stalled, both bodies still marked; resumed, it completes as before',
    async (phase) => {
      const w = await world();
      const before = await census(w.t);
      const mergeId = await mergeV2(w);
      await paged(async () => {
        UNMERGE_FAULT.phase = phase;
        try {
          await w.colleague.as.mutation(api.undo.run, { actionId: mergeId, reason: 'Two lakes' });
          await settle(w.t);
        } finally {
          UNMERGE_FAULT.phase = null;
        }
        const stuck = await receiptOf(w, mergeId);
        expect(stuck?.done).toBe(false);
        expect(stuck?.stalled).toMatchObject({ code: 'pageFailed' });
        // (`convex-test`'s scheduler records no error text; a deployment's does, and it rides along.)
        const lead = (await unmergeRowOf(w.t, w.loser)) as Doc<'moderationActions'>;
        expect(await markers(w)).toEqual([lead._id, lead._id]);
        expect(await pendingPages(w)).toBe(0);
        await w.actor.as.mutation(api.unmerge.resume, { mergeActionId: mergeId });
        await settle(w.t);
      });
      const done = await receiptOf(w, mergeId);
      expect(done?.done).toBe(true);
      expect(done?.stalled).toBeNull();
      expect(await markers(w)).toEqual([null, null]);
      expect(await census(w.t)).toEqual(before);
    },
  );

  test('resume is refused while a page runs, twice makes one continuation, and refused once done', async () => {
    const w = await world(['content']);
    const mergeId = await mergeV2(w);
    await paged(async () => {
      await w.colleague.as.mutation(api.undo.run, { actionId: mergeId, reason: 'Two lakes' });
      // A page is pending: nothing to resume.
      await expect(
        w.actor.as.mutation(api.unmerge.resume, { mergeActionId: mergeId }),
      ).rejects.toThrow(UNMERGE_RESUME_RUNNING);
      // Stall it: the pending page fails.
      UNMERGE_FAULT.phase = 'moved';
      try {
        await settle(w.t);
      } finally {
        UNMERGE_FAULT.phase = null;
      }
      expect((await receiptOf(w, mergeId))?.stalled).not.toBeNull();
      await w.actor.as.mutation(api.unmerge.resume, { mergeActionId: mergeId });
      await expect(
        w.colleague.as.mutation(api.unmerge.resume, { mergeActionId: mergeId }),
      ).rejects.toThrow(UNMERGE_RESUME_RUNNING);
      expect(await pendingPages(w)).toBe(1);
      // A skater holds no merge lever.
      await expect(
        w.skater.as.mutation(api.unmerge.resume, { mergeActionId: mergeId }),
      ).rejects.toThrow();
      await settle(w.t);
    });
    expect((await receiptOf(w, mergeId))?.done).toBe(true);
    await expect(
      w.actor.as.mutation(api.unmerge.resume, { mergeActionId: mergeId }),
    ).rejects.toThrow(UNMERGE_RESUME_DONE);
  });
  test('runningOn finds a pair’s unmerge by either body — its merge, stalled or not — and none once done', async () => {
    const w = await world(['content']);
    const mergeId = await mergeV2(w);
    const on = (ids: Id<'waterBodies'>[]) =>
      w.colleague.as.query(api.unmerge.runningOn, { waterBodyIds: ids });
    expect(await on([w.loser, w.survivor])).toBeNull();
    await paged(async () => {
      UNMERGE_FAULT.phase = 'moved';
      try {
        await w.colleague.as.mutation(api.undo.run, { actionId: mergeId, reason: 'Two lakes' });
        await settle(w.t);
      } finally {
        UNMERGE_FAULT.phase = null;
      }
      // By the survivor alone, or the loser: the merge resume and receipt are keyed by.
      for (const ids of [[w.survivor], [w.loser], [w.elsewhere, w.loser]]) {
        expect(await on(ids)).toMatchObject({
          mergeActionId: mergeId,
          done: false,
          stalled: expect.objectContaining({ code: 'pageFailed' }),
        });
      }
      // Bounded to the first two ids passed: a marked body third in the list is never read.
      expect(await on([w.elsewhere, w.partner, w.loser])).toBeNull();
      await w.actor.as.mutation(api.unmerge.resume, { mergeActionId: mergeId });
      await settle(w.t);
    });
    expect(await on([w.loser, w.survivor])).toBeNull();
    // Held to `audit.read`, as `receipt` is (a query takes a read capability): a skater is refused.
    await expect(
      w.skater.as.query(api.unmerge.runningOn, { waterBodyIds: [w.loser] }),
    ).rejects.toThrow();
  });

  // ── R11: which stalls a resume can finish, and the exit for the rest ──

  /** The unmerge's row and its next page, mid-run (one row a page). */
  const midRun = async (w: World, mergeId: Id<'moderationActions'>) => {
    await w.colleague.as.mutation(api.undo.run, { actionId: mergeId, reason: 'Two lakes' });
    const lead = (await unmergeRowOf(w.t, w.loser)) as Doc<'moderationActions'>;
    return {
      lead,
      next: (lead.metadata as { nextPageId: Id<'_scheduled_functions'> }).nextPageId,
    };
  };
  const patchMeta = (
    w: World,
    id: Id<'moderationActions'>,
    fn: (m: Record<string, unknown>) => Record<string, unknown>,
  ) =>
    w.t.run(async (ctx) => {
      const row = (await ctx.db.get(id)) as Doc<'moderationActions'>;
      await ctx.db.patch(id, { metadata: fn((row.metadata ?? {}) as Record<string, unknown>) });
    });

  test.each([
    [
      'pageCanceled',
      async (w: World, next: Id<'_scheduled_functions'>) => {
        await w.t.run((ctx) => ctx.scheduler.cancel(next));
      },
    ],
    [
      'pageMissing',
      async (w: World, next: Id<'_scheduled_functions'>, lead: Doc<'moderationActions'>) => {
        await w.t.run((ctx) => ctx.scheduler.cancel(next));
        await patchMeta(w, lead._id, ({ nextPageId: _n, ...m }) => m);
      },
    ],
    [
      'pageStopped',
      async (w: World, next: Id<'_scheduled_functions'>, lead: Doc<'moderationActions'>) => {
        await w.t.run((ctx) => ctx.scheduler.cancel(next));
        // A page the scheduler finished that carried nothing on (a job that ran and returned).
        const done = await w.t.run(
          async (ctx) =>
            (await ctx.db.system.query('_scheduled_functions').collect()).find(
              (j) => j.state.kind === 'success',
            )?._id,
        );
        await patchMeta(w, lead._id, (m) => ({ ...m, nextPageId: done }));
      },
    ],
  ] as const)('%s: resumable, and a resume finishes it as before', async (code, stop) => {
    const w = await world(['content']);
    const before = await census(w.t);
    const mergeId = await mergeV2(w);
    await paged(async () => {
      const { lead, next } = await midRun(w, mergeId);
      await stop(w, next, lead);
      // While stalled, how much is still as the merge left it: the first page put one row back.
      expect((await receiptOf(w, mergeId))?.stalled).toEqual({
        code,
        resumable: true,
        notReached: { phase: 'moved', from: 1, remaining: { moved: 4 } },
      });
      await w.actor.as.mutation(api.unmerge.resume, { mergeActionId: mergeId });
      await settle(w.t);
    });
    expect((await receiptOf(w, mergeId))?.done).toBe(true);
    expect(await census(w.t)).toEqual(before);
  });

  test('pageFailed is resumable', async () => {
    const w = await world(['content']);
    const mergeId = await mergeV2(w);
    await paged(async () => {
      UNMERGE_FAULT.phase = 'moved';
      try {
        await midRun(w, mergeId);
        await settle(w.t);
      } finally {
        UNMERGE_FAULT.phase = null;
      }
    });
    expect((await receiptOf(w, mergeId))?.stalled).toMatchObject({
      code: 'pageFailed',
      resumable: true,
    });
  });

  /** A stall no resume can carry on from, each made as it happens. */
  const deadEnds: [
    UnmergeStallCode,
    (w: World, mergeId: Id<'moderationActions'>, lead: Doc<'moderationActions'>) => Promise<void>,
  ][] = [
    [
      'undone',
      (w, _m, lead) =>
        w.t.run(async (ctx) => {
          await writeAudit(ctx, {
            actorId: w.actor.id,
            action: 'merge_waterbody',
            targetType: 'waterbody',
            targetId: w.loser,
            reason: 'Undone',
            undoesActionId: lead._id,
            createdAt: Date.now(),
          });
        }),
    ],
    ['recordGone', (w, mergeId) => w.t.run((ctx) => ctx.db.delete(mergeId))],
    [
      'recordUnreadable',
      (w, mergeId) =>
        w.t.run(async (ctx) => {
          const part = await ctx.db
            .query('auditSnapshots')
            .withIndex('by_action', (q) => q.eq('actionId', mergeId))
            .first();
          if (part) await ctx.db.patch(part._id, { payload: { chunk: '{', of: 2 } });
        }),
    ],
    [
      'mergedAgain',
      (w) =>
        w.t.run(async (ctx) => {
          const survivor = (await ctx.db.get(w.survivor)) as Doc<'waterBodies'>;
          const loser = (await ctx.db.get(w.loser)) as Doc<'waterBodies'>;
          await mergeBodyInto(ctx, { survivor, loser, actorId: w.actor.id, reason: 'Again' });
        }),
    ],
  ];

  test.each(deadEnds)(
    '%s: not resumable — resume refuses in words; abandon releases both bodies and records what was and wasn’t put back',
    async (code, stop) => {
      const w = await world(['content']);
      const mergeId = await mergeV2(w);
      const lead = await paged(async () => {
        const { lead } = await midRun(w, mergeId);
        await stop(w, mergeId, lead);
        await settle(w.t);
        return lead;
      });
      // How much is still un-moved, as the abandon would record it — unknown when the record can't
      // be read.
      expect((await receiptOf(w, mergeId))?.stalled).toEqual({
        code,
        resumable: false,
        notReached:
          code === 'recordUnreadable' ? null : { phase: 'moved', from: 1, remaining: { moved: 4 } },
      });
      await expect(
        w.actor.as.mutation(api.unmerge.resume, { mergeActionId: mergeId }),
      ).rejects.toThrow(UNMERGE_CANT_RESUME[code as keyof typeof UNMERGE_CANT_RESUME]);
      // Both bodies still locked by the dead unmerge, until it is abandoned.
      expect(await markers(w)).toEqual([lead._id, lead._id]);
      await expect(
        w.actor.as.mutation(api.unmerge.abandon, { mergeActionId: mergeId, reason: '  ' }),
      ).rejects.toThrow(UNMERGE_ABANDON_REASON);
      const shown = (await receiptOf(w, mergeId))?.stalled?.notReached;
      const { actionId } = await w.actor.as.mutation(api.unmerge.abandon, {
        mergeActionId: mergeId,
        reason: 'It can’t finish',
      });
      // The dialog showed what the abandon then records.
      expect((await w.t.run((ctx) => ctx.db.get(actionId)))?.metadata?.notReached).toEqual(shown);
      expect(await markers(w)).toEqual([null, null]);
      const after = await receiptOf(w, mergeId);
      expect(after).toMatchObject({ done: false, stalled: null, abandoned: { actionId } });
      const row = await w.t.run((ctx) => ctx.db.get(actionId));
      expect(row).toMatchObject({
        action: 'unmerge_waterbody',
        actorId: w.actor.id,
        targetId: w.loser,
        reason: 'It can’t finish',
        metadata: { abandons: lead._id, mergeActionId: mergeId, stalled: { code } },
      });
      // What wasn't put back, from the cursor on — unless the merge's record can't be read.
      const notReached = (row?.metadata as { notReached?: unknown } | undefined)?.notReached;
      if (code === 'recordUnreadable') expect(notReached).toBeNull();
      else expect(notReached).toMatchObject({ phase: 'moved', from: 1 });
      // Ended: neither resumed nor abandoned again.
      await expect(
        w.actor.as.mutation(api.unmerge.resume, { mergeActionId: mergeId }),
      ).rejects.toThrow(UNMERGE_ABANDONED);
      await expect(
        w.actor.as.mutation(api.unmerge.abandon, { mergeActionId: mergeId, reason: 'Again' }),
      ).rejects.toThrow(UNMERGE_ABANDONED);
    },
  );

  test('abandon: refused while a page runs, once done, and to a skater; allowed on a resumable stall', async () => {
    const w = await world(['content']);
    const mergeId = await mergeV2(w);
    await paged(async () => {
      await midRun(w, mergeId);
      await expect(
        w.actor.as.mutation(api.unmerge.abandon, { mergeActionId: mergeId, reason: 'Stop' }),
      ).rejects.toThrow(UNMERGE_RESUME_RUNNING);
      UNMERGE_FAULT.phase = 'moved';
      try {
        await settle(w.t);
      } finally {
        UNMERGE_FAULT.phase = null;
      }
    });
    await expect(
      w.skater.as.mutation(api.unmerge.abandon, { mergeActionId: mergeId, reason: 'Stop' }),
    ).rejects.toThrow();
    // A page that fails the same way each time would lock both bodies for good: a resumable stall can
    // be abandoned too.
    await w.actor.as.mutation(api.unmerge.abandon, { mergeActionId: mergeId, reason: 'Stuck' });
    expect(await markers(w)).toEqual([null, null]);
    const w2 = await world(['content']);
    const merge2 = await mergeV2(w2);
    await unmerge(w2, merge2);
    await expect(
      w2.actor.as.mutation(api.unmerge.abandon, { mergeActionId: merge2, reason: 'Late' }),
    ).rejects.toThrow(UNMERGE_RESUME_DONE);
  });
});

// ── One unmerge a body at a time (Greptile on #173) ───────────────────────────────────────────────

suite('one unmerge a body at a time: a second is refused while either body is still being unmerged', () => {
  const marks = (w: World, ids: Id<'waterBodies'>[]) =>
    w.t.run(async (ctx) =>
      Promise.all(ids.map(async (id) => (await ctx.db.get(id))?.unmergeActionId ?? null)),
    );
  const offerFor = (w: World, actionId: Id<'moderationActions'>) =>
    w.t.run(async (ctx) =>
      undoState(
        ctx,
        (await ctx.db.get(w.colleague.id)) as Doc<'profiles'>,
        (await ctx.db.get(actionId)) as Doc<'moderationActions'>,
        'one',
      ),
    );
  /** The unmerge of `mergeId` started and left mid-run (one row a page; its later pages pending). */
  const startPaged = async (w: World, mergeId: Id<'moderationActions'>) => {
    const was = PAGE_SEAM.sources;
    PAGE_SEAM.sources = 1;
    try {
      await w.colleague.as.mutation(api.undo.run, { actionId: mergeId, reason: 'Two lakes' });
    } finally {
      PAGE_SEAM.sources = was;
    }
  };
  const name = (w: World, id: Id<'waterBodies'>) =>
    w.t.run(async (ctx) => (await ctx.db.get(id))?.name as string);
  /** Both refuse the second unmerge, offer and run, in the same sentence. */
  const refused = async (w: World, mergeId: Id<'moderationActions'>, busy: Id<'waterBodies'>) => {
    const why = unmergeBodyBusy(await name(w, busy));
    expect(await offerFor(w, mergeId)).toEqual({ state: 'unavailable', why });
    await expect(
      w.colleague.as.mutation(api.undo.run, { actionId: mergeId, reason: 'Too' }),
    ).rejects.toThrow(why);
  };

  test('two merges into one survivor: the second’s unmerge waits for the first; both then come back as before', async () => {
    const w = await world(['content']);
    const before = await census(w.t);
    const first = await mergeV2(w);
    // A second body, unrelated to the first's partners, merged into the same survivor.
    const second = await mergeV2({ ...w, loser: w.elsewhere });
    await startPaged(w, first);
    const lead = (await unmergeRowOf(w.t, w.loser)) as Doc<'moderationActions'>;
    await refused(w, second, w.survivor);
    // Nothing was overwritten: the survivor is still the first unmerge's.
    expect(await marks(w, [w.loser, w.survivor, w.elsewhere])).toEqual([lead._id, lead._id, null]);
    await settle(w.t);
    expect(await marks(w, [w.loser, w.survivor])).toEqual([null, null]);
    await unmerge(w, second);
    expect(await census(w.t)).toEqual(before);
  });

  test('a survivor that is the loser of a running unmerge (the chain A→B, then B→C, undone last first)', async () => {
    const w = await world(['content']);
    const before = await census(w.t);
    // A (the drawing) into B (the survivor), then B into C (elsewhere).
    const aIntoB = await mergeV2(w);
    const bIntoC = await mergeV2({ ...w, survivor: w.elsewhere, loser: w.survivor });
    // Undoing A→B first is refused: B is merged into C.
    expect((await offerFor(w, aIntoB)).state).toBe('unavailable');
    await startPaged(w, bIntoC);
    // B is back on its own, but still being unmerged: A→B waits.
    await refused(w, aIntoB, w.survivor);
    await settle(w.t);
    await unmerge(w, aIntoB);
    expect(await census(w.t)).toEqual(before);
  });

  test('a stalled first unmerge holds the second until it is resumed or abandoned; abandon clears only its own', async () => {
    const w = await world(['content']);
    const first = await mergeV2(w);
    const second = await mergeV2({ ...w, loser: w.elsewhere });
    const was = PAGE_SEAM.sources;
    PAGE_SEAM.sources = 1;
    UNMERGE_FAULT.phase = 'moved';
    try {
      await w.colleague.as.mutation(api.undo.run, { actionId: first, reason: 'Two lakes' });
      await settle(w.t);
    } finally {
      UNMERGE_FAULT.phase = null;
      PAGE_SEAM.sources = was;
    }
    await refused(w, second, w.survivor);
    await w.actor.as.mutation(api.unmerge.abandon, { mergeActionId: first, reason: 'Stuck' });
    expect(await marks(w, [w.loser, w.survivor])).toEqual([null, null]);
    await unmerge(w, second);
    expect((await w.colleague.as.query(api.unmerge.receipt, { mergeActionId: second }))?.done).toBe(
      true,
    );
  });

  test('a marker that isn’t its own is never cleared — by the last page or by abandon', async () => {
    const w = await world(['content']);
    const first = await mergeV2(w);
    await startPaged(w, first);
    // Another row's marker on the survivor (as a second unmerge would have set it before the refusal).
    const other = await w.t.run((ctx) =>
      ctx.db.insert('moderationActions', {
        action: 'unmerge_waterbody',
        targetType: 'waterbody',
        targetId: w.survivor,
        reason: 'Another',
        createdAt: Date.now(),
      }),
    );
    await w.t.run((ctx) => ctx.db.patch(w.survivor, { unmergeActionId: other }));
    await settle(w.t);
    expect(await marks(w, [w.loser, w.survivor])).toEqual([null, other]);
    // And abandon, on a stalled one.
    const w2 = await world(['content']);
    const m2 = await mergeV2(w2);
    const was = PAGE_SEAM.sources;
    PAGE_SEAM.sources = 1;
    UNMERGE_FAULT.phase = 'moved';
    try {
      await w2.colleague.as.mutation(api.undo.run, { actionId: m2, reason: 'Two lakes' });
      await settle(w2.t);
    } finally {
      UNMERGE_FAULT.phase = null;
      PAGE_SEAM.sources = was;
    }
    const other2 = await w2.t.run((ctx) =>
      ctx.db.insert('moderationActions', {
        action: 'unmerge_waterbody',
        targetType: 'waterbody',
        targetId: w2.survivor,
        reason: 'Another',
        createdAt: Date.now(),
      }),
    );
    await w2.t.run((ctx) => ctx.db.patch(w2.survivor, { unmergeActionId: other2 }));
    await w2.actor.as.mutation(api.unmerge.abandon, { mergeActionId: m2, reason: 'Stuck' });
    expect(await marks(w2, [w2.loser, w2.survivor])).toEqual([null, other2]);
  });
});

// ── Where the unmerge is said ──────────────────────────────────────────────────────────────────────

suite('the unmerge in both bodies’ History', () => {
  test('its row, with its outcome, is in the loser’s History and the survivor’s', async () => {
    const w = await world(['content']);
    const mergeId = await mergeV2(w);
    await unmerge(w, mergeId);
    for (const waterBodyId of [w.loser, w.survivor]) {
      const { entries } = await w.colleague.as.query(api.bodyConsole.history, { waterBodyId });
      const row = entries.find((e) => e.action === 'unmerge_waterbody');
      expect(row?.undoesActionId).toBe(mergeId);
      expect(row?.metadata).toMatchObject({ done: true, left: { count: 0 } });
    }
  });
});

// ── Page room: each restored row costs no more than its page reserves for it ───────────────────────

suite('each restored row costs no more than the page reserves for it, kind by kind', () => {
  /** A row's step, run alone in a fresh transaction, measured on every axis a page's room asks. */
  const measure = (t: T, step: (ctx: MutationCtx) => Promise<unknown>) =>
    t.run(async (ctx) => {
      const axes = [
        'bytesRead',
        'documentsRead',
        'databaseQueries',
        'documentsWritten',
        'bytesWritten',
      ] as const;
      const at = async () => {
        const m = await ctx.meta.getTransactionMetrics();
        return Object.fromEntries(axes.map((k) => [k, m[k].used])) as Record<
          (typeof axes)[number],
          number
        >;
      };
      let spent: Record<string, number> = {};
      // In an Inbox batch, as a page runs it: an item's refresh is owed to the batch's end, which the
      // page's room counts apart (`batchHasRoom`).
      await inboxBatch(ctx, async () => {
        const before = await at();
        await step(ctx);
        const after = await at();
        spent = Object.fromEntries(axes.map((k) => [k, after[k] - before[k]]));
      });
      return spent as TxCost;
    });
  const within = (spent: TxCost, reserved: TxCost, kind: string) => {
    for (const k of Object.keys(reserved) as (keyof TxCost)[]) {
      expect(spent[k], `${kind}: ${k}`).toBeLessThanOrEqual(reserved[k]);
    }
  };
  const plus = (a: TxCost, b: TxCost): TxCost =>
    Object.fromEntries(
      Object.keys(a).map((k) => [k, a[k as keyof TxCost] + b[k as keyof TxCost]]),
    ) as TxCost;

  test('moved rows of every table, skates, re-made favorites, bays, labels and side rows', async () => {
    const w = await world();
    const mergeId = await mergeV2(w);
    const { cs, mergeRow } = await w.t.run(async (ctx) => ({
      cs: (await readSnapshot<MergeChangeSet>(ctx, mergeId)) as MergeChangeSet,
      mergeRow: (await ctx.db.get(mergeId)) as Doc<'moderationActions'>,
    }));
    const S = UNMERGE_ROW_STEPS;
    const seen = new Set<string>();
    for (const m of cs.moved) {
      seen.add(m.table);
      const spent = await measure(w.t, (ctx) =>
        S.moveBack(ctx, m, w.survivor, w.loser, mergeRow.createdAt),
      );
      within(spent, plus(S.movedCost(m.table), RECONCILE_COST), m.table);
    }
    expect(seen.size).toBe(9);
    const skate = cs.movedActivities?.[0];
    if (!skate) throw new Error('no skate');
    within(
      await measure(w.t, (ctx) => S.activityBack(ctx, skate, w.survivor, w.loser)),
      S.SMALL_COST,
      'skate',
    );
    const fav = cs.deletedFavorites[0];
    if (!fav) throw new Error('no dropped favorite');
    within(
      await measure(w.t, (ctx) => S.favoriteBack(ctx, fav, w.loser)),
      S.SMALL_COST,
      'favorite',
    );
    for (const table of ['waterBodySubAreas', 'bodyLandmarks'] as const) {
      for (const after of (cs.rowsAfter ?? []).filter((r) => r.table === table)) {
        within(
          await measure(w.t, (ctx) => S.fieldsBack(ctx, after, S.beforeOf(cs, after))),
          S.SHAPE_COST,
          `${table} ${after.id}`,
        );
      }
    }
    const state = {
      cs,
      mergeRow,
      unmergeId: mergeId,
      actorId: w.actor.id,
      cursor: { phase: 'sides' as const, from: 0 },
      left: { count: 0, byKind: {}, rows: [] },
    };
    for (const side of cs.sideActions ?? []) {
      within(
        await measure(w.t, (ctx) => S.sideUndone(ctx, cs, side, state)),
        S.SIDE_COST,
        `side ${side}`,
      );
    }
    // The side rows were written (their targets put back above), so each measured its whole path.
    const undone = await w.t.run(async (ctx) =>
      (await ctx.db.query('moderationActions').collect()).filter((r) =>
        (cs.sideActions ?? []).includes(r.undoesActionId as Id<'moderationActions'>),
      ),
    );
    expect(undone).toHaveLength(cs.sideActions?.length ?? 0);
  });
});

// ── The drawer's message ───────────────────────────────────────────────────────────────────────────

suite('the drawer is told of the merge once, or not at all', () => {
  const flushAll = async (t: T) => {
    await t.mutation(internal.notifications.flushNotificationQueue, {});
    await settle(t);
  };
  const toldDrawer = async (w: World) =>
    (
      await w.t.run((ctx) =>
        ctx.db
          .query('notifications')
          .filter((q) => q.eq(q.field('userId'), w.drawer.id))
          .collect(),
      )
    ).length;

  /** The drawer's queued message, if the merge queued one (S4a's enqueue). */
  const queued = (w: World) =>
    w.t.run((ctx) =>
      ctx.db
        .query('notificationQueue')
        .filter((q) => q.eq(q.field('userId'), w.drawer.id))
        .collect(),
    );
  const dueNow = (w: World) =>
    w.t.run(async (ctx) => {
      for (const row of await ctx.db.query('notificationQueue').collect()) {
        await ctx.db.patch(row._id, { flushAfter: 0 });
      }
    });

  test('an unmerge inside the window drops the merged message', async () => {
    const w = await world(['content']);
    const mergeId = await mergeV2(w);
    // The merge queued its `merged` message (S4a's enqueue): the unmerge drops it.
    expect(await queued(w)).toHaveLength(1);
    await unmerge(w, mergeId);
    await dueNow(w);
    await flushAll(w.t);
    expect(await toldDrawer(w)).toBe(0);
  });

  test('a merge that stands is told once, and an unmerge after it tells nothing more', async () => {
    const w = await world(['content']);
    const mergeId = await mergeV2(w);
    expect(await queued(w)).toHaveLength(1);
    await dueNow(w);
    await flushAll(w.t);
    expect(await toldDrawer(w)).toBe(1);
    await unmerge(w, mergeId);
    await dueNow(w);
    await flushAll(w.t);
    expect(await toldDrawer(w)).toBe(1);
  });
});

// biome-ignore lint/suspicious/noExportsInTest: the property test and the offer-versus-run table build on this world and its merge; its own suites register only when this file runs.
export {
  census,
  harness,
  KINDS,
  type Kind,
  leftOf,
  mergeV2,
  rect,
  settle,
  type T,
  unmerge,
  unmergeRowOf,
  VOLATILE,
  type World,
  world,
};
