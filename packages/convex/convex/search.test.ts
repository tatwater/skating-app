import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import schema from './schema';
import { RECENTS_MAX } from './search';

const modules = import.meta.glob('./**/*.*s');

type T = ReturnType<typeof convexTest>;
const NOW = Date.now();

const SQUARE = {
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

async function seedUser(t: T, subject: string, extra: Partial<Doc<'profiles'>> = {}) {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: `${subject} name`,
      username: subject,
      profileImageUrl: `https://img/${subject}`,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: {
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
      },
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'member',
      status: 'active',
      createdAt: NOW,
      ...extra,
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

async function seedBody(t: T, name: string, extra: Partial<Doc<'waterBodies'>> = {}) {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      source: 'osm',
      name,
      searchText: name,
      type: 'lakePond',
      polygon: SQUARE,
      bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      centroid: { lat: 0.5, lng: 0.5 },
      states: ['NH'],
      dedupStatus: 'clean',
      createdAt: NOW,
      ...extra,
    }),
  );
}

async function seedBay(
  t: T,
  waterBodyId: Id<'waterBodies'>,
  createdByUserId: Id<'profiles'>,
  extra: Partial<Doc<'waterBodySubAreas'>> = {},
) {
  return t.run((ctx) =>
    ctx.db.insert('waterBodySubAreas', {
      waterBodyId,
      name: 'The Narrows',
      searchText: 'The Narrows',
      polygon: SQUARE,
      bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      centroid: { lat: 0.5, lng: 0.5 },
      surfaceAreaSqM: 40_000,
      displayScore: 1,
      minVisibleZoom: 10,
      createdByUserId,
      createdAt: NOW,
      updatedAt: NOW,
      ...extra,
    }),
  );
}

describe('search.resolveRecents (B03 §11)', () => {
  test('resolves lakes, bays and skaters in pick order, with outlines and avatars', async () => {
    const t = convexTest(schema, modules);
    const ada = await seedUser(t, 'ada');
    const lake = await seedBody(t, 'Mascoma Lake');
    const bay = await seedBay(t, lake, ada.id);
    const rows = await t.query(api.search.resolveRecents, {
      picks: [
        { kind: 'skater', id: 'ADA' },
        { kind: 'water_body', id: lake },
        { kind: 'sub_area', id: bay },
      ],
    });
    expect(rows[0]).toEqual({
      kind: 'skater',
      id: 'ADA',
      username: 'ada',
      displayName: 'ada name',
      profileImageUrl: 'https://img/ada',
      trustClass: 'new',
    });
    expect(rows[1]).toMatchObject({
      kind: 'water_body',
      waterBodyId: lake,
      name: 'Mascoma Lake',
      type: 'lakePond',
      states: ['NH'],
      outline: { bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 } },
    });
    expect(rows[1] && 'outline' in rows[1] && rows[1].outline?.rings[0]?.length).toBeGreaterThan(3);
    expect(rows[2]).toMatchObject({
      kind: 'sub_area',
      waterBodyId: lake,
      name: 'The Narrows',
      parentName: 'Mascoma Lake',
    });
  });

  test('a merged lake resolves to its survivor; a dormant one is marked inactive', async () => {
    const t = convexTest(schema, modules);
    const survivor = await seedBody(t, 'Survivor');
    const loser = await seedBody(t, 'Loser', { mergedIntoId: survivor, dedupStatus: 'merged' });
    const dormant = await seedBody(t, 'Sleepy', { dormant: { since: NOW, reason: 'inactive' } });
    const rows = await t.query(api.search.resolveRecents, {
      picks: [
        { kind: 'water_body', id: loser },
        { kind: 'water_body', id: dormant },
      ],
    });
    expect(rows[0]).toMatchObject({ waterBodyId: survivor, name: 'Survivor' });
    expect(rows[1]).toMatchObject({ name: 'Sleepy', inactive: true });
  });

  test('anything that no longer resolves is null in its place', async () => {
    const t = convexTest(schema, modules);
    const viewer = await seedUser(t, 'viewer');
    const blocker = await seedUser(t, 'blocker');
    await seedUser(t, 'ghost', { deletionRequestedAt: NOW });
    const removed = await seedBody(t, 'Gone', { removedAt: NOW });
    const lake = await seedBody(t, 'Lake');
    const deadBay = await seedBay(t, lake, viewer.id, { removedAt: NOW });
    await t.run((ctx) =>
      ctx.db.insert('blocks', { blockerId: blocker.id, blockedId: viewer.id, createdAt: NOW }),
    );
    const rows = await viewer.as.query(api.search.resolveRecents, {
      picks: [
        { kind: 'water_body', id: removed },
        { kind: 'water_body', id: 'not-an-id' },
        { kind: 'sub_area', id: deadBay },
        { kind: 'sub_area', id: 'nope' },
        { kind: 'skater', id: 'blocker' },
        { kind: 'skater', id: 'ghost' },
      ],
    });
    expect(rows).toEqual([null, null, null, null, null, null]);
    expect(
      await t.query(api.search.resolveRecents, { picks: [{ kind: 'skater', id: '  ' }] }),
    ).toEqual([null]);
  });

  test('a private profile is a name and an avatar, marked private (D13)', async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, 'quiet', { profileVisibility: 'private' });
    const [row] = await t.query(api.search.resolveRecents, {
      picks: [{ kind: 'skater', id: 'quiet' }],
    });
    expect(row).toMatchObject({ kind: 'skater', username: 'quiet', private: true });
  });

  test('refuses more than the Recent group holds', async () => {
    const t = convexTest(schema, modules);
    const picks = Array.from({ length: RECENTS_MAX + 1 }, () => ({
      kind: 'skater' as const,
      id: 'x',
    }));
    await expect(t.query(api.search.resolveRecents, { picks })).rejects.toThrow(/At most/);
  });
});

describe('search hits carry what exists on the row (B03 §11)', () => {
  test('lake and bay hits carry their area; skater hits their report count', async () => {
    const t = convexTest(schema, modules);
    const ada = await seedUser(t, 'ada', { reportCount: 212 });
    const lake = await seedBody(t, 'Mascoma Lake', { surfaceAreaSqM: 4_625_000 });
    await seedBay(t, lake, ada.id, { name: 'Mascoma Narrows', searchText: 'Mascoma Narrows' });
    const hits = await t.query(api.waterBodies.searchByName, { query: 'Mascoma' });
    expect(hits.find((h) => h.kind === 'body')?.surfaceAreaSqM).toBe(4_625_000);
    expect(hits.find((h) => h.kind === 'subArea')?.surfaceAreaSqM).toBe(40_000);
    const people = await t.query(api.profiles.searchProfiles, { query: 'ada' });
    expect(people[0]?.reportCount).toBe(212);
  });
});
