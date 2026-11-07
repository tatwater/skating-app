import { RISK_ACK_VERSION } from '@skating/core';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
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
