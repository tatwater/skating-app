/**
 * **A note or reply sent twice** (B01-5f review): Send pressed again across a slow connection. With a
 * client key, the second call on the same ticket answers the first — one row, one send scheduled, the
 * same answer — and writes nothing; without one, as before.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { SETTLE_MS } from './lib/notificationQueue';
import { CLIENT_KEY_REFUSAL, CLIENT_KEY_TAKEN_REFUSAL } from './lib/supportThread';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

const PREFS = {
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

async function world() {
  const t = convexTest(schema, modules);
  const person = async (subject: string, role: 'member' | 'admin') => {
    await t.run((ctx) =>
      ctx.db.insert('profiles', {
        clerkUserId: subject,
        displayName: `${subject} Test-Person`,
        username: subject,
        driveTimePrefMinutes: 60,
        profileVisibility: 'public' as const,
        notificationPrefs: PREFS,
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role,
        status: 'active' as const,
        createdAt: Date.now(),
        email: `${subject}@example.test`,
      }),
    );
    return t.withIdentity({ subject });
  };
  const admin = await person('admin', 'admin');
  const colleague = await person('colleague', 'admin');
  const skater = await person('skater', 'member');
  const ticket = () => skater.mutation(api.support.create, { category: 'bug', body: 'x' });
  const messagesOn = (ticketId: Id<'supportTickets'>) =>
    t.run(async (ctx) =>
      (await ctx.db.query('supportMessages').collect()).filter((m) => m.ticketId === ticketId),
    );
  const sends = () =>
    t.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect()).filter((j) =>
        /support(\.js)?:(sendReply|watchReply)$/.test(j.name),
      ),
    );
  const rows = () =>
    t.run(async (ctx) => (await ctx.db.query('moderationActions').collect()).length);
  return { t, admin, colleague, ticket, messagesOn, sends, rows };
}

const KEY = 'send-7f3a9c21';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-12-01T12:00:00Z'));
  vi.stubEnv('RESEND_API_KEY', 're_test_placeholder');
  vi.stubEnv('SUPPORT_FROM_EMAIL', 'support@example.test');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('support.reply and support.addNote with a client key', () => {
  test('the same key twice on a ticket: one reply, one send and one watch, the same answer', async () => {
    const w = await world();
    const ticketId = await w.ticket();
    const first = await w.admin.mutation(api.support.reply, {
      ticketId,
      body: 'Hi',
      clientKey: KEY,
    });
    const auditRows = await w.rows();
    vi.advanceTimersByTime(5_000);
    const again = await w.admin.mutation(api.support.reply, {
      ticketId,
      body: 'Hi',
      clientKey: KEY,
    });
    expect(again).toEqual(first);
    expect(await w.messagesOn(ticketId)).toHaveLength(1);
    expect((await w.sends()).map((j) => j.name.replace('.js', '')).sort()).toEqual([
      'support:sendReply',
      'support:watchReply',
    ]);
    expect(await w.rows()).toBe(auditRows);
    // Once it went, the repeat answers it as it stands.
    vi.advanceTimersByTime(SETTLE_MS);
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    const later = await w.admin.mutation(api.support.reply, {
      ticketId,
      body: 'Hi',
      clientKey: KEY,
    });
    expect(later).toMatchObject({ messageId: first.messageId, status: 'sent', undoable: false });
    expect(await w.messagesOn(ticketId)).toHaveLength(1);
  });

  test('the same key on another ticket, and no key at all, write as before', async () => {
    const w = await world();
    const a = await w.ticket();
    const b = await w.ticket();
    await w.admin.mutation(api.support.reply, { ticketId: a, body: 'Hi', clientKey: KEY });
    await w.admin.mutation(api.support.reply, { ticketId: b, body: 'Hi', clientKey: KEY });
    expect(await w.messagesOn(a)).toHaveLength(1);
    expect(await w.messagesOn(b)).toHaveLength(1);
    await w.admin.mutation(api.support.reply, { ticketId: a, body: 'Hi' });
    await w.admin.mutation(api.support.reply, { ticketId: a, body: 'Hi' });
    expect(await w.messagesOn(a)).toHaveLength(3);
  });

  test('a note: the same key twice is one note and the same answer', async () => {
    const w = await world();
    const ticketId = await w.ticket();
    const first = await w.admin.mutation(api.support.addNote, {
      ticketId,
      body: 'Seen',
      clientKey: KEY,
    });
    const again = await w.admin.mutation(api.support.addNote, {
      ticketId,
      body: 'Seen',
      clientKey: KEY,
    });
    expect(again).toEqual(first);
    expect(await w.messagesOn(ticketId)).toHaveLength(1);
  });

  test('a key another staffer used, or used for the other kind, is refused; a malformed one too', async () => {
    const w = await world();
    const ticketId = await w.ticket();
    await w.admin.mutation(api.support.addNote, { ticketId, body: 'Seen', clientKey: KEY });
    await expect(
      w.admin.mutation(api.support.reply, { ticketId, body: 'Hi', clientKey: KEY }),
    ).rejects.toThrow(CLIENT_KEY_TAKEN_REFUSAL);
    await expect(
      w.colleague.mutation(api.support.addNote, { ticketId, body: 'Seen', clientKey: KEY }),
    ).rejects.toThrow(CLIENT_KEY_TAKEN_REFUSAL);
    for (const bad of ['short', 'x'.repeat(65), 'has spaces in it', 'semi;colon!']) {
      await expect(
        w.admin.mutation(api.support.addNote, { ticketId, body: 'Seen', clientKey: bad }),
      ).rejects.toThrow(CLIENT_KEY_REFUSAL);
    }
    expect(await w.messagesOn(ticketId)).toHaveLength(1);
  });
});
