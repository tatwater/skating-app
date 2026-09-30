import { MAX_OPEN_LANDMARK_REQUESTS_PER_USER } from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

/**
 * A report naming a landmark, and a report naming a spot no map has (D202): the landmark id is
 * checked against the body and counted; the typed name becomes a `name_landmark` proposal that a
 * moderator answers from the lake editor.
 */

const modules = import.meta.glob('./**/*.*s');
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const SKATE_TIME = Date.UTC(2026, 0, 10);
const OBSERVED = { suitability: 'experienced_only' as const, surfaceTags: ['glass' as const] };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

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

async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  role: 'member' | 'moderator' = 'member',
) {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

const POLYGON = {
  type: 'Polygon' as const,
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

async function seedBody(t: ReturnType<typeof convexTest>, externalId: string) {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        externalId,
        osmId: externalId,
        name: `Lake ${externalId}`,
        type: 'lakePond',
        polygon: POLYGON,
        bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
        centroid: { lat: 0.5, lng: 0.5 },
        surfaceAreaSqM: 1_000_000,
      },
    ],
  });
  const body = (await t.run((ctx) => ctx.db.query('waterBodies').collect())).find(
    (b) => b.externalId === externalId,
  );
  if (!body) throw new Error('seed failed');
  return body._id;
}

async function seedLandmark(
  t: ReturnType<typeof convexTest>,
  waterBodyId: Id<'waterBodies'>,
  name: string,
  extra: { removed?: boolean } = {},
) {
  return t.run((ctx) =>
    ctx.db.insert('bodyLandmarks', {
      waterBodyId,
      name,
      kind: 'island',
      point: { lat: 0.5, lng: 0.5 },
      source: 'osm',
      externalIds: [],
      aliases: [],
      createdAt: 0,
      updatedAt: 0,
      ...(extra.removed ? { removedAt: 1 } : {}),
    }),
  );
}

const at = { lat: 0.4, lng: 0.4 };

function located(point: { name?: string; landmarkId?: string }) {
  return { coord: at, radiusMeters: 75, ...point };
}

async function requests(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) => ctx.db.query('waterBodyRequests').collect());
}

describe('a report that names a landmark', () => {
  test('keeps the id and the name, and counts each report once', async () => {
    const t = convexTest(schema, modules);
    const lake = await seedBody(t, 'osm/1');
    const apple = await seedLandmark(t, lake, 'Apple Island');
    const { as } = await seedUser(t, 'skater');
    const post = () =>
      as.mutation(api.reports.create, {
        ...OBSERVED,
        waterBodyId: lake,
        skateEndTime: SKATE_TIME,
        // Named twice in one report: counted once.
        iceTypes: [
          {
            type: 'black_ice',
            where: { point: located({ name: 'Apple Island', landmarkId: apple }) },
          },
          {
            type: 'shell_ice',
            where: { point: located({ name: 'Apple Island', landmarkId: apple }) },
          },
        ],
      });
    const reportId = await post();
    const report = await t.run((ctx) => ctx.db.get(reportId));
    expect(report?.iceTypes[0]?.where?.point).toMatchObject({
      name: 'Apple Island',
      landmarkId: apple,
    });
    expect((await t.run((ctx) => ctx.db.get(apple)))?.reportCount).toBe(1);
    await post();
    expect((await t.run((ctx) => ctx.db.get(apple)))?.reportCount).toBe(2);
    // A known landmark is not a proposal.
    expect(await requests(t)).toHaveLength(0);
  });

  test('another lake’s landmark, a removed one, or a string that is no id keeps the words and loses the id', async () => {
    const t = convexTest(schema, modules);
    const lake = await seedBody(t, 'osm/1');
    const other = await seedBody(t, 'osm/2');
    const foreign = await seedLandmark(t, other, 'Gull Rock');
    const gone = await seedLandmark(t, lake, 'Old Pier', { removed: true });
    const { as } = await seedUser(t, 'skater');
    for (const landmarkId of [foreign, gone, 'not-an-id']) {
      const reportId = await as.mutation(api.reports.create, {
        ...OBSERVED,
        waterBodyId: lake,
        skateEndTime: SKATE_TIME,
        iceTypes: [
          { type: 'black_ice', where: { point: located({ name: 'Old Pier', landmarkId }) } },
        ],
      });
      const report = await t.run((ctx) => ctx.db.get(reportId));
      expect(report?.iceTypes[0]?.where?.point).toEqual(located({ name: 'Old Pier' }));
    }
    expect((await t.run((ctx) => ctx.db.get(foreign)))?.reportCount).toBeUndefined();
  });

  test('a landmark’s id carries its own name, whatever the client sent', async () => {
    const t = convexTest(schema, modules);
    const lake = await seedBody(t, 'osm/1');
    const apple = await seedLandmark(t, lake, 'Apple Island');
    const { as } = await seedUser(t, 'skater');
    const reportId = await as.mutation(api.reports.create, {
      ...OBSERVED,
      waterBodyId: lake,
      skateEndTime: SKATE_TIME,
      iceTypes: [
        {
          type: 'black_ice',
          where: { point: located({ name: 'anything at all', landmarkId: apple }) },
        },
      ],
    });
    const report = await t.run((ctx) => ctx.db.get(reportId));
    expect(report?.iceTypes[0]?.where?.point?.name).toBe('Apple Island');
    // …and no proposal for the words it replaced.
    expect(await requests(t)).toHaveLength(0);
  });

  test('an edit never counts toward a landmark’s prominence, however often it re-adds one', async () => {
    const t = convexTest(schema, modules);
    const lake = await seedBody(t, 'osm/1');
    const apple = await seedLandmark(t, lake, 'Apple Island');
    const { as } = await seedUser(t, 'skater');
    const reportId = await as.mutation(api.reports.create, {
      ...OBSERVED,
      waterBodyId: lake,
      skateEndTime: SKATE_TIME,
      iceTypes: [{ type: 'black_ice' }],
    });
    const edit = () =>
      as.mutation(api.reports.update, {
        reportId,
        ...OBSERVED,
        skateEndTime: SKATE_TIME,
        iceTypes: [
          {
            type: 'black_ice',
            where: { point: located({ name: 'Apple Island', landmarkId: apple }) },
          },
        ],
      });
    await edit();
    await edit();
    expect((await t.run((ctx) => ctx.db.get(apple)))?.reportCount).toBeUndefined();
    const report = await t.run((ctx) => ctx.db.get(reportId));
    expect(report?.iceTypes[0]?.where?.point?.landmarkId).toBe(apple);
  });
});

describe('a report that names a spot no map has', () => {
  test('files a proposal with the name, the spot and the report — once per person', async () => {
    const t = convexTest(schema, modules);
    const lake = await seedBody(t, 'osm/1');
    const { id: skater, as } = await seedUser(t, 'skater');
    const post = (name: string) =>
      as.mutation(api.reports.create, {
        ...OBSERVED,
        waterBodyId: lake,
        skateEndTime: SKATE_TIME,
        iceTypes: [{ type: 'black_ice', where: { point: located({ name }) } }],
      });
    const reportId = await post('Bird Poop Rock');
    await post('bird poop rock');
    const rows = await requests(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'name_landmark',
      status: 'open',
      requesterId: skater,
      waterBodyId: lake,
      name: 'Bird Poop Rock',
      coord: at,
      reportId,
    });
  });

  test('one report naming a place two ways files one ask; "the Gut" meets the landmark "Gut"', async () => {
    const t = convexTest(schema, modules);
    const lake = await seedBody(t, 'osm/1');
    await seedLandmark(t, lake, 'Gut');
    const { as } = await seedUser(t, 'skater');
    await as.mutation(api.reports.create, {
      ...OBSERVED,
      waterBodyId: lake,
      skateEndTime: SKATE_TIME,
      iceTypes: [
        { type: 'black_ice', where: { point: located({ name: 'St. Albans Rock' }) } },
        { type: 'shell_ice', where: { point: located({ name: 'Saint Albans rock' }) } },
      ],
      surfaceTags: ['glass'],
      observedFrom: 'shore',
      sightings: [{ type: 'open', where: { point: located({ name: 'the Gut' }) } }],
    });
    expect((await requests(t)).map((r) => r.name)).toEqual(['St. Albans Rock']);
  });

  test('files nothing for a name a landmark or a bay already answers to', async () => {
    const t = convexTest(schema, modules);
    const lake = await seedBody(t, 'osm/1');
    await seedLandmark(t, lake, 'Apple Island');
    const { id: skater, as } = await seedUser(t, 'skater');
    await t.run((ctx) =>
      ctx.db.insert('waterBodySubAreas', {
        waterBodyId: lake,
        name: 'Mud Bay',
        searchText: 'Mud Bay',
        polygon: POLYGON,
        bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
        centroid: { lat: 0.5, lng: 0.5 },
        surfaceAreaSqM: 100_000,
        displayScore: 1,
        minVisibleZoom: 10,
        createdByUserId: skater,
        createdAt: 0,
        updatedAt: 0,
      }),
    );
    await as.mutation(api.reports.create, {
      ...OBSERVED,
      waterBodyId: lake,
      skateEndTime: SKATE_TIME,
      iceTypes: [
        { type: 'black_ice', where: { point: located({ name: 'apple island' }) } },
        { type: 'shell_ice', where: { point: located({ name: 'Mud Bay' }) } },
      ],
    });
    expect(await requests(t)).toHaveLength(0);
  });

  test('stops at the person’s budget, and the report still posts', async () => {
    const t = convexTest(schema, modules);
    const lake = await seedBody(t, 'osm/1');
    const { as } = await seedUser(t, 'skater');
    const names = Array.from(
      { length: MAX_OPEN_LANDMARK_REQUESTS_PER_USER + 2 },
      (_, i) => `Rock ${i}`,
    );
    const reportId = await as.mutation(api.reports.create, {
      ...OBSERVED,
      waterBodyId: lake,
      skateEndTime: SKATE_TIME,
      surfaceTags: names.map(() => 'glass' as const).slice(0, 1),
      iceTypes: [
        { type: 'black_ice', where: { point: located({ name: names[0] }) } },
        { type: 'shell_ice', where: { point: located({ name: names[1] }) } },
      ],
      iceThickness: {
        readings: names.slice(2).map((name) => ({
          method: 'estimated' as const,
          minCm: 5,
          where: { point: located({ name }) },
        })),
      },
    });
    expect(reportId).toBeDefined();
    expect(await requests(t)).toHaveLength(MAX_OPEN_LANDMARK_REQUESTS_PER_USER);
  });

  test('an edit proposes only the names it adds', async () => {
    const t = convexTest(schema, modules);
    const lake = await seedBody(t, 'osm/1');
    const { as } = await seedUser(t, 'skater');
    const reportId = await as.mutation(api.reports.create, {
      ...OBSERVED,
      waterBodyId: lake,
      skateEndTime: SKATE_TIME,
      iceTypes: [{ type: 'black_ice', where: { point: located({ name: 'Bird Poop Rock' }) } }],
    });
    // Declined in the meantime: an edit that keeps the name does not re-file it.
    const [first] = await requests(t);
    if (!first) throw new Error('no proposal filed');
    await t.run((ctx) => ctx.db.patch(first._id, { status: 'declined' }));
    await as.mutation(api.reports.update, {
      reportId,
      ...OBSERVED,
      skateEndTime: SKATE_TIME,
      iceTypes: [
        { type: 'black_ice', where: { point: located({ name: 'Bird Poop Rock' }) } },
        { type: 'shell_ice', where: { point: located({ name: 'Gull Ledge' }) } },
      ],
    });
    const names = (await requests(t)).map((r) => r.name).sort();
    expect(names).toEqual(['Bird Poop Rock', 'Gull Ledge']);
  });

  test('is not a drawer ask — the request lane refuses the kind from a button', async () => {
    const t = convexTest(schema, modules);
    const lake = await seedBody(t, 'osm/1');
    const { as } = await seedUser(t, 'skater');
    await expect(
      as.mutation(api.corpusRequests.create, {
        kind: 'name_landmark',
        coord: at,
        waterBodyId: lake,
      }),
    ).rejects.toThrow();
  });
});

describe('a moderator answering proposals', () => {
  async function twoAsks() {
    const t = convexTest(schema, modules);
    const lake = await seedBody(t, 'osm/1');
    const mod = await seedUser(t, 'mod', 'moderator');
    for (const subject of ['a', 'b']) {
      const { as } = await seedUser(t, subject);
      await as.mutation(api.reports.create, {
        ...OBSERVED,
        waterBodyId: lake,
        skateEndTime: SKATE_TIME,
        iceTypes: [
          {
            type: 'black_ice',
            where: {
              point: located({ name: subject === 'a' ? 'Bird Poop Rock' : 'bird-poop rock' }),
            },
          },
        ],
      });
    }
    // A decision closes the asks that existed when it was made (`openSiblings`'s `asOf`); the
    // clock is frozen here, so move it on as real time would between an ask and its answer.
    vi.setSystemTime(NOW + 60_000);
    return { t, lake, mod };
  }

  test('sees one row per place, with who asked and where', async () => {
    const { lake, mod } = await twoAsks();
    const queue = await mod.as.query(api.corpusRequests.openLandmarkRequestsForBody, {
      waterBodyId: lake,
    });
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ name: 'Bird Poop Rock', askers: 2, coord: at });
    expect(queue[0]?.reportIds).toHaveLength(2);
    expect(queue[0]?.existingLandmarkId).toBeUndefined();
  });

  test('adding the landmark with the ask attached answers everyone who asked', async () => {
    const { t, lake, mod } = await twoAsks();
    const [row] = await mod.as.query(api.corpusRequests.openLandmarkRequestsForBody, {
      waterBodyId: lake,
    });
    if (!row) throw new Error('no queue row');
    const id = await mod.as.mutation(api.landmarks.create, {
      waterBodyId: lake,
      name: row.name,
      kind: 'other',
      point: row.coord,
      requestId: row.requestId,
    });
    expect((await t.run((ctx) => ctx.db.get(id)))?.source).toBe('proposal');
    const rows = await requests(t);
    expect(rows.map((r) => [r.status, r.landmarkId])).toEqual([
      ['approved', id],
      ['approved', id],
    ]);
  });

  test('refuses an answer that does not carry the asked-for name', async () => {
    const { lake, mod } = await twoAsks();
    const [row] = await mod.as.query(api.corpusRequests.openLandmarkRequestsForBody, {
      waterBodyId: lake,
    });
    if (!row) throw new Error('no queue row');
    await expect(
      mod.as.mutation(api.landmarks.create, {
        waterBodyId: lake,
        name: 'Gull Rock',
        kind: 'other',
        point: row.coord,
        requestId: row.requestId,
      }),
    ).rejects.toThrow(/doesn't carry the name that was asked for/);
  });

  test('approving from the queue needs the landmark to exist; declining needs a reason', async () => {
    const { t, lake, mod } = await twoAsks();
    const [row] = await mod.as.query(api.corpusRequests.openLandmarkRequestsForBody, {
      waterBodyId: lake,
    });
    if (!row) throw new Error('no queue row');
    await expect(
      mod.as.mutation(api.corpusRequests.approve, { requestId: row.requestId }),
    ).rejects.toThrow(/add it in the lake editor first/);
    const landmark = await seedLandmark(t, lake, 'Bird Poop Rock');
    const queue = await mod.as.query(api.corpusRequests.openLandmarkRequestsForBody, {
      waterBodyId: lake,
    });
    expect(queue[0]?.existingLandmarkId).toBe(landmark);
    await mod.as.mutation(api.corpusRequests.approve, { requestId: row.requestId });
    expect(
      (await requests(t)).every((r) => r.status === 'approved' && r.landmarkId === landmark),
    ).toBe(true);
  });
});
