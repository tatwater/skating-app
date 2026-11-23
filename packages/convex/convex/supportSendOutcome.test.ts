/**
 * **What became of a reply's send, three ways** (B01-5f, Greptile on #175): Resend accepting →
 * `sent`; a definite refusal (a 4xx, a 429 past its retries) → `failed` (`sendFailed`); a request that
 * may have gone with no trustworthy answer (a thrown fetch, a timeout, a 5xx, a 409) →
 * `outcomeUnknown` — never read as "not sent", never resent by itself. Each through the scheduled send,
 * with Resend stubbed; every request carries the reply's idempotency key. And the Clerk fallback: a
 * lookup that errored is no "no address" — the claim is let go and the watch tries again.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { SETTLE_MS } from './lib/notificationQueue';
import { SEND_TIMEOUT_MS, sendEmail, sendEmailOutcome } from './lib/resend';
import { REPLY_SEND_ATTEMPTS, REPLY_WATCH_MS } from './lib/supportThread';
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

/** Each Resend request seen: its idempotency key. */
const requests: (string | null)[] = [];
type Answer = number | 'throw' | 'hang';

/** Resend answers each request in turn from `answers` (the last repeats); Clerk as `clerk` says. */
function stubFetch(answers: Answer[], clerk: number | 'throw' = 200) {
  requests.length = 0;
  let n = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('api.clerk.com')) {
        if (clerk === 'throw') return Promise.reject(new TypeError('fetch failed'));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              primary_email_address_id: 'e1',
              email_addresses: [{ id: 'e1', email_address: 'early@example.test' }],
            }),
            { status: clerk },
          ),
        );
      }
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push(headers['Idempotency-Key'] ?? null);
      const answer = answers[Math.min(n++, answers.length - 1)] as Answer;
      if (answer === 'throw') return Promise.reject(new TypeError('fetch failed'));
      if (answer === 'hang') {
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ id: 'x' }), {
          status: answer,
          headers: { 'retry-after': '1' },
        }),
      );
    }),
  );
}

async function world(subject = 'skater', email: string | null = 'skater@example.test') {
  const t = convexTest(schema, modules);
  const person = async (who: string, role: 'member' | 'admin', mail?: string) => {
    await t.run((ctx) =>
      ctx.db.insert('profiles', {
        clerkUserId: who,
        displayName: `${who} Test-Person`,
        username: who,
        driveTimePrefMinutes: 60,
        profileVisibility: 'public' as const,
        notificationPrefs: PREFS,
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role,
        status: 'active' as const,
        createdAt: Date.now(),
        ...(mail ? { email: mail } : {}),
      }),
    );
    return t.withIdentity({ subject: who });
  };
  const admin = await person('admin', 'admin');
  const filer =
    email === null ? t.withIdentity({ subject }) : await person(subject, 'member', email);
  const ticketId = await filer.mutation(api.support.create, { category: 'bug', body: 'x' });
  const out = await admin.mutation(api.support.reply, { ticketId, body: 'Hello' });
  const row = () => t.run((ctx) => ctx.db.get(out.messageId)) as Promise<Doc<'supportMessages'>>;
  /** The scheduled send, run at its time — the timers advanced while it runs. */
  const send = async () => {
    vi.setSystemTime(out.sendAfter + 1);
    const running = t.action(internal.support.sendReply, { messageId: out.messageId });
    let done = false;
    running.finally(() => {
      done = true;
    });
    for (let i = 0; i < 60 && !done; i++) await vi.advanceTimersByTimeAsync(1_000);
    await running;
  };
  return { t, admin, out, row, send, messageId: out.messageId as Id<'supportMessages'> };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-12-01T12:00:00Z'));
  vi.stubEnv('RESEND_API_KEY', 're_test_placeholder');
  vi.stubEnv('SUPPORT_FROM_EMAIL', 'support@example.test');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the scheduled send records what became of it', () => {
  test.each([
    { name: 'accepted (200)', answers: [200], status: 'sent', why: undefined, tries: 1 },
    { name: 'refused (400)', answers: [400], status: 'failed', why: 'sendFailed', tries: 1 },
    { name: 'refused (403)', answers: [403], status: 'failed', why: 'sendFailed', tries: 1 },
    { name: 'refused (422)', answers: [422], status: 'failed', why: 'sendFailed', tries: 1 },
    {
      name: 'rate limited past its retries (429)',
      answers: [429],
      status: 'failed',
      why: 'sendFailed',
      tries: 4,
    },
    {
      name: 'rate limited, then accepted',
      answers: [429, 200],
      status: 'sent',
      why: undefined,
      tries: 2,
    },
    {
      name: 'a server error (500)',
      answers: [500],
      status: 'failed',
      why: 'outcomeUnknown',
      tries: 1,
    },
    {
      name: 'unavailable (503)',
      answers: [503],
      status: 'failed',
      why: 'outcomeUnknown',
      tries: 1,
    },
    {
      name: 'an idempotency conflict (409)',
      answers: [409],
      status: 'failed',
      why: 'outcomeUnknown',
      tries: 1,
    },
    {
      name: 'a thrown fetch',
      answers: ['throw'],
      status: 'failed',
      why: 'outcomeUnknown',
      tries: 1,
    },
    { name: 'a timeout', answers: ['hang'], status: 'failed', why: 'outcomeUnknown', tries: 1 },
    {
      name: 'a 429, then a thrown fetch',
      answers: [429, 'throw'],
      status: 'failed',
      why: 'outcomeUnknown',
      tries: 2,
    },
  ] as const)('$name → $status $why', async ({ answers, status, why, tries }) => {
    stubFetch([...answers]);
    const w = await world();
    await w.send();
    const row = await w.row();
    expect(row.status).toBe(status);
    expect(row.failedWhy).toBe(why);
    // Each request carried the reply's own idempotency key.
    expect(requests).toEqual(Array(tries).fill(`support-reply/${w.messageId}`));
    // An unknown outcome is never resent by itself: every scheduled send and watch run to the end.
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(requests).toHaveLength(tries);
    expect((await w.row()).failedWhy).toBe(why);
  });

  test('an unknown outcome keeps its claim: a later answer from that claim still says how it went', async () => {
    stubFetch(['throw']);
    const w = await world();
    await w.send();
    const row = await w.row();
    expect(row).toMatchObject({ status: 'failed', failedWhy: 'outcomeUnknown' });
    expect(row.sentAt).toBeTypeOf('number');
    await w.t.mutation(internal.support.replySent, {
      messageId: w.messageId,
      claimedAt: row.sentAt as number,
    });
    expect((await w.row()).status).toBe('sent');
  });

  test('accepted, then the outcome write lost (the action died): the watch says outcomeUnknown, one email', async () => {
    stubFetch([200]);
    const w = await world();
    vi.setSystemTime(w.out.sendAfter + 1);
    const claim = await w.t.mutation(internal.support.claimReply, { messageId: w.messageId });
    // The provider took it …
    expect(
      await sendEmailOutcome({
        to: 'skater@example.test',
        from: 'support@example.test',
        subject: 's',
        html: 'h',
        text: 't',
        context: 'support reply',
        idempotencyKey: `support-reply/${w.messageId}`,
      }),
    ).toEqual({ kind: 'accepted' });
    // … and `replySent` never ran. The watch, once the claim is older than an action can run.
    vi.setSystemTime((claim?.claimedAt as number) + 12 * 60 * 1000);
    await w.t.mutation(internal.support.watchReply, { messageId: w.messageId, attempt: 1 });
    expect((await w.row()).failedWhy).toBe('outcomeUnknown');
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(requests).toHaveLength(1);
  });
});

describe('the Clerk fallback, three ways', () => {
  test('a lookup that errored is not "no address": the claim is let go, the watch sends again, and it goes', async () => {
    stubFetch([200], 'throw');
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_placeholder');
    const w = await world('user_early', null);
    await w.send();
    const row = await w.row();
    expect(row.status).toBe('settling');
    expect(row.sentAt).toBeUndefined();
    expect(requests).toEqual([]);
    // Clerk answers by the watch's try.
    stubFetch([200], 200);
    vi.setSystemTime(w.out.sendAfter + REPLY_WATCH_MS);
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await w.row()).status).toBe('sent');
    expect(requests).toHaveLength(1);
  });

  test(`an erroring lookup on every try: failed (sendFailed) after ${REPLY_SEND_ATTEMPTS} — nothing sent`, async () => {
    stubFetch([200], 500);
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_placeholder');
    const w = await world('user_early', null);
    vi.setSystemTime(w.out.sendAfter + SETTLE_MS * 60);
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await w.row()).toMatchObject({ status: 'failed', failedWhy: 'sendFailed' });
    expect(requests).toEqual([]);
  });

  test('Clerk says there is no such person (404): failed (noAddress)', async () => {
    stubFetch([200], 404);
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_placeholder');
    const w = await world('user_early', null);
    await w.send();
    expect(await w.row()).toMatchObject({ status: 'failed', failedWhy: 'noAddress' });
  });
});

describe('the other callers keep their boolean', () => {
  test('sendEmail is true only for accepted; its timeout is the outcome’s', async () => {
    vi.stubEnv('RESEND_FROM_EMAIL', 'updates@example.test');
    const mail = {
      to: 'a@example.test',
      subject: 's',
      html: 'h',
      text: 't',
      context: 'operator alert',
    };
    for (const [answer, want] of [
      [200, true],
      [400, false],
      [500, false],
      ['throw', false],
    ] as const) {
      stubFetch([answer]);
      expect(await sendEmail(mail)).toBe(want);
    }
    expect(SEND_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
