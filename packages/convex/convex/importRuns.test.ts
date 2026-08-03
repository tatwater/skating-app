/**
 * ETL run history (N6c F2). Three things matter here, and none of them is arithmetic for its own
 * sake:
 *
 *  - **A truncated failure list must say it was truncated.** The pair `failures` /
 *    `failuresTotal` is the whole design; a sample that silently passes for the whole set would
 *    make the table worse than the printed summaries it replaces.
 *  - **A retried progress write must not double-count.** Counts replace by name; failures append.
 *  - **The read side is admin-only.** Run rows name deployment targets, source URLs and checksums.
 */
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { MAX_STORED_FAILURES } from './importRuns';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

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

function harness() {
  return convexTest(schema, modules);
}

async function seedUser(
  t: ReturnType<typeof harness>,
  subject: string,
  role: 'member' | 'moderator' | 'admin',
) {
  await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return t.withIdentity({ subject });
}

async function startRun(
  t: ReturnType<typeof harness>,
  overrides: Record<string, unknown> = {},
): Promise<Id<'importRuns'>> {
  return await t.mutation(internal.importRuns.start, {
    kind: 'canonical_water' as const,
    label: 'VT canonical water',
    deployment: 'dev:agile-bee-397',
    isProd: false,
    ...overrides,
  });
}

describe('importRuns write path', () => {
  test('a run opens as running with no finish time — a killed loader leaves this behind', async () => {
    const t = harness();
    const runId = await startRun(t);
    const row = await t.run((ctx) => ctx.db.get(runId));

    expect(row?.status).toBe('running');
    expect(row?.finishedAt).toBeUndefined();
    expect(row?.failuresTotal).toBe(0);
  });

  test('counts replace by name, so a retried progress write cannot double-count', async () => {
    const t = harness();
    const runId = await startRun(t);

    await t.mutation(internal.importRuns.progress, {
      runId,
      counts: [{ name: 'inserted', value: 500 }],
    });
    // The same call again — what a retry looks like.
    await t.mutation(internal.importRuns.progress, {
      runId,
      counts: [{ name: 'inserted', value: 500 }],
    });

    const row = await t.run((ctx) => ctx.db.get(runId));
    expect(row?.counts).toEqual([{ name: 'inserted', value: 500 }]);
  });

  test('stages replace by name, so re-sending a stage refines it instead of duplicating it', async () => {
    const t = harness();
    const runId = await startRun(t, { stages: [{ name: 'extract', sha256: 'abc' }] });

    await t.mutation(internal.importRuns.progress, {
      runId,
      stages: [{ name: 'load', counts: [{ name: 'batchesApplied', value: 3 }] }],
    });
    await t.mutation(internal.importRuns.progress, {
      runId,
      stages: [{ name: 'load', counts: [{ name: 'batchesApplied', value: 67 }] }],
    });

    const row = await t.run((ctx) => ctx.db.get(runId));
    expect(row?.stages.map((s) => s.name)).toEqual(['extract', 'load']);
    expect(row?.stages[1]?.counts).toEqual([{ name: 'batchesApplied', value: 67 }]);
  });

  test('failures append across calls and the total keeps counting past the stored cap', async () => {
    const t = harness();
    const runId = await startRun(t);

    // Two batches of failures, together well past the cap.
    for (let batch = 0; batch < 2; batch++) {
      await t.mutation(internal.importRuns.progress, {
        runId,
        failures: Array.from({ length: MAX_STORED_FAILURES }, (_, i) => ({
          stage: 'transform',
          key: `way/${batch}-${i}`,
          reason: 'unclosed ring',
        })),
      });
    }

    const row = await t.run((ctx) => ctx.db.get(runId));
    expect(row?.failures).toHaveLength(MAX_STORED_FAILURES);
    expect(row?.failuresTotal).toBe(MAX_STORED_FAILURES * 2);
    // The sample kept is the *first* one seen, not the last — the earliest failures are the ones
    // that diagnose a run, and a tail sample would be dominated by whatever cascaded.
    expect(row?.failures[0]?.key).toBe('way/0-0');
  });

  test("a loader's own failure total wins when it saw more than it forwarded", async () => {
    const t = harness();
    const runId = await startRun(t);

    await t.mutation(internal.importRuns.progress, {
      runId,
      failures: [{ stage: 'transform', reason: 'bad geometry' }],
      failuresTotal: 4_000,
    });

    const row = await t.run((ctx) => ctx.db.get(runId));
    expect(row?.failures).toHaveLength(1);
    expect(row?.failuresTotal).toBe(4_000);
  });

  test('finish stamps the terminal status, the time and the error', async () => {
    const t = harness();
    const runId = await startRun(t);

    await t.mutation(internal.importRuns.finish, {
      runId,
      status: 'failed' as const,
      error: '5 consecutive batch failures',
      counts: [{ name: 'inserted', value: 10 }],
    });

    const row = await t.run((ctx) => ctx.db.get(runId));
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('5 consecutive batch failures');
    expect(row?.finishedAt).toBeTypeOf('number');
    expect(row?.counts).toEqual([{ name: 'inserted', value: 10 }]);
  });

  test('coverage replaces wholesale rather than merging a half-updated denominator', async () => {
    const t = harness();
    const runId = await startRun(t);

    await t.mutation(internal.importRuns.progress, {
      runId,
      coverage: { unit: 'bodies', eligible: 100, covered: 10, omissions: [] },
    });
    await t.mutation(internal.importRuns.progress, {
      runId,
      coverage: {
        unit: 'bodies',
        eligible: 116_070,
        covered: 8_100,
        omissions: [{ reason: 'below the HydroLAKES 10 ha floor', count: 107_970 }],
      },
    });

    const row = await t.run((ctx) => ctx.db.get(runId));
    expect(row?.coverage?.eligible).toBe(116_070);
    expect(row?.coverage?.omissions).toHaveLength(1);
  });

  test('a progress call that omits coverage leaves the existing one standing', async () => {
    const t = harness();
    const runId = await startRun(t);
    await t.mutation(internal.importRuns.progress, {
      runId,
      coverage: { unit: 'bodies', eligible: 100, covered: 90, omissions: [] },
    });
    await t.mutation(internal.importRuns.progress, { runId, counts: [{ name: 'x', value: 1 }] });

    const row = await t.run((ctx) => ctx.db.get(runId));
    expect(row?.coverage?.covered).toBe(90);
  });

  test('writing to a run that does not exist throws rather than silently doing nothing', async () => {
    const t = harness();
    const runId = await startRun(t);
    await t.run((ctx) => ctx.db.delete(runId));

    await expect(t.mutation(internal.importRuns.progress, { runId, counts: [] })).rejects.toThrow(
      /not found/,
    );
  });
});

describe('importRuns read path', () => {
  test('is admin-only — a moderator cannot read deployment targets and source URLs', async () => {
    const t = harness();
    await startRun(t);
    const moderator = await seedUser(t, 'mod', 'moderator');

    await expect(moderator.query(api.importRuns.list, {})).rejects.toThrow();
  });

  test('lists newest first for an admin', async () => {
    const t = harness();
    const first = await startRun(t, { label: 'first' });
    const second = await startRun(t, { label: 'second' });
    const admin = await seedUser(t, 'admin', 'admin');

    const runs = await admin.query(api.importRuns.list, {});
    expect(runs.map((r) => r._id)).toEqual([second, first]);
  });

  test('narrows by kind and by campaign', async () => {
    const t = harness();
    await startRun(t, { kind: 'canonical_water' as const, campaignId: 'n6c' });
    await startRun(t, { kind: 'elevation' as const, campaignId: 'n6c' });
    await startRun(t, { kind: 'elevation' as const, campaignId: 'other' });
    const admin = await seedUser(t, 'admin', 'admin');

    expect(await admin.query(api.importRuns.list, { kind: 'elevation' })).toHaveLength(2);
    // A campaign is the unit "how did the last import go" is actually asking about — five state
    // extracts are five rows and one operation.
    expect(await admin.query(api.importRuns.list, { campaignId: 'n6c' })).toHaveLength(2);
  });

  test('get returns one run with its full stage path', async () => {
    const t = harness();
    const runId = await startRun(t, {
      stages: [
        {
          name: 'extract',
          sourceUrl: 'https://download.geofabrik.de/x.pbf',
          checksumVerified: true,
        },
        { name: 'filter', command: 'osmium tags-filter …' },
      ],
    });
    const admin = await seedUser(t, 'admin', 'admin');

    const run = await admin.query(api.importRuns.get, { runId });
    expect(run?.stages.map((s) => s.name)).toEqual(['extract', 'filter']);
    expect(run?.stages[0]?.checksumVerified).toBe(true);
  });
});
