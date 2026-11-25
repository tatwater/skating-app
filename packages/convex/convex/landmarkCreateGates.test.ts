import type { Capability } from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';

/**
 * `landmarks.create` placing an ask (D300): an emailed name also needs `corpus.placeNames`, a
 * skater's proposal also needs `inbox.request` — the capabilities the Places tab gates the buttons
 * on. Every role holding `body.places` holds both today, so the test raises one capability's role
 * past the moderator's to prove the server asks for it, and only when the ask is passed.
 */

const hooks = vi.hoisted(() => ({ raised: new Set<string>() }));

vi.mock('@skating/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@skating/core')>();
  return {
    ...core,
    CAPABILITIES: new Proxy(core.CAPABILITIES, {
      get(target, key, receiver) {
        const rule = Reflect.get(target, key, receiver);
        return typeof key === 'string' && hooks.raised.has(key) ? { ...rule, role: 'admin' } : rule;
      },
    }),
  };
});

const modules = import.meta.glob('./**/*.*s');
const NOW = Date.UTC(2026, 0, 15, 12);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  hooks.raised.clear();
});
afterEach(() => {
  vi.useRealTimers();
  hooks.raised.clear();
});

const raise = (capability: Capability) => hooks.raised.add(capability);

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
  moderatorDecision: false,
};

const LAKE = {
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

const profile = (subject: string, role: 'member' | 'moderator') => ({
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
  createdAt: NOW,
});

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert('profiles', profile('mod', 'moderator'));
    // A skater asked for the landmark: a moderator never decides their own ask.
    const skater = await ctx.db.insert('profiles', profile('skater', 'member'));
    const body = await ctx.db.insert('waterBodies', {
      name: 'Lake Champlain',
      searchText: 'Lake Champlain',
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: LAKE,
      bbox: { minLat: 44.0, minLng: -73.5, maxLat: 45.0, maxLng: -72.5 },
      centroid: { lat: 44.5, lng: -73.0 },
      surfaceAreaSqM: 8.7e9,
      dedupStatus: 'clean' as const,
      createdAt: NOW,
    });
    const placeName = await ctx.db.insert('corpusPlaceNames', {
      name: 'The Narrows',
      askKey: 'the narrows',
      aliases: [],
      messages: 3,
      skatedMessages: 1,
      states: ['VT'],
      waterBodyId: body,
      status: 'open',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const request = await ctx.db.insert('waterBodyRequests', {
      kind: 'name_landmark',
      status: 'open',
      requesterId: skater,
      coord: { lat: 44.4, lng: -73.1 },
      waterBodyId: body,
      name: 'Long Point',
      createdAt: NOW,
    });
    return { body, placeName, request };
  });
  return { t, ...ids, as: t.withIdentity({ subject: 'mod' }) };
}

const landmarkCount = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => (await ctx.db.query('bodyLandmarks').collect()).length);

describe('landmarks.create, placing an ask', () => {
  test('an emailed name needs corpus.placeNames too, and nothing is written without it', async () => {
    const { t, as, body, placeName } = await seed();
    raise('corpus.placeNames');
    await expect(
      as.mutation(api.landmarks.create, {
        waterBodyId: body,
        name: 'The Narrows',
        kind: 'narrows',
        point: { lat: 44.5, lng: -73.0 },
        corpusNameId: placeName,
      }),
    ).rejects.toThrow('Requires admin role');
    expect(await landmarkCount(t)).toBe(0);
    expect((await t.run((ctx) => ctx.db.get(placeName)))?.status).toBe('open');
    // The same drop with no emailed name behind it is the landmark's own capability alone.
    await as.mutation(api.landmarks.create, {
      waterBodyId: body,
      name: 'The Narrows',
      kind: 'narrows',
      point: { lat: 44.5, lng: -73.0 },
    });
    expect(await landmarkCount(t)).toBe(1);
  });

  test('a skater’s proposal needs inbox.request too, and nothing is written without it', async () => {
    const { t, as, body, request } = await seed();
    raise('inbox.request');
    await expect(
      as.mutation(api.landmarks.create, {
        waterBodyId: body,
        name: 'Long Point',
        kind: 'point',
        point: { lat: 44.4, lng: -73.1 },
        requestId: request,
      }),
    ).rejects.toThrow('Requires admin role');
    expect(await landmarkCount(t)).toBe(0);
    expect((await t.run((ctx) => ctx.db.get(request)))?.status).toBe('open');
    await as.mutation(api.landmarks.create, {
      waterBodyId: body,
      name: 'Long Point',
      kind: 'point',
      point: { lat: 44.4, lng: -73.1 },
    });
    expect(await landmarkCount(t)).toBe(1);
  });

  test('a moderator holding every capability places both, and each ask is decided', async () => {
    const { t, as, body, placeName, request } = await seed();
    await as.mutation(api.landmarks.create, {
      waterBodyId: body,
      name: 'The Narrows',
      kind: 'narrows',
      point: { lat: 44.5, lng: -73.0 },
      corpusNameId: placeName,
    });
    await as.mutation(api.landmarks.create, {
      waterBodyId: body,
      name: 'Long Point',
      kind: 'point',
      point: { lat: 44.4, lng: -73.1 },
      requestId: request,
    });
    expect(await landmarkCount(t)).toBe(2);
    expect((await t.run((ctx) => ctx.db.get(placeName)))?.status).toBe('placed');
    expect((await t.run((ctx) => ctx.db.get(request)))?.status).toBe('approved');
  });
});
