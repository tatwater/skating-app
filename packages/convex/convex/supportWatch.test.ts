/**
 * **A reply's send that dies** (B01-5f review). Convex runs a scheduled action at most once and never
 * retries it, so each reply's watch (`support.watchReply`) settles one its send left: not claimed → the
 * send again (at most one email, by the claim), then `sendFailed`; claimed with no answer → once the
 * claim is older than an action can run, `outcomeUnknown` — may or may not have been sent, said as
 * that, never resent. A late answer from the same claim wins.
 *
 * Only `claimReply` writes before the send's answer, so a death after the claim — before the address,
 * before the provider, after the provider took it — leaves one state: the claim alone. Each is that
 * state; the last with the email really taken first.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { SETTLE_MS } from './lib/notificationQueue';
import {
  REPLY_OUTCOME_UNKNOWN_REFUSAL,
  REPLY_SEND_ATTEMPTS,
  REPLY_SENDING_REFUSAL,
  REPLY_WATCH_MS,
  SEND_ACTION_LIMIT_MS,
} from './lib/supportThread';
import { undoState } from './lib/undo';
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
  const person = async (subject: string, role: 'member' | 'admin', email?: string) => {
    const id = await t.run((ctx) =>
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
        ...(email ? { email } : {}),
      }),
    );
    return { id, as: t.withIdentity({ subject }) };
  };
  const admin = await person('admin', 'admin');
  const skater = await person('skater', 'member', 'skater@example.test');
  const ticketId = await skater.as.mutation(api.support.create, { category: 'bug', body: 'x' });
  const reply = (body = 'Hello') => admin.as.mutation(api.support.reply, { ticketId, body });
  const message = (id: Id<'supportMessages'>) =>
    t.run((ctx) => ctx.db.get(id)) as Promise<Doc<'supportMessages'>>;
  const watch = (messageId: Id<'supportMessages'>, attempt = 1) =>
    t.mutation(internal.support.watchReply, { messageId, attempt });
  const cancelWords = async (messageId: Id<'supportMessages'>) => {
    try {
      await admin.as.mutation(api.support.cancelReply, { messageId });
      return null;
    } catch (err) {
      return String((err as { data?: unknown }).data);
    }
  };
  return { t, admin, skater, ticketId, reply, message, watch, cancelWords };
}

const mails: string[] = [];
function stubResend() {
  mails.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('api.resend.com')) mails.push(JSON.parse(String(init?.body)).text as string);
      return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-12-01T12:00:00Z'));
  vi.stubEnv('RESEND_API_KEY', 're_test_placeholder');
  vi.stubEnv('SUPPORT_FROM_EMAIL', 'Gli Support <support@example.test>');
  stubResend();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('a claimed reply whose send died', () => {
  test('is watched again until an action could no longer be running, then reads outcomeUnknown — never resent', async () => {
    const w = await world();
    const out = await w.reply();
    // Each reply that will go has its watch scheduled beside its send.
    const jobs = await w.t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    expect(jobs.filter((j) => /support(\.js)?:watchReply$/.test(j.name))).toHaveLength(1);
    vi.setSystemTime(out.sendAfter + 1000);
    const claim = await w.t.mutation(internal.support.claimReply, { messageId: out.messageId });
    expect(claim).not.toBeNull();
    // The send dies here. The first watch is too soon after the claim: watched again, unmarked.
    vi.setSystemTime(out.sendAfter + REPLY_WATCH_MS);
    await w.watch(out.messageId);
    expect((await w.message(out.messageId)).status).toBe('settling');
    expect(await w.cancelWords(out.messageId)).toBe(REPLY_SENDING_REFUSAL);
    // Past what an action can run: may or may not have been sent.
    vi.setSystemTime((claim?.claimedAt as number) + SEND_ACTION_LIMIT_MS);
    await w.watch(out.messageId);
    expect(await w.message(out.messageId)).toMatchObject({
      status: 'failed',
      failedWhy: 'outcomeUnknown',
    });
    expect(await w.cancelWords(out.messageId)).toBe(REPLY_OUTCOME_UNKNOWN_REFUSAL);
    // Every scheduled send and watch run to the end: nothing resends it.
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(mails).toEqual([]);
    expect((await w.message(out.messageId)).failedWhy).toBe('outcomeUnknown');
  });

  test('after the provider took it (the answer lost): outcomeUnknown, and still exactly one email', async () => {
    const w = await world();
    const out = await w.reply('Taken by the provider');
    vi.setSystemTime(out.sendAfter + 1000);
    await w.t.action(internal.support.sendReply, { messageId: out.messageId });
    expect(mails).toHaveLength(1);
    // The answer never landed: the row as the claim alone left it.
    const claimedAt = Date.now() - 500;
    await w.t.run((ctx) =>
      ctx.db.patch(out.messageId, { status: 'settling', sentAt: claimedAt, failedWhy: undefined }),
    );
    vi.setSystemTime(claimedAt + SEND_ACTION_LIMIT_MS);
    await w.watch(out.messageId);
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await w.message(out.messageId)).failedWhy).toBe('outcomeUnknown');
    expect(mails).toHaveLength(1);
  });

  test('a late answer from the same claim wins over the watch; another claim’s answer is ignored', async () => {
    const w = await world();
    const out = await w.reply();
    vi.setSystemTime(out.sendAfter + 1000);
    const claim = await w.t.mutation(internal.support.claimReply, { messageId: out.messageId });
    const claimedAt = claim?.claimedAt as number;
    vi.setSystemTime(claimedAt + SEND_ACTION_LIMIT_MS);
    await w.watch(out.messageId);
    expect((await w.message(out.messageId)).failedWhy).toBe('outcomeUnknown');
    await w.t.mutation(internal.support.replySent, {
      messageId: out.messageId,
      claimedAt: claimedAt + 1,
    });
    expect((await w.message(out.messageId)).failedWhy).toBe('outcomeUnknown');
    await w.t.mutation(internal.support.replySent, { messageId: out.messageId, claimedAt });
    const sent = await w.message(out.messageId);
    expect(sent.status).toBe('sent');
    expect(sent.failedWhy).toBeUndefined();

    const two = await w.reply('Second');
    vi.setSystemTime(two.sendAfter + 1000);
    const c2 = await w.t.mutation(internal.support.claimReply, { messageId: two.messageId });
    vi.setSystemTime((c2?.claimedAt as number) + SEND_ACTION_LIMIT_MS);
    await w.watch(two.messageId);
    await w.t.mutation(internal.support.replyFailed, {
      messageId: two.messageId,
      claimedAt: c2?.claimedAt as number,
      why: 'noAddress',
    });
    expect(await w.message(two.messageId)).toMatchObject({
      status: 'failed',
      failedWhy: 'noAddress',
    });
  });

  test('the thread, the undo offer and the export say outcomeUnknown as that', async () => {
    const w = await world();
    const out = await w.reply('Maybe went');
    vi.setSystemTime(out.sendAfter + 1000);
    const claim = await w.t.mutation(internal.support.claimReply, { messageId: out.messageId });
    vi.setSystemTime((claim?.claimedAt as number) + SEND_ACTION_LIMIT_MS);
    await w.watch(out.messageId);
    const read = await w.admin.as.query(api.inbox.item, { ref: `ticket:${w.ticketId}` });
    if (read.item?.kind !== 'ticket') throw new Error('not a ticket');
    expect(read.item.messages[0]?.reply).toMatchObject({
      status: 'failed',
      failedWhy: 'outcomeUnknown',
      sentAt: null,
      cancel: REPLY_OUTCOME_UNKNOWN_REFUSAL,
    });
    const offer = await w.t.run(async (ctx) =>
      undoState(
        ctx,
        (await ctx.db.get(w.admin.id)) as Doc<'profiles'>,
        (await ctx.db.get(out.actionId)) as Doc<'moderationActions'>,
        'one',
      ),
    );
    expect(offer).toEqual({ state: 'unavailable', why: REPLY_OUTCOME_UNKNOWN_REFUSAL });
    const data = await w.t.query(internal.dataExport.collect, { userId: w.skater.id });
    expect(data.supportTickets[0]?.replies).toEqual([
      { body: 'Maybe went', sentAt: null, delivery: 'unknown' },
    ]);
  });
});

describe('a reply no send ever claimed', () => {
  test('its watch schedules the send again — one email, however many sends then run', async () => {
    const w = await world();
    const out = await w.reply('Never claimed');
    // The scheduled send never runs (a deploy took it): canceled under the scheduler.
    await w.t.run(async (ctx) => {
      for (const job of await ctx.db.system.query('_scheduled_functions').collect()) {
        if (/support(\.js)?:sendReply$/.test(job.name)) await ctx.scheduler.cancel(job._id);
      }
    });
    vi.setSystemTime(out.sendAfter + REPLY_WATCH_MS);
    await w.watch(out.messageId);
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(mails).toEqual([expect.stringContaining('Never claimed')]);
    expect((await w.message(out.messageId)).status).toBe('sent');
  });

  test(`after ${REPLY_SEND_ATTEMPTS} watches with no claim, failed (sendFailed): it never went`, async () => {
    const w = await world();
    const out = await w.reply();
    vi.setSystemTime(out.sendAfter + REPLY_WATCH_MS);
    await w.watch(out.messageId, REPLY_SEND_ATTEMPTS);
    expect(await w.message(out.messageId)).toMatchObject({
      status: 'failed',
      failedWhy: 'sendFailed',
    });
    // Watches of a reply that settled do nothing.
    await w.watch(out.messageId);
    expect((await w.message(out.messageId)).failedWhy).toBe('sendFailed');
  });

  test('a reply sent or canceled is left alone by its watch', async () => {
    const w = await world();
    const sent = await w.reply('Goes');
    const gone = await w.reply('Canceled');
    await w.admin.as.mutation(api.support.cancelReply, { messageId: gone.messageId });
    vi.setSystemTime(sent.sendAfter + SETTLE_MS + REPLY_WATCH_MS * 4);
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await w.message(sent.messageId)).status).toBe('sent');
    expect((await w.message(gone.messageId)).status).toBe('canceled');
    expect(mails).toHaveLength(1);
  });
});
