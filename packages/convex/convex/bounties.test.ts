import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

function harness() {
  const t = convexTest(schema, modules);
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
      type: 'lakePond' as const,
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
    // The gate returns its rejection rather than throwing (Phase 7b) so the decision commits alongside
    // the `bountyGateEvents` row recording it; `bounties.create` re-raises it to the caller.
    const outcome = await requester.as.mutation(internal.bounties.createChecked, {
      waterBodyId,
      weatherReopenedReports: [],
    });
    expect(outcome).toMatchObject({ ok: false, decision: 'suppressed' });
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
    const outcome = await requester.as.mutation(internal.bounties.createChecked, {
      waterBodyId,
      weatherReopenedReports: [{ reportId, skateEndTime }],
    });
    expect(outcome.ok).toBe(true);
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
    const outcome = await requester.as.mutation(internal.bounties.createChecked, {
      waterBodyId,
      weatherReopenedReports: [{ reportId, skateEndTime: skateEndTime - 3 * HOUR }],
    });
    expect(outcome).toMatchObject({ ok: false, decision: 'suppressed' });
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
      /you already have 3 open bounties/i,
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
      /you already have 3 open bounties/i,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * The gate log (Phase 7b). The reason this table exists is that a rejected attempt is invisible: you
 * cannot tell whether FRESH_REPORT_HOURS or MAX_OPEN_BOUNTIES_PER_DAY is set right by looking only at
 * the bounties that got through. So the invariant under test is that **every** attempt lands a row —
 * including the two that end in a thrown error for the caller — with the (age, window) pair the
 * suppression scatter plots.
 */
describe('bountyGateEvents', () => {
  const gateEvents = (t: ReturnType<typeof harness>) =>
    t.run((ctx) => ctx.db.query('bountyGateEvents').collect());

  test('records an allowed attempt, attributed to the requester', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const waterBodyId = await seedBody(t);
    await requester.as.action(api.bounties.create, { waterBodyId });

    const events = await gateEvents(t);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      decision: 'allowed',
      waterBodyId,
      requesterId: requester.id,
      weatherReopened: false,
    });
  });

  test('records the closest call on an allowed attempt, so the scatter has dots below the line', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const reporter = await seedUser(t, 'reporter'); // new account ⇒ 24h window
    const waterBodyId = await seedBody(t);
    // Past its shortened window, so it doesn't suppress — but it's still the freshest read on the body,
    // which is the only honest reference point an allowed attempt has.
    const reportId = await seedReport(reporter, waterBodyId, Date.now() - 30 * HOUR);
    await requester.as.action(api.bounties.create, { waterBodyId });

    const event = (await gateEvents(t))[0];
    expect(event?.decision).toBe('allowed');
    expect(event?.decidingReportId).toBe(reportId);
    expect(event?.reportAgeH).toBeCloseTo(30, 0);
    expect(event?.appliedWindowH).toBeCloseTo(24, 0); // 48h base, halved for a new account
    // The dot sits ABOVE its window — an allowed attempt whose closest call had already expired.
    expect(event?.reportAgeH ?? 0).toBeGreaterThan(event?.appliedWindowH ?? 0);
  });

  test('a suppressed attempt is logged even though the caller sees an error', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const reporter = await seedUser(t, 'reporter');
    const waterBodyId = await seedBody(t);
    const reportId = await seedReport(reporter, waterBodyId, Date.now() - 2 * HOUR);

    await expect(requester.as.action(api.bounties.create, { waterBodyId })).rejects.toThrow(
      /already has fresh eyes/,
    );
    // The rejection is what the log is FOR — a throwing gate would have rolled this row back.
    const events = await gateEvents(t);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ decision: 'suppressed', decidingReportId: reportId });
    expect(events[0]?.reportAgeH ?? 0).toBeLessThan(events[0]?.appliedWindowH ?? 0);
  });

  test('a capped attempt is logged as capped, not mislabelled as suppressed', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    for (let i = 0; i < 3; i++) {
      await requester.as.action(api.bounties.create, { waterBodyId: await seedBody(t) });
    }
    // A 4th body that also has fresh eyes: both gates would reject, and the cap is the unambiguous
    // reason (the weather pass is skipped for a capped caller, so the freshness verdict would be
    // computed without its exemptions).
    const reporter = await seedUser(t, 'reporter');
    const waterBodyId = await seedBody(t);
    await seedReport(reporter, waterBodyId, Date.now() - 2 * HOUR);
    await expect(requester.as.action(api.bounties.create, { waterBodyId })).rejects.toThrow(
      /you already have 3 open bounties/i,
    );

    const events = await gateEvents(t);
    expect(events).toHaveLength(4);
    expect(events.filter((e) => e.decision === 'capped')).toHaveLength(1);
    expect(events.some((e) => e.decision === 'suppressed')).toBe(false);
  });

  test('flags the weather reopen — the numerator of the reopen rate (D56)', async () => {
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const reporter = await seedUser(t, 'reporter');
    const waterBodyId = await seedBody(t);
    await seedReport(reporter, waterBodyId, Date.now() - 12 * HOUR); // would suppress on the base gate
    // A hard freeze across the whole window since the skate (12h × −16°C = 192 FDH, over the 180 bar)
    // ⇒ the ice likely changed ⇒ the suppressor is cleared and the attempt flips to allowed.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify(coldWeather(Date.now(), 12, -16)), { status: 200 }),
      ),
    );
    await requester.as.action(api.bounties.create, { waterBodyId });

    const event = (await gateEvents(t))[0];
    expect(event).toMatchObject({ decision: 'allowed', weatherReopened: true });
  });

  test('the freshness scan reads newest-first, so the gate weighs the freshest report (N1)', async () => {
    // Greptile PR #27: the index runs *ascending* on `skateEndTime`, so the scan needed `.order('desc')`
    // — without it the gate weighed the oldest rows in the window and the fan-out notified whoever
    // reported longest ago. Observable here with no truncation at all: `decidingReport` falls back to
    // the freshest report on the body when nothing suppresses, so an ascending scan would log the
    // 5-day-old one instead. (The truncated case can't isolate this any more — a truncated scan blocks
    // whatever it read; see the two tests below.)
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const reporter = await seedUser(t, 'reporter');
    const waterBodyId = await seedBody(t);
    const now = Date.now();

    const insert = (skateEndTime: number) =>
      t.run((ctx) =>
        ctx.db.insert('reports', {
          authorId: reporter.id,
          waterBodyId,
          point: { lat: 0.5, lng: 0.5 },
          skateEndTime,
          reportTime: now,
          source: 'native' as const,
          iceTypes: [],
          surfaceTags: [],
          moderationStatus: 'visible' as const,
          photoIds: [],
          hazardIdsCreated: [],
          createdAt: now,
          updatedAt: now,
        }),
      ) as Promise<Id<'reports'>>;

    // All inside the 144h scan window, all past their own 24h (new-account) freshness window, so
    // nothing suppresses and the bounty is allowed either way — what differs is which one is logged.
    const oldest = await insert(now - 140 * HOUR);
    await insert(now - 90 * HOUR);
    const freshest = await insert(now - 30 * HOUR);

    const outcome = await requester.as.mutation(internal.bounties.createChecked, {
      waterBodyId,
      weatherReopenedReports: [],
    });
    expect(outcome.ok).toBe(true);
    const event = (await gateEvents(t))[0];
    expect(event?.decidingReportId).toBe(freshest);
    expect(event?.decidingReportId).not.toBe(oldest);
  });

  test('an 11th suppressor past BOUNTY_FRESH_MAX_REPORTS cannot block what weather already cleared', async () => {
    // Greptile PR #27 round 6 asked whether the ten-suppressor cap can hide an older blocker once the
    // ten it saw are all weather-reopened. It can't, and the reason is worth pinning: reopening is
    // MONOTONE IN REPORT AGE. A verdict is read over `[skateEndTime, now]`, an older report's window
    // strictly contains a newer one's, and both degree-hour integrals only accumulate — so if the ten
    // newest suppressors were reopened, anything older was too. (`weather.test.ts` → "is monotone in
    // window length" pins the arithmetic that makes this true.)
    //
    // This is the *allow* side, and it is deliberate: blocking here would deny a legitimate reopen on
    // any body busy enough to carry eleven fresh reports. The scan is complete — 12 rows, well under
    // the 200-row cap — so `truncated` is false and only the suppressor cap is in play.
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const reporter = await seedUser(t, 'reporter');
    const waterBodyId = await seedBody(t);
    const now = Date.now();

    // Twelve reports inside the 48h base window, so every one of them suppresses weather-free and the
    // evaluator stops at ten. Spread so the newest ten are strictly newer than the last two.
    const seeded: { id: Id<'reports'>; skateEndTime: number }[] = [];
    await t.run(async (ctx) => {
      for (let i = 0; i < 12; i++) {
        const skateEndTime = now - (1 + i) * HOUR;
        const id = await ctx.db.insert('reports', {
          authorId: reporter.id,
          waterBodyId,
          point: { lat: 0.5, lng: 0.5 },
          skateEndTime,
          reportTime: now,
          source: 'native' as const,
          iceTypes: [],
          surfaceTags: [],
          moderationStatus: 'visible' as const,
          photoIds: [],
          hazardIdsCreated: [],
          createdAt: now,
          updatedAt: now,
        });
        seeded.push({ id, skateEndTime });
      }
    });

    // What the action would hand back: the ten newest suppressors, all reopened by the freeze since.
    const inputs = await requester.as.query(internal.bounties.bountyFreshnessInputs, {
      waterBodyId,
    });
    expect(inputs.status).toBe('ok');
    const reopened = inputs.status === 'ok' ? inputs.reports : [];
    expect(reopened).toHaveLength(10); // BOUNTY_FRESH_MAX_REPORTS — the cap under discussion
    // Every one of them is newer than the two the cap never reached.
    const oldestReopened = Math.min(...reopened.map((r) => r.skateEndTime));
    expect(seeded.filter((r) => r.skateEndTime < oldestReopened)).toHaveLength(2);

    const outcome = await requester.as.mutation(internal.bounties.createChecked, {
      waterBodyId,
      weatherReopenedReports: reopened,
    });
    expect(outcome.ok).toBe(true);
  });

  test('a truncated scan blocks even when every suppressor it found was weather-reopened (N1)', async () => {
    // Greptile PR #27 round 5: the first saturation rule was "truncated AND no suppressors", which
    // left the hole exactly where the logic gets interesting. A truncated scan whose suppressors were
    // all weather-reopened has no blocker either — and a freeze clearing the reports we *did* read
    // says nothing about the ones past the cap. So the block is decided after the reopen set is
    // applied: whatever the scanned rows resolve to, a truncated scan can't clear the body.
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const reporter = await seedUser(t, 'reporter');
    const waterBodyId = await seedBody(t);
    const now = Date.now();
    const skateEndTime = now - 1 * HOUR;

    // 200 expired reports + one fresh suppressor = 201 rows, so the scan truncates.
    let suppressorId: Id<'reports'> | undefined;
    await t.run(async (ctx) => {
      for (let i = 0; i < 200; i++) {
        await ctx.db.insert('reports', {
          authorId: reporter.id,
          waterBodyId,
          point: { lat: 0.5, lng: 0.5 },
          skateEndTime: now - (100 + i * 0.2) * HOUR,
          reportTime: now,
          source: 'native' as const,
          iceTypes: [],
          surfaceTags: [],
          moderationStatus: 'visible' as const,
          photoIds: [],
          hazardIdsCreated: [],
          createdAt: now,
          updatedAt: now,
        });
      }
      suppressorId = await ctx.db.insert('reports', {
        authorId: reporter.id,
        waterBodyId,
        point: { lat: 0.5, lng: 0.5 },
        skateEndTime,
        reportTime: now,
        source: 'native' as const,
        iceTypes: [],
        surfaceTags: [],
        moderationStatus: 'visible' as const,
        photoIds: [],
        hazardIdsCreated: [],
        createdAt: now,
        updatedAt: now,
      });
    });

    // The action clears the ONLY suppressor it found. On a complete scan that would allow the bounty
    // (the test above this proves the reopen path works); on a truncated one it must not.
    const outcome = await requester.as.mutation(internal.bounties.createChecked, {
      waterBodyId,
      weatherReopenedReports: [{ reportId: suppressorId as Id<'reports'>, skateEndTime }],
    });
    expect(outcome).toMatchObject({ ok: false, decision: 'suppressed' });
  }, 30_000);

  test('a saturated freshness scan blocks rather than guessing (N1)', async () => {
    // Greptile PR #27, round 2: newest-first is only a *heuristic* for "most likely to suppress".
    // A report's window stretches with author trust and thumbs (to 3× base) and shrinks to as little
    // as zero, so a trusted read from four days ago can outlast 200 newer throwaway ones — and the
    // cap can't be raised past the read fan-out to find it. When the scan saturates without finding
    // a suppressor, the verdict is unknown, and the gate has to block instead of allowing.
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const reporter = await seedUser(t, 'reporter');
    const waterBodyId = await seedBody(t);
    const now = Date.now();

    // One MORE than the cap, all inside the 144h query window but all well past their own 24h
    // (new-account) windows — so nothing in the scanned set suppresses, and the cap is genuinely what
    // stopped the scan. Whether the report just past the cap would have suppressed is unknowable
    // here; that's the point. (201, not 200: at exactly the cap the scan is *complete*, and treating
    // that as a truncation would reject a valid bounty — see the boundary test below.)
    await t.run(async (ctx) => {
      for (let i = 0; i < 201; i++) {
        await ctx.db.insert('reports', {
          authorId: reporter.id,
          waterBodyId,
          point: { lat: 0.5, lng: 0.5 },
          skateEndTime: now - (100 + i * 0.2) * HOUR,
          reportTime: now,
          source: 'native' as const,
          iceTypes: [],
          surfaceTags: [],
          moderationStatus: 'visible' as const,
          photoIds: [],
          hazardIdsCreated: [],
          createdAt: now,
          updatedAt: now,
        });
      }
    });

    const outcome = await requester.as.mutation(internal.bounties.createChecked, {
      waterBodyId,
      weatherReopenedReports: [],
    });
    expect(outcome).toMatchObject({ ok: false, decision: 'suppressed' });
    // And the action's pre-gate short-circuits too, so a saturated body never drives weather I/O.
    const inputs = await requester.as.query(internal.bounties.bountyFreshnessInputs, {
      waterBodyId,
    });
    expect(inputs.status).toBe('suppressed');
  }, 30_000);

  test('a body with EXACTLY the scan cap is a complete scan, not a saturated one (N1)', async () => {
    // The boundary the saturation rule turns on. `take(cap)` returning `cap` rows is ambiguous —
    // exactly that many, or more behind them — and calling it a truncation would reject a bounty on
    // a body whose every report was read and none of which suppresses. The scan asks for `cap + 1`
    // so the two cases are distinguishable (Greptile PR #27). Same fixture as the test above, one
    // report short of overflowing.
    const t = harness();
    const requester = await seedUser(t, 'requester');
    const reporter = await seedUser(t, 'reporter');
    const waterBodyId = await seedBody(t);
    const now = Date.now();

    await t.run(async (ctx) => {
      for (let i = 0; i < 200; i++) {
        await ctx.db.insert('reports', {
          authorId: reporter.id,
          waterBodyId,
          point: { lat: 0.5, lng: 0.5 },
          skateEndTime: now - (100 + i * 0.2) * HOUR,
          reportTime: now,
          source: 'native' as const,
          iceTypes: [],
          surfaceTags: [],
          moderationStatus: 'visible' as const,
          photoIds: [],
          hazardIdsCreated: [],
          createdAt: now,
          updatedAt: now,
        });
      }
    });

    const outcome = await requester.as.mutation(internal.bounties.createChecked, {
      waterBodyId,
      weatherReopenedReports: [],
    });
    expect(outcome.ok).toBe(true); // nothing suppresses, and we know it — so the bounty is allowed
  }, 30_000);

  test('does not log a rejection that never reached the gate (unauthorized, missing body)', async () => {
    const t = harness();
    const waterBodyId = await seedBody(t);
    // Anonymous: rejected before any DB work. An auth failure is not a tuning signal, and counting it
    // would inflate the denominator of every rate the gate charts.
    await expect(t.action(api.bounties.create, { waterBodyId })).rejects.toThrow(/Not signed in/);
    expect(await gateEvents(t)).toHaveLength(0);
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
