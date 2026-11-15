/**
 * The People reads at the worst a profile can weigh (a whole document), under Convex's real
 * transaction limits: every read that could load many profiles reads light rows instead, or pages by
 * real bytes, or confirms only a few. Each case here failed the 16 MiB limit before it was reshaped.
 */
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  markReady,
  READY_FLAG_SUBJECTS,
  READY_ROWS,
  READY_UNDO_CHAINS,
  refreshPersonRow,
} from './lib/peopleRows';
import { UNDO_NEEDS_ROWS } from './lib/undo';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const DAY = 86_400_000;
/** Near the document limit, in the one free-text field a profile has: what a profile can weigh. */
const HEAVY = 'h'.repeat(1000 * 1024);
type T = ReturnType<typeof convexTest>;

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

async function heavy(t: T, subject: string, over: Partial<Doc<'profiles'>> = {}) {
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
      createdAt: Date.now(),
      bio: HEAVY,
      ...over,
    });
    await refreshPersonRow(ctx, id);
    return id;
  });
}

async function setup() {
  const t = convexTest({ schema, modules, transactionLimits: true });
  await t.run(async (ctx) => {
    await markReady(ctx, READY_ROWS);
    await markReady(ctx, READY_FLAG_SUBJECTS);
    await markReady(ctx, READY_UNDO_CHAINS);
  });
  return t;
}

describe('no People read loads profiles past the read limit', () => {
  test('the parked list pages by real bytes over twenty heavy parked profiles', async () => {
    const t = await setup();
    await heavy(t, 'ops', { role: 'admin', bio: undefined });
    for (let i = 0; i < 20; i++) {
      await heavy(t, `p${i}`, {
        status: 'suspended',
        suspendedUntil: Date.now() - DAY,
        lapseAttempts: 3,
        lapseParkedAt: Date.now() - i,
      });
    }
    const ops = t.withIdentity({ subject: 'ops' });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 10; pages++) {
      const page: { parked: { userId: string }[]; isDone: boolean; continueCursor: string } =
        await ops.query(api.peopleJobs.parkedLapses, { cursor });
      seen.push(...page.parked.map((p) => p.userId));
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    expect(new Set(seen).size).toBe(20);
  });

  test('a ledger holder’s page with twenty heavy admins, five of them holders', async () => {
    const t = await setup();
    for (let i = 0; i < 20; i++) {
      await heavy(t, `a${i}`, { role: 'admin', ...(i < 5 ? { canEditLedger: true } : {}) });
    }
    const target = await heavy(t, 'target', { role: 'admin', canEditLedger: true });
    const page = await t
      .withIdentity({ subject: 'a0' })
      .query(api.people.person, { userId: target });
    expect(page?.can.suspend).toEqual({ ok: true, needsReason: true });
    expect(page?.ledger).toEqual({ editor: true, last: false });
  });

  test('History over sixty rows by thirty heavy moderators, and a holder banned and lifted twenty times', async () => {
    const t = await setup();
    const target = await heavy(t, 'target');
    for (let i = 0; i < 30; i++) {
      await heavy(t, `m${i}`, { role: 'moderator' });
      const m = t.withIdentity({ subject: `m${i}` });
      await m.mutation(api.moderation.setPostingPermission, {
        userId: target,
        permission: 'comments',
        allowed: false,
        reason: 'r',
      });
      await m.mutation(api.moderation.setPostingPermission, {
        userId: target,
        permission: 'comments',
        allowed: true,
      });
    }
    const h = await t.withIdentity({ subject: 'm0' }).query(api.people.history, {
      userId: target,
      limit: 100,
    });
    expect(h?.rows).toHaveLength(60);
    expect(h?.rows.every((r) => r.actor?.displayName !== null)).toBe(true);

    for (let i = 0; i < 6; i++) await heavy(t, `adm${i}`, { role: 'admin', canEditLedger: true });
    const holder = await heavy(t, 'holder', { role: 'admin', canEditLedger: true });
    const adm = t.withIdentity({ subject: 'adm0' });
    for (let i = 0; i < 20; i++) {
      await adm.mutation(api.moderation.banUser, { userId: holder, reason: 'r' });
      await adm.mutation(api.moderation.unbanUser, { userId: holder });
    }
    const hh = await adm.query(api.people.history, { userId: holder, limit: 100 });
    expect(hh?.rows).toHaveLength(40);
    expect(hh?.rows[0]?.undo).toEqual({ state: 'available', needsReason: true });
  });

  test('a heavy staffer’s decisions and figures', async () => {
    const t = await setup();
    const staffer = await heavy(t, 'staffer', { role: 'moderator' });
    const target = await heavy(t, 'target');
    const s = t.withIdentity({ subject: 'staffer' });
    for (let i = 0; i < 30; i++) {
      await s.mutation(api.moderation.setBountyPostLimit, {
        userId: target,
        limit: i % 2,
        reason: 'r',
      });
    }
    const d = await s.query(api.people.decisions, { userId: staffer, limit: 100 });
    expect(d.rows).toHaveLength(30);
    const stats = await s.query(api.people.staffStats, { userId: staffer as Id<'profiles'> });
    expect(stats?.decisions.thisWeek.count).toBe(30);
  });

  test('Decisions where every row is a discipline action on a different heavy ledger holder', async () => {
    const t = await setup();
    await heavy(t, 'adm', { role: 'admin', canEditLedger: true });
    for (let i = 0; i < 12; i++) await heavy(t, `h${i}`, { role: 'admin', canEditLedger: true });
    const adm = t.withIdentity({ subject: 'adm' });
    const ids = (await t.run((ctx) => ctx.db.query('profiles').collect()))
      .filter((p) => p.username.startsWith('h'))
      .map((p) => p._id);
    for (const id of ids) {
      await adm.mutation(api.moderation.banUser, { userId: id, reason: 'r' });
      await adm.mutation(api.moderation.unbanUser, { userId: id });
    }
    const admId = (await t.run((ctx) => ctx.db.query('profiles').collect())).find(
      (p) => p.username === 'adm',
    )?._id as Id<'profiles'>;
    const d = await adm.query(api.people.decisions, { userId: admId, limit: 100 });
    expect(d.rows).toHaveLength(24);
    // Every lift's undo would ban a holder: each asks the last-editor check, read once for the page.
    expect(
      d.rows.filter((r) => r.action === 'unban').every((r) => r.undo.state === 'available'),
    ).toBe(true);
  });

  test('before the rows exist, undo state reads each person once and then says it can’t check', async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const adm = await heavy(t, 'adm', { role: 'admin' });
    const rowless: Id<'profiles'>[] = [];
    await t.run(async (ctx) => {
      for (let i = 0; i < 16; i++) {
        rowless.push(
          await ctx.db.insert('profiles', {
            clerkUserId: `r${i}`,
            displayName: `r${i}`,
            username: `r${i}`,
            driveTimePrefMinutes: 60,
            profileVisibility: 'public' as const,
            notificationPrefs: NOTIF_PREFS,
            dateOfBirth: 0,
            reputationPoints: 0,
            role: 'member' as const,
            status: 'active' as const,
            createdAt: 0,
            bio: HEAVY,
          }),
        );
      }
    });
    const a = t.withIdentity({ subject: 'adm' });
    for (const id of rowless) {
      await a.mutation(api.moderation.setPostingPermission, {
        userId: id,
        permission: 'reports',
        allowed: false,
        reason: 'r',
      });
    }
    // The writes made their rows; take them away again, as before the backfill.
    await t.run(async (ctx) => {
      for (const id of rowless) {
        const row = await ctx.db
          .query('peopleRows')
          .withIndex('by_user', (q) => q.eq('userId', id))
          .first();
        if (row) await ctx.db.delete(row._id);
      }
    });
    const d = await a.query(api.people.decisions, { userId: adm, limit: 100 });
    expect(d.rows).toHaveLength(16);
    // As many heavy profiles as the request's one budget has left are read; the rest say why they
    // can't be checked here — and the page never reads past the limit.
    const states = d.rows.map((r) => r.undo);
    const available = states.filter((u) => u.state === 'available').length;
    const unchecked = states.filter(
      (u) => u.state === 'unavailable' && u.why === UNDO_NEEDS_ROWS,
    ).length;
    expect(available).toBeGreaterThan(0);
    expect(unchecked).toBeGreaterThan(0);
    expect(available + unchecked).toBe(16);
  });
});
