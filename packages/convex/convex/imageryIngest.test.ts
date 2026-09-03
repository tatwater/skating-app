import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

/**
 * The season lifecycle of the 25-site checker (D149, and D161's gate for the weather sweep).
 *
 * ⚠ **This file exists because the checker had no tests at all**, and it had just grown a second
 * edge. Opening was covered by `ingestGate.test.ts` at the pure-function level, but the wiring — the
 * early return that decides whether a tick does anything — was not, which is exactly where the bug
 * lived: a recorded `opensOn` short-circuited every subsequent tick, so the `closesOn` that
 * `ingestWindow` computed was never persisted and nothing downstream could ever stand down.
 */

const square = (d: number): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [-72.0331 - d, 44.0163 - d],
      [-72.0331 + d, 44.0163 - d],
      [-72.0331 + d, 44.0163 + d],
      [-72.0331 - d, 44.0163 + d],
      [-72.0331 - d, 44.0163 - d],
    ],
  ],
});

async function seedSites(t: ReturnType<typeof convexTest>, count = 3) {
  await t.run(async (ctx) => {
    for (let i = 0; i < count; i++) {
      await ctx.db.insert('waterBodies', {
        name: `Gate Lake ${i}`,
        searchText: `Gate Lake ${i}`,
        type: 'lakePond' as const,
        source: 'osm' as const,
        polygon: square(0.01),
        bbox: { minLat: 43.99, minLng: -72.05, maxLat: 44.05, maxLng: -71.99 },
        centroid: { lat: 44.0163 + i * 0.1, lng: -72.0331 },
        interiorPoint: { lat: 44.0163 + i * 0.1, lng: -72.0331 },
        dedupStatus: 'clean' as const,
        curatedBoost: 10 - i,
        createdAt: Date.now(),
      });
    }
  });
}

/** Open-Meteo's multi-coordinate daily shape: one object per site. */
function dailyLows(siteCount: number, start: string, lows: number[]) {
  const base = new Date(`${start}T00:00:00Z`).getTime();
  const time = lows.map((_, i) => new Date(base + i * 86_400_000).toISOString().slice(0, 10));
  return Array.from({ length: siteCount }, () => ({
    daily: { time, temperature_2m_min: lows },
  }));
}

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/**
 * The checker's month gate and its October observation floor both read the real clock, so a test
 * has to pin the clock **and** date its fixtures consistently with it.
 *
 * ⚠ Both dates below sit inside one season label: D63's boundary is July, so December 2026 and
 * April 2027 are both `winter-2026-27`. Straddling it accidentally is how a close ends up filed
 * against a season that never opened.
 */
const IN_SEASON = '2026-12-15';
const IN_SPRING = '2027-04-30';
const atDate = (iso: string) => vi.setSystemTime(new Date(`${iso}T00:00:00Z`));

describe('maybeCheckSeasonOpen — the season lifecycle', () => {
  test('does nothing between July and October', async () => {
    vi.useFakeTimers();
    atDate('2026-08-15');
    const t = convexTest(schema, modules);
    await seedSites(t);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await t.action(internal.imageryIngest.maybeCheckSeasonOpen, {});
    expect(result).toMatchObject({ skipped: 'before October' });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  test('records the open, then keeps ticking to look for the close', async () => {
    vi.useFakeTimers();
    atDate(IN_SEASON);
    const t = convexTest(schema, modules);
    await seedSites(t);

    // A cold December: every site freezes, so the corpus signal fires and winter establishes.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson(dailyLows(3, '2026-12-01', [2, -1, -3, -4, -5]))),
    );
    const opened = await t.action(internal.imageryIngest.maybeCheckSeasonOpen, {});
    expect(opened).toMatchObject({ open: true, opensOn: '2026-12-02' });

    // ⚠ The regression this file exists for. A second tick must NOT report "already recorded" —
    // the row has an open date and no close date, so there is still work to do.
    const again = await t.action(internal.imageryIngest.maybeCheckSeasonOpen, {});
    expect(again).not.toMatchObject({ skipped: 'already recorded' });
    expect(again).toMatchObject({ open: true });

    vi.useRealTimers();
  });

  test('closes the season on a sustained thaw, against the RECORDED winterFrom', async () => {
    vi.useFakeTimers();
    atDate(IN_SEASON);
    const t = convexTest(schema, modules);
    await seedSites(t);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson(dailyLows(3, '2026-12-01', [2, -1, -3, -4, -5]))),
    );
    await t.action(internal.imageryIngest.maybeCheckSeasonOpen, {});

    // Now it is April and the fetch window reaches back only to mid-January — nowhere near the
    // December freeze-up. `ingestWindow` would find no winterFrom here and never close; the recorded
    // one is what makes the close reachable.
    atDate(IN_SPRING);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okJson(
          dailyLows(
            3,
            '2027-04-01',
            Array.from({ length: 20 }, () => 8),
          ),
        ),
      ),
    );
    const closed = await t.action(internal.imageryIngest.maybeCheckSeasonOpen, {});
    expect(closed).toMatchObject({ closed: true, closesOn: '2027-04-10' });

    const row = await t.run((ctx) => ctx.db.query('imageryIngestSeasons').first());
    expect(row?.closesOn).toBe('2027-04-10');
    expect(row?.closedAt).toBeTypeOf('number');

    // Closed is final within a season: a late cold snap does not reopen it, and a later tick does
    // not move the date to whenever we last looked.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okJson(
          dailyLows(
            3,
            '2027-05-01',
            Array.from({ length: 20 }, () => 9),
          ),
        ),
      ),
    );
    const after = await t.action(internal.imageryIngest.maybeCheckSeasonOpen, {});
    expect(after).toMatchObject({ skipped: 'already recorded' });
    const unchanged = await t.run((ctx) => ctx.db.query('imageryIngestSeasons').first());
    expect(unchanged?.closesOn).toBe('2027-04-10');

    vi.useRealTimers();
  });

  test('a season that opened but never established winter is not left ticking for ever', async () => {
    vi.useFakeTimers();
    atDate(IN_SEASON);
    const t = convexTest(schema, modules);
    await seedSites(t);
    const gate = await t.run((ctx) =>
      ctx.db.insert('imageryIngestSeasons', {
        season: 'winter-2026-27',
        opensOn: '2026-11-02',
        openedBy: ['sentinel'],
        // The sentinel opened it and the region never followed — a real recorded state, and one
        // with no close to find. Ticking daily against it would be a fetch a day for nothing.
        winterFrom: null,
        sitesSampled: 3,
        detectedAt: Date.now(),
      }),
    );
    expect(gate).toBeTruthy();

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await t.action(internal.imageryIngest.maybeCheckSeasonOpen, {});
    expect(result).toMatchObject({ skipped: 'already recorded' });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('season boundary alerts staff', () => {
  /** An active moderator and admin, plus two who must NOT be mailed. */
  async function seedStaff(t: ReturnType<typeof convexTest>) {
    const base = {
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: {
        activityDetected: true,
        bountyRequest: true,
        hazardConfirmation: true,
        bountyFulfilled: true,
        reportRated: true,
        reportCommented: true,
        contentFlagResolved: true,
        favoriteReport: true,
        nearbyReportDigest: true,
        greatReportNearby: true,
      },
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      createdAt: Date.now(),
    };
    await t.run(async (ctx) => {
      await ctx.db.insert('profiles', {
        ...base,
        clerkUserId: 'mod-1',
        displayName: 'Mod',
        username: 'mod1',
        role: 'moderator' as const,
        status: 'active' as const,
      });
      await ctx.db.insert('profiles', {
        ...base,
        clerkUserId: 'admin-1',
        displayName: 'Admin',
        username: 'admin1',
        role: 'admin' as const,
        status: 'active' as const,
      });
      // ⚠ Keeps its role but must not be mailed — suspension and demotion are separate levers (D37).
      await ctx.db.insert('profiles', {
        ...base,
        clerkUserId: 'mod-suspended',
        displayName: 'Suspended Mod',
        username: 'modsus',
        role: 'moderator' as const,
        status: 'suspended' as const,
      });
      await ctx.db.insert('profiles', {
        ...base,
        clerkUserId: 'member-1',
        displayName: 'Member',
        username: 'member1',
        role: 'member' as const,
        status: 'active' as const,
      });
    });
  }

  async function queuedBroadcasts(t: ReturnType<typeof convexTest>) {
    return t.run(async (ctx) => {
      const jobs = await ctx.db.system.query('_scheduled_functions').collect();
      return jobs.filter((j) => j.name.includes('broadcastToStaff'));
    });
  }

  test('mails staff exactly once when the season opens', async () => {
    vi.useFakeTimers();
    atDate(IN_SEASON);
    const t = convexTest(schema, modules);
    await seedSites(t);
    await seedStaff(t);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson(dailyLows(3, '2026-12-01', [2, -1, -3, -4, -5]))),
    );

    await t.action(internal.imageryIngest.maybeCheckSeasonOpen, {});
    const first = await queuedBroadcasts(t);
    expect(first).toHaveLength(1);
    const args = first[0]?.args[0] as { subject: string; lines: string[] };
    expect(args.subject).toContain('has begun');
    expect(args.lines.join(' ')).toContain('2026-12-02');

    // The daily cron keeps ticking after an open (it is looking for the close), so a second tick
    // must not mail everyone again. ⚠ What stops it *here* is the control flow — the second tick
    // takes the close branch and never reaches the open one. The `created` gate is defence in depth
    // for the concurrent case this cannot reach; its own guarantee is asserted directly below.
    await t.action(internal.imageryIngest.maybeCheckSeasonOpen, {});
    expect(await queuedBroadcasts(t)).toHaveLength(1);
    vi.useRealTimers();
  });

  test('mails staff exactly once when the season closes', async () => {
    vi.useFakeTimers();
    atDate(IN_SEASON);
    const t = convexTest(schema, modules);
    await seedSites(t);
    await seedStaff(t);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson(dailyLows(3, '2026-12-01', [2, -1, -3, -4, -5]))),
    );
    await t.action(internal.imageryIngest.maybeCheckSeasonOpen, {});

    atDate(IN_SPRING);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okJson(
          dailyLows(
            3,
            '2027-04-01',
            Array.from({ length: 20 }, () => 8),
          ),
        ),
      ),
    );
    await t.action(internal.imageryIngest.maybeCheckSeasonOpen, {});

    const jobs = await queuedBroadcasts(t);
    const closes = jobs.filter((j) =>
      (j.args[0] as { subject: string }).subject.includes('closed'),
    );
    expect(closes).toHaveLength(1);

    // A later tick short-circuits on the recorded close and tells nobody again — again by control
    // flow, with the mutation's refusal to re-close as the backstop.
    await t.action(internal.imageryIngest.maybeCheckSeasonOpen, {});
    const after = await queuedBroadcasts(t);
    expect(
      after.filter((j) => (j.args[0] as { subject: string }).subject.includes('closed')),
    ).toHaveLength(1);
    vi.useRealTimers();
  });

  test('the record mutations are what actually make the alerts once-only', async () => {
    // ⚠ The tests above exercise the sequential path, where control flow already prevents a second
    // mail. The real guarantee — two ticks racing, which convex-test cannot schedule — lives in the
    // mutations, so it is asserted at that level rather than assumed.
    const t = convexTest(schema, modules);
    const args = {
      season: 'winter-2026-27',
      opensOn: '2026-12-02',
      openedBy: ['corpus'],
      winterFrom: '2026-12-02',
      sitesSampled: 3,
    };
    const first = await t.run((ctx) =>
      ctx.runMutation(internal.imageryIngest.recordSeasonOpen, args),
    );
    const second = await t.run((ctx) =>
      ctx.runMutation(internal.imageryIngest.recordSeasonOpen, args),
    );
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);

    const closed = await t.run((ctx) =>
      ctx.runMutation(internal.imageryIngest.recordSeasonClose, {
        season: 'winter-2026-27',
        closesOn: '2027-04-10',
      }),
    );
    const reclosed = await t.run((ctx) =>
      ctx.runMutation(internal.imageryIngest.recordSeasonClose, {
        season: 'winter-2026-27',
        closesOn: '2027-05-01',
      }),
    );
    expect(closed).not.toBeNull();
    expect(reclosed).toBeNull(); // and the date does not move to whenever we last looked
    const row = await t.run((ctx) => ctx.db.query('imageryIngestSeasons').first());
    expect(row?.closesOn).toBe('2027-04-10');
  });

  test('the recipient list is active moderators and admins, and nobody else', async () => {
    const t = convexTest(schema, modules);
    await seedStaff(t);
    const staff = await t.run((ctx) => ctx.runQuery(internal.operatorAlerts.staffSubjects, {}));
    expect(staff.map((s) => s.subject).sort()).toEqual(['admin-1', 'mod-1']);
  });

  test('a broadcast with no configured staff is reported, not thrown', async () => {
    // Dev has no moderator (a known open founder call), and a cron must not fail because of it.
    const t = convexTest(schema, modules);
    const res = await t.action(internal.operatorAlerts.broadcastToStaff, {
      subject: 's',
      heading: 'h',
      lines: [],
      deepLinkPath: '/admin',
    });
    expect(res).toEqual({ recipients: 0, sent: 0 });
  });

  test('a broadcast reports zero sent when Resend is unconfigured, without throwing', async () => {
    // ⚠ All Resend env vars ship unset. `sent` is what tells "nobody is configured" from "nobody was
    // told" — a silent void would let an unsent alert look delivered.
    const t = convexTest(schema, modules);
    await seedStaff(t);
    const res = await t.action(internal.operatorAlerts.broadcastToStaff, {
      subject: 's',
      heading: 'h',
      lines: ['x'],
      deepLinkPath: '/admin',
    });
    expect(res.recipients).toBe(2);
    expect(res.sent).toBe(0);
  });
});
