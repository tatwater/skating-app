import { MAX_LANDMARKS_PER_BODY } from '@skating/core';
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
  t: ReturnType<typeof convexTest>,
  subject: string,
  role: 'member' | 'moderator' | 'admin' = 'member',
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

function rect(minLng: number, minLat: number, maxLng: number, maxLat: number) {
  return [
    [minLng, minLat],
    [maxLng, minLat],
    [maxLng, maxLat],
    [minLng, maxLat],
    [minLng, minLat],
  ];
}

/** A stand-in lake with one island (a hole) in its northeast corner. */
const LAKE = {
  type: 'Polygon' as const,
  coordinates: [rect(-73.5, 44.0, -72.5, 45.0), rect(-72.8, 44.7, -72.7, 44.8)],
};
const ISLAND = { lat: 44.75, lng: -72.75 };

async function seedBody(
  t: ReturnType<typeof convexTest>,
  extra: { dedupStatus?: 'clean' | 'merged' } = {},
) {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Lake Champlain',
      searchText: 'Lake Champlain',
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: LAKE,
      bbox: { minLat: 44.0, minLng: -73.5, maxLat: 45.0, maxLng: -72.5 },
      centroid: { lat: 44.5, lng: -73.0 },
      surfaceAreaSqM: 8.7e9,
      dedupStatus: extra.dedupStatus ?? ('clean' as const),
      createdAt: Date.now(),
    }),
  );
}

async function settle(t: ReturnType<typeof convexTest>) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

function imported(
  name: string,
  point: { lat: number; lng: number },
  extra: Partial<{
    kind: 'island' | 'point' | 'bay' | 'other';
    externalIds: string[];
    aliases: string[];
    corpusMessages: number;
    areaSqM: number;
    source: 'osm' | 'gnis';
  }> = {},
) {
  return {
    name,
    kind: extra.kind ?? ('island' as const),
    point,
    source: extra.source ?? ('osm' as const),
    externalIds: extra.externalIds ?? [`osm:node/${name.length}`],
    aliases: extra.aliases ?? [],
    ...(extra.corpusMessages !== undefined ? { corpusMessages: extra.corpusMessages } : {}),
    ...(extra.areaSqM !== undefined ? { areaSqM: extra.areaSqM } : {}),
  };
}

/** One body through the batch import — the shape every test here wants. */
function importFor(
  t: ReturnType<typeof harness>,
  args: {
    waterBodyId: Id<'waterBodies'>;
    landmarks: ReturnType<typeof imported>[];
    campaignId?: string;
    dryRun?: boolean;
  },
) {
  const { waterBodyId, landmarks, ...rest } = args;
  return t.mutation(internal.landmarks.importBatch, {
    bodies: [{ waterBodyId, landmarks }],
    ...rest,
  });
}

async function rowsOf(t: ReturnType<typeof harness>, waterBodyId: Id<'waterBodies'>) {
  return t.run((ctx) =>
    ctx.db
      .query('bodyLandmarks')
      .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
      .collect(),
  );
}

describe('landmarks.importBatch', () => {
  test('is dry unless told otherwise, and says what it would have done', async () => {
    const t = harness();
    const body = await seedBody(t);
    const counts = await importFor(t, {
      waterBodyId: body,
      landmarks: [imported('Apple Island', ISLAND)],
    });
    expect(counts.created).toBe(1);
    expect(await rowsOf(t, body)).toHaveLength(0);
  });

  test('writes once, and a re-run changes nothing', async () => {
    const t = harness();
    const body = await seedBody(t);
    const args = {
      waterBodyId: body,
      landmarks: [
        imported('Apple Island', ISLAND, { externalIds: ['osm:way/1'], corpusMessages: 3 }),
      ],
      campaignId: 'landmarks-test',
      dryRun: false,
    };
    expect((await importFor(t, args)).created).toBe(1);
    const again = await importFor(t, args);
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    const [row] = await rowsOf(t, body);
    expect(row).toMatchObject({
      name: 'Apple Island',
      source: 'osm',
      lastCampaignId: 'landmarks-test',
    });
  });

  test('an OSM island and its GNIS twin become one row carrying both ids', async () => {
    const t = harness();
    const body = await seedBody(t);
    await importFor(t, {
      waterBodyId: body,
      landmarks: [
        imported('Apple Island', ISLAND, { externalIds: ['osm:way/1'], areaSqM: 200_000 }),
        imported(
          'Apple Is',
          { lat: 44.752, lng: -72.751 },
          {
            externalIds: ['gnis:42'],
            source: 'gnis',
            aliases: ['Apple Island'],
          },
        ),
      ],
      dryRun: false,
    });
    const rows = await rowsOf(t, body);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalIds.sort()).toEqual(['gnis:42', 'osm:way/1']);
  });

  test('two candidates for one row settle on the first, so a re-run reports nothing changed', async () => {
    const t = harness();
    const body = await seedBody(t);
    const args = {
      waterBodyId: body,
      landmarks: [
        imported(
          'The Gut',
          { lat: 44.3, lng: -73.2 },
          { kind: 'other', externalIds: ['osm:way/1'] },
        ),
        imported(
          'The Gut',
          { lat: 44.305, lng: -73.2 },
          { kind: 'other', externalIds: ['gnis:1'] },
        ),
      ],
    };
    // The dry run counts the pair as the one row an apply writes.
    expect((await importFor(t, args)).created).toBe(1);
    await importFor(t, { ...args, dryRun: false });
    const again = await importFor(t, { ...args, dryRun: false });
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    const [row] = await rowsOf(t, body);
    expect(row?.point).toEqual({ lat: 44.3, lng: -73.2 });
    expect(row?.externalIds.sort()).toEqual(['gnis:1', 'osm:way/1']);
  });

  test('a spelling a later run drops leaves a catalog row, but never a moderator’s', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const held = await mod.as.mutation(api.landmarks.create, {
      waterBodyId: body,
      name: 'Gull Rock',
      kind: 'other',
      point: { lat: 44.3, lng: -73.2 },
      aliases: ['the gull'],
    });
    const run = (aliases: string[]) =>
      importFor(t, {
        waterBodyId: body,
        landmarks: [
          imported('Apple Island', ISLAND, { externalIds: ['osm:way/1'], aliases }),
          imported(
            'Gull Rock',
            { lat: 44.3, lng: -73.2 },
            { kind: 'other', externalIds: ['gnis:9'], aliases },
          ),
        ],
        dryRun: false,
      });
    await run(['Lake Champlain (Apple Island)']);
    expect((await run([])).updated).toBe(1);
    const rows = await rowsOf(t, body);
    expect(rows.find((r) => r.name === 'Apple Island')?.aliases).toEqual([]);
    const gull = await t.run((ctx) => ctx.db.get(held));
    expect(gull?.aliases).toEqual(['the gull', 'Lake Champlain (Apple Island)']);
    expect(gull?.externalIds).toEqual(['gnis:9']);
  });

  test('two places with one name, far apart, stay two places', async () => {
    const t = harness();
    const body = await seedBody(t);
    await importFor(t, {
      waterBodyId: body,
      landmarks: [
        imported(
          'Long Point',
          { lat: 44.1, lng: -73.4 },
          { kind: 'point', externalIds: ['gnis:1'] },
        ),
        imported(
          'Long Point',
          { lat: 44.9, lng: -72.6 },
          { kind: 'point', externalIds: ['gnis:2'] },
        ),
      ],
      dryRun: false,
    });
    expect(await rowsOf(t, body)).toHaveLength(2);
  });

  test('never resurrects a removed row, and keeps a moderator’s name while adding the catalog’s', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const kept = await mod.as.mutation(api.landmarks.create, {
      waterBodyId: body,
      name: 'Bird Poop Rock',
      kind: 'other',
      point: { lat: 44.3, lng: -73.2 },
    });
    const gone = await mod.as.mutation(api.landmarks.create, {
      waterBodyId: body,
      name: 'Old Pier',
      kind: 'other',
      point: { lat: 44.2, lng: -73.1 },
    });
    await mod.as.mutation(api.landmarks.remove, { landmarkId: gone });

    const counts = await importFor(t, {
      waterBodyId: body,
      landmarks: [
        imported(
          'Bird Poop Rock',
          { lat: 44.301, lng: -73.2 },
          { kind: 'other', externalIds: ['gnis:7'] },
        ),
        imported(
          'Old Pier',
          { lat: 44.2, lng: -73.1 },
          { kind: 'other', externalIds: ['osm:way/9'] },
        ),
      ],
      dryRun: false,
    });
    expect(counts).toMatchObject({ moderatorHeld: 1, removedHeld: 1, created: 0 });
    const row = await t.run((ctx) => ctx.db.get(kept));
    expect(row).toMatchObject({ name: 'Bird Poop Rock', point: { lat: 44.3, lng: -73.2 } });
    expect(row?.externalIds).toEqual(['gnis:7']);
    expect((await t.run((ctx) => ctx.db.get(gone)))?.removedAt).toBeDefined();
  });

  test('refuses a new row past the per-body cap, bounded at the write', async () => {
    const t = harness();
    const body = await seedBody(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_LANDMARKS_PER_BODY; i++) {
        await ctx.db.insert('bodyLandmarks', {
          waterBodyId: body,
          name: `Rock ${i}`,
          kind: 'other',
          point: { lat: 44.1 + i * 1e-4, lng: -73.3 },
          source: 'gnis',
          externalIds: [`gnis:r${i}`],
          aliases: [],
          createdAt: 0,
          updatedAt: 0,
        });
      }
    });
    const counts = await importFor(t, {
      waterBodyId: body,
      landmarks: [imported('Apple Island', ISLAND)],
      dryRun: false,
    });
    expect(counts.overCap).toBe(1);
  });

  test('skips a body that stopped being listed after the export', async () => {
    const t = harness();
    const body = await seedBody(t, { dedupStatus: 'merged' });
    const counts = await importFor(t, {
      waterBodyId: body,
      landmarks: [imported('Apple Island', ISLAND)],
      dryRun: false,
    });
    expect(counts.bodyNotListed).toBe(1);
    expect(await rowsOf(t, body)).toHaveLength(0);
  });

  test('sums across the bodies of a batch', async () => {
    const t = harness();
    const a = await seedBody(t);
    const b = await seedBody(t);
    const counts = await t.mutation(internal.landmarks.importBatch, {
      bodies: [
        { waterBodyId: a, landmarks: [imported('Apple Island', ISLAND)] },
        {
          waterBodyId: b,
          landmarks: [imported('Gull Island', ISLAND, { externalIds: ['gnis:5'] })],
        },
      ],
      dryRun: false,
    });
    expect(counts.created).toBe(2);
    expect((await rowsOf(t, b)).map((r) => r.name)).toEqual(['Gull Island']);
  });

  test('leaves a name to the bay that already answers to it', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Malletts Bay',
      aliases: ['Mallets Bay'],
      polygon: { type: 'Polygon', coordinates: [rect(-73.4, 44.1, -73.2, 44.3)] },
    });
    const counts = await importFor(t, {
      waterBodyId: body,
      landmarks: [
        imported('Mallets Bay', { lat: 44.2, lng: -73.3 }, { kind: 'bay' }),
        imported('Apple Island', ISLAND),
      ],
      dryRun: false,
    });
    expect(counts).toMatchObject({ alreadyBay: 1, created: 1 });
  });

  test('drops a candidate whose name is empty', async () => {
    const t = harness();
    const body = await seedBody(t);
    const counts = await importFor(t, {
      waterBodyId: body,
      landmarks: [imported('   ', ISLAND)],
      dryRun: false,
    });
    expect(counts.created).toBe(0);
  });
});

describe('landmarks.listForBody', () => {
  test('lists live rows, most prominent first, with a label zoom', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await importFor(t, {
      waterBodyId: body,
      landmarks: [
        imported(
          'Quiet Rock',
          { lat: 44.2, lng: -73.2 },
          { kind: 'other', externalIds: ['gnis:1'] },
        ),
        imported('Apple Island', ISLAND, { externalIds: ['osm:way/1'], corpusMessages: 12 }),
      ],
      dryRun: false,
    });
    const [, quiet] = (await rowsOf(t, body)).sort((a, b) => a.name.localeCompare(b.name));
    const list = await t.query(api.landmarks.listForBody, { waterBodyId: body });
    expect(list.map((l) => l.name)).toEqual(['Apple Island', 'Quiet Rock']);
    expect(list[0]?.minZoom).toBeLessThan(list[1]?.minZoom ?? 0);

    if (!quiet) throw new Error('fixture: Quiet Rock was not loaded');
    await mod.as.mutation(api.landmarks.remove, { landmarkId: quiet._id });
    expect(
      (await t.query(api.landmarks.listForBody, { waterBodyId: body })).map((l) => l.name),
    ).toEqual(['Apple Island']);
    const editor = await mod.as.query(api.landmarks.listForEditor, { waterBodyId: body });
    expect(editor.find((l) => l.name === 'Quiet Rock')?.removedAt).toBeDefined();
  });

  test('the editor list is a moderator’s', async () => {
    const t = harness();
    const body = await seedBody(t);
    const member = await seedUser(t, 'member');
    await expect(
      member.as.query(api.landmarks.listForEditor, { waterBodyId: body }),
    ).rejects.toThrow(/moderator/i);
  });
});

describe('landmarks.listBodyGeometry', () => {
  test('pages listed bodies with their outline and leaves the merged ones out', async () => {
    const t = harness();
    const live = await seedBody(t);
    await seedBody(t, { dedupStatus: 'merged' });
    const page = await t.query(internal.landmarks.listBodyGeometry, { batchSize: 10 });
    expect(page.bodies.map((b) => b._id)).toEqual([live]);
    expect(page.bodies[0]?.polygon).toEqual(LAKE);
    expect(page.isDone).toBe(true);
  });
});

describe('a moderator’s hand', () => {
  test('a member cannot drop a landmark', async () => {
    const t = harness();
    const body = await seedBody(t);
    const member = await seedUser(t, 'member');
    await expect(
      member.as.mutation(api.landmarks.create, {
        waterBodyId: body,
        name: 'Bird Poop Rock',
        kind: 'other',
        point: { lat: 44.3, lng: -73.2 },
      }),
    ).rejects.toThrow(/moderator/i);
  });

  test('create, edit, remove and restore each land an audit row', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await mod.as.mutation(api.landmarks.create, {
      waterBodyId: body,
      name: '  Bird   Poop Rock ',
      kind: 'other',
      point: { lat: 44.3, lng: -73.2 },
      aliases: ['bird poop rock', 'the poop rock'],
    });
    let row = await t.run((ctx) => ctx.db.get(id));
    // Whitespace collapsed; the alias that only re-spells the name dropped.
    expect(row).toMatchObject({
      name: 'Bird Poop Rock',
      aliases: ['the poop rock'],
      source: 'moderator',
    });

    await mod.as.mutation(api.landmarks.update, {
      landmarkId: id,
      name: 'Gull Rock',
      kind: 'island',
      point: { lat: 44.31, lng: -73.2 },
    });
    row = await t.run((ctx) => ctx.db.get(id));
    expect(row).toMatchObject({
      name: 'Gull Rock',
      kind: 'island',
      point: { lat: 44.31, lng: -73.2 },
    });

    await mod.as.mutation(api.landmarks.remove, { landmarkId: id });
    await mod.as.mutation(api.landmarks.remove, { landmarkId: id }); // a no-op, not a second row
    await mod.as.mutation(api.landmarks.restore, { landmarkId: id });
    await mod.as.mutation(api.landmarks.restore, { landmarkId: id });

    const audits = await t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_target', (q) =>
          q.eq('targetType', 'bodyLandmark').eq('targetId', id as string),
        )
        .collect(),
    );
    expect(audits.map((a) => a.action)).toEqual([
      'create_landmark',
      'edit_landmark',
      'remove',
      'restore',
    ]);
  });

  test('refuses a second landmark of the same name nearby, but not across the lake', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const args = { waterBodyId: body, name: 'Long Point', kind: 'point' as const };
    await mod.as.mutation(api.landmarks.create, { ...args, point: { lat: 44.1, lng: -73.4 } });
    await expect(
      mod.as.mutation(api.landmarks.create, { ...args, point: { lat: 44.101, lng: -73.4 } }),
    ).rejects.toThrow(/already a landmark/);
    await mod.as.mutation(api.landmarks.create, { ...args, point: { lat: 44.9, lng: -72.6 } });
  });

  test('refuses an empty or overlong name', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const args = { waterBodyId: body, kind: 'other' as const, point: { lat: 44.3, lng: -73.2 } };
    await expect(mod.as.mutation(api.landmarks.create, { ...args, name: '  ' })).rejects.toThrow(
      /name/,
    );
    await expect(
      mod.as.mutation(api.landmarks.create, { ...args, name: 'x'.repeat(81) }),
    ).rejects.toThrow(/80/);
  });

  test('a restore is refused when a live landmark has taken the name since', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const args = { waterBodyId: body, name: 'Gull Rock', kind: 'island' as const, point: ISLAND };
    const first = await mod.as.mutation(api.landmarks.create, args);
    await mod.as.mutation(api.landmarks.remove, { landmarkId: first });
    await mod.as.mutation(api.landmarks.create, args);
    await expect(mod.as.mutation(api.landmarks.restore, { landmarkId: first })).rejects.toThrow(
      /already a landmark/,
    );
  });
});

describe('landmarks and bays', () => {
  test('an island in a bay is stamped with the bay, though the bay’s polygon has a hole there', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await mod.as.mutation(api.landmarks.create, {
      waterBodyId: body,
      name: 'Gull Island',
      kind: 'island',
      point: ISLAND,
    });
    expect((await t.run((ctx) => ctx.db.get(id)))?.subAreaId).toBeUndefined();

    const bay = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Northeast Bay',
      polygon: { type: 'Polygon', coordinates: [rect(-72.9, 44.6, -72.5, 45.0)] },
    });
    await settle(t);
    expect((await t.run((ctx) => ctx.db.get(id)))?.subAreaId).toBe(bay);
  });

  test('drawing a bay by chord retires the reference landmark of the same name', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await mod.as.mutation(api.landmarks.create, {
      waterBodyId: body,
      name: 'Kingsland Bay',
      kind: 'bay',
      point: { lat: 44.03, lng: -73.47 },
    });
    // The same name at the far end of the lake is another place, and stays.
    const far = await mod.as.mutation(api.landmarks.create, {
      waterBodyId: body,
      name: 'Kingsland Bay',
      kind: 'bay',
      point: { lat: 44.9, lng: -72.6 },
    });
    const other = await mod.as.mutation(api.landmarks.create, {
      waterBodyId: body,
      name: 'Gull Island',
      kind: 'island',
      point: ISLAND,
    });
    await mod.as.mutation(api.subAreas.createFromChord, {
      waterBodyId: body,
      name: 'Kingsland Bay',
      mouth: {
        a: { lat: 44.1, lng: -73.5 },
        b: { lat: 44.0, lng: -73.4 },
        side: { lat: 44.02, lng: -73.48 },
        sagittaM: 0,
      },
    });
    expect((await t.run((ctx) => ctx.db.get(id)))?.removedAt).toBeDefined();
    expect((await t.run((ctx) => ctx.db.get(other)))?.removedAt).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(far)))?.removedAt).toBeUndefined();
    // …and the one it became cannot come back beside it.
    await expect(mod.as.mutation(api.landmarks.restore, { landmarkId: id })).rejects.toThrow(
      /is a bay on this lake/,
    );
  });

  test('renaming a bay retires a landmark that carries its new name; a landmark may not take a bay’s', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const bay = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Mud Bay',
      polygon: { type: 'Polygon', coordinates: [rect(-73.4, 44.1, -73.2, 44.3)] },
    });
    const id = await mod.as.mutation(api.landmarks.create, {
      waterBodyId: body,
      name: 'Kingsland Bay',
      kind: 'bay',
      point: { lat: 44.2, lng: -73.3 },
    });
    await mod.as.mutation(api.subAreas.rename, { subAreaId: bay, name: 'Kingsland Bay' });
    expect((await t.run((ctx) => ctx.db.get(id)))?.removedAt).toBeDefined();
    await expect(
      mod.as.mutation(api.landmarks.create, {
        waterBodyId: body,
        name: 'kingsland bay',
        kind: 'other',
        point: { lat: 44.9, lng: -72.6 },
      }),
    ).rejects.toThrow(/is a bay on this lake/);
  });

  test('promoting a landmark to a bay retires it in the same write', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await mod.as.mutation(api.landmarks.create, {
      waterBodyId: body,
      name: 'Kingsland Bay',
      kind: 'bay',
      point: { lat: 44.2, lng: -73.3 },
    });
    const bay = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Kingsland Bay',
      polygon: { type: 'Polygon', coordinates: [rect(-73.4, 44.1, -73.2, 44.3)] },
      promoteLandmarkId: id,
    });
    expect((await t.run((ctx) => ctx.db.get(id)))?.removedAt).toBeDefined();
    const audits = await t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_target', (q) =>
          q.eq('targetType', 'bodyLandmark').eq('targetId', id as string),
        )
        .collect(),
    );
    expect(audits.at(-1)).toMatchObject({
      action: 'promote_landmark',
      metadata: { subAreaId: bay },
    });
  });

  test('a landmark from another lake cannot be promoted, and the bay is not drawn either', async () => {
    const t = harness();
    const body = await seedBody(t);
    const other = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await mod.as.mutation(api.landmarks.create, {
      waterBodyId: other,
      name: 'Kingsland Bay',
      kind: 'bay',
      point: { lat: 44.2, lng: -73.3 },
    });
    await expect(
      mod.as.mutation(api.subAreas.create, {
        waterBodyId: body,
        name: 'Kingsland Bay',
        polygon: { type: 'Polygon', coordinates: [rect(-73.4, 44.1, -73.2, 44.3)] },
        promoteLandmarkId: id,
      }),
    ).rejects.toThrow(/not on this lake/);
    const bays = await t.run((ctx) => ctx.db.query('waterBodySubAreas').collect());
    expect(bays).toHaveLength(0);
  });
});
