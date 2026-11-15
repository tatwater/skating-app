/**
 * A merge moves what was asked of the merged-away body (B01-3b): its requests (the founder's ruling),
 * open place names and open flags, recorded for the unmerge; and the repair for earlier merges.
 */

import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { readSnapshot } from './lib/audit';
import schema from './schema';
import { type MergeChangeSet, mergeBodyInto } from './waterBodies';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
const NOW = Date.now();

const NOTIF_PREFS = {
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
};
const square: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-72.01, 43.99],
      [-71.99, 43.99],
      [-71.99, 44.01],
      [-72.01, 44.01],
      [-72.01, 43.99],
    ],
  ],
};

async function seed(t: T) {
  return t.run(async (ctx) => {
    const person = (n: string) =>
      ctx.db.insert('profiles', {
        clerkUserId: `merge-${n}`,
        displayName: n,
        username: `merge-${n}`,
        dateOfBirth: Date.UTC(1990, 0, 1),
        driveTimePrefMinutes: 60,
        profileVisibility: 'public',
        notificationPrefs: NOTIF_PREFS,
        reputationPoints: 0,
        role: 'moderator',
        status: 'active',
        createdAt: NOW,
      });
    const mod = await person('mod');
    const skater = await person('skater');
    const body = (name: string) =>
      ctx.db.insert('waterBodies', {
        name,
        searchText: name,
        type: 'lakePond',
        source: 'osm',
        polygon: square,
        bbox: { minLat: 43.99, minLng: -72.01, maxLat: 44.01, maxLng: -71.99 },
        centroid: { lat: 44, lng: -72 },
        dedupStatus: 'suspected_duplicate',
        createdAt: NOW,
      });
    const survivor = await body('Survivor');
    const loser = await body('Loser');
    const request = (status: 'open' | 'declined') =>
      ctx.db.insert('waterBodyRequests', {
        kind: 'name_bay',
        status,
        requesterId: skater,
        coord: { lat: 44, lng: -72 },
        waterBodyId: loser,
        name: 'Cove',
        createdAt: NOW,
      });
    const openRequest = await request('open');
    const decidedRequest = await request('declined');
    const name = (status: 'open' | 'dismissed', key: string) =>
      ctx.db.insert('corpusPlaceNames', {
        name: key,
        askKey: key,
        aliases: [],
        messages: 1,
        skatedMessages: 0,
        states: [],
        waterBodyId: loser,
        status,
        createdAt: NOW,
        updatedAt: NOW,
      });
    const openName = await name('open', 'gut');
    const dismissedName = await name('dismissed', 'old');
    const flag = (
      flaggerId: Id<'profiles'>,
      targetId: string,
      reason: 'no_public_access' | 'other' = 'no_public_access',
      status: 'open' | 'reviewing' = 'open',
    ) =>
      ctx.db.insert('contentFlags', {
        flaggerId,
        targetType: 'waterbody',
        targetId,
        reason,
        status,
        createdAt: NOW,
      });
    const movedFlag = await flag(skater, loser);
    // The moderator flagged both bodies: their flag on the loser stays (one open flag per target) —
    // though the survivor's says something else and is already in review.
    await flag(mod, survivor, 'other', 'reviewing');
    const keptFlag = await flag(mod, loser);
    return {
      mod,
      survivor,
      loser,
      openRequest,
      decidedRequest,
      openName,
      dismissedName,
      movedFlag,
      keptFlag,
    };
  });
}

describe('a merge moves the asks', () => {
  test('requests, open place names and open flags move to the survivor, recorded for the unmerge', async () => {
    const t = harness();
    const s = await seed(t);
    const actionId = await t.run(async (ctx) => {
      await mergeBodyInto(ctx, {
        survivor: (await ctx.db.get(s.survivor)) as Doc<'waterBodies'>,
        loser: (await ctx.db.get(s.loser)) as Doc<'waterBodies'>,
        actorId: s.mod,
        reason: 'one lake',
      });
      const row = await ctx.db
        .query('moderationActions')
        .withIndex('by_target_action', (q) =>
          q.eq('targetType', 'waterbody').eq('targetId', s.loser).eq('action', 'merge_waterbody'),
        )
        .first();
      return row?._id as Id<'moderationActions'>;
    });
    const after = await t.run(async (ctx) => ({
      openRequest: (await ctx.db.get(s.openRequest))?.waterBodyId,
      decidedRequest: (await ctx.db.get(s.decidedRequest))?.waterBodyId,
      openName: (await ctx.db.get(s.openName))?.waterBodyId,
      dismissedName: (await ctx.db.get(s.dismissedName))?.waterBodyId,
      movedFlag: (await ctx.db.get(s.movedFlag))?.targetId,
      keptFlag: (await ctx.db.get(s.keptFlag))?.targetId,
      row: await ctx.db
        .query('bodyLibraryRows')
        .withIndex('by_body', (q) => q.eq('waterBodyId', s.survivor).eq('scope', '*'))
        .first(),
      changeSet: await readSnapshot<MergeChangeSet>(ctx, actionId),
    }));
    expect(after).toMatchObject({
      openRequest: s.survivor,
      decidedRequest: s.survivor,
      openName: s.survivor,
      dismissedName: s.loser,
      movedFlag: s.survivor,
      keptFlag: s.loser,
    });
    // The survivor's asks now count what moved: the open request, the open name, and both flags on it.
    expect(after.row?.asks).toBe(4);
    const moved = after.changeSet?.moved.filter((m) =>
      ['waterBodyRequests', 'corpusPlaceNames', 'contentFlags'].includes(m.table),
    );
    expect(moved?.map((m) => [m.table, m.waterBodyId])).toEqual([
      ['waterBodyRequests', s.loser],
      ['waterBodyRequests', s.loser],
      ['corpusPlaceNames', s.loser],
      ['contentFlags', s.loser],
    ]);
  });

  test('the repair moves the asks of bodies merged before, once', async () => {
    const t = harness();
    const s = await seed(t);
    await t.run((ctx) =>
      ctx.db.patch(s.loser, { dedupStatus: 'merged', mergedIntoId: s.survivor }),
    );
    expect(await t.mutation(internal.waterBodies.retargetMergedAsks, {})).toEqual({
      moved: 4,
      isDone: true,
    });
    expect(await t.mutation(internal.waterBodies.retargetMergedAsks, {})).toEqual({
      moved: 0,
      isDone: true,
    });
    const request = await t.run((ctx) => ctx.db.get(s.openRequest));
    expect(request?.waterBodyId).toBe(s.survivor);
  });
});
