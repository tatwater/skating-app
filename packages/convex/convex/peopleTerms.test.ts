/**
 * **One answer for when a person's status terms were set, and why** (B01-4f, the founder's call on a
 * repeat ban): the person page's status note and the list row give the same date and reason after
 * any run of status writes; a repeat that changed nothing moves neither; the rows backfill stamps rows
 * written before the rule (`lib/statusTerms`).
 */
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { markReady, personRowOf, refreshPersonRow } from './lib/peopleRows';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const T0 = Date.UTC(2026, 10, 14, 12);
const DAY = 86_400_000;
type T = ReturnType<typeof convexTest>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

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

async function seed(t: T, subject: string, over: Partial<Doc<'profiles'>> = {}) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: T0 - 30 * DAY,
      ...over,
    });
    await refreshPersonRow(ctx, id);
    return id;
  });
}

async function setup() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await markReady(ctx, 'rows');
    await markReady(ctx, 'flagSubjects');
    await markReady(ctx, 'undoChains');
  });
  return t;
}

const as = (t: T, subject: string) => t.withIdentity({ subject });

/** The page's note and the list row, side by side. */
async function bothAnswers(t: T, id: Id<'profiles'>) {
  const p = await as(t, 'adm').query(api.people.person, { userId: id });
  const row = await t.run((ctx) => personRowOf(ctx, id));
  return { note: p?.statusNote ?? null, row };
}

describe('the page and the list row agree on when the terms were set, and why', () => {
  test('over any run of status writes (property)', async () => {
    type Step = { kind: 'ban' | 'suspend' | 'lift'; reason: 'a' | 'b'; days: 1 | 2 };
    const step: fc.Arbitrary<Step> = fc.record({
      kind: fc.constantFrom('ban' as const, 'suspend' as const, 'lift' as const),
      reason: fc.constantFrom('a' as const, 'b' as const),
      days: fc.constantFrom(1 as const, 2 as const),
    });
    const same = fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 6 }), async (steps) => {
      const t = await setup();
      await seed(t, 'adm', { role: 'admin' });
      const id = await seed(t, 'them');
      let clock = T0;
      for (const s of steps) {
        clock += 60_000;
        vi.setSystemTime(clock);
        const a = as(t, 'adm');
        if (s.kind === 'ban')
          await a.mutation(api.moderation.banUser, { userId: id, reason: s.reason });
        else if (s.kind === 'suspend')
          await a.mutation(api.moderation.suspendUser, {
            userId: id,
            reason: s.reason,
            suspendedUntil: T0 + s.days * DAY,
          });
        else await a.mutation(api.moderation.unbanUser, { userId: id });
      }
      const { note, row } = await bothAnswers(t, id);
      const person = (await t.run((ctx) => ctx.db.get(id))) as Doc<'profiles'>;
      if (person.status === 'active') {
        expect(note).toBeNull();
        return;
      }
      // The write that set the terms as they stand: the last step that changed them.
      expect(note?.atCapped).toBe(false);
      expect(note?.at).toBe(row?.statusSince);
      expect(note?.reason).toBe(person.statusReason);
      expect(row?.statusReason).toBe(person.statusReason);
    });
    // Pinned seeds, so a failure replays; then one run on a fresh seed.
    for (const seed of [20261116, 3]) await fc.assert(same, { seed, numRuns: 8 });
    await fc.assert(same, { numRuns: 4 });
  });
});

describe('the rows backfill stamps a row written before the rule', () => {
  test('a repeat ban with a new reason, written as before: the row is dated by it after the backfill', async () => {
    const t = await setup();
    const adm = await seed(t, 'adm', { role: 'admin' });
    const id = await seed(t, 'them');
    vi.setSystemTime(T0 - 3 * DAY);
    await as(t, 'adm').mutation(api.moderation.banUser, { userId: id, reason: 'first' });
    // A second ban as the old writer left it: its row and the profile's reason, the list row's date
    // still the first ban's.
    await t.run(async (ctx) => {
      await ctx.db.patch(id, { statusReason: 'again' });
      await ctx.db.insert('moderationActions', {
        actorId: adm,
        action: 'ban',
        targetType: 'user',
        targetId: id,
        reason: 'again',
        metadata: { prev: { status: 'banned', statusReason: 'first', suspendedUntil: null } },
        createdAt: T0 - DAY,
      });
      await refreshPersonRow(ctx, id);
    });
    vi.setSystemTime(T0);
    let both = await bothAnswers(t, id);
    expect(both.note).toMatchObject({ at: T0 - DAY, reason: 'again' });
    expect(both.row?.statusSince).toBe(T0 - 3 * DAY);
    await t.mutation(internal.peopleJobs.backfillRows, { alone: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    both = await bothAnswers(t, id);
    expect(both.row?.statusSince).toBe(T0 - DAY);
    expect(both.note?.at).toBe(both.row?.statusSince);
  });

  test('a person with nothing on record reads "not recorded" on the row, as the note does', async () => {
    const t = await setup();
    await seed(t, 'adm', { role: 'admin' });
    const id = await seed(t, 'them', { status: 'banned', statusReason: 'old' });
    await t.run(async (ctx) => {
      const row = await personRowOf(ctx, id);
      if (row) await ctx.db.patch(row._id, { statusSince: T0 - 9 * DAY });
    });
    await t.mutation(internal.peopleJobs.backfillRows, { alone: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const both = await bothAnswers(t, id);
    expect(both.note).toMatchObject({ at: null, atCapped: false });
    expect(both.row?.statusSince).toBe(0);
  });
});

describe('an undo of a terms change puts the prior terms back — the reason included', () => {
  test('ban "a", ban "b", undo: banned "a" again, on the page and the row; the undo row keeps its own reason; redo brings "b" back', async () => {
    const t = await setup();
    await seed(t, 'adm', { role: 'admin' });
    const id = await seed(t, 'them');
    const a = as(t, 'adm');
    vi.setSystemTime(T0 - 3 * DAY);
    await a.mutation(api.moderation.banUser, { userId: id, reason: 'a' });
    vi.setSystemTime(T0 - 2 * DAY);
    const second = (await a.mutation(api.moderation.banUser, { userId: id, reason: 'b' })) as {
      actionId: Id<'moderationActions'>;
    };
    vi.setSystemTime(T0 - DAY);
    await a.mutation(api.undo.run, { actionId: second.actionId, reason: 'oops' });
    let both = await bothAnswers(t, id);
    expect(both.note).toMatchObject({ reason: 'a', at: T0 - DAY });
    expect(both.row).toMatchObject({ statusReason: 'a', statusSince: T0 - DAY });
    const undoRow = await t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_undoes', (q) => q.eq('undoesActionId', second.actionId))
        .first(),
    );
    expect(undoRow?.reason).toBe('oops');
    // Redo: the undo undone puts "b" back, dated anew.
    vi.setSystemTime(T0);
    await a.mutation(api.undo.run, {
      actionId: undoRow?._id as Id<'moderationActions'>,
      reason: 'redo',
    });
    both = await bothAnswers(t, id);
    expect(both.note).toMatchObject({ reason: 'b', at: T0 });
    expect(both.row).toMatchObject({ statusReason: 'b', statusSince: T0 });
  });
});
