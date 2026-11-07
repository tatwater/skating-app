import { RISK_ACK_VERSION } from '@skating/core';
import { ConvexError } from 'convex/values';
import { convexTest } from 'convex-test';
import { describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import {
  PROFILE_LAKE_SCAN_CAP,
  USERNAME_CHANGE_COOLDOWN_MS,
  usernameCooldownMessage,
} from './profiles';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

const ADULT_DOB = Date.UTC(new Date().getUTCFullYear() - 40, 0, 1);

async function onboard(t: ReturnType<typeof convexTest>, subject: string, username: string) {
  const as = t.withIdentity({ subject });
  const id = await as.mutation(api.profiles.upsertFromClerk, {
    displayName: subject,
    username,
    dateOfBirth: ADULT_DOB,
    riskAckVersion: RISK_ACK_VERSION,
  });
  return { id, as };
}

describe('profiles.usernameAvailable (B03 §11)', () => {
  test('needs a signed-in identity', async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.profiles.usernameAvailable, { username: 'ada' })).rejects.toThrow(
      /not authenticated/i,
    );
  });

  test('answers before the profile exists — onboarding asks first', async () => {
    const t = convexTest(schema, modules);
    const fresh = t.withIdentity({ subject: 'clerk_new' });
    expect(await fresh.query(api.profiles.usernameAvailable, { username: '  Ada_K ' })).toEqual({
      username: 'ada_k',
      available: true,
    });
  });

  test('a name another account holds is taken, case-insensitively', async () => {
    const t = convexTest(schema, modules);
    await onboard(t, 'clerk_ada', 'ada');
    const bob = t.withIdentity({ subject: 'clerk_bob' });
    expect(await bob.query(api.profiles.usernameAvailable, { username: 'ADA' })).toEqual({
      username: 'ada',
      available: false,
      reason: 'taken',
    });
  });

  test('a malformed name is refused for its shape, before anyone is looked up', async () => {
    const t = convexTest(schema, modules);
    const bob = t.withIdentity({ subject: 'clerk_bob' });
    expect(await bob.query(api.profiles.usernameAvailable, { username: 'a!' })).toEqual({
      username: 'a!',
      available: false,
      reason: 'invalid',
    });
  });

  test('your own handle is yours: available, and marked current', async () => {
    const t = convexTest(schema, modules);
    const { as } = await onboard(t, 'clerk_ada', 'ada');
    expect(await as.query(api.profiles.usernameAvailable, { username: 'Ada' })).toEqual({
      username: 'ada',
      available: true,
      current: true,
    });
  });

  test("a ghost's handle stays reserved through the deletion window (D62)", async () => {
    const t = convexTest(schema, modules);
    const { id } = await onboard(t, 'clerk_ada', 'ada');
    await t.run((ctx) => ctx.db.patch(id, { deletionRequestedAt: Date.now() }));
    const bob = t.withIdentity({ subject: 'clerk_bob' });
    const answer = await bob.query(api.profiles.usernameAvailable, { username: 'ada' });
    expect(answer.available).toBe(false);
  });
});

describe('profiles.changeUsername (B03 §11)', () => {
  test('renames the caller, storing the canonical form', async () => {
    const t = convexTest(schema, modules);
    const { as } = await onboard(t, 'clerk_ada', 'ada');
    expect(await as.mutation(api.profiles.changeUsername, { username: ' Ada_Lovelace ' })).toEqual({
      username: 'ada_lovelace',
    });
    expect((await as.query(api.profiles.current, {}))?.username).toBe('ada_lovelace');
    // The old handle is free again, to anyone.
    const bob = t.withIdentity({ subject: 'clerk_bob' });
    expect((await bob.query(api.profiles.usernameAvailable, { username: 'ada' })).available).toBe(
      true,
    );
  });

  test('keeping the same name is a no-op, not a collision with yourself', async () => {
    const t = convexTest(schema, modules);
    const { as } = await onboard(t, 'clerk_ada', 'ada');
    expect(await as.mutation(api.profiles.changeUsername, { username: 'ADA' })).toEqual({
      username: 'ada',
    });
  });

  test('refuses a taken or malformed name with the same words onboarding uses', async () => {
    const t = convexTest(schema, modules);
    await onboard(t, 'clerk_ada', 'ada');
    const { as: bob } = await onboard(t, 'clerk_bob', 'bob');
    await expect(bob.mutation(api.profiles.changeUsername, { username: 'Ada' })).rejects.toThrow(
      /already taken/i,
    );
    await expect(bob.mutation(api.profiles.changeUsername, { username: 'no' })).rejects.toThrow(
      /3–30 characters/,
    );
    expect((await bob.query(api.profiles.current, {}))?.username).toBe('bob');
  });

  test('a ghost cannot trade away the handle the deletion window reserves (D62)', async () => {
    const t = convexTest(schema, modules);
    const { id, as } = await onboard(t, 'clerk_ada', 'ada');
    await t.run((ctx) => ctx.db.patch(id, { deletionRequestedAt: Date.now() }));
    await expect(as.mutation(api.profiles.changeUsername, { username: 'ada2' })).rejects.toThrow();
  });

  test('a banned account cannot rename to slip a moderation action (D37)', async () => {
    const t = convexTest(schema, modules);
    const { id, as } = await onboard(t, 'clerk_ada', 'ada');
    await t.run((ctx) => ctx.db.patch(id, { status: 'banned' }));
    await expect(as.mutation(api.profiles.changeUsername, { username: 'ada2' })).rejects.toThrow();
  });
});

describe('profiles.changeUsername — one rename per 30 days', () => {
  const T0 = Date.UTC(2026, 10, 8, 15, 0);

  async function renamedAt(t: ReturnType<typeof convexTest>) {
    vi.useFakeTimers({ now: T0 });
    const { id, as } = await onboard(t, 'clerk_ada', 'ada');
    // The handle picked at onboarding starts no cooldown: the first rename goes through at once.
    expect(await as.mutation(api.profiles.changeUsername, { username: 'ada2' })).toEqual({
      username: 'ada2',
    });
    expect((await t.run((ctx) => ctx.db.get(id)))?.usernameChangedAt).toBe(T0);
    return { id, as };
  }

  test('refuses a second rename a moment before the 30 days are up, saying when it unlocks', async () => {
    const t = convexTest(schema, modules);
    try {
      const { as } = await renamedAt(t);
      vi.setSystemTime(T0 + USERNAME_CHANGE_COOLDOWN_MS - 1);
      const refusal = await as
        .mutation(api.profiles.changeUsername, { username: 'ada3' })
        .catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(ConvexError);
      expect(
        (refusal as ConvexError<{ code: string; message: string; unlocksAt: number }>).data,
      ).toEqual({
        code: 'username_cooldown',
        message:
          'You can change your username once every 30 days. You can change it again on December 8, 2026.',
        unlocksAt: T0 + USERNAME_CHANGE_COOLDOWN_MS,
      });
      expect((await as.query(api.profiles.current, {}))?.username).toBe('ada2');
      // Re-saving the name you have is not a rename, and is never refused.
      expect(await as.mutation(api.profiles.changeUsername, { username: 'ADA2' })).toEqual({
        username: 'ada2',
      });
      // Asking whether a name is free is unaffected.
      expect((await as.query(api.profiles.usernameAvailable, { username: 'ada3' })).available).toBe(
        true,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test('allows the next rename at exactly 30 days, and that one starts a new cooldown', async () => {
    const t = convexTest(schema, modules);
    try {
      const { id, as } = await renamedAt(t);
      const unlock = T0 + USERNAME_CHANGE_COOLDOWN_MS;
      vi.setSystemTime(unlock);
      expect(await as.mutation(api.profiles.changeUsername, { username: 'ada3' })).toEqual({
        username: 'ada3',
      });
      expect((await t.run((ctx) => ctx.db.get(id)))?.usernameChangedAt).toBe(unlock);
      vi.setSystemTime(unlock + 1);
      await expect(as.mutation(api.profiles.changeUsername, { username: 'ada4' })).rejects.toThrow(
        /once every 30 days/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test('names the unlock day in the skater’s own zone', async () => {
    const t = convexTest(schema, modules);
    try {
      const { id, as } = await renamedAt(t);
      // 01:30 UTC on the unlock instant is still the evening before in Los Angeles.
      const lateUtc = Date.UTC(2026, 10, 9, 1, 30);
      await t.run((ctx) =>
        ctx.db.patch(id, {
          usernameChangedAt: lateUtc - USERNAME_CHANGE_COOLDOWN_MS + 1_000,
          timezone: 'America/Los_Angeles',
        }),
      );
      vi.setSystemTime(lateUtc - USERNAME_CHANGE_COOLDOWN_MS + 2_000);
      await expect(as.mutation(api.profiles.changeUsername, { username: 'ada3' })).rejects.toThrow(
        /again on November 8, 2026\./,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test('re-running onboarding with a new handle is a rename, under the same cooldown', async () => {
    const t = convexTest(schema, modules);
    try {
      const { id, as } = await renamedAt(t);
      const resync = (username: string) =>
        as.mutation(api.profiles.upsertFromClerk, {
          displayName: 'clerk_ada',
          username,
          dateOfBirth: ADULT_DOB,
          riskAckVersion: RISK_ACK_VERSION,
        });
      vi.setSystemTime(T0 + 1_000);
      // The same handle re-synced is not a rename.
      await expect(resync('ada2')).resolves.toBe(id);
      await expect(resync('ada3')).rejects.toThrow(/once every 30 days/);
      expect((await t.run((ctx) => ctx.db.get(id)))?.username).toBe('ada2');
      vi.setSystemTime(T0 + USERNAME_CHANGE_COOLDOWN_MS);
      await expect(resync('ada3')).resolves.toBe(id);
      const row = await t.run((ctx) => ctx.db.get(id));
      expect(row?.username).toBe('ada3');
      expect(row?.usernameChangedAt).toBe(T0 + USERNAME_CHANGE_COOLDOWN_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  test('the message names the day in the zone it is given', () => {
    expect(usernameCooldownMessage(Date.UTC(2026, 11, 8, 3, 0), 'America/New_York')).toMatch(
      /December 7, 2026\.$/,
    );
  });
});

describe('profiles.getPublicProfile — distinct lakes (B03 §11)', () => {
  test('counts the distinct lakes across visible reports, and says when it stopped short', async () => {
    const t = convexTest(schema, modules);
    const { id } = await onboard(t, 'clerk_ada', 'ada');
    const bodies = await t.run(async (ctx) => {
      const out = [];
      for (const name of ['A', 'B', 'C']) {
        out.push(
          await ctx.db.insert('waterBodies', {
            source: 'osm',
            name,
            searchText: name,
            type: 'lakePond',
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
            bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
            centroid: { lat: 0.5, lng: 0.5 },
            dedupStatus: 'clean',
            createdAt: Date.now(),
          }),
        );
      }
      return out;
    });
    const report = (waterBodyId: (typeof bodies)[number], extra: Record<string, unknown> = {}) =>
      t.run((ctx) =>
        ctx.db.insert('reports', {
          authorId: id,
          waterBodyId,
          point: { lat: 0.5, lng: 0.5 },
          skateEndTime: Date.now(),
          reportTime: Date.now(),
          source: 'native',
          iceTypes: [],
          surfaceTags: [],
          photoIds: [],
          hazardIdsCreated: [],
          moderationStatus: 'visible',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          ...extra,
        }),
      );
    const [a, b, c] = bodies as [
      (typeof bodies)[number],
      (typeof bodies)[number],
      (typeof bodies)[number],
    ];
    await report(a);
    await report(a);
    await report(b);
    await report(c, { moderationStatus: 'hidden' }); // not on their record
    const profile = await t.query(api.profiles.getPublicProfile, { username: 'ada' });
    expect(profile && !profile.private && profile.lakeCount).toBe(2);
    expect(profile && !profile.private && profile.lakeCountCapped).toBeUndefined();

    await t.run(async (ctx) => {
      for (let i = 0; i < PROFILE_LAKE_SCAN_CAP; i++) {
        await ctx.db.insert('reports', {
          authorId: id,
          waterBodyId: a,
          point: { lat: 0.5, lng: 0.5 },
          skateEndTime: Date.now() + 1,
          reportTime: Date.now(),
          source: 'native',
          iceTypes: [],
          surfaceTags: [],
          photoIds: [],
          hazardIdsCreated: [],
          moderationStatus: 'visible',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const capped = await t.query(api.profiles.getPublicProfile, { username: 'ada' });
    warn.mockRestore();
    expect(capped && !capped.private && capped.lakeCountCapped).toBe(true);
    expect(capped && !capped.private && capped.lakeCount).toBe(1);
  });
});
