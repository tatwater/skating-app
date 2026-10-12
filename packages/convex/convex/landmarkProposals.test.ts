import { MAX_OPEN_LANDMARK_REQUESTS_PER_USER } from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { QUEUE_CAP } from './corpusRequests';
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
  extra: { removed?: boolean; point?: { lat: number; lng: number } } = {},
) {
  return t.run((ctx) =>
    ctx.db.insert('bodyLandmarks', {
      waterBodyId,
      name,
      kind: 'island',
      point: extra.point ?? { lat: 0.5, lng: 0.5 },
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
/** Another spot on the same lake, ~31 km from `at` — another place by any name. */
const far = { lat: 0.6, lng: 0.6 };

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

  test('an open sighting at a landmark pins its circle unless the landmark was chosen by name (Greptile P1 on #84)', async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t, 'skater');
    const label = { lat: 0.5, lng: 0.5 }; // seedLandmark's point
    // One lake per case: touching pins auto-merge, and a hazard does not name its report.
    const post = async (externalId: string, point: { byName?: boolean }, removed = false) => {
      const lake = await seedBody(t, externalId);
      const landmarkId = await seedLandmark(t, lake, 'Apple Island', { removed });
      const reportId = await as.mutation(api.reports.create, {
        ...OBSERVED,
        waterBodyId: lake,
        skateEndTime: SKATE_TIME,
        observedFrom: 'on_ice',
        sightings: [
          {
            type: 'open',
            where: {
              point: { coord: label, radiusMeters: 75, name: 'Apple Island', landmarkId, ...point },
            },
          },
        ],
      });
      const pins = await t.run((ctx) =>
        ctx.db
          .query('hazards')
          .collect()
          .then((rows) => rows.filter((h) => h.waterBodyId === lake).map((h) => h.geometryKind)),
      );
      const report = await t.run((ctx) => ctx.db.get(reportId));
      return { pins, point: report?.sightings?.[0]?.where?.point };
    };
    // A thumb on the label took the landmark's name: still a tap, still a pin.
    expect((await post('osm/1', {})).pins).toEqual(['point_radius']);
    // The chip: the island is land, so nothing — and the choice is kept on the report.
    const chosen = await post('osm/2', { byName: true });
    expect(chosen.pins).toEqual([]);
    expect(chosen.point?.byName).toBe(true);
    // A chip for a landmark removed since: the id goes, the flag with it, and the spot pins.
    const orphan = await post('osm/3', { byName: true }, true);
    expect(orphan.pins).toEqual(['point_radius']);
    expect(orphan.point).not.toHaveProperty('byName');
    expect(orphan.point).not.toHaveProperty('landmarkId');
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
    await seedLandmark(t, lake, 'Gut', { point: at });
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

  test('files nothing for a place a landmark already is, or a name a bay answers to', async () => {
    const t = convexTest(schema, modules);
    const lake = await seedBody(t, 'osm/1');
    await seedLandmark(t, lake, 'Apple Island', { point: at });
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

  test('files the same name at another place — two Long Points are two proposals (Greptile P1 on #84)', async () => {
    const t = convexTest(schema, modules);
    const lake = await seedBody(t, 'osm/1');
    await seedLandmark(t, lake, 'Long Point', { point: far });
    const { as } = await seedUser(t, 'skater');
    const post = (coord: { lat: number; lng: number }) =>
      as.mutation(api.reports.create, {
        ...OBSERVED,
        waterBodyId: lake,
        skateEndTime: SKATE_TIME,
        iceTypes: [
          {
            type: 'black_ice',
            where: { point: { coord, radiusMeters: 75, name: 'Long Point' } },
          },
        ],
      });
    await post(at); // far from the known Long Point: a proposal
    await post({ lat: 0.4005, lng: 0.4 }); // ~56 m on: the same place, already asked
    expect((await requests(t)).map((r) => r.coord)).toEqual([at]);
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
    const { proposals, more } = await mod.as.query(api.corpusRequests.openLandmarkRequestsForBody, {
      waterBodyId: lake,
    });
    expect(more).toBe(false);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ name: 'Bird Poop Rock', askers: 2, coord: at });
    expect(proposals[0]?.reportIds).toHaveLength(2);
    expect(proposals[0]?.existingLandmarkId).toBeUndefined();
  });

  test('adding the landmark with the ask attached answers everyone who asked', async () => {
    const { t, lake, mod } = await twoAsks();
    const {
      proposals: [row],
    } = await mod.as.query(api.corpusRequests.openLandmarkRequestsForBody, { waterBodyId: lake });
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
    const {
      proposals: [row],
    } = await mod.as.query(api.corpusRequests.openLandmarkRequestsForBody, { waterBodyId: lake });
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
    const {
      proposals: [row],
    } = await mod.as.query(api.corpusRequests.openLandmarkRequestsForBody, { waterBodyId: lake });
    if (!row) throw new Error('no queue row');
    await expect(
      mod.as.mutation(api.corpusRequests.approve, { requestId: row.requestId }),
    ).rejects.toThrow(/add it in the lake editor first/);
    // One by that name across the lake answers nobody here.
    await seedLandmark(t, lake, 'Bird Poop Rock', { point: far });
    await expect(
      mod.as.mutation(api.corpusRequests.approve, { requestId: row.requestId }),
    ).rejects.toThrow(/near that spot/);
    // Two that answer (~220 m off, then at the spot): the nearer is the answer, whatever the order.
    await seedLandmark(t, lake, 'Bird Poop Rock', { point: { lat: 0.402, lng: 0.4 } });
    const landmark = await seedLandmark(t, lake, 'Bird Poop Rock', { point: at });
    const queue = await mod.as.query(api.corpusRequests.openLandmarkRequestsForBody, {
      waterBodyId: lake,
    });
    expect(queue.proposals[0]?.existingLandmarkId).toBe(landmark);
    expect((await mod.as.query(api.corpusRequests.listQueue, {}))[0]?.existingLandmarkId).toBe(
      landmark,
    );
    await mod.as.mutation(api.corpusRequests.approve, { requestId: row.requestId });
    expect(
      (await requests(t)).every((r) => r.status === 'approved' && r.landmarkId === landmark),
    ).toBe(true);
  });
});

describe('two places by one name (Greptile P1 and P2 on #84)', () => {
  /** Open `Long Point` asks written straight to the table — `create` files one per person. */
  async function seedAsks(
    t: ReturnType<typeof convexTest>,
    lake: Id<'waterBodies'>,
    requesterId: Id<'profiles'>,
    coord: { lat: number; lng: number },
    n: number,
  ) {
    return t.run(async (ctx) => {
      const ids: Id<'waterBodyRequests'>[] = [];
      for (let i = 0; i < n; i++) {
        ids.push(
          await ctx.db.insert('waterBodyRequests', {
            kind: 'name_landmark',
            status: 'open',
            requesterId,
            coord,
            waterBodyId: lake,
            name: 'Long Point',
            nameKey: 'long point',
            createdAt: Date.now(),
          }),
        );
      }
      return ids;
    });
  }

  async function lakeWithAsks() {
    const t = convexTest(schema, modules);
    const lake = await seedBody(t, 'osm/1');
    const mod = await seedUser(t, 'mod', 'moderator');
    const skater = await seedUser(t, 'skater');
    return { t, lake, mod, skater };
  }

  const statusesAt = async (t: ReturnType<typeof convexTest>, coord: { lat: number }) =>
    (await requests(t)).filter((r) => r.coord.lat === coord.lat).map((r) => r.status);

  test('are two rows, and adding one answers only the asks for it', async () => {
    const { t, lake, mod, skater } = await lakeWithAsks();
    await seedAsks(t, lake, skater.id, at, 2);
    await seedAsks(t, lake, skater.id, far, 1);
    vi.setSystemTime(NOW + 60_000);
    const { proposals } = await mod.as.query(api.corpusRequests.openLandmarkRequestsForBody, {
      waterBodyId: lake,
    });
    expect(proposals.map((p) => [p.coord, p.askers])).toEqual([
      [at, 2],
      [far, 1],
    ]);
    // The moderator's queue counts askers by place too.
    const queue = await mod.as.query(api.corpusRequests.listQueue, {});
    expect(queue.map((r) => r.askers)).toEqual([2, 2, 1]);

    const near = proposals[0];
    if (!near) throw new Error('no proposal');
    await mod.as.mutation(api.landmarks.create, {
      waterBodyId: lake,
      name: 'Long Point',
      kind: 'point',
      point: near.coord,
      requestId: near.requestId,
    });
    expect(await statusesAt(t, at)).toEqual(['approved', 'approved']);
    expect(await statusesAt(t, far)).toEqual(['open']);
    // The other Long Point is still a question, and the new landmark is not its answer.
    const after = await mod.as.query(api.corpusRequests.openLandmarkRequestsForBody, {
      waterBodyId: lake,
    });
    expect(after.proposals).toHaveLength(1);
    expect(after.proposals[0]).toMatchObject({ coord: far });
    expect(after.proposals[0]?.existingLandmarkId).toBeUndefined();
    expect(
      (await mod.as.query(api.corpusRequests.listQueue, {}))[0]?.existingLandmarkId,
    ).toBeUndefined();
  });

  test('each shows the other as a possible duplicate, and a far landmark by the name too', async () => {
    const { t, lake, mod, skater } = await lakeWithAsks();
    await seedAsks(t, lake, skater.id, at, 1);
    await seedAsks(t, lake, skater.id, far, 1);
    const elsewhere = { lat: 0.2, lng: 0.2 }; // ~31 km from `at`
    const known = await seedLandmark(t, lake, 'Long Point', { point: elsewhere });
    const { proposals } = await mod.as.query(api.corpusRequests.openLandmarkRequestsForBody, {
      waterBodyId: lake,
    });
    expect(proposals[0]).toMatchObject({
      coord: at,
      similarLandmark: { landmarkId: known, name: 'Long Point', point: elsewhere },
      similarProposal: { name: 'Long Point', coord: far, requestId: proposals[1]?.requestId },
    });
    expect(proposals[0]?.similarProposal?.meters).toBeGreaterThan(30_000);
    // The queue page says the same of each row.
    const queue = await mod.as.query(api.corpusRequests.listQueue, {});
    expect(queue[0]).toMatchObject({
      similarLandmark: { landmarkId: known },
      similarProposal: { coord: far },
    });
  });

  test('another proposal is a possible duplicate by any of its spellings, both ways', async () => {
    const { t, lake, mod, skater } = await lakeWithAsks();
    await seedAsks(t, lake, skater.id, at, 1);
    // Filed under another name, with this one as a spelling.
    await t.run((ctx) =>
      ctx.db.insert('waterBodyRequests', {
        kind: 'name_landmark',
        status: 'open',
        requesterId: skater.id,
        coord: far,
        waterBodyId: lake,
        name: 'Pointe Longue',
        aliases: ['Long Point'],
        nameKey: 'pointe longue',
        createdAt: Date.now(),
      }),
    );
    const { proposals } = await mod.as.query(api.corpusRequests.openLandmarkRequestsForBody, {
      waterBodyId: lake,
    });
    expect(proposals.map((p) => p.similarProposal?.name)).toEqual(['Pointe Longue', 'Long Point']);
    const queue = await mod.as.query(api.corpusRequests.listQueue, {});
    expect(queue.map((r) => r.similarProposal?.name)).toEqual(['Pointe Longue', 'Long Point']);
  });

  test('a moderator can say a far proposal is a landmark already there — by its name only', async () => {
    const { t, lake, mod, skater } = await lakeWithAsks();
    const [ask] = await seedAsks(t, lake, skater.id, at, 1);
    if (!ask) throw new Error('no ask');
    const known = await seedLandmark(t, lake, 'Long Point', { point: far });
    const cedar = await seedLandmark(t, lake, 'Cedar Island', { point: far });
    const other = await seedLandmark(t, await seedBody(t, 'osm/2'), 'Long Point', { point: at });
    const gone = await seedLandmark(t, lake, 'Long Point', { point: far, removed: true });
    vi.setSystemTime(NOW + 60_000);
    // Without the moderator's word, a landmark that far answers nothing.
    await expect(mod.as.mutation(api.corpusRequests.approve, { requestId: ask })).rejects.toThrow(
      /near that spot/,
    );
    await expect(
      mod.as.mutation(api.corpusRequests.approve, { requestId: ask, landmarkId: cedar }),
    ).rejects.toThrow(/doesn't carry the name/);
    await expect(
      mod.as.mutation(api.corpusRequests.approve, { requestId: ask, landmarkId: other }),
    ).rejects.toThrow(/not on this lake/);
    // Taken off the map since the row was drawn: said so, not "not on this lake".
    await expect(
      mod.as.mutation(api.corpusRequests.approve, { requestId: ask, landmarkId: gone }),
    ).rejects.toThrow(/taken off the map/);
    await mod.as.mutation(api.corpusRequests.approve, { requestId: ask, landmarkId: known });
    expect(await t.run((ctx) => ctx.db.get(ask))).toMatchObject({
      status: 'approved',
      landmarkId: known,
    });
  });

  test('only a landmark request takes a landmark as its answer', async () => {
    const { t, lake, mod, skater } = await lakeWithAsks();
    const landmark = await seedLandmark(t, lake, 'Long Point', { point: at });
    const activate = await t.run((ctx) =>
      ctx.db.insert('waterBodyRequests', {
        kind: 'activate',
        status: 'open',
        requesterId: skater.id,
        coord: at,
        waterBodyId: lake,
        createdAt: Date.now(),
      }),
    );
    await expect(
      mod.as.mutation(api.corpusRequests.approve, { requestId: activate, landmarkId: landmark }),
    ).rejects.toThrow(/Only a landmark request/);
  });

  test('reviewState says what became of a review, and who did it', async () => {
    const { t, lake, mod, skater } = await lakeWithAsks();
    const colleague = await seedUser(t, 'colleague', 'moderator');
    const [a] = await seedAsks(t, lake, skater.id, at, 1);
    const [b] = await seedAsks(t, lake, skater.id, far, 1);
    if (!a || !b) throw new Error('no asks');
    const landmark = await seedLandmark(t, lake, 'Long Point', { point: far });
    vi.setSystemTime(NOW + 60_000);
    const state = () =>
      mod.as.query(api.corpusRequests.reviewState, { requestIds: [a, b], landmarkId: landmark });
    expect(await state()).toMatchObject({
      requests: [
        { requestId: a, status: 'open' },
        { requestId: b, status: 'open' },
      ],
      landmark: { removed: false, name: 'Long Point', point: far, byMe: false },
    });
    // A colleague declines the other end, and takes the landmark down.
    await colleague.as.mutation(api.corpusRequests.decline, { requestId: b, note: 'Not a place.' });
    await colleague.as.mutation(api.landmarks.remove, { landmarkId: landmark });
    expect(await state()).toMatchObject({
      requests: [
        { requestId: a, status: 'open' },
        { requestId: b, status: 'declined', by: 'colleague', byMe: false },
      ],
      landmark: { removed: true, by: 'colleague', byMe: false },
    });
    // The moderator's own answer reads as theirs, with the landmark that answered it.
    await seedLandmark(t, lake, 'Long Point', { point: at });
    await mod.as.mutation(api.corpusRequests.approve, { requestId: a });
    expect((await state()).requests[0]).toMatchObject({
      status: 'approved',
      by: 'mod',
      byMe: true,
      answeredWith: 'Long Point',
    });
    // A request that no longer exists is gone; a review holds two at most; skaters cannot ask.
    await t.run((ctx) => ctx.db.delete(b));
    expect((await state()).requests[1]).toEqual({ requestId: b, status: 'gone' });
    // A landmark is named only by the act that explains it: a restore says nothing of a move, a
    // colleague's move is theirs, and a catalog drop after it is nobody's.
    await mod.as.mutation(api.landmarks.restore, { landmarkId: landmark });
    expect((await state()).landmark).toEqual({
      removed: false,
      name: 'Long Point',
      point: far,
      byMe: false,
    });
    const moved = { lat: 0.61, lng: 0.6 };
    await colleague.as.mutation(api.landmarks.update, { landmarkId: landmark, point: moved });
    expect((await state()).landmark).toMatchObject({ point: moved, by: 'colleague', byMe: false });
    await t.run((ctx) =>
      ctx.db.patch(landmark, { removedAt: NOW + 120_000, catalogDroppedAt: NOW + 120_000 }),
    );
    expect((await state()).landmark).toEqual({
      removed: true,
      name: 'Long Point',
      point: moved,
      byMe: false,
    });
    await t.run((ctx) => ctx.db.delete(landmark));
    expect((await state()).landmark).toEqual({ removed: true, byMe: false });
    await expect(
      mod.as.query(api.corpusRequests.reviewState, { requestIds: [a, a, a] }),
    ).rejects.toThrow(/at most two/);
    await expect(
      skater.as.query(api.corpusRequests.reviewState, { requestIds: [a] }),
    ).rejects.toThrow();
  });

  test('a decision drains its place past pages full of the other place’s asks', async () => {
    const { t, lake, mod, skater } = await lakeWithAsks();
    // The other place's asks first, so every page the drain reads starts full of rows it leaves.
    await seedAsks(t, lake, skater.id, far, QUEUE_CAP + 20);
    vi.setSystemTime(NOW + 1);
    const [first, ...rest] = await seedAsks(t, lake, skater.id, at, 30);
    if (!first) throw new Error('no ask');
    vi.setSystemTime(NOW + 60_000);
    await mod.as.mutation(api.corpusRequests.decline, { requestId: first, note: 'Not a place.' });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await statusesAt(t, at)).toEqual(Array(rest.length + 1).fill('declined'));
    expect((await statusesAt(t, far)).every((s) => s === 'open')).toBe(true);
  });

  test('a lake past the read says more are waiting', async () => {
    const { t, lake, mod, skater } = await lakeWithAsks();
    await seedAsks(t, lake, skater.id, at, QUEUE_CAP + 1);
    const { proposals, more } = await mod.as.query(api.corpusRequests.openLandmarkRequestsForBody, {
      waterBodyId: lake,
    });
    expect(more).toBe(true);
    expect(proposals[0]?.askers).toBe(QUEUE_CAP);
  });

  test('the queue counts for each row what deciding that row closes, when asks chain (#84 review)', async () => {
    const { t, lake, mod, skater } = await lakeWithAsks();
    // ~700 m apart in a line: A and B are one place, B and C are one place, A and C are not.
    const [a, b, c] = [at, { lat: 0.4063, lng: 0.4 }, { lat: 0.4126, lng: 0.4 }];
    if (!a || !b || !c) throw new Error('no spots');
    await seedAsks(t, lake, skater.id, a, 1);
    vi.setSystemTime(NOW + 1);
    const [middle] = await seedAsks(t, lake, skater.id, b, 1);
    vi.setSystemTime(NOW + 2);
    await seedAsks(t, lake, skater.id, c, 1);
    if (!middle) throw new Error('no ask');
    vi.setSystemTime(NOW + 60_000);
    const queue = await mod.as.query(api.corpusRequests.listQueue, {});
    expect(queue.map((r) => r.askers)).toEqual([2, 3, 2]);
    // B's row said three, and B's decision closes three.
    await mod.as.mutation(api.corpusRequests.decline, { requestId: middle, note: 'Not a place.' });
    expect((await requests(t)).map((r) => r.status)).toEqual(['declined', 'declined', 'declined']);
  });

  test('an edit that moves a named spot to another place by that name proposes it (#84 review)', async () => {
    const { t, lake, skater } = await lakeWithAsks();
    const post = (coord: { lat: number; lng: number }) => ({
      ...OBSERVED,
      skateEndTime: SKATE_TIME,
      iceTypes: [
        {
          type: 'black_ice' as const,
          where: { point: { coord, radiusMeters: 75, name: 'Long Point' } },
        },
      ],
    });
    const reportId = await skater.as.mutation(api.reports.create, {
      ...post(at),
      waterBodyId: lake,
    });
    // A nudge is the same place; the far Long Point is a new one.
    await skater.as.mutation(api.reports.update, { reportId, ...post({ lat: 0.4005, lng: 0.4 }) });
    expect((await requests(t)).map((r) => r.coord)).toEqual([at]);
    await skater.as.mutation(api.reports.update, { reportId, ...post(far) });
    expect((await requests(t)).map((r) => r.coord)).toEqual([at, far]);
  });
});
