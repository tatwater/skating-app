/**
 * **A reply's settle, under random interleavings** (B01-5f, D284). Up to three replies on a ticket,
 * each with an optional cancel at a random moment, its send fired by hand at a random moment past its
 * window (as a late scheduler would), colleagues' notes and a resolve in between — then every
 * scheduled send run to its end, so each reply's send runs at least twice. Whatever the order:
 *
 * - a cancel lands exactly when it comes inside the window, and is refused after it in the policy's
 *   words ("Sent replies can't be unsent");
 * - a reply canceled is never mailed; one not canceled is mailed **once**;
 * - each ends `canceled` or `sent`, never both, never still settling.
 *
 * Runs: {@link RUNS} a seed over three pinned seeds and fast-check's own (a failure prints its seed:
 * pin it in {@link SEEDS} to replay). The 50× run sets `RUNS` to 600 for one go.
 */

import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { SETTLE_MS } from './lib/notificationQueue';
import { SENT_REPLY_REFUSAL } from './lib/supportThread';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const RUNS = 12;
const START = Date.parse('2026-12-01T12:00:00Z');
/** The harness steps its clock a millisecond a transaction: moments are kept clear of the edge. */
const EDGE = 200;

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

/** A moment inside or past a window, never within {@link EDGE} of its end. */
const offset = fc
  .integer({ min: 0, max: 2 * SETTLE_MS })
  .filter((ms) => Math.abs(ms - SETTLE_MS) > EDGE);

const replyPlan = fc.record({
  cancelAt: fc.option(offset, { nil: undefined }),
  sendAt: fc.integer({ min: SETTLE_MS + EDGE, max: SETTLE_MS + 30_000 }),
});

const scenario = fc.record({
  replies: fc.array(replyPlan, { minLength: 1, maxLength: 3 }),
  /** A colleague's note at each of these moments. */
  notes: fc.array(fc.integer({ min: 0, max: 2 * SETTLE_MS }), { maxLength: 2 }),
  /** A colleague resolves the ticket at this moment. */
  resolveAt: fc.option(fc.integer({ min: 0, max: 2 * SETTLE_MS }), { nil: undefined }),
  /** Each reply's own start, spread over a few seconds. */
  gaps: fc.array(fc.integer({ min: 1, max: 5_000 }), { minLength: 3, maxLength: 3 }),
});

type Scenario = typeof scenario extends fc.Arbitrary<infer S> ? S : never;

async function check(s: Scenario) {
  vi.setSystemTime(START);
  const t = convexTest(schema, modules);
  const person = async (subject: string, role: 'member' | 'admin', email?: string) => {
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
        createdAt: START,
        ...(email ? { email } : {}),
      }),
    );
    return t.withIdentity({ subject });
  };
  const admin = await person('admin', 'admin');
  const colleague = await person('colleague', 'admin');
  const skater = await person('skater', 'member', 'skater@example.test');
  const ticketId = await skater.mutation(api.support.create, { category: 'bug', body: 'Broken' });

  const sent: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('api.resend.com')) sent.push(JSON.parse(String(init?.body)).text as string);
      return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
    }),
  );

  // Each reply written at its own start; then every event in time order.
  type Event = { at: number; run: () => Promise<void> };
  const events: Event[] = [];
  const replies: {
    body: string;
    messageId: Id<'supportMessages'>;
    start: number;
    canceled: boolean | null;
  }[] = [];
  let now = START;
  for (const [i, plan] of s.replies.entries()) {
    now += s.gaps[i] ?? 1;
    vi.setSystemTime(now);
    const body = `Reply number ${i}`;
    const out = await admin.mutation(api.support.reply, { ticketId, body });
    const reply = { body, messageId: out.messageId, start: now, canceled: null as boolean | null };
    replies.push(reply);
    if (plan.cancelAt !== undefined) {
      events.push({
        at: now + plan.cancelAt,
        run: async () => {
          try {
            await admin.mutation(api.support.cancelReply, { messageId: out.messageId });
            reply.canceled = true;
          } catch (err) {
            expect(String((err as { data?: unknown }).data)).toBe(SENT_REPLY_REFUSAL);
            reply.canceled = false;
          }
        },
      });
    }
    events.push({
      at: now + plan.sendAt,
      run: async () => {
        await t.action(internal.support.sendReply, { messageId: out.messageId });
      },
    });
  }
  for (const at of s.notes) {
    events.push({
      at: START + at,
      run: async () => {
        await colleague.mutation(api.support.addNote, { ticketId, body: 'Seen' }).catch(() => {});
      },
    });
  }
  if (s.resolveAt !== undefined) {
    events.push({
      at: START + s.resolveAt,
      run: async () => {
        await colleague.mutation(api.support.resolve, { ticketId }).catch(() => {});
      },
    });
  }
  events.sort((a, b) => a.at - b.at);
  for (const e of events) {
    vi.setSystemTime(Math.max(e.at, Date.now()));
    await e.run();
  }
  // Every scheduled send now runs too: each reply's send runs a second time, and must do nothing.
  vi.setSystemTime(Date.now() + 2 * SETTLE_MS);
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  for (const [i, r] of replies.entries()) {
    const plan = s.replies[i] as Scenario['replies'][number];
    const row = await t.run((ctx) => ctx.db.get(r.messageId));
    const inWindow = plan.cancelAt !== undefined && plan.cancelAt < SETTLE_MS;
    // The cancel lands exactly inside the window.
    if (plan.cancelAt !== undefined) expect(r.canceled, `reply ${i}`).toBe(inWindow);
    const mailed = sent.filter((text) => text.startsWith(r.body)).length;
    if (inWindow) {
      expect(row?.status).toBe('canceled');
      expect(mailed).toBe(0);
    } else {
      expect(row?.status).toBe('sent');
      expect(mailed).toBe(1);
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.stubEnv('RESEND_API_KEY', 're_test_placeholder');
  vi.stubEnv('SUPPORT_FROM_EMAIL', 'Gli Support <support@example.test>');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const SEEDS: (number | undefined)[] = [20261122, 3, 7_777, undefined];

describe('a reply settles to canceled or sent, once, whatever the interleaving', () => {
  for (const seed of SEEDS) {
    test(`seed ${seed ?? 'fast-check’s own'}`, async () => {
      await fc.assert(fc.asyncProperty(scenario, check), {
        numRuns: RUNS,
        ...(seed !== undefined ? { seed } : {}),
        endOnFailure: true,
      });
    }, 120_000);
  }
});
