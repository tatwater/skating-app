/**
 * The People backfills' after-merge procedure, performed literally (B01 §5.7). The `convex run`
 * commands are parsed out of `AFTER_MERGE_PROCEDURE` — the text the phase doc, the roadmap and the PR
 * body quote word for word (`packages/guards` holds them to it) — and run with exactly the function
 * names and argument objects written there, on an empty database and on seeded ones: the normal path,
 * a backfill that fails part-way, a pass that stopped. Each ends with the check all ready and no
 * People read pending. If the docs' text and the code disagree, this fails.
 */
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import * as peopleRows from './lib/peopleRows';
import {
  AFTER_MERGE_PROCEDURE,
  BACKFILL_STALL_MS,
  PEOPLE_BACKFILLS,
  type Preparation,
  refreshPersonRow,
} from './lib/peopleRows';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const T0 = Date.UTC(2026, 10, 14, 12);
type T = ReturnType<typeof convexTest>;

beforeEach(() => {
  vi.useFakeTimers();
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

function profile(subject: string, over: Partial<Doc<'profiles'>> = {}) {
  return {
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
    createdAt: T0 - 30 * 86_400_000,
    ...over,
  };
}

// ── The procedure, as written ──

/** Every `convex run <function> '<arguments>'` in the procedure's text, in order. */
const COMMANDS = [...AFTER_MERGE_PROCEDURE.matchAll(/`convex run (\S+) '([^']*)'`/g)].map((m) => ({
  fn: m[1] as string,
  args: m[2] as string,
}));
const [START, CHECK, RERUN, RESTORE] = COMMANDS as [
  (typeof COMMANDS)[number],
  (typeof COMMANDS)[number],
  (typeof COMMANDS)[number],
  (typeof COMMANDS)[number],
];

/** The functions the procedure names that are queries; every other one is a mutation. */
const QUERIES = new Set(['peopleJobs:preparation']);

/** Run `fn` with `args` exactly as written (placeholders filled in), as `convex run` would. */
// biome-ignore lint/suspicious/noExplicitAny: a function named at run time, as the CLI resolves it
async function run(t: T, fn: string, args: string): Promise<any> {
  const [module, name] = fn.split(':') as [string, string];
  // biome-ignore lint/suspicious/noExplicitAny: the generated reference tree, indexed by name
  const ref = (internal as any)[module][name];
  const parsed = JSON.parse(args);
  return QUERIES.has(fn) ? t.query(ref, parsed) : t.mutation(ref, parsed);
}

const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers, 1_000);

/**
 * Steps 2–5 (step 1 is the deploy, which `convexTest` stands in for): start the chain; check until
 * ready, running every job the check names in `rerun` again as written; then restore each tombstone
 * the logs named.
 */
async function followProcedure(t: T, logged: () => string[]): Promise<Preparation> {
  await run(t, START.fn, START.args);
  return checkUntilReady(t, logged);
}

/** Steps 3–5 alone: what an operator does after a run that didn't end ready. */
async function checkUntilReady(t: T, logged: () => string[]): Promise<Preparation> {
  for (let round = 0; round < 5; round++) {
    await drain(t);
    const state: Preparation = await run(t, CHECK.fn, CHECK.args);
    if (state.ready) break;
    for (const job of state.rerun) await run(t, RERUN.fn.replace('<job>', job), RERUN.args);
  }
  for (const id of logged()) await run(t, RESTORE.fn, RESTORE.args.replace('<id>', id));
  return run(t, CHECK.fn, CHECK.args);
}

/** The ids `backfillRows` logged as overwritten tombstones. */
function tombstoneLog() {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  return () =>
    errors.mock.calls
      .map((c) => /status was overwritten: (\S+)/.exec(String(c[0]))?.[1])
      .filter((id): id is string => id !== undefined);
}

/** Every People read an admin's console makes, each asserted to say nothing is pending or short. */
async function expectNothingPending(t: T, adminId: Id<'profiles'>, subject: string) {
  const as = t.withIdentity({ subject });
  const lanes = await as.query(api.people.lanes, {});
  expect(lanes.pending).toEqual([]);
  for (const l of lanes.lanes) {
    expect({ lane: l.lane, pending: l.pending, reasons: l.reasons }).toEqual({
      lane: l.lane,
      pending: [],
      reasons: [],
    });
    const page = await as.query(api.people.listPage, { lane: l.lane });
    expect({ lane: l.lane, pending: page.pending, partial: page.partial }).toEqual({
      lane: l.lane,
      pending: [],
      partial: false,
    });
  }
  const search = await as.query(api.people.listPage, { lane: 'everyone', search: subject });
  expect(search).toMatchObject({ pending: [], partial: false });
  expect((await as.query(api.people.person, { userId: adminId }))?.pending).toEqual([]);
  expect((await as.query(api.people.history, { userId: adminId }))?.pending).toEqual([]);
  const stats = await as.query(api.people.staffStats, { userId: adminId });
  expect(stats).toMatchObject({ pending: [], tenureCapped: false });
  expect((await as.query(api.people.staffSeason, { userId: adminId }))?.pending).toEqual([]);
  expect((await as.query(api.console.overview, {})).people.pending).toEqual([]);
}

const ALL_READY = {
  ready: true,
  pending: [],
  rerun: [],
  backfills: PEOPLE_BACKFILLS.map(({ backfill, job }) =>
    expect.objectContaining({ backfill, job, ready: true, running: false, failed: 0 }),
  ),
};

test('the procedure’s text parses into the commands it means', () => {
  expect(COMMANDS.map((c) => c.fn)).toEqual([
    PEOPLE_BACKFILLS[0].job,
    'peopleJobs:preparation',
    '<job>',
    'peopleJobs:restoreTombstoneStatus',
  ]);
  expect(AFTER_MERGE_PROCEDURE).toContain('`convex dev --once`');
});

describe('the after-merge procedure, performed as written', () => {
  test('an empty database: the check ends all ready, and so does every read', async () => {
    const t = convexTest(schema, modules);
    const before: Preparation = await run(t, CHECK.fn, CHECK.args);
    expect(before).toMatchObject({
      ready: false,
      pending: PEOPLE_BACKFILLS.map((b) => b.backfill),
      rerun: PEOPLE_BACKFILLS.map((b) => b.job),
    });
    expect(await followProcedure(t, tombstoneLog())).toMatchObject(ALL_READY);
    // The first account, made through the writers after the steps: every read whole.
    const adminId = await t.run(async (ctx) => {
      const id = await ctx.db.insert('profiles', profile('adm', { role: 'admin' }));
      await refreshPersonRow(ctx, id);
      return id;
    });
    await expectNothingPending(t, adminId, 'adm');
  });

  test('a database written before this build: every backfill done, a tombstone restored, every read whole', async () => {
    const t = convexTest(schema, modules);
    // Rows as the old writers left them: profiles with no People row, a flag with no subject, an
    // undo chain with no stored place, and a tombstone a discipline write overwrote.
    const { adminId, broken } = await t.run(async (ctx) => {
      const adminId = await ctx.db.insert('profiles', profile('adm', { role: 'admin' }));
      const skater = await ctx.db.insert('profiles', profile('skater'));
      const broken = await ctx.db.insert(
        'profiles',
        profile('gone', { status: 'banned', deletedAt: T0 - 86_400_000 }),
      );
      await ctx.db.insert('contentFlags', {
        flaggerId: adminId,
        targetType: 'user',
        targetId: skater,
        reason: 'spam',
        status: 'open',
        createdAt: T0 - 1_000,
      });
      const base = { actorId: adminId, targetType: 'user' as const, reason: 'r', targetId: skater };
      const first = await ctx.db.insert('moderationActions', {
        ...base,
        action: 'set_posting_permission',
        createdAt: T0 - 3_000,
      });
      await ctx.db.insert('moderationActions', {
        ...base,
        action: 'set_posting_permission',
        undoesActionId: first,
        createdAt: T0 - 2_000,
      });
      return { adminId, broken };
    });
    const as = t.withIdentity({ subject: 'adm' });
    expect((await as.query(api.people.lanes, {})).pending).toEqual(['rows', 'flagSubjects']);
    expect((await as.query(api.people.staffStats, { userId: adminId }))?.pending).toEqual([
      'undoChains',
    ]);

    const logged = tombstoneLog();
    expect(await followProcedure(t, logged)).toMatchObject(ALL_READY);
    expect(logged()).toEqual([broken]);
    expect((await t.run((ctx) => ctx.db.get(broken)))?.status).toBe('deleted');
    expect(
      (await t.run((ctx) => ctx.db.query('contentFlags').first()))?.subjectUserId,
    ).toBeDefined();
    const undo = await t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .filter((q) => q.neq(q.field('undoesActionId'), undefined))
        .first(),
    );
    expect(undo?.undoRoot).toBeDefined();
    await expectNothingPending(t, adminId, 'adm');
  });

  test('a backfill that fails part-way: the check names it to run again, and the documented re-run makes it ready', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let i = 0; i < 60; i++) await ctx.db.insert('profiles', profile(`s${i}`));
    });
    const logged = tombstoneLog();
    vi.spyOn(peopleRows, 'refreshPersonRow').mockRejectedValueOnce(new Error('poison'));
    await run(t, START.fn, START.args);
    await drain(t);
    const failed: Preparation = await run(t, CHECK.fn, CHECK.args);
    expect(failed).toMatchObject({
      ready: false,
      pending: ['rows'],
      rerun: ['peopleJobs:backfillRows'],
    });
    expect(failed.backfills[0]).toMatchObject({ ready: false, running: false, failed: 1 });
    // The rest of the chain ran regardless, and is ready.
    expect(failed.backfills.slice(1).every((b) => b.ready)).toBe(true);
    // Recovered with the documented re-run only (steps 3–5), not by starting the chain again.
    expect(await checkUntilReady(t, logged)).toMatchObject(ALL_READY);
    expect(await t.run((ctx) => ctx.db.query('peopleRows').collect())).toHaveLength(60);
  });

  test('a chain still running is not named to run again; a pass that stopped is, once stalled', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let i = 0; i < 60; i++) await ctx.db.insert('profiles', profile(`s${i}`));
    });
    // The first pass only: 50 profiles, the next pass scheduled.
    await run(t, START.fn, START.args);
    const running: Preparation = await run(t, CHECK.fn, CHECK.args);
    expect(running).toMatchObject({ ready: false, rerun: [] });
    expect(running.backfills[0]).toMatchObject({ running: true, stalled: false, failed: 0 });
    expect(running.backfills[0]?.cursor).not.toBeNull();
    // That scheduled pass never runs (as when a pass throws: its write rolls back, the row stays).
    vi.setSystemTime(T0 + BACKFILL_STALL_MS + 1);
    const stalled: Preparation = await run(t, CHECK.fn, CHECK.args);
    expect(stalled.backfills[0]).toMatchObject({ running: true, stalled: true });
    expect(stalled.rerun).toEqual(PEOPLE_BACKFILLS.map((b) => b.job));
    for (const job of stalled.rerun) await run(t, RERUN.fn.replace('<job>', job), RERUN.args);
    await drain(t);
    expect(await run(t, CHECK.fn, CHECK.args)).toMatchObject(ALL_READY);
  });
});

describe('every backfill takes the same arguments', () => {
  test('the documented ones, and its own continuation; an unknown argument is the only thing refused', async () => {
    const t = convexTest(schema, modules);
    for (const { job } of PEOPLE_BACKFILLS) {
      for (const args of ['{}', '{"alone":true}', '{"cursor":null,"alone":true}', RERUN.args]) {
        await expect(run(t, job, args), `${job} ${args}`).resolves.toMatchObject({ done: true });
      }
      for (const args of ['{"bogus":true}', '{"failed":0}', '{"after":1}']) {
        await expect(run(t, job, args), `${job} ${args}`).rejects.toThrow();
      }
    }
    await drain(t);
    expect(await run(t, CHECK.fn, CHECK.args)).toMatchObject(ALL_READY);
  });
});

test('`alone` re-runs one backfill without starting the rest', async () => {
  const t = convexTest(schema, modules);
  await run(t, PEOPLE_BACKFILLS[0].job, RERUN.args);
  await drain(t);
  expect(((await run(t, CHECK.fn, CHECK.args)) as Preparation).pending).toEqual([
    'flagSubjects',
    'undoChains',
  ]);
});

test('a ready backfill stays ready through a re-run', async () => {
  const t = convexTest(schema, modules);
  await followProcedure(t, () => []);
  await t.run(async (ctx) => {
    for (let i = 0; i < 60; i++) await ctx.db.insert('profiles', profile(`s${i}`));
  });
  await run(t, PEOPLE_BACKFILLS[0].job, RERUN.args);
  const state: Preparation = await run(t, CHECK.fn, CHECK.args);
  expect(state.backfills[0]).toMatchObject({ ready: true, running: true });
  expect(state.ready).toBe(true);
});
