/**
 * The drift repair at the member bound, over decided items, and over facets (B01-5, the second
 * review): an item of any allowed size is repairable; an item wrongly left decided while a source is
 * open again is found; a tab that drifted is put right.
 */

import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { fileMember, flagSource, MAX_MEMBERS } from './lib/inboxItems';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
const NOW = Date.now();

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
};

const profile = (subject: string) => ({
  clerkUserId: subject,
  displayName: `${subject} Test-Person`,
  username: subject,
  driveTimePrefMinutes: 60,
  profileVisibility: 'public' as const,
  notificationPrefs: PREFS,
  dateOfBirth: Date.UTC(1990, 0, 1),
  reputationPoints: 0,
  role: 'member' as const,
  status: 'active' as const,
  createdAt: NOW,
});

/** One report flagged by `n` different people, each flag filed through the one writer. */
async function flaggedReport(t: T, n: number) {
  return t.run(async (ctx) => {
    const author = await ctx.db.insert('profiles', profile('author'));
    const body = await ctx.db.insert('waterBodies', {
      name: 'Pond',
      searchText: 'Pond',
      type: 'lakePond',
      source: 'osm',
      dedupStatus: 'clean',
      polygon: {
        type: 'Polygon',
        coordinates: [
          [
            [-1, -1],
            [-1, 1],
            [1, 1],
            [1, -1],
            [-1, -1],
          ],
        ],
      },
      centroid: { lat: 0, lng: 0 },
      bbox: { minLat: -1, minLng: -1, maxLat: 1, maxLng: 1 },
      createdAt: NOW,
    } as never);
    const report = await ctx.db.insert('reports', {
      authorId: author,
      waterBodyId: body as Id<'waterBodies'>,
      point: { lat: 0, lng: 0 },
      skateEndTime: NOW,
      reportTime: NOW,
      source: 'native',
      iceTypes: [],
      surfaceTags: [],
      photoIds: [],
      moderationStatus: 'visible',
      hazardIdsCreated: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
    const flags: Id<'contentFlags'>[] = [];
    for (let i = 0; i < n; i++) {
      const flagger = await ctx.db.insert('profiles', profile(`f${i}`));
      const id = await ctx.db.insert('contentFlags', {
        flaggerId: flagger,
        targetType: 'report',
        targetId: report,
        reason: 'spam',
        status: 'open',
        origin: 'user',
        subjectUserId: author,
        createdAt: NOW + i,
      });
      await fileMember(ctx, flagSource(id));
      flags.push(id);
    }
    return { report, flags };
  });
}

describe('the repair at the member bound', () => {
  // Filing 500 members is about 4 s alone and six times that beside the whole suite: its own timeout.
  test.each([10, 60, MAX_MEMBERS])(
    'an item with %i members is checked, not failed',
    async (n) => {
      const t = harness();
      await flaggedReport(t, n);
      const pass = await t.mutation(internal.inboxItems.repair, {});
      expect(pass).toMatchObject({ failed: 0, fixed: 0 });
      expect(await t.run((ctx) => ctx.db.query('jobFailures').collect())).toEqual([]);
    },
    90_000,
  );
});

describe('the repair widened', () => {
  test('an item left decided while its source is open again is found by the decided walk', async () => {
    const t = harness();
    const { flags } = await flaggedReport(t, 2);
    // Decide both flags through the writer, then reopen one source behind its back (a missed reopen).
    await t.run(async (ctx) => {
      const { decideItem } = await import('./lib/inboxItems');
      for (const id of flags) {
        await ctx.db.patch(id, { status: 'dismissed', resolvedAt: NOW });
        await decideItem(ctx, flagSource(id));
      }
      await ctx.db.patch(flags[0] as Id<'contentFlags'>, { status: 'open', resolvedAt: undefined });
    });
    const before = await t.run((ctx) => ctx.db.query('inboxItems').first());
    expect(before?.status).toBe('decided');
    const pass = await t.mutation(internal.inboxItems.repair, {});
    expect(pass).toMatchObject({ decidedChecked: 1, failed: 0 });
    expect(pass.fixed).toBeGreaterThan(0);
    const after = await t.run((ctx) => ctx.db.query('inboxItems').collect());
    expect(after.map((i) => [i.status, i.memberCount])).toEqual([['open', 1]]);
  });

  test('a drifted tab is put right: a drawing whose overlap changed with no hook', async () => {
    const t = harness();
    const item = await t.run(async (ctx) => {
      const drawer = await ctx.db.insert('profiles', profile('drawer'));
      const id = (await ctx.db.insert('waterBodies', {
        name: 'Drawn',
        searchText: 'Drawn',
        type: 'lakePond',
        source: 'user',
        dedupStatus: 'clean',
        reviewStatus: 'pending',
        createdByUserId: drawer,
        polygon: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [0, 1],
              [1, 1],
              [1, 0],
              [0, 0],
            ],
          ],
        },
        centroid: { lat: 0.5, lng: 0.5 },
        bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
        createdAt: NOW,
      } as never)) as Id<'waterBodies'>;
      const { bodySource } = await import('./lib/inboxItems');
      await fileMember(ctx, bodySource(id));
      // A candidate stamped later, through a write the guard can't see.
      await ctx.db.patch(id, { duplicateCandidateIds: [id] });
      return id;
    });
    expect((await t.run((ctx) => ctx.db.query('inboxItems').first()))?.facet).toBe('newWater');
    const pass = await t.mutation(internal.inboxItems.repair, {});
    expect(pass.fixed).toBeGreaterThan(0);
    const after = await t.run(async (ctx) => ({
      facet: (await ctx.db.query('inboxItems').first())?.facet,
      counts: Object.fromEntries(
        (await ctx.db.query('inboxCounts').collect()).map((c) => [c.key, c.count]),
      ),
    }));
    expect(after.facet).toBe('overlap');
    expect(after.counts).toMatchObject({
      'open:drawnBodies:overlap': 1,
      'open:drawnBodies:newWater': 0,
    });
    void item;
  });

  test('an item that drifted wholesale is repaired over laps, never failed', async () => {
    const t = harness();
    const { flags } = await flaggedReport(t, 150);
    await t.run(async (ctx) => {
      for (const id of flags) await ctx.db.patch(id, { status: 'retracted', retractedAt: NOW });
    });
    for (let lap = 0; lap < 3; lap++) {
      expect((await t.mutation(internal.inboxItems.repair, {})).failed).toBe(0);
    }
    expect(await t.run((ctx) => ctx.db.query('inboxItems').collect())).toEqual([]);
  });

  test('parked backfill failures never hold the retry’s head', async () => {
    const t = harness();
    const { flags } = await flaggedReport(t, 1);
    await t.run(async (ctx) => {
      // Three parked failures, oldest first, then the one live failure that must still be retried.
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert('jobFailures', {
          job: 'inboxBackfill',
          key: `contentFlags:gone${i}`,
          errorClass: 'Error',
          attempts: 3,
          firstFailedAt: 1,
          lastFailedAt: 1 + i,
          parkedAt: 10,
        });
      }
      await ctx.db.insert('jobFailures', {
        job: 'inboxBackfill',
        key: `contentFlags:${flags[0]}`,
        errorClass: 'Error',
        attempts: 1,
        firstFailedAt: 5,
        lastFailedAt: 5,
      });
    });
    const pass = await t.mutation(internal.inboxItems.repair, {});
    expect(pass.retried).toBe(1);
    const left = await t.run((ctx) => ctx.db.query('jobFailures').collect());
    expect(left.map((f) => f.key).sort()).toEqual([
      'contentFlags:gone0',
      'contentFlags:gone1',
      'contentFlags:gone2',
    ]);
  });
});

describe('the writes that move a tab, hooked', () => {
  const lakeAt = async (t: T, externalId: string, x: number) => {
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          source: 'osm',
          states: ['NH'],
          externalId,
          osmId: externalId,
          name: `Pond ${externalId}`,
          type: 'lakePond',
          polygon: {
            type: 'Polygon',
            coordinates: [
              [
                [x, 0],
                [x, 1],
                [x + 1, 1],
                [x + 1, 0],
                [x, 0],
              ],
            ],
          },
          bbox: { minLat: 0, minLng: x, maxLat: 1, maxLng: x + 1 },
          centroid: { lat: 0.5, lng: x + 0.5 },
          surfaceAreaSqM: 1_000_000,
        },
      ],
    });
    return (await t.run((ctx) => ctx.db.query('waterBodies').collect())).find(
      (b) => b.externalId === externalId,
    )?._id as Id<'waterBodies'>;
  };
  const facets = (t: T) =>
    t.run(async (ctx) =>
      (await ctx.db.query('inboxItems').collect())
        .filter((i) => i.status === 'open')
        .map((i) => i.facet),
    );

  test('clearing a ruling flips its open reports from Disputes to New', async () => {
    const t = harness();
    const lake = await lakeAt(t, 'osm/A', 0);
    const [mod, s] = await t.run(async (ctx) => [
      await ctx.db.insert('profiles', { ...profile('mod'), role: 'moderator' as const }),
      await ctx.db.insert('profiles', profile('s')),
    ]);
    await t
      .withIdentity({ subject: 'mod' })
      .mutation(api.waterBodies.setPublicAccess, { waterBodyId: lake, verdict: 'open' });
    await t.withIdentity({ subject: 's' }).mutation(api.contentFlags.flag, {
      targetType: 'waterbody',
      targetId: lake,
      reason: 'no_public_access',
      note: 'Gated now',
    });
    expect(await facets(t)).toEqual(['disputes']);
    await t
      .withIdentity({ subject: 'mod' })
      .mutation(api.waterBodies.setPublicAccess, { waterBodyId: lake, verdict: null });
    expect(await facets(t)).toEqual(['new']);
    void mod;
    void s;
  });

  test('a merge that resolves a drawing’s last candidate moves it to New water', async () => {
    const t = harness();
    const survivor = await lakeAt(t, 'osm/S', 0);
    const loser = await lakeAt(t, 'osm/L', 3);
    const drawn = await t.run(async (ctx) => {
      const drawer = await ctx.db.insert('profiles', profile('drawer'));
      await ctx.db.insert('profiles', { ...profile('mod'), role: 'moderator' as const });
      const id = (await ctx.db.insert('waterBodies', {
        name: 'Drawn',
        searchText: 'Drawn',
        type: 'lakePond',
        source: 'user',
        dedupStatus: 'suspected_duplicate',
        reviewStatus: 'pending',
        createdByUserId: drawer,
        duplicateCandidateIds: [loser],
        polygon: {
          type: 'Polygon',
          coordinates: [
            [
              [3, 0],
              [3, 1],
              [4, 1],
              [4, 0],
              [3, 0],
            ],
          ],
        },
        centroid: { lat: 0.5, lng: 3.5 },
        bbox: { minLat: 0, minLng: 3, maxLat: 1, maxLng: 4 },
        createdAt: NOW,
      } as never)) as Id<'waterBodies'>;
      await ctx.db.patch(loser, { duplicateCandidateIds: [id] });
      await fileMember(ctx, (await import('./lib/inboxItems')).bodySource(id));
      return id;
    });
    expect(await facets(t)).toEqual(['overlap']);
    await t
      .withIdentity({ subject: 'mod' })
      .mutation(api.waterBodies.merge, { survivorId: survivor, loserId: loser });
    expect(await facets(t)).toEqual(['newWater']);
    void drawn;
  });
});
