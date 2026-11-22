/**
 * Asks a script filed are not Inbox items (D289, amended): `backfillOrigin` stamps exactly the rows
 * the seed wrote before `origin` existed, and a seed-origin ask stays decidable where it is today by
 * any staffer holding the capability — its requester included.
 */

import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { fileMember, requestSource } from './lib/inboxItems';
import { ROW_MAX } from './lib/readBudget';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

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
  moderatorDecision: false,
};
const POLYGON: Polygon = {
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
};
const CENTER = { lat: 0.5, lng: 0.5 };

async function seed(t: T) {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        states: ['VT'],
        externalId: 'osm/A',
        osmId: 'osm/A',
        name: 'Quiet Pond',
        type: 'lakePond',
        polygon: POLYGON,
        bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
        centroid: CENTER,
        surfaceAreaSqM: 1_000_000,
      },
    ],
  });
  return t.run(async (ctx) => {
    const lake = (await ctx.db.query('waterBodies').first())?._id as Id<'waterBodies'>;
    const centroid = (await ctx.db.get(lake))?.centroid ?? CENTER;
    const person = (n: string, role: 'member' | 'moderator' | 'admin') =>
      ctx.db.insert('profiles', {
        clerkUserId: n,
        displayName: `${n} Test-Person`,
        username: n,
        driveTimePrefMinutes: 60,
        profileVisibility: 'public',
        notificationPrefs: PREFS,
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role,
        status: 'active',
        createdAt: 1,
      });
    const staff = await person('staff', 'admin');
    const skater = await person('skater', 'member');
    const ask = (
      name: string,
      requesterId: Id<'profiles'>,
      coord: { lat: number; lng: number },
      extra: { aliases?: string[]; origin?: 'seed' | 'app'; kind?: 'name_bay' | 'takedown' } = {},
    ) =>
      ctx.db.insert('waterBodyRequests', {
        kind: extra.kind ?? 'name_bay',
        status: 'open',
        requesterId,
        coord,
        waterBodyId: lake,
        ...(extra.kind === 'takedown' ? {} : { name, nameKey: name.toLowerCase() }),
        ...(extra.aliases ? { aliases: extra.aliases } : {}),
        ...(extra.origin ? { origin: extra.origin } : {}),
        createdAt: 10,
      });
    const rows = {
      // The seed's two marks.
      aliased: await ask('NW Bay', skater, { lat: 0.9, lng: 0.9 }, { aliases: ['Northwest Bay'] }),
      staffPlace: await ask('Cove', staff, { lat: 0.2, lng: 0.2 }),
      // Not the seed's: staff at the lake's own point, a skater's drawer ask, already stamped, not a bay.
      staffLakePoint: await ask('Gut', staff, centroid),
      skaterPlace: await ask('Narrows', skater, { lat: 0.3, lng: 0.3 }),
      stamped: await ask('Old', staff, { lat: 0.4, lng: 0.4 }, { aliases: ['x'], origin: 'seed' }),
      takedown: await ask('', staff, { lat: 0.6, lng: 0.6 }, { kind: 'takedown' }),
    };
    // As the live hooks would have filed them before the stamp.
    for (const id of Object.values(rows)) await fileMember(ctx, requestSource(id));
    return { lake, staff, skater, rows };
  });
}

describe('corpusRequests:backfillOrigin', () => {
  test('dry lists exactly the rule’s rows and writes nothing; apply stamps only those, once', async () => {
    const t = harness();
    const { rows } = await seed(t);
    const before = await t.run((ctx) => ctx.db.query('inboxItemMembers').collect());
    const dry = await t.mutation(internal.corpusRequests.backfillOrigin, {});
    expect(dry.applied).toBe(false);
    expect(dry.candidates.map((c) => [c.requestId, c.reason]).sort()).toEqual(
      [
        [rows.aliased, 'aliases'],
        [rows.staffPlace, 'staff_requester_off_lake_point'],
      ].sort(),
    );
    expect(await t.run((ctx) => ctx.db.query('inboxItemMembers').collect())).toEqual(before);
    expect(
      (await t.run((ctx) => ctx.db.query('waterBodyRequests').collect())).filter(
        (r) => r.origin === 'seed',
      ),
    ).toHaveLength(1);

    const applied = await t.mutation(internal.corpusRequests.backfillOrigin, { apply: true });
    expect(applied.candidates).toHaveLength(2);
    const stamped = (await t.run((ctx) => ctx.db.query('waterBodyRequests').collect()))
      .filter((r) => r.origin === 'seed')
      .map((r) => r._id)
      .sort();
    expect(stamped).toEqual([rows.aliased, rows.staffPlace, rows.stamped].sort());
    // Their Inbox members left with the stamp; the others stay.
    const members = await t.run((ctx) => ctx.db.query('inboxItemMembers').collect());
    expect(members.map((m) => m.sourceId).sort()).toEqual(
      [rows.staffLakePoint, rows.skaterPlace, rows.takedown].sort(),
    );
    // Idempotent: a second apply finds nothing.
    expect(
      (await t.mutation(internal.corpusRequests.backfillOrigin, { apply: true })).candidates,
    ).toEqual([]);
  });

  test('bounded on bytes: a budget for one row’s worst case reads one row a call, and still advances', async () => {
    const t = harness();
    await seed(t);
    const oneRow = ROW_MAX.waterBodyRequest + ROW_MAX.profile + ROW_MAX.waterBody;
    const found: string[] = [];
    let cursor: string | null = null;
    let calls = 0;
    for (; calls < 20; calls++) {
      const page: {
        candidates: { requestId: string }[];
        read: number;
        isDone: boolean;
        continueCursor: string;
      } = await t.mutation(internal.corpusRequests.backfillOrigin, { cursor, budgetBytes: oneRow });
      expect(page.read).toBeLessThanOrEqual(1);
      found.push(...page.candidates.map((c) => c.requestId));
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    // Six rows, one a call; a call stops before reading a row it can't start, so the seventh reads
    // none and finds the end.
    expect(calls + 1).toBe(7);
    expect(found).toHaveLength(2);
  });

  test('paged: a page of one row walks the table to the same candidates', async () => {
    const t = harness();
    await seed(t);
    const found: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const page: { candidates: { requestId: string }[]; isDone: boolean; continueCursor: string } =
        await t.mutation(internal.corpusRequests.backfillOrigin, { cursor, pageCap: 1 });
      found.push(...page.candidates.map((c) => c.requestId));
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    expect(found).toHaveLength(2);
  });
});

describe('a seed-origin ask stays decidable by any staffer with the capability (the D289 exemption)', () => {
  test('its own staff requester declines one, and approves another from a drawn bay', async () => {
    const t = harness();
    const { lake, staff, rows } = await seed(t);
    await t.mutation(internal.corpusRequests.backfillOrigin, { apply: true });
    const asStaff = t.withIdentity({ subject: 'staff' });
    await asStaff.mutation(api.corpusRequests.decline, {
      requestId: rows.staffPlace,
      note: 'not a bay',
    });
    await t.run((ctx) =>
      ctx.db.insert('waterBodySubAreas', {
        waterBodyId: lake,
        name: 'NW Bay',
        searchText: 'NW Bay',
        polygon: {
          type: 'Polygon',
          coordinates: [
            [
              [0.8, 0.8],
              [0.8, 0.95],
              [0.95, 0.95],
              [0.95, 0.8],
              [0.8, 0.8],
            ],
          ],
        },
        bbox: { minLat: 0.8, minLng: 0.8, maxLat: 0.95, maxLng: 0.95 },
        centroid: { lat: 0.875, lng: 0.875 },
        surfaceAreaSqM: 40_000,
        displayScore: 1,
        minVisibleZoom: 10,
        createdByUserId: staff,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await asStaff.mutation(api.corpusRequests.approve, { requestId: rows.aliased });
    const decided = await t.run(async (ctx) => [
      await ctx.db.get(rows.staffPlace),
      await ctx.db.get(rows.aliased),
    ]);
    expect(decided.map((r) => r?.status)).toEqual(['declined', 'approved']);
    // Neither filed an item, before or after.
    const members = await t.run((ctx) => ctx.db.query('inboxItemMembers').collect());
    expect(members.some((m) => m.sourceId === rows.aliased || m.sourceId === rows.staffPlace)).toBe(
      false,
    );
  });
});
