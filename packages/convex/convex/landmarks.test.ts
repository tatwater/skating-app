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

/** What the catalogs read on a test run — and, seeded, what the deployment last accepted. */
const SOURCES = [
  { source: 'vt.osm', count: 100 },
  { source: 'vt.gnis', count: 10 },
];

/** Give the deployment an accepted complete load, so a complete line's sources can vouch for it. */
async function seedBaseline(t: ReturnType<typeof harness>, sources = SOURCES) {
  await t.run((ctx) => ctx.db.insert('landmarkSourceBaselines', { sources, acceptedAt: 0 }));
}

/** One body through the batch import — the shape every test here wants. */
function importFor(
  t: ReturnType<typeof harness>,
  args: {
    waterBodyId: Id<'waterBodies'>;
    landmarks: ReturnType<typeof imported>[];
    campaignId?: string;
    dryRun?: boolean;
    complete?: boolean;
    sources?: { source: string; count: number }[];
    acceptSourceDrop?: boolean;
    acceptMassDrop?: boolean;
  },
) {
  const { waterBodyId, landmarks, complete, ...rest } = args;
  return t.mutation(internal.landmarks.importBatch, {
    bodies: [{ waterBodyId, landmarks, ...(complete !== undefined ? { complete } : {}) }],
    // A complete line carries what its sources read, as the loader sends it.
    ...(complete ? { sources: SOURCES } : {}),
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
        point: { lat: 44.25, lng: -73.25 },
      }),
    ).rejects.toThrow(/is a bay on this lake/);
    // The same name across the lake is another place — the one rule the retirement also reads.
    const far = await mod.as.mutation(api.landmarks.create, {
      waterBodyId: body,
      name: 'kingsland bay',
      kind: 'other',
      point: { lat: 44.9, lng: -72.6 },
    });
    await mod.as.mutation(api.landmarks.update, { landmarkId: far, kind: 'bay' });
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

describe('a run that stops placing a landmark (catalog drops)', () => {
  const A = imported('Gull Island', ISLAND, { externalIds: ['osm:way/1'] });
  const B = imported('Butler Island', { lat: 44.5, lng: -73.2 }, { externalIds: ['osm:way/2'] });

  test('a complete line retires the catalog row it no longer has, and a later one brings it back', async () => {
    const t = harness();
    await seedBaseline(t);
    const body = await seedBody(t);
    await importFor(t, { waterBodyId: body, landmarks: [A, B], complete: true, dryRun: false });

    const dry = await importFor(t, { waterBodyId: body, landmarks: [A], complete: true });
    expect(dry.dropped).toBe(1);
    expect((await rowsOf(t, body)).every((r) => r.removedAt === undefined)).toBe(true);

    const counts = await importFor(t, {
      waterBodyId: body,
      landmarks: [A],
      complete: true,
      dryRun: false,
    });
    expect(counts).toMatchObject({ dropped: 1, unchanged: 1 });
    const butler = (await rowsOf(t, body)).find((r) => r.name === 'Butler Island');
    expect(butler?.removedAt).toBeDefined();
    expect(butler?.catalogDroppedAt).toBeDefined();
    const listed = await t.query(api.landmarks.listForBody, { waterBodyId: body });
    expect(listed.map((l) => l.name)).toEqual(['Gull Island']);

    const back = await importFor(t, {
      waterBodyId: body,
      landmarks: [A, B],
      complete: true,
      dryRun: false,
    });
    expect(back).toMatchObject({ returned: 1, removedHeld: 0, created: 0 });
    const returned = (await rowsOf(t, body)).find((r) => r.name === 'Butler Island');
    expect(returned?.removedAt).toBeUndefined();
    expect(returned?.catalogDroppedAt).toBeUndefined();
  });

  test('an empty complete line retires every catalog row; an empty line on a bare body reads nothing more', async () => {
    const t = harness();
    await seedBaseline(t);
    const body = await seedBody(t);
    const bare = await seedBody(t);
    await importFor(t, { waterBodyId: body, landmarks: [A, B], dryRun: false });
    const counts = await t.mutation(internal.landmarks.importBatch, {
      bodies: [
        { waterBodyId: body, landmarks: [], complete: true },
        { waterBodyId: bare, landmarks: [], complete: true },
      ],
      sources: SOURCES,
      dryRun: false,
    });
    expect(counts.dropped).toBe(2);
    expect(await t.query(api.landmarks.listForBody, { waterBodyId: body })).toEqual([]);
  });

  test('a line that is not complete retires nothing (a partial run of some states)', async () => {
    const t = harness();
    const body = await seedBody(t);
    await importFor(t, { waterBodyId: body, landmarks: [A, B], dryRun: false });
    const counts = await importFor(t, { waterBodyId: body, landmarks: [A], dryRun: false });
    expect(counts.dropped).toBe(0);
    expect((await rowsOf(t, body)).every((r) => r.removedAt === undefined)).toBe(true);
  });

  test('a moderator’s rows are theirs: never dropped, and a removal still holds', async () => {
    const t = harness();
    await seedBaseline(t);
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await importFor(t, { waterBodyId: body, landmarks: [A, B], dryRun: false });
    const rows = await rowsOf(t, body);
    const gull = rows.find((r) => r.name === 'Gull Island')?._id as Id<'bodyLandmarks'>;
    const butler = rows.find((r) => r.name === 'Butler Island')?._id as Id<'bodyLandmarks'>;
    await mod.as.mutation(api.landmarks.update, { landmarkId: gull, aliases: ['Gull Isle'] });
    await mod.as.mutation(api.landmarks.remove, { landmarkId: butler });
    const handMade = await mod.as.mutation(api.landmarks.create, {
      waterBodyId: body,
      name: 'Sea Caves',
      kind: 'other',
      point: { lat: 44.3, lng: -73.1 },
    });

    const empty = await importFor(t, {
      waterBodyId: body,
      landmarks: [],
      complete: true,
      dryRun: false,
    });
    expect(empty.dropped).toBe(0);
    const again = await importFor(t, {
      waterBodyId: body,
      landmarks: [A, B],
      complete: true,
      dryRun: false,
    });
    expect(again).toMatchObject({ removedHeld: 1, returned: 0, moderatorHeld: 1 });
    expect((await t.run((ctx) => ctx.db.get(handMade)))?.removedAt).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(butler)))?.removedAt).toBeDefined();
  });

  test('a moderator restoring a dropped row vouches for it, so the next run keeps it', async () => {
    const t = harness();
    await seedBaseline(t);
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await importFor(t, { waterBodyId: body, landmarks: [A, B], dryRun: false });
    await importFor(t, { waterBodyId: body, landmarks: [A], complete: true, dryRun: false });
    const butler = (await rowsOf(t, body)).find((r) => r.name === 'Butler Island');
    const editor = await mod.as.query(api.landmarks.listForEditor, { waterBodyId: body });
    expect(editor.find((l) => l.name === 'Butler Island')?.catalogDroppedAt).toBeDefined();

    await mod.as.mutation(api.landmarks.restore, {
      landmarkId: butler?._id as Id<'bodyLandmarks'>,
    });
    const restored = await t.run((ctx) => ctx.db.get(butler?._id as Id<'bodyLandmarks'>));
    expect(restored?.removedAt).toBeUndefined();
    expect(restored?.catalogDroppedAt).toBeUndefined();
    expect(restored?.moderatorEditedAt).toBeDefined();
    const next = await importFor(t, {
      waterBodyId: body,
      landmarks: [A],
      complete: true,
      dryRun: false,
    });
    expect(next.dropped).toBe(0);
  });

  test('a dropped row does not come back past the cap', async () => {
    const t = harness();
    await seedBaseline(t);
    const body = await seedBody(t);
    await importFor(t, { waterBodyId: body, landmarks: [A, B], dryRun: false });
    await importFor(t, { waterBodyId: body, landmarks: [A], complete: true, dryRun: false });
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_LANDMARKS_PER_BODY - 1; i++) {
        await ctx.db.insert('bodyLandmarks', {
          waterBodyId: body,
          name: `Rock ${i}`,
          kind: 'other',
          point: { lat: 44.1 + i * 1e-4, lng: -73.3 },
          source: 'moderator',
          externalIds: [],
          aliases: [],
          moderatorEditedAt: 0,
          createdAt: 0,
          updatedAt: 0,
        });
      }
    });
    const counts = await importFor(t, { waterBodyId: body, landmarks: [A, B], dryRun: false });
    expect(counts).toMatchObject({ overCap: 1, returned: 0 });
  });
});

describe('a river mouth’s ids (self-review)', () => {
  test('a placement id is the run’s alone: a redrawn shore replaces it rather than piling up', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mouth = (at: string, lat: number) =>
      imported(
        'Otter Creek',
        { lat, lng: -73.4 },
        {
          kind: 'other',
          externalIds: [`osm:way/9#in@${at}`],
        },
      );
    await importFor(t, {
      waterBodyId: body,
      landmarks: [mouth('44.2000,-73.4000', 44.2)],
      dryRun: false,
    });
    await importFor(t, {
      waterBodyId: body,
      landmarks: [mouth('44.2001,-73.4000', 44.2001)],
      dryRun: false,
    });
    const [row] = await rowsOf(t, body);
    expect(row?.externalIds).toEqual(['osm:way/9#in@44.2001,-73.4000']);
  });
});

describe('what a drop must not do (self-review)', () => {
  const A = imported('Gull Island', ISLAND, { externalIds: ['osm:way/1'] });
  const B = imported('Butler Island', { lat: 44.5, lng: -73.2 }, { externalIds: ['osm:way/2'] });

  test('a dropped row does not return beside the live one a moderator put there meanwhile', async () => {
    const t = harness();
    await seedBaseline(t);
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await importFor(t, { waterBodyId: body, landmarks: [A, B], dryRun: false });
    await importFor(t, { waterBodyId: body, landmarks: [A], complete: true, dryRun: false });
    const handMade = await mod.as.mutation(api.landmarks.create, {
      waterBodyId: body,
      name: 'Butler Island',
      kind: 'island',
      point: { lat: 44.5001, lng: -73.2 },
    });
    const counts = await importFor(t, {
      waterBodyId: body,
      landmarks: [A, B],
      complete: true,
      dryRun: false,
    });
    expect(counts).toMatchObject({ returned: 0, moderatorHeld: 1 });
    const live = (await rowsOf(t, body)).filter(
      (r) => r.name === 'Butler Island' && r.removedAt === undefined,
    );
    expect(live.map((r) => r._id)).toEqual([handMade]);
    expect(live[0]?.externalIds).toEqual(['osm:way/2']);
  });

  test('a dropped row a moderator edited, or chose to keep off, stays off', async () => {
    const t = harness();
    await seedBaseline(t);
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const C = imported('Hen Island', { lat: 44.7, lng: -73.0 }, { externalIds: ['osm:way/3'] });
    await importFor(t, { waterBodyId: body, landmarks: [A, B, C], dryRun: false });
    await importFor(t, { waterBodyId: body, landmarks: [A], complete: true, dryRun: false });
    const rows = await rowsOf(t, body);
    const butler = rows.find((r) => r.name === 'Butler Island')?._id as Id<'bodyLandmarks'>;
    const hen = rows.find((r) => r.name === 'Hen Island')?._id as Id<'bodyLandmarks'>;
    await mod.as.mutation(api.landmarks.update, { landmarkId: butler, name: 'Butler Isle' });
    await mod.as.mutation(api.landmarks.remove, { landmarkId: hen });
    const kept = await t.run((ctx) => ctx.db.get(hen));
    expect(kept?.removedAt).toBeDefined();
    expect(kept?.catalogDroppedAt).toBeUndefined();

    const counts = await importFor(t, {
      waterBodyId: body,
      landmarks: [A, B, C],
      complete: true,
      dryRun: false,
    });
    expect(counts).toMatchObject({ returned: 0, removedHeld: 2 });
    expect((await t.run((ctx) => ctx.db.get(butler)))?.name).toBe('Butler Isle');
  });

  test('a far same-named place loads past a bay, and a candidate with a bad name keeps its row', async () => {
    const t = harness();
    await seedBaseline(t);
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    // The far Mud Bay, 80 km from the bay drawn below: the bay rule leaves it standing.
    const far = imported(
      'Mud Bay',
      { lat: 44.9, lng: -72.6 },
      { kind: 'bay', externalIds: ['gnis:1'] },
    );
    await importFor(t, { waterBodyId: body, landmarks: [far, B], dryRun: false });
    await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Mud Bay',
      polygon: { type: 'Polygon', coordinates: [rect(-73.4, 44.1, -73.2, 44.3)] },
    });
    const counts = await importFor(t, {
      waterBodyId: body,
      landmarks: [far, { ...B, name: '  ' }],
      complete: true,
      dryRun: false,
    });
    // The far Mud Bay is no bay's (80 km off): it refreshes like any landmark. The blank name is
    // skipped, and still keeps its row.
    expect(counts).toMatchObject({ alreadyBay: 0, invalidName: 1, dropped: 0, unchanged: 1 });
    expect((await rowsOf(t, body)).every((r) => r.removedAt === undefined)).toBe(true);
  });

  test('removals piling up never push a live row out of the per-body read', async () => {
    const t = harness();
    const body = await seedBody(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_LANDMARKS_PER_BODY + 5; i++) {
        await ctx.db.insert('bodyLandmarks', {
          waterBodyId: body,
          name: `Gone ${i}`,
          kind: 'other',
          point: { lat: 44.1 + i * 1e-4, lng: -73.3 },
          source: 'gnis',
          externalIds: [`gnis:g${i}`],
          aliases: [],
          removedAt: 1 + i,
          catalogDroppedAt: 1 + i,
          createdAt: 0,
          updatedAt: 0,
        });
      }
    });
    await importFor(t, { waterBodyId: body, landmarks: [A], dryRun: false });
    const listed = await t.query(api.landmarks.listForBody, { waterBodyId: body });
    expect(listed.map((l) => l.name)).toEqual(['Gull Island']);
  });
});

describe('a bay and a landmark’s aliases', () => {
  test('drawing a bay retires a landmark that answers to its name only as an alias', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await mod.as.mutation(api.landmarks.create, {
      waterBodyId: body,
      name: 'Ferris Bay',
      aliases: ['Kingsland Bay'],
      kind: 'bay',
      point: { lat: 44.2, lng: -73.3 },
    });
    await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Kingsland Bay',
      polygon: { type: 'Polygon', coordinates: [rect(-73.4, 44.1, -73.2, 44.3)] },
    });
    expect((await t.run((ctx) => ctx.db.get(id)))?.removedAt).toBeDefined();
  });

  test('the import skips a candidate whose alias is a live bay’s name', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Kingsland Bay',
      polygon: { type: 'Polygon', coordinates: [rect(-73.4, 44.1, -73.2, 44.3)] },
    });
    const counts = await importFor(t, {
      waterBodyId: body,
      landmarks: [
        imported(
          'Ferris Bay',
          { lat: 44.2, lng: -73.3 },
          { kind: 'bay', aliases: ['Kingsland Bay'] },
        ),
      ],
      dryRun: false,
    });
    expect(counts).toMatchObject({ alreadyBay: 1, created: 0 });
  });
});

describe('a merge carries the landmarks (D36 / D202)', () => {
  const P_BUTLER = { lat: 44.5, lng: -73.2 };
  const P_PROVIDENCE = { lat: 44.6, lng: -73.1 };
  const P_MUD = { lat: 44.2, lng: -73.3 };

  test('moved to the survivor, twins folded, held removals held, bay names retired', async () => {
    const t = harness();
    const survivor = await seedBody(t);
    const loser = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.subAreas.create, {
      waterBodyId: survivor,
      name: 'Mud Bay',
      polygon: { type: 'Polygon', coordinates: [rect(-73.4, 44.1, -73.2, 44.3)] },
    });
    await importFor(t, {
      waterBodyId: survivor,
      landmarks: [
        imported('Gull Island', ISLAND, { externalIds: ['osm:way/1'], corpusMessages: 3 }),
        imported('Butler Island', P_BUTLER, { externalIds: ['osm:way/2'] }),
      ],
      dryRun: false,
    });
    const survivorButler = (await rowsOf(t, survivor)).find((r) => r.name === 'Butler Island');
    await mod.as.mutation(api.landmarks.remove, {
      landmarkId: survivorButler?._id as Id<'bodyLandmarks'>,
    });
    await importFor(t, {
      waterBodyId: loser,
      landmarks: [
        imported('Gull Island', ISLAND, {
          externalIds: ['gnis:9'],
          aliases: ['Gull Isle'],
          corpusMessages: 7,
          source: 'gnis',
        }),
        imported('Butler Island', P_BUTLER, { externalIds: ['gnis:10'], source: 'gnis' }),
        imported('Providence Island', P_PROVIDENCE, { externalIds: ['osm:way/3'] }),
        imported('Mud Bay Ledge', P_MUD, {
          kind: 'other',
          externalIds: ['osm:node/4'],
          aliases: ['Mud Bay'],
        }),
        imported('Hen Island', { lat: 44.7, lng: -73.0 }, { externalIds: ['osm:way/6'] }),
      ],
      dryRun: false,
    });
    // A takedown on the merged lake moves with its row and stays a takedown.
    const hen = (await rowsOf(t, loser)).find((r) => r.name === 'Hen Island');
    await mod.as.mutation(api.landmarks.remove, { landmarkId: hen?._id as Id<'bodyLandmarks'> });

    await mod.as.mutation(api.waterBodies.merge, { survivorId: survivor, loserId: loser });

    expect(await rowsOf(t, loser)).toEqual([]);
    const listed = await t.query(api.landmarks.listForBody, { waterBodyId: survivor });
    expect(listed.map((l) => l.name).sort()).toEqual(['Gull Island', 'Providence Island']);
    const rows = await rowsOf(t, survivor);
    const gull = rows.find((r) => r.name === 'Gull Island' && r.removedAt === undefined);
    expect(gull?.externalIds.sort()).toEqual(['gnis:9', 'osm:way/1']);
    expect(gull?.aliases).toEqual(['Gull Isle']);
    expect(gull?.corpusMessages).toBe(7);
    expect(
      rows
        .filter((r) => r.removedAt !== undefined)
        .map((r) => r.name)
        .sort(),
    ).toEqual(['Butler Island', 'Butler Island', 'Gull Island', 'Hen Island', 'Mud Bay Ledge']);
    const audit = await t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .filter((q) => q.eq(q.field('action'), 'merge_waterbody'))
        .first(),
    );
    expect(audit?.metadata).toMatchObject({
      repointed: {
        landmarks: 5,
        landmarksFolded: 2,
        landmarksOverCap: 0,
        landmarksRetiredAsBay: 1,
      },
    });

    // The ETL finds the folded row by either id — the retired twin holding one does not shadow it.
    const rerun = await importFor(t, {
      waterBodyId: survivor,
      landmarks: [
        imported('Gull Island', ISLAND, { externalIds: ['gnis:9'], aliases: ['Gull Isle'] }),
      ],
    });
    expect(rerun).toMatchObject({ removedHeld: 0, created: 0 });
  });

  test('a twin without a footprint takes the moved row’s, and its specific kind', async () => {
    const t = harness();
    const survivor = await seedBody(t);
    const loser = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await importFor(t, {
      waterBodyId: survivor,
      landmarks: [
        imported('Gull Island', ISLAND, { kind: 'other', externalIds: ['gnis:9'], source: 'gnis' }),
      ],
      dryRun: false,
    });
    await importFor(t, {
      waterBodyId: loser,
      landmarks: [imported('Gull Island', ISLAND, { externalIds: ['osm:way/1'], areaSqM: 42_000 })],
      dryRun: false,
    });
    await mod.as.mutation(api.waterBodies.merge, { survivorId: survivor, loserId: loser });
    const live = (await rowsOf(t, survivor)).filter((r) => r.removedAt === undefined);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ kind: 'island', areaSqM: 42_000 });
    expect(live[0]?.externalIds.sort()).toEqual(['gnis:9', 'osm:way/1']);
  });

  test('a moderator’s twin from the merged lake keeps the moderator’s name and point', async () => {
    const t = harness();
    const survivor = await seedBody(t);
    const loser = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await importFor(t, {
      waterBodyId: survivor,
      landmarks: [imported('Rock Point', P_BUTLER, { kind: 'point', externalIds: ['osm:node/5'] })],
      dryRun: false,
    });
    const moved = { lat: 44.501, lng: -73.2 };
    await mod.as.mutation(api.landmarks.create, {
      waterBodyId: loser,
      name: 'Rock Point',
      aliases: ['The Rock'],
      kind: 'point',
      point: moved,
    });
    await mod.as.mutation(api.waterBodies.merge, { survivorId: survivor, loserId: loser });
    const live = (await rowsOf(t, survivor)).filter((r) => r.removedAt === undefined);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ name: 'Rock Point', point: moved, aliases: ['The Rock'] });
    expect(live[0]?.moderatorEditedAt).toBeDefined();
    expect(live[0]?.externalIds).toEqual(['osm:node/5']);
  });

  test('past the survivor’s cap a moved landmark is retired, not stranded', async () => {
    const t = harness();
    const survivor = await seedBody(t);
    const loser = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_LANDMARKS_PER_BODY; i++) {
        await ctx.db.insert('bodyLandmarks', {
          waterBodyId: survivor,
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
    await importFor(t, {
      waterBodyId: loser,
      landmarks: [imported('Providence Island', P_PROVIDENCE)],
      dryRun: false,
    });
    await mod.as.mutation(api.waterBodies.merge, { survivorId: survivor, loserId: loser });
    const moved = (await rowsOf(t, survivor)).find((r) => r.name === 'Providence Island');
    expect(moved?.removedAt).toBeDefined();
  });
});

describe('a merge, the survivor’s rows deciding (self-review)', () => {
  const P = { lat: 44.5, lng: -73.2 };

  test('a row a merge moved is not dropped by a run matched against an export older than the merge', async () => {
    const t = harness();
    await seedBaseline(t);
    const survivor = await seedBody(t);
    const loser = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await importFor(t, {
      waterBodyId: loser,
      landmarks: [imported('Butler Island', P, { externalIds: ['osm:way/2'] })],
      dryRun: false,
    });
    const exportedBefore = Date.now() - 1;
    await mod.as.mutation(api.waterBodies.merge, { survivorId: survivor, loserId: loser });
    const run = (matchedAt?: number) =>
      t.mutation(internal.landmarks.importBatch, {
        bodies: [{ waterBodyId: survivor, landmarks: [], complete: true }],
        sources: SOURCES,
        ...(matchedAt !== undefined ? { matchedAt } : {}),
        dryRun: false,
      });
    expect((await run(exportedBefore)).dropped).toBe(0);
    expect((await run()).dropped).toBe(0);
    vi.advanceTimersByTime(1_000);
    expect((await run(Date.now())).dropped).toBe(1);
  });

  test('a twin the catalogs dropped does not hold the moved row; the moved row stays live', async () => {
    const t = harness();
    await seedBaseline(t);
    const survivor = await seedBody(t);
    const loser = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const butler = imported('Butler Island', P, { externalIds: ['osm:way/2'] });
    await importFor(t, { waterBodyId: survivor, landmarks: [butler], dryRun: false });
    await importFor(t, { waterBodyId: survivor, landmarks: [], complete: true, dryRun: false });
    await importFor(t, {
      waterBodyId: loser,
      landmarks: [imported('Butler Island', P, { externalIds: ['gnis:2'], source: 'gnis' })],
      dryRun: false,
    });
    await mod.as.mutation(api.waterBodies.merge, { survivorId: survivor, loserId: loser });
    const listed = await t.query(api.landmarks.listForBody, { waterBodyId: survivor });
    expect(listed.map((l) => l.name)).toEqual(['Butler Island']);
  });

  test('a takedown on the merged lake stays on its own row, and the survivor’s label stands', async () => {
    const t = harness();
    const survivor = await seedBody(t);
    const loser = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await importFor(t, {
      waterBodyId: survivor,
      landmarks: [imported('Butler Island', P, { externalIds: ['osm:way/2'] })],
      dryRun: false,
    });
    await importFor(t, {
      waterBodyId: loser,
      landmarks: [imported('Butler Island', P, { externalIds: ['gnis:2'], source: 'gnis' })],
      dryRun: false,
    });
    const taken = (await rowsOf(t, loser))[0]?._id as Id<'bodyLandmarks'>;
    await mod.as.mutation(api.landmarks.remove, { landmarkId: taken });
    await mod.as.mutation(api.waterBodies.merge, { survivorId: survivor, loserId: loser });
    const rows = await rowsOf(t, survivor);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.removedAt === undefined)).toHaveLength(1);
    expect((await t.run((ctx) => ctx.db.get(taken)))?.removedAt).toBeDefined();
  });

  test('a folded row is never matched again, and a moderator restoring it makes it a place', async () => {
    const t = harness();
    const survivor = await seedBody(t);
    const loser = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await importFor(t, {
      waterBodyId: survivor,
      landmarks: [imported('Butler Island', P, { externalIds: ['osm:way/2'] })],
      dryRun: false,
    });
    await importFor(t, {
      waterBodyId: loser,
      landmarks: [imported('Butler Island', P, { externalIds: ['osm:way/2'] })],
      dryRun: false,
    });
    await mod.as.mutation(api.waterBodies.merge, { survivorId: survivor, loserId: loser });
    const folded = (await rowsOf(t, survivor)).find((r) => r.mergedIntoId !== undefined);
    expect(folded).toBeDefined();
    const editor = await mod.as.query(api.landmarks.listForEditor, { waterBodyId: survivor });
    expect(editor.find((l) => l._id === folded?._id)?.mergedIntoId).toBeDefined();

    // The twin is removed, then dropped by nothing: a run placing the id again finds the twin, not
    // the folded row — and holds it, a person having removed it.
    const twin = (await rowsOf(t, survivor)).find((r) => r.mergedIntoId === undefined);
    await mod.as.mutation(api.landmarks.remove, { landmarkId: twin?._id as Id<'bodyLandmarks'> });
    await mod.as.mutation(api.landmarks.restore, {
      landmarkId: folded?._id as Id<'bodyLandmarks'>,
    });
    const restored = await t.run((ctx) => ctx.db.get(folded?._id as Id<'bodyLandmarks'>));
    expect(restored?.mergedIntoId).toBeUndefined();
    expect(restored?.removedAt).toBeUndefined();
  });

  test('a catalog row moved past the cap comes back when a run has room for it', async () => {
    const t = harness();
    await seedBaseline(t);
    const survivor = await seedBody(t);
    const loser = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_LANDMARKS_PER_BODY; i++) {
        await ctx.db.insert('bodyLandmarks', {
          waterBodyId: survivor,
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
    const hen = imported('Hen Island', { lat: 44.7, lng: -73.0 }, { externalIds: ['osm:way/6'] });
    await importFor(t, { waterBodyId: loser, landmarks: [hen], dryRun: false });
    await mod.as.mutation(api.waterBodies.merge, { survivorId: survivor, loserId: loser });
    const moved = (await rowsOf(t, survivor)).find((r) => r.name === 'Hen Island');
    expect(moved?.catalogDroppedAt).toBeDefined();
    // A complete run that keeps only Hen Island drops the rocks and brings it back.
    // Dropping all 1,500 rocks is the per-lake brake's case: held, unless the operator says so.
    const held = await importFor(t, {
      waterBodyId: survivor,
      landmarks: [hen],
      complete: true,
      dryRun: true,
    });
    expect(held).toMatchObject({ dropped: 0, dropsHeld: MAX_LANDMARKS_PER_BODY, returned: 0 });
    const counts = await importFor(t, {
      waterBodyId: survivor,
      landmarks: [hen],
      complete: true,
      acceptMassDrop: true,
      dryRun: false,
    });
    expect(counts).toMatchObject({ returned: 1, dropped: MAX_LANDMARKS_PER_BODY });
  });
});

describe('a complete load retires only what its sources vouch for (Greptile, third round)', () => {
  const A = imported('Gull Island', ISLAND, { externalIds: ['osm:way/1'] });
  const B = imported('Butler Island', { lat: 44.5, lng: -73.2 }, { externalIds: ['osm:way/2'] });

  test('with no accepted load on the deployment, a complete line retires nothing and says why', async () => {
    const t = harness();
    const body = await seedBody(t);
    await importFor(t, { waterBodyId: body, landmarks: [A, B], dryRun: false });
    const counts = await importFor(t, {
      waterBodyId: body,
      landmarks: [A],
      complete: true,
      dryRun: false,
    });
    expect(counts.dropped).toBe(0);
    expect(counts.shortfalls).toEqual([
      'no complete load has been accepted on this deployment yet',
    ]);
  });

  test('a source that read short of the accepted load retires nothing, unless the operator says so', async () => {
    const t = harness();
    const body = await seedBody(t);
    await seedBaseline(t);
    await importFor(t, { waterBodyId: body, landmarks: [A, B], dryRun: false });
    const short = [
      { source: 'vt.osm', count: 50 },
      { source: 'vt.gnis', count: 10 },
    ];
    const held = await importFor(t, {
      waterBodyId: body,
      landmarks: [A],
      complete: true,
      sources: short,
      dryRun: false,
    });
    expect(held).toMatchObject({ dropped: 0 });
    expect(held.shortfalls).toEqual(['vt.osm: 50 candidates, 50% under the accepted 100']);
    // No sources at all cannot vouch either.
    const unsaid = await t.mutation(internal.landmarks.importBatch, {
      bodies: [{ waterBodyId: body, landmarks: [A], complete: true }],
      dryRun: false,
    });
    expect(unsaid.dropped).toBe(0);
    const meant = await importFor(t, {
      waterBodyId: body,
      landmarks: [A],
      complete: true,
      sources: short,
      acceptSourceDrop: true,
      dryRun: false,
    });
    expect(meant).toMatchObject({ dropped: 1, shortfalls: [] });
  });

  test('the bar moves only on an accepted complete load, and never down without the operator', async () => {
    const t = harness();
    const accept = (sources: { source: string; count: number }[], acceptSourceDrop?: boolean) =>
      t.mutation(internal.landmarks.acceptCompleteLoad, {
        sources,
        campaignId: 'c1',
        ...(acceptSourceDrop !== undefined ? { acceptSourceDrop } : {}),
      });
    const bars = () => t.run((ctx) => ctx.db.query('landmarkSourceBaselines').collect());

    // The first load sets the bar — but not with a source that read nothing.
    expect(await accept([{ source: 'vt.osm', count: 0 }])).toMatchObject({ accepted: false });
    expect(await accept(SOURCES)).toEqual({ accepted: true, shortfalls: [] });
    // A short load does not lower it…
    const short = [
      { source: 'vt.osm', count: 50 },
      { source: 'vt.gnis', count: 10 },
    ];
    expect(await accept(short)).toMatchObject({ accepted: false });
    expect(await bars()).toHaveLength(1);
    // …unless the operator says the shrink is real, and that is recorded.
    expect(await accept(short, true)).toMatchObject({ accepted: true });
    const all = await bars();
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ sources: short, campaignId: 'c1', acceptedShrink: true });
  });

  test('a lake about to lose most of its catalog labels holds them (the per-lake brake)', async () => {
    const t = harness();
    const body = await seedBody(t);
    await seedBaseline(t);
    const many = Array.from({ length: 12 }, (_, i) =>
      imported(
        `Rock ${i}`,
        { lat: 44.1 + i * 0.01, lng: -73.3 },
        {
          kind: 'other',
          externalIds: [`gnis:r${i}`],
        },
      ),
    );
    await importFor(t, { waterBodyId: body, landmarks: many, dryRun: false });
    const held = await importFor(t, {
      waterBodyId: body,
      landmarks: many.slice(0, 1),
      complete: true,
      dryRun: false,
    });
    expect(held).toMatchObject({ dropped: 0, dropsHeld: 11 });
    expect((await rowsOf(t, body)).every((r) => r.removedAt === undefined)).toBe(true);
    const meant = await importFor(t, {
      waterBodyId: body,
      landmarks: many.slice(0, 1),
      complete: true,
      // Excusing a source shrink does not lift the brake: that takes its own word.
      acceptSourceDrop: true,
      dryRun: true,
    });
    expect(meant).toMatchObject({ dropped: 0, dropsHeld: 11 });
    const lifted = await importFor(t, {
      waterBodyId: body,
      landmarks: many.slice(0, 1),
      complete: true,
      acceptMassDrop: true,
      dryRun: false,
    });
    expect(lifted).toMatchObject({ dropped: 11, dropsHeld: 0 });
  });
});

describe('a merge never overrides a moderator’s call (Greptile, third round)', () => {
  test('a moderator’s `other` stays `other` beside a catalog twin of a specific kind', async () => {
    const t = harness();
    const survivor = await seedBody(t);
    const loser = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await mod.as.mutation(api.landmarks.create, {
      waterBodyId: survivor,
      name: 'Gull Island',
      kind: 'other',
      point: ISLAND,
    });
    await importFor(t, {
      waterBodyId: loser,
      landmarks: [imported('Gull Island', ISLAND, { externalIds: ['osm:way/1'], areaSqM: 42_000 })],
      dryRun: false,
    });
    await mod.as.mutation(api.waterBodies.merge, { survivorId: survivor, loserId: loser });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row).toMatchObject({ kind: 'other', name: 'Gull Island', point: ISLAND });
    // The footprint is a fact about the place, not a classification: it still comes across.
    expect(row?.areaSqM).toBe(42_000);
    expect(row?.externalIds).toEqual(['osm:way/1']);
  });
});

describe('the review of the third round', () => {
  test('two places near one row each keep their own: a place match is the nearest unclaimed row', async () => {
    const t = harness();
    const body = await seedBody(t);
    await seedBaseline(t);
    // Two "Otter Creek" rocks 1.67 km apart, inside each other's 1 km radius only at the margin.
    const at = (lat: number, id: string) =>
      imported('Otter Creek', { lat, lng: -73.3 }, { kind: 'other', externalIds: [id] });
    await importFor(t, { waterBodyId: body, landmarks: [at(44.2, 'osm:a')], dryRun: false });
    await importFor(t, { waterBodyId: body, landmarks: [at(44.215, 'osm:b')], dryRun: false });
    // A redrawn shore gives both new ids; the second sits 0.95 km from the first row and 0.72 km
    // from the second — the first row was the first match in index order, the second is the nearest.
    const counts = await importFor(t, {
      waterBodyId: body,
      landmarks: [at(44.203, 'osm:a2'), at(44.2085, 'osm:b2')],
      complete: true,
      dryRun: false,
    });
    expect(counts).toMatchObject({ dropped: 0, created: 0, updated: 2 });
    const rows = (await rowsOf(t, body)).sort((a, b) => a.point.lat - b.point.lat);
    expect(rows.map((r) => r.point.lat)).toEqual([44.203, 44.2085]);
  });

  test('a restore vouches for the row, whatever retired it, so a complete run keeps it', async () => {
    const t = harness();
    const body = await seedBody(t);
    await seedBaseline(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const B = imported('Butler Island', { lat: 44.5, lng: -73.2 }, { externalIds: ['osm:way/2'] });
    await importFor(t, { waterBodyId: body, landmarks: [B], dryRun: false });
    const id = (await rowsOf(t, body))[0]?._id as Id<'bodyLandmarks'>;
    await mod.as.mutation(api.landmarks.remove, { landmarkId: id });
    await mod.as.mutation(api.landmarks.restore, { landmarkId: id });
    expect((await t.run((ctx) => ctx.db.get(id)))?.moderatorEditedAt).toBeDefined();
    const counts = await importFor(t, {
      waterBodyId: body,
      landmarks: [],
      complete: true,
      dryRun: false,
    });
    expect(counts.dropped).toBe(0);
  });

  test('a moderator cannot put a label on, or restore one to, a lake that is not on the map', async () => {
    const t = harness();
    const body = await seedBody(t);
    const merged = await seedBody(t, { dedupStatus: 'merged' });
    const mod = await seedUser(t, 'mod', 'moderator');
    await expect(
      mod.as.mutation(api.landmarks.create, {
        waterBodyId: merged,
        name: 'Bird Poop Rock',
        kind: 'other',
        point: ISLAND,
      }),
    ).rejects.toThrow(/not on the map/);
    const id = await mod.as.mutation(api.landmarks.create, {
      waterBodyId: body,
      name: 'Bird Poop Rock',
      kind: 'other',
      point: ISLAND,
    });
    await mod.as.mutation(api.landmarks.remove, { landmarkId: id });
    await t.run((ctx) => ctx.db.patch(id, { waterBodyId: merged }));
    await expect(mod.as.mutation(api.landmarks.restore, { landmarkId: id })).rejects.toThrow(
      /not on the map/,
    );
  });

  test('a bay redrawn to reach a same-named landmark retires it', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const bay = await mod.as.mutation(api.subAreas.create, {
      waterBodyId: body,
      name: 'Kingsland Bay',
      polygon: { type: 'Polygon', coordinates: [rect(-73.4, 44.1, -73.35, 44.15)] },
    });
    // 7 km east of the bay: another place, until the bay is drawn over it.
    const id = await mod.as.mutation(api.landmarks.create, {
      waterBodyId: body,
      name: 'Kingsland Bay',
      kind: 'bay',
      point: { lat: 44.125, lng: -73.27 },
    });
    await mod.as.mutation(api.subAreas.redraw, {
      subAreaId: bay,
      polygon: { type: 'Polygon', coordinates: [rect(-73.4, 44.1, -73.25, 44.15)] },
    });
    expect((await t.run((ctx) => ctx.db.get(id)))?.removedAt).toBeDefined();
  });

  test('a seeded batch of bays retires the labels they name, once per lake', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const id = await mod.as.mutation(api.landmarks.create, {
      waterBodyId: body,
      name: 'Mud Bay',
      kind: 'bay',
      point: { lat: 44.2, lng: -73.3 },
    });
    await t.mutation(internal.subAreas.importSeed, {
      actorUserId: mod.id,
      seed: [
        {
          waterBodyId: body,
          name: 'Mud Bay',
          box: { minLat: 44.1, minLng: -73.4, maxLat: 44.3, maxLng: -73.2 },
        },
        {
          waterBodyId: body,
          name: 'Deep Bay',
          box: { minLat: 44.6, minLng: -73.4, maxLat: 44.65, maxLng: -73.3 },
        },
      ],
      dryRun: false,
    });
    expect((await t.run((ctx) => ctx.db.get(id)))?.removedAt).toBeDefined();
  });

  test('a moderator’s deleted alias stays deleted; a new feature still brings its spelling', async () => {
    const t = harness();
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    const carry = (ids: string[], aliases: string[]) =>
      imported('Carry Bay', { lat: 44.2, lng: -73.3 }, { kind: 'bay', externalIds: ids, aliases });
    await importFor(t, {
      waterBodyId: body,
      landmarks: [carry(['gnis:1'], ['Carletons Prize'])],
      dryRun: false,
    });
    const id = (await rowsOf(t, body))[0]?._id as Id<'bodyLandmarks'>;
    await mod.as.mutation(api.landmarks.update, { landmarkId: id, aliases: [] });
    await importFor(t, {
      waterBodyId: body,
      landmarks: [carry(['gnis:1'], ['Carletons Prize'])],
      dryRun: false,
    });
    expect((await t.run((ctx) => ctx.db.get(id)))?.aliases).toEqual([]);
    await importFor(t, {
      waterBodyId: body,
      landmarks: [carry(['gnis:1', 'osm:node/7'], ['Carry Cove'])],
      dryRun: false,
    });
    expect((await t.run((ctx) => ctx.db.get(id)))?.aliases).toEqual(['Carry Cove']);
  });

  test('a run without a footprint or a specific kind keeps the ones the row has', async () => {
    const t = harness();
    const body = await seedBody(t);
    await importFor(t, {
      waterBodyId: body,
      landmarks: [imported('Gull Island', ISLAND, { externalIds: ['osm:way/1'], areaSqM: 42_000 })],
      dryRun: false,
    });
    await importFor(t, {
      waterBodyId: body,
      landmarks: [
        imported('Gull Island', ISLAND, { kind: 'other', externalIds: ['gnis:9'], source: 'gnis' }),
      ],
      dryRun: false,
    });
    const [row] = await rowsOf(t, body);
    expect(row).toMatchObject({ kind: 'island', areaSqM: 42_000 });
  });
});
