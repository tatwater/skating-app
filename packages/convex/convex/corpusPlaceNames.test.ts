import { convexTest } from 'convex-test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

function harness() {
  vi.useFakeTimers();
  return convexTest(schema, modules);
}

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
  t: ReturnType<typeof harness>,
  subject: string,
  role: 'member' | 'moderator' = 'moderator',
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

const RECT = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [-73.5, 44.0],
      [-72.5, 44.0],
      [-72.5, 45.0],
      [-73.5, 45.0],
      [-73.5, 44.0],
    ],
  ],
};

async function seedBody(t: ReturnType<typeof harness>, name: string) {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name,
      searchText: name,
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: RECT,
      bbox: { minLat: 44.0, minLng: -73.5, maxLat: 45.0, maxLng: -72.5 },
      centroid: { lat: 44.5, lng: -73.0 },
      surfaceAreaSqM: 8.7e9,
      states: ['VT'],
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  );
}

function name(
  n: string,
  extra: Partial<{
    messages: number;
    waterBodyId: Id<'waterBodies'>;
    candidateBodyIds: Id<'waterBodies'>[];
    aliases: string[];
    parentName: string;
  }> = {},
) {
  return {
    name: n,
    aliases: extra.aliases ?? [],
    messages: extra.messages ?? 1,
    skatedMessages: 0,
    states: ['VT'],
    ...(extra.parentName ? { parentName: extra.parentName } : {}),
    ...(extra.waterBodyId ? { waterBodyId: extra.waterBodyId } : {}),
    ...(extra.candidateBodyIds ? { candidateBodyIds: extra.candidateBodyIds } : {}),
  };
}

async function load(
  t: ReturnType<typeof harness>,
  names: ReturnType<typeof name>[],
  dryRun = false,
) {
  return t.mutation(internal.corpusPlaceNames.importBatch, { names, dryRun });
}

describe('corpusPlaceNames.importBatch', () => {
  test('is dry unless told, loads open rows, refreshes open ones and holds decided ones', async () => {
    const t = harness();
    const lake = await seedBody(t, 'Lake Champlain');
    const mod = await seedUser(t, 'mod');
    const first = [
      name('Apple Island', { messages: 24, waterBodyId: lake, parentName: 'Lake Champlain' }),
      name('Baltic Sea', { messages: 5 }),
    ];
    expect(await load(t, first, true)).toMatchObject({ created: 2 });
    expect(await load(t, first)).toMatchObject({ created: 2 });
    const { rows } = await mod.as.query(api.corpusPlaceNames.listQueue, {});
    const baltic = rows.find((r) => r.name === 'Baltic Sea');
    if (!baltic) throw new Error('not loaded');
    await mod.as.mutation(api.corpusPlaceNames.dismiss, {
      id: baltic._id,
      reason: 'outside_region',
    });
    const again = await load(t, [
      name('Apple Island', { messages: 30, waterBodyId: lake, parentName: 'Lake Champlain' }),
      name('Baltic Sea', { messages: 9 }),
    ]);
    expect(again).toEqual({ created: 0, refreshed: 1, unchanged: 0, decidedHeld: 1, duplicate: 0 });
    expect(await load(t, [name('   ')])).toMatchObject({ created: 0 });
  });

  test('drops a lake no longer on the map, and keeps the name for a person to place', async () => {
    const t = harness();
    const gone = await seedBody(t, 'Gone Pond');
    await t.run((ctx) => ctx.db.delete(gone));
    const merged = await seedBody(t, 'Merged Pond');
    await t.run((ctx) => ctx.db.patch(merged, { dedupStatus: 'merged' }));
    const lake = await seedBody(t, 'Long Pond');
    await load(t, [
      name('Big Rock', { waterBodyId: merged, candidateBodyIds: [gone, merged, lake] }),
    ]);
    const [row] = await t.run((ctx) => ctx.db.query('corpusPlaceNames').collect());
    expect(row?.waterBodyId).toBeUndefined();
    expect(row?.candidateBodyIds).toEqual([lake]);
    expect(row?.candidateLabels).toEqual(['Long Pond · VT']);
  });

  test('keeps the first of two names that fold alike in one load, and says so', async () => {
    const t = harness();
    const counts = await load(t, [
      name('St. Albans Rock', { messages: 5 }),
      name('Saint Albans rock', { messages: 2 }),
    ]);
    expect(counts).toMatchObject({ created: 1, duplicate: 1 });
    const rows = await t.run((ctx) => ctx.db.query('corpusPlaceNames').collect());
    expect(rows.map((r) => [r.name, r.messages])).toEqual([['St. Albans Rock', 5]]);
  });

  test('a lake a moderator gave stays given, and a re-load finds the row by the corpus’s key', async () => {
    const t = harness();
    const lake = await seedBody(t, 'Lake Champlain');
    const mod = await seedUser(t, 'mod');
    await load(t, [name('Hero’s Welcome', { messages: 12 })]);
    const [row] = (await mod.as.query(api.corpusPlaceNames.listQueue, {})).rows;
    if (!row) throw new Error('not loaded');
    await mod.as.mutation(api.corpusPlaceNames.setLake, { id: row._id, waterBodyId: lake });
    const again = await load(t, [name('Hero’s Welcome', { messages: 13 })]);
    expect(again).toMatchObject({ created: 0, refreshed: 1 });
    const rows = await t.run((ctx) => ctx.db.query('corpusPlaceNames').collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      waterBodyId: lake,
      lakeLabel: 'Lake Champlain · VT',
      messages: 13,
    });
  });

  test('stamps the campaign on a name the run carries unchanged', async () => {
    const t = harness();
    await t.mutation(internal.corpusPlaceNames.importBatch, {
      names: [name('Gull Ledge')],
      campaignId: 'first',
      dryRun: false,
    });
    const counts = await t.mutation(internal.corpusPlaceNames.importBatch, {
      names: [name('Gull Ledge')],
      campaignId: 'second',
      dryRun: false,
    });
    expect(counts).toMatchObject({ unchanged: 1 });
    const [row] = await t.run((ctx) => ctx.db.query('corpusPlaceNames').collect());
    expect(row?.lastCampaignId).toBe('second');
  });
});

describe('the triage page', () => {
  test('lists the most mentioned first, with lakes by name, and hides the long tail on request', async () => {
    const t = harness();
    const lake = await seedBody(t, 'Lake Champlain');
    const other = await seedBody(t, 'Lake George');
    const mod = await seedUser(t, 'mod');
    await load(t, [
      name('Apple Island', { messages: 24, waterBodyId: lake }),
      name('Long Point', { messages: 3, candidateBodyIds: [lake, other] }),
      name('Once Rock', { messages: 1 }),
    ]);
    const all = await mod.as.query(api.corpusPlaceNames.listQueue, {});
    expect(all.rows.map((r) => r.name)).toEqual(['Apple Island', 'Long Point', 'Once Rock']);
    expect(all.rows[0]?.lake?.label).toBe('Lake Champlain · VT');
    expect(all.rows[1]?.candidates.map((c) => c.label)).toEqual([
      'Lake Champlain · VT',
      'Lake George · VT',
    ]);
    const busy = await mod.as.query(api.corpusPlaceNames.listQueue, { minMessages: 2 });
    expect(busy.rows.map((r) => r.name)).toEqual(['Apple Island', 'Long Point']);
  });

  test('is a moderator’s', async () => {
    const t = harness();
    const member = await seedUser(t, 'member', 'member');
    await expect(member.as.query(api.corpusPlaceNames.listQueue, {})).rejects.toThrow(/moderator/i);
  });

  test('picks a lake, dismisses with a reason, and reopens — each audited', async () => {
    const t = harness();
    const lake = await seedBody(t, 'Lake Champlain');
    const mod = await seedUser(t, 'mod');
    await load(t, [name('Hero’s Welcome', { messages: 12 })]);
    const [row] = (await mod.as.query(api.corpusPlaceNames.listQueue, {})).rows;
    if (!row) throw new Error('not loaded');
    await mod.as.mutation(api.corpusPlaceNames.setLake, { id: row._id, waterBodyId: lake });
    const onLake = await mod.as.query(api.corpusPlaceNames.openForBody, { waterBodyId: lake });
    expect(onLake.map((r) => r.name)).toEqual(['Hero’s Welcome']);

    await mod.as.mutation(api.corpusPlaceNames.dismiss, {
      id: row._id,
      reason: 'not_a_place',
      note: '  a store, not a spot on the ice ',
    });
    await expect(
      mod.as.mutation(api.corpusPlaceNames.setLake, { id: row._id, waterBodyId: lake }),
    ).rejects.toThrow(/already been decided/);
    const dismissed = await mod.as.query(api.corpusPlaceNames.listQueue, { status: 'dismissed' });
    expect(dismissed.rows[0]).toMatchObject({
      dismissReason: 'not_a_place',
      dismissNote: 'a store, not a spot on the ice',
    });
    await mod.as.mutation(api.corpusPlaceNames.reopen, { id: row._id });
    await expect(mod.as.mutation(api.corpusPlaceNames.reopen, { id: row._id })).rejects.toThrow(
      /Only a dismissed name/,
    );
    const audits = await t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_target', (q) =>
          q.eq('targetType', 'corpusPlaceName').eq('targetId', row._id as string),
        )
        .collect(),
    );
    expect(audits.map((a) => a.action)).toEqual(['remove', 'restore']);
    expect(audits[0]?.reason).toBe(
      'Dismissed "Hero’s Welcome": not_a_place — a store, not a spot on the ice',
    );
    expect(audits[0]?.metadata).toMatchObject({ reason: 'not_a_place' });
  });

  test('refuses a lake that is not on the map', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod');
    const merged = await t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        name: 'Merged Pond',
        searchText: 'Merged Pond',
        type: 'lakePond' as const,
        source: 'osm' as const,
        polygon: RECT,
        bbox: { minLat: 44.0, minLng: -73.5, maxLat: 45.0, maxLng: -72.5 },
        centroid: { lat: 44.5, lng: -73.0 },
        surfaceAreaSqM: 1,
        dedupStatus: 'merged' as const,
        createdAt: Date.now(),
      }),
    );
    await load(t, [name('Big Rock')]);
    const [row] = (await mod.as.query(api.corpusPlaceNames.listQueue, {})).rows;
    if (!row) throw new Error('not loaded');
    await expect(
      mod.as.mutation(api.corpusPlaceNames.setLake, { id: row._id, waterBodyId: merged }),
    ).rejects.toThrow(/not on the map/);
  });
});

describe('placing a name', () => {
  test('dropping a landmark for it places it, and carries its count to the landmark', async () => {
    const t = harness();
    const lake = await seedBody(t, 'Lake Champlain');
    const other = await seedBody(t, 'Lake George');
    const mod = await seedUser(t, 'mod');
    await load(t, [name('Apple Island', { messages: 24, waterBodyId: lake })]);
    const [row] = await mod.as.query(api.corpusPlaceNames.openForBody, { waterBodyId: lake });
    if (!row) throw new Error('not loaded');
    // Not on another lake:
    await expect(
      mod.as.mutation(api.landmarks.create, {
        waterBodyId: other,
        name: 'Apple Island',
        kind: 'point',
        point: { lat: 44.6, lng: -73.3 },
        corpusNameId: row._id,
      }),
    ).rejects.toThrow(/waiting on another lake/);
    const landmarkId = await mod.as.mutation(api.landmarks.create, {
      waterBodyId: lake,
      name: 'Apple Island',
      kind: 'point',
      point: { lat: 44.6, lng: -73.3 },
      corpusNameId: row._id,
    });
    expect(await t.run((ctx) => ctx.db.get(landmarkId))).toMatchObject({
      corpusMessages: 24,
      source: 'corpus',
    });
    const stored = await t.run((ctx) => ctx.db.get(row._id));
    expect(stored).toMatchObject({ status: 'placed', landmarkId });
    expect(await mod.as.query(api.corpusPlaceNames.openForBody, { waterBodyId: lake })).toEqual([]);
    await expect(
      mod.as.mutation(api.landmarks.create, {
        waterBodyId: lake,
        name: 'Apple Island Two',
        kind: 'point',
        point: { lat: 44.2, lng: -73.1 },
        corpusNameId: row._id,
      }),
    ).rejects.toThrow(/already been placed or dismissed/);
  });

  test('filing it as another spelling of a landmark already there', async () => {
    const t = harness();
    const lake = await seedBody(t, 'Lake Champlain');
    const other = await seedBody(t, 'Lake George');
    const mod = await seedUser(t, 'mod');
    const isle = await mod.as.mutation(api.landmarks.create, {
      waterBodyId: lake,
      name: 'Isle La Motte',
      kind: 'island',
      point: { lat: 44.9, lng: -73.3 },
    });
    const elsewhere = await mod.as.mutation(api.landmarks.create, {
      waterBodyId: other,
      name: 'Elsewhere Island',
      kind: 'island',
      point: { lat: 44.9, lng: -73.3 },
    });
    await load(t, [
      name('Isle LaMotte', { messages: 4, waterBodyId: lake, aliases: ['Isle of La Motte'] }),
    ]);
    const [row] = await mod.as.query(api.corpusPlaceNames.openForBody, { waterBodyId: lake });
    if (!row) throw new Error('not loaded');
    await expect(
      mod.as.mutation(api.corpusPlaceNames.fileAsSpelling, { id: row._id, landmarkId: elsewhere }),
    ).rejects.toThrow(/another lake/);
    await mod.as.mutation(api.corpusPlaceNames.fileAsSpelling, { id: row._id, landmarkId: isle });
    const landmark = await t.run((ctx) => ctx.db.get(isle));
    expect(landmark?.aliases).toEqual(['Isle LaMotte', 'Isle of La Motte']);
    expect(landmark?.corpusMessages).toBe(4);
    expect((await t.run((ctx) => ctx.db.get(row._id)))?.status).toBe('placed');
  });

  test('refuses a spelling a bay answers to, or one a full landmark cannot keep', async () => {
    const t = harness();
    const lake = await seedBody(t, 'Lake Champlain');
    const mod = await seedUser(t, 'mod');
    await mod.as.mutation(api.subAreas.create, {
      waterBodyId: lake,
      name: 'Kingsland Bay',
      polygon: {
        type: 'Polygon',
        coordinates: [
          [
            [-73.4, 44.1],
            [-73.2, 44.1],
            [-73.2, 44.3],
            [-73.4, 44.3],
            [-73.4, 44.1],
          ],
        ],
      },
    });
    const point = await mod.as.mutation(api.landmarks.create, {
      waterBodyId: lake,
      name: 'Hawkins Point',
      kind: 'point',
      point: { lat: 44.2, lng: -73.3 },
      aliases: Array.from({ length: 12 }, (_, i) => `Hawkins Spelling ${i}`),
    });
    await load(t, [
      name('Kingsland Bay', { waterBodyId: lake }),
      name('The Hawk', { waterBodyId: lake }),
    ]);
    const open = await mod.as.query(api.corpusPlaceNames.openForBody, { waterBodyId: lake });
    const bay = open.find((r) => r.name === 'Kingsland Bay');
    const hawk = open.find((r) => r.name === 'The Hawk');
    if (!bay || !hawk) throw new Error('not loaded');
    await expect(
      mod.as.mutation(api.corpusPlaceNames.fileAsSpelling, { id: hawk._id, landmarkId: point }),
    ).rejects.toThrow(/as many spellings/);
    await mod.as.mutation(api.landmarks.update, { landmarkId: point, aliases: [] });
    await expect(
      mod.as.mutation(api.corpusPlaceNames.fileAsSpelling, { id: bay._id, landmarkId: point }),
    ).rejects.toThrow(/is a bay on this lake/);
    expect((await t.run((ctx) => ctx.db.get(bay._id)))?.status).toBe('open');
  });

  test('a name already on the map, unsure which, loads as such', async () => {
    const t = harness();
    const lake = await seedBody(t, 'Lake Champlain');
    const mod = await seedUser(t, 'mod');
    await t.mutation(internal.corpusPlaceNames.importBatch, {
      names: [{ ...name('Cedar Island', { waterBodyId: lake }), alreadyNamed: true }],
      dryRun: false,
    });
    const [row] = await mod.as.query(api.corpusPlaceNames.openForBody, { waterBodyId: lake });
    expect(row).toMatchObject({ name: 'Cedar Island', alreadyNamed: true });
  });

  test('refuses a removed landmark, and a name already decided', async () => {
    const t = harness();
    const lake = await seedBody(t, 'Lake Champlain');
    const mod = await seedUser(t, 'mod');
    const gone = await mod.as.mutation(api.landmarks.create, {
      waterBodyId: lake,
      name: 'Old Pier',
      kind: 'other',
      point: { lat: 44.9, lng: -73.3 },
    });
    await mod.as.mutation(api.landmarks.remove, { landmarkId: gone });
    await load(t, [name('The Old Pier', { waterBodyId: lake })]);
    const [row] = await mod.as.query(api.corpusPlaceNames.openForBody, { waterBodyId: lake });
    if (!row) throw new Error('not loaded');
    await expect(
      mod.as.mutation(api.corpusPlaceNames.fileAsSpelling, { id: row._id, landmarkId: gone }),
    ).rejects.toThrow(/no longer on the map/);
    await mod.as.mutation(api.corpusPlaceNames.dismiss, { id: row._id, reason: 'other' });
    await expect(
      mod.as.mutation(api.corpusPlaceNames.dismiss, { id: row._id, reason: 'other' }),
    ).rejects.toThrow(/already been decided/);
  });
});
