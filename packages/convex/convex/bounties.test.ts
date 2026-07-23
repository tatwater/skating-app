import geospatial from '@convex-dev/geospatial/test';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

function harness() {
  const t = convexTest(schema, modules);
  geospatial.register(t);
  geospatial.register(t, 'adminAreasGeo');
  return t;
}

// The bounty-create action (§7c) fetches weather per recent report. Default to an empty response so the
// suite exercises the recency×thumbs×trust decay with NEUTRAL weather (and never touches the network);
// the weather-reopen test overrides this. A genuine hard freeze since a report ⇒ the ice likely changed ⇒
// reopen. Default 12h × −20°C = 240 freezing-degree-hours, comfortably over the bounty-reopen bar
// (`BOUNTY_REOPEN_FREEZING_DEGREE_HOURS` = 180 — a HIGHER bar than the contradiction check's 48, so an
// ordinary single freezing night does NOT reopen; see the "modest freeze" test below).
function coldWeather(refMs: number, n = 12, tempC = -20) {
  const s = (hoursBeforeRef: number) => Math.floor((refMs - hoursBeforeRef * HOUR) / 1000);
  return {
    utc_offset_seconds: -18000,
    hourly: {
      time: Array.from({ length: n }, (_, i) => s(n - i)),
      temperature_2m: Array.from({ length: n }, () => tempC),
      precipitation: Array.from({ length: n }, () => 0),
      rain: Array.from({ length: n }, () => 0),
      snowfall: Array.from({ length: n }, () => 0),
      snow_depth: Array.from({ length: n }, () => 0),
      wind_speed_10m: Array.from({ length: n }, () => 5),
      wind_gusts_10m: Array.from({ length: n }, () => 8),
      cloud_cover: Array.from({ length: n }, () => 50),
      sunshine_duration: Array.from({ length: n }, () => 0),
      shortwave_radiation: Array.from({ length: n }, () => 0),
    },
  };
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ hourly: { time: [] } }), { status: 200 })),
  );
});
afterEach(() => vi.unstubAllGlobals());

const NOTIF_PREFS = {
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
};

async function seedUser(t: ReturnType<typeof harness>, subject: string) {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
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
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

let bodySeq = 0;
async function seedBody(t: ReturnType<typeof harness>) {
  const offset = bodySeq++;
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: `Pond ${offset}`,
      type: 'lake' as const,
      source: 'osm' as const,
      polygon: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [offset, 0],
            [offset, 1],
            [offset + 1, 1],
            [offset + 1, 0],
            [offset, 0],
          ],
        ],
      },
      bbox: { minLat: 0, minLng: offset, maxLat: 1, maxLng: offset + 1 },
      centroid: { lat: 0.5, lng: offset + 0.5 },
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  );
}

type Actor = Awaited<ReturnType<typeof seedUser>>;

async function seedReport(
  actor: Actor,
  waterBodyId: Id<'waterBodies'>,
  skateEndTime = Date.now(),
): Promise<Id<'reports'>> {
  return actor.as.mutation(api.reports.create, {
    waterBodyId,
    skateEndTime,
    iceTypes: ['black_ice'],
  }) as Promise<Id<'reports'>>;
}

const HOUR = 60 * 60 * 1000;

describe('bounties.create', () => {
  test('creates an open bounty and fans out bounty_request to recent reporters, not the requester', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const reporter = await seedUser(t, 'reporter');
    const waterBodyId = await seedBody(t);
    // A report 60h old: outside the 48h freshness block but inside the 72h eligibility window.
    await seedReport(reporter, waterBodyId, Date.now() - 60 * HOUR);

    const bountyId = await requester.as.action(api.bounties.create, { waterBodyId });
    const bounty = await t.run((ctx) => ctx.db.get(bountyId));
    expect(bounty?.status).toBe('open');

    const notes = await t.run((ctx) => ctx.db.query('notifications').collect());
    const requests = notes.filter((n) => n.type === 'bounty_request');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.userId).toBe(reporter.id); // eligible reporter notified; requester never
  });

  test('blocks a bounty on a body with a fresh report', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const reporter = await seedUser(t, 'reporter');
    const waterBodyId = await seedBody(t);
    await seedReport(reporter, waterBodyId, Date.now() - 2 * HOUR); // well within 48h

    await expect(requester.as.action(api.bounties.create, { waterBodyId })).rejects.toThrow(
      /already has fresh eyes/,
    );
  });

  test('decay: a lone new-account report past its shortened window no longer blocks (§7c)', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const reporter = await seedUser(t, 'reporter'); // brand-new account ⇒ 24h freshness window, not 48h
    const waterBodyId = await seedBody(t);
    await seedReport(reporter, waterBodyId, Date.now() - 30 * HOUR); // stale at 24h though the old cutoff was 48h

    // The old hard 48h gate would have blocked this; the decay window (24h for a new account) allows it.
    const bountyId = await requester.as.action(api.bounties.create, { waterBodyId });
    expect(bountyId).toBeTruthy();
  });

  test('createChecked re-checks freshness transactionally — a suppressor that landed after the weather pass still blocks (§7c TOCTOU)', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const reporter = await seedUser(t, 'reporter');
    const waterBodyId = await seedBody(t);
    // Model the race: the action's weather pass saw no suppressor (empty reopened set), but by commit a
    // fresh report has landed. The transactional re-check inside the mutation must catch it rather than
    // trusting the action's stale snapshot and persisting an ineligible bounty (+ fanning out notices).
    await seedReport(reporter, waterBodyId, Date.now() - 1 * HOUR);
    await expect(
      requester.as.mutation(internal.bounties.createChecked, {
        waterBodyId,
        weatherReopenedReports: [],
      }),
    ).rejects.toThrow(/already has fresh eyes/);
  });

  test("createChecked honors the action's weather-reopened set — a reopened suppressor does not block (§7c)", async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const reporter = await seedUser(t, 'reporter');
    const waterBodyId = await seedBody(t);
    const skateEndTime = Date.now() - 1 * HOUR;
    const reportId = await seedReport(reporter, waterBodyId, skateEndTime);
    // The same fresh suppressor, but the action flagged it weather-reopened (id + the timestamp its verdict
    // was computed against) — so it must NOT block.
    const bountyId = await requester.as.mutation(internal.bounties.createChecked, {
      waterBodyId,
      weatherReopenedReports: [{ reportId, skateEndTime }],
    });
    expect(bountyId).toBeTruthy();
  });

  test('createChecked drops a weather-reopen exemption whose skateEndTime changed since the verdict (§7c)', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const reporter = await seedUser(t, 'reporter');
    const waterBodyId = await seedBody(t);
    const skateEndTime = Date.now() - 1 * HOUR;
    const reportId = await seedReport(reporter, waterBodyId, skateEndTime);
    // The report was edited to a LATER skate time after the action computed its weather verdict against the
    // OLD one. The shorter window can no longer justify the reopen, so the stale exemption (keyed on the old
    // timestamp) must not match the current report — it suppresses again and the bounty is blocked.
    await expect(
      requester.as.mutation(internal.bounties.createChecked, {
        waterBodyId,
        weatherReopenedReports: [{ reportId, skateEndTime: skateEndTime - 3 * HOUR }],
      }),
    ).rejects.toThrow(/already has fresh eyes/);
  });

  test('weather that changed the ice reopens a bounty despite a suppressing report (§7c)', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const reporter = await seedUser(t, 'reporter');
    const waterBodyId = await seedBody(t);
    const skate = Date.now() - 12 * HOUR; // 12h old ⇒ inside the 24h new-account window ⇒ would suppress
    await seedReport(reporter, waterBodyId, skate);

    // But a hard freeze since the skate (12h × −16°C = 192 freezing-degree-hours, over the 180 bar) means
    // the ice likely changed → fresh eyes wanted → allow the bounty. The window is [skate, now], so the
    // stub's in-window hours must carry the whole signal (a longer/colder run than the modest-freeze test).
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify(coldWeather(Date.now(), 12, -16)), { status: 200 }),
      ),
    );
    const bountyId = await requester.as.action(api.bounties.create, { waterBodyId });
    expect(bountyId).toBeTruthy();
  });

  test('a modest overnight freeze does NOT reopen a bounty — the reopen bar is higher than the contradiction check (§7c)', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const reporter = await seedUser(t, 'reporter');
    const waterBodyId = await seedBody(t);
    const skate = Date.now() - 6 * HOUR; // 6h old ⇒ inside the new-account window ⇒ suppresses
    await seedReport(reporter, waterBodyId, skate);

    // 6h × −8°C = 48 freezing-degree-hours — enough for the contradiction check, but BELOW the 180-FDH
    // bounty-reopen bar. An ordinary cold night must not un-suppress a still-fresh report's bounty.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify(coldWeather(Date.now(), 6, -8)), { status: 200 }),
      ),
    );
    await expect(requester.as.action(api.bounties.create, { waterBodyId })).rejects.toThrow(
      /fresh eyes/,
    );
  });

  test('rejects an unauthenticated caller before doing any weather I/O (§7c)', async () => {
    const t = harness();
    const waterBodyId = await seedBody(t);
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ hourly: { time: [] } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    // No `.as` identity ⇒ the up-front auth guard must throw before any DB read or Open-Meteo fetch.
    await expect(t.action(api.bounties.create, { waterBodyId })).rejects.toThrow(/signed in/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('rejects an authenticated-but-ineligible caller (minor) before any weather I/O (§7c security)', async () => {
    const t = harness();
    const minor = await seedUser(t, 'minor');
    await t.run((ctx) =>
      ctx.db.patch(minor.id, { dateOfBirth: Date.now() - 10 * 365 * 24 * HOUR }),
    );
    const reporter = await seedUser(t, 'reporter');
    const waterBodyId = await seedBody(t);
    await seedReport(reporter, waterBodyId, Date.now() - 12 * HOUR); // a suppressor the loop would fetch
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ hourly: { time: [] } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    // Eligibility is now enforced in `bountyFreshnessInputs` (which runs first), so a minor is rejected
    // before the action ever drives an Open-Meteo fetch on the shared quota — not just at write time.
    await expect(minor.as.action(api.bounties.create, { waterBodyId })).rejects.toThrow(/under 18/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('enforces the rolling open-bounty cap', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    for (let i = 0; i < 3; i++) {
      const body = await seedBody(t);
      await requester.as.action(api.bounties.create, { waterBodyId: body });
    }
    const fourth = await seedBody(t);
    await expect(requester.as.action(api.bounties.create, { waterBodyId: fourth })).rejects.toThrow(
      /maximum number of open bounties/,
    );
  });

  test('rejects a capped requester before any weather I/O (§7c resource guard)', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    // Fill the cap on empty bodies (no suppressors ⇒ the create loop never fetches weather).
    for (let i = 0; i < 3; i++) {
      await requester.as.action(api.bounties.create, { waterBodyId: await seedBody(t) });
    }
    // A 4th body that DOES have a suppressing report — its weather would be fetched in the loop if the
    // cap weren't checked first. The pre-weather cap gate must reject before any Open-Meteo call.
    const reporter = await seedUser(t, 'reporter');
    const waterBodyId = await seedBody(t);
    await seedReport(reporter, waterBodyId, Date.now() - 12 * HOUR);
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ hourly: { time: [] } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    await expect(requester.as.action(api.bounties.create, { waterBodyId })).rejects.toThrow(
      /maximum number of open bounties/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('bounties.cancel', () => {
  test('the requester cancels their open bounty; others cannot', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const other = await seedUser(t, 'other');
    const waterBodyId = await seedBody(t);
    const bountyId = await requester.as.action(api.bounties.create, { waterBodyId });

    await expect(other.as.mutation(api.bounties.cancel, { bountyId })).rejects.toThrow(
      /Only the requester/,
    );

    await requester.as.mutation(api.bounties.cancel, { bountyId });
    expect((await t.run((ctx) => ctx.db.get(bountyId)))?.status).toBe('cancelled');

    // Cancelling a non-open bounty is rejected.
    await expect(requester.as.mutation(api.bounties.cancel, { bountyId })).rejects.toThrow(
      /not open/,
    );
  });
});

describe('bounties fulfillment', () => {
  test('auto-attaches a new report, then a helpful thumb from the requester fulfills + rewards', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const bountyId = await requester.as.action(api.bounties.create, { waterBodyId });

    const reportId = await seedReport(author, waterBodyId);
    // Auto-attached.
    expect((await t.run((ctx) => ctx.db.get(bountyId)))?.fulfillingReportIds).toContain(reportId);

    await requester.as.mutation(api.ratings.rate, {
      targetType: 'report',
      targetId: reportId,
      verdict: 'helpful',
      bountyId,
    });

    const bounty = await t.run((ctx) => ctx.db.get(bountyId));
    expect(bounty?.status).toBe('fulfilled');
    // Reward is the separate bountyPoints currency, awarded to the report author.
    expect((await t.run((ctx) => ctx.db.get(author.id)))?.bountyPoints).toBe(bounty?.rewardPoints);
    const notes = await t.run((ctx) =>
      ctx.db
        .query('notifications')
        .filter((q) => q.eq(q.field('userId'), author.id))
        .collect(),
    );
    expect(notes.some((n) => n.type === 'bounty_fulfilled')).toBe(true);
  });

  test('a pre-existing helpful vote from the feed still fulfills when confirmed on the bounty page', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const bountyId = await requester.as.action(api.bounties.create, { waterBodyId });
    const reportId = await seedReport(author, waterBodyId);

    // First: the requester thumbs the report helpful from the FEED — no `bountyId`, so it doesn't fulfill.
    await requester.as.mutation(api.ratings.rate, {
      targetType: 'report',
      targetId: reportId,
      verdict: 'helpful',
    });
    expect((await t.run((ctx) => ctx.db.get(bountyId)))?.status).toBe('open');

    // Then: the requester opens the bounty page and clicks the already-active helpful button (WITH
    // `bountyId`). The verdict is unchanged, but the bounty must still fulfill — not silently no-op.
    await requester.as.mutation(api.ratings.rate, {
      targetType: 'report',
      targetId: reportId,
      verdict: 'helpful',
      bountyId,
    });

    const bounty = await t.run((ctx) => ctx.db.get(bountyId));
    expect(bounty?.status).toBe('fulfilled');
    expect((await t.run((ctx) => ctx.db.get(author.id)))?.bountyPoints).toBe(bounty?.rewardPoints);
    // The helpful thumb was cast once (the re-vote is a no-op for points), so the author's boost isn't
    // double-counted.
    const helpfulEvents = await t.run((ctx) =>
      ctx.db
        .query('pointEvents')
        .filter((q) =>
          q.and(q.eq(q.field('userId'), author.id), q.eq(q.field('reason'), 'helpful_thumb')),
        )
        .collect(),
    );
    expect(helpfulEvents).toHaveLength(1);
  });

  test('an unhelpful thumb from the requester leaves the bounty open', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const bountyId = await requester.as.action(api.bounties.create, { waterBodyId });
    const reportId = await seedReport(author, waterBodyId);

    await requester.as.mutation(api.ratings.rate, {
      targetType: 'report',
      targetId: reportId,
      verdict: 'unhelpful',
      bountyId,
    });

    expect((await t.run((ctx) => ctx.db.get(bountyId)))?.status).toBe('open');
    expect((await t.run((ctx) => ctx.db.get(author.id)))?.bountyPoints ?? 0).toBe(0);
  });
});

describe('bounties.listOpen (global / near-me / viewport browse)', () => {
  test('returns open bounties newest-first; excludes cancelled + expired', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const body0 = await seedBody(t);
    const body1 = await seedBody(t);
    const b0 = await requester.as.action(api.bounties.create, { waterBodyId: body0 });
    const b1 = await requester.as.action(api.bounties.create, { waterBodyId: body1 });
    // Make b1 unambiguously newer than b0 so the sort is deterministic.
    await t.run((ctx) => ctx.db.patch(b0, { createdAt: Date.now() - HOUR }));

    let open = await t.query(api.bounties.listOpen, {});
    expect(open.map((b) => b._id)).toEqual([b1, b0]);
    expect(open[0]?.requester.trustClass).toBe('new'); // fresh account, 0 points
    expect(open[0]?.waterBodyName).toBeDefined();

    // Cancel one and expire the other → both drop out of the browse.
    await requester.as.mutation(api.bounties.cancel, { bountyId: b1 });
    await t.run((ctx) => ctx.db.patch(b0, { expiresAt: Date.now() - HOUR }));
    open = await t.query(api.bounties.listOpen, {});
    expect(open).toHaveLength(0);
  });

  test('viewport filters to bounties whose body intersects the rectangle', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const body0 = await seedBody(t); // bbox lng [n, n+1]
    const body1 = await seedBody(t); // bbox lng [n+1, n+2]
    const b0 = await requester.as.action(api.bounties.create, { waterBodyId: body0 });
    await requester.as.action(api.bounties.create, { waterBodyId: body1 });
    const body0Doc = await t.run((ctx) => ctx.db.get(body0));
    // A rectangle covering only body0's bbox.
    const viewport = {
      minLat: 0,
      maxLat: 1,
      // biome-ignore lint/style/noNonNullAssertion: seeded body always exists.
      minLng: body0Doc!.bbox.minLng - 0.1,
      // biome-ignore lint/style/noNonNullAssertion: seeded body always exists.
      maxLng: body0Doc!.bbox.minLng + 0.1,
    };
    const open = await t.query(api.bounties.listOpen, { viewport });
    expect(open.map((b) => b._id)).toEqual([b0]);
  });

  test('sortByHome sorts by the viewer private home coord without returning distances', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const body0 = await seedBody(t);
    const body1 = await seedBody(t);
    await requester.as.action(api.bounties.create, { waterBodyId: body0 });
    const b1 = await requester.as.action(api.bounties.create, { waterBodyId: body1 });
    const body1Doc = await t.run((ctx) => ctx.db.get(body1));
    // A viewer whose home sits on body1's centroid → body1's bounty sorts first, but no distance leaks.
    const viewer = await seedUser(t, 'viewer');
    // biome-ignore lint/style/noNonNullAssertion: seeded body always exists.
    await t.run((ctx) => ctx.db.patch(viewer.id, { homeCoord: body1Doc!.centroid }));

    const open = await viewer.as.query(api.bounties.listOpen, { sortByHome: true });
    expect(open[0]?._id).toBe(b1); // nearest-to-home first
    expect(open[0]?.distanceMeters).toBeUndefined(); // never returned in home-sort mode (D11)
  });

  test('near sorts by distance and attaches distanceMeters', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const body0 = await seedBody(t);
    const body1 = await seedBody(t);
    await requester.as.action(api.bounties.create, { waterBodyId: body0 });
    const b1 = await requester.as.action(api.bounties.create, { waterBodyId: body1 });
    const body1Doc = await t.run((ctx) => ctx.db.get(body1));
    // biome-ignore lint/style/noNonNullAssertion: seeded body always exists.
    const near = body1Doc!.centroid;
    const open = await t.query(api.bounties.listOpen, { near });
    expect(open[0]?._id).toBe(b1); // nearest first
    expect(open[0]?.distanceMeters).toBeDefined();
    expect(open[0]?.distanceMeters ?? 1).toBeLessThan(open[1]?.distanceMeters ?? 0);
  });
});

describe('bounties.getDetail', () => {
  test('enriches the bounty with requester, body, and candidate reports with isOwn', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const bountyId = await requester.as.action(api.bounties.create, { waterBodyId });
    const reportId = await seedReport(author, waterBodyId); // auto-attaches

    const asRequester = await requester.as.query(api.bounties.getDetail, { bountyId });
    expect(asRequester?.isRequester).toBe(true);
    expect(asRequester?.requester.trustClass).toBe('new');
    expect(asRequester?.waterBody?.name).toBeDefined();
    expect(asRequester?.fulfillingReports).toHaveLength(1);
    expect(asRequester?.fulfillingReports[0]?._id).toBe(reportId);
    expect(asRequester?.fulfillingReports[0]?.isOwn).toBe(false); // the report is the author's

    const asAuthor = await author.as.query(api.bounties.getDetail, { bountyId });
    expect(asAuthor?.isRequester).toBe(false);
    expect(asAuthor?.fulfillingReports[0]?.isOwn).toBe(true); // author viewing their own report
  });
});

describe('trust class in profile reads (D50)', () => {
  test('getPublicProfile derives the class from points + age and exposes badges/bountyPoints', async () => {
    const t = harness();
    const user = await seedUser(t, 'ada');

    // Fresh account (0 points) → the `new` welcome class; badges empty; bountyPoints 0.
    let profile = await t.query(api.profiles.getPublicProfile, { username: 'ada' });
    expect(profile?.trustClass).toBe('new');
    expect(profile && !profile.private ? profile.badges : null).toEqual([]);
    expect(profile && !profile.private ? profile.bountyPoints : null).toBe(0);

    // Crossing the `trusted` threshold (≥15) promotes the class; points always beat age.
    await t.run((ctx) =>
      ctx.db.patch(user.id, {
        reputationPoints: 20,
        badges: ['trusted_reporter'],
        bountyPoints: 10,
      }),
    );
    profile = await t.query(api.profiles.getPublicProfile, { username: 'ada' });
    expect(profile?.trustClass).toBe('trusted');
    expect(profile && !profile.private ? profile.badges : null).toEqual(['trusted_reporter']);
    expect(profile && !profile.private ? profile.bountyPoints : null).toBe(10);
  });

  test('publicByIds returns each author trust class (never the raw score)', async () => {
    const t = harness();
    const user = await seedUser(t, 'nadia');
    await t.run((ctx) => ctx.db.patch(user.id, { reputationPoints: 70 })); // expert threshold

    const map = await t.query(api.profiles.publicByIds, { profileIds: [user.id] });
    expect(map[user.id]?.trustClass).toBe('expert');
    expect(map[user.id]).not.toHaveProperty('reputationPoints');
  });
});

describe('bounties.expireBounties', () => {
  test('flips open bounties past their expiry to expired', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const waterBodyId = await seedBody(t);
    const bountyId = await requester.as.action(api.bounties.create, { waterBodyId });
    await t.run((ctx) => ctx.db.patch(bountyId, { expiresAt: Date.now() - HOUR }));

    const res = await t.mutation(internal.bounties.expireBounties, {});
    expect(res.expired).toBe(1);
    expect((await t.run((ctx) => ctx.db.get(bountyId)))?.status).toBe('expired');
  });
});
