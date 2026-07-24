/**
 * Phase 7 support tickets (D35/D37). Covers the admin-only inbox gate, the key affordance that a
 * suspended/banned user can still file an appeal (create uses getCurrentProfile, not requireProfile),
 * and the two abuse bounds that affordance needs to stay safe: authentication is required, and one
 * account is capped per window (2026-07-24 review).
 */
import geospatial from '@convex-dev/geospatial/test';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

function harness() {
  const t = convexTest(schema, modules);
  geospatial.register(t);
  geospatial.register(t, 'adminAreasGeo');
  return t;
}

async function seed(
  t: ReturnType<typeof convexTest>,
  subject: string,
  role: 'member' | 'admin' = 'member',
  status: 'active' | 'banned' = 'active',
): Promise<Id<'profiles'>> {
  return t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: {
        activityDetected: true,
        bountyRequest: true,
        hazardConfirmation: true,
        bountyFulfilled: true,
        reportRated: true,
        reportCommented: true,
        contentFlagResolved: true,
        favoriteReport: true,
        nearbyReportDigest: false,
        greatReportNearby: false,
      },
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status,
      createdAt: Date.now(),
    }),
  ) as Promise<Id<'profiles'>>;
}

const as = (t: ReturnType<typeof convexTest>, subject: string) => t.withIdentity({ subject });

describe('support.create', () => {
  test('a signed-in user files a ticket with captured context', async () => {
    const t = harness();
    await seed(t, 'user');
    const id = await as(t, 'user').mutation(api.support.create, {
      category: 'bug',
      body: 'map is blank',
      context: { platform: 'web', appVersion: '1.0.0' },
    });
    const ticket = await t.run((ctx) => ctx.db.get(id));
    expect(ticket?.status).toBe('open');
    expect(ticket?.context?.platform).toBe('web');
  });

  test('a BANNED user can still file an appeal (the whole point of not using requireProfile)', async () => {
    const t = harness();
    await seed(t, 'banned', 'member', 'banned');
    const id = await as(t, 'banned').mutation(api.support.create, {
      category: 'account',
      body: 'I think my ban was a mistake, here is context',
    });
    expect(await t.run((ctx) => ctx.db.get(id))).toBeTruthy();
  });

  test('an empty body is rejected', async () => {
    const t = harness();
    await seed(t, 'user');
    await expect(
      as(t, 'user').mutation(api.support.create, { category: 'other', body: '   ' }),
    ).rejects.toThrow(/describe the issue/);
  });

  test('an UNAUTHENTICATED caller cannot file (no anonymous ticket/email flood)', async () => {
    const t = harness();
    await expect(
      t.mutation(api.support.create, { category: 'bug', body: 'anonymous spam' }),
    ).rejects.toThrow(/Sign in/);
    expect(await t.run((ctx) => ctx.db.query('supportTickets').collect())).toHaveLength(0);
  });

  test('a signed-in caller with no profile row yet can file, stamped with their Clerk subject', async () => {
    const t = harness();
    const id = await as(t, 'unprovisioned').mutation(api.support.create, {
      category: 'bug',
      body: 'signup is broken so I have no account',
    });
    const ticket = await t.run((ctx) => ctx.db.get(id));
    expect(ticket?.userId).toBeUndefined();
    expect(ticket?.clerkUserId).toBe('unprovisioned');
  });

  test('one account is rate-limited after 5 tickets in the window', async () => {
    const t = harness();
    await seed(t, 'noisy');
    for (let i = 0; i < 5; i++) {
      await as(t, 'noisy').mutation(api.support.create, { category: 'bug', body: `issue ${i}` });
    }
    await expect(
      as(t, 'noisy').mutation(api.support.create, { category: 'bug', body: 'issue 6' }),
    ).rejects.toThrow(/several messages recently/);
    expect(await t.run((ctx) => ctx.db.query('supportTickets').collect())).toHaveLength(5);

    // The cap is per submitter, not global — a second account is unaffected.
    await seed(t, 'other');
    await expect(
      as(t, 'other').mutation(api.support.create, { category: 'bug', body: 'my own issue' }),
    ).resolves.toBeTruthy();
  });

  test('the rate limit only counts tickets inside the window', async () => {
    const t = harness();
    await seed(t, 'olduser');
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    await t.run(async (ctx) => {
      for (let i = 0; i < 5; i++) {
        await ctx.db.insert('supportTickets', {
          clerkUserId: 'olduser',
          category: 'bug',
          body: `old ${i}`,
          status: 'open',
          createdAt: dayAgo,
        });
      }
    });
    await expect(
      as(t, 'olduser').mutation(api.support.create, { category: 'bug', body: 'a new issue' }),
    ).resolves.toBeTruthy();
  });
});

describe('support inbox (admin-only, D37 PII)', () => {
  test('a member cannot assign or resolve', async () => {
    const t = harness();
    await seed(t, 'member');
    const user = await seed(t, 'reporter');
    const ticketId = await as(t, 'reporter').mutation(api.support.create, {
      category: 'bug',
      body: 'x is broken',
    });
    void user;
    await expect(as(t, 'member').mutation(api.support.assign, { ticketId })).rejects.toThrow(
      /admin/,
    );
    await expect(as(t, 'member').mutation(api.support.resolve, { ticketId })).rejects.toThrow(
      /admin/,
    );
  });

  test('an admin assigns (open -> in_progress) then resolves', async () => {
    const t = harness();
    const adminId = await seed(t, 'admin', 'admin');
    await seed(t, 'reporter');
    const ticketId = await as(t, 'reporter').mutation(api.support.create, {
      category: 'bug',
      body: 'x is broken',
    });

    await as(t, 'admin').mutation(api.support.assign, { ticketId });
    let ticket = await t.run((ctx) => ctx.db.get(ticketId));
    expect(ticket?.status).toBe('in_progress');
    expect(ticket?.assignedToUserId).toBe(adminId);

    await as(t, 'admin').mutation(api.support.resolve, { ticketId });
    ticket = await t.run((ctx) => ctx.db.get(ticketId));
    expect(ticket?.status).toBe('resolved');
    expect(ticket?.resolvedByUserId).toBe(adminId);
  });
});
