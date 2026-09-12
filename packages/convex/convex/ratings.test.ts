import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

function harness() {
  const t = convexTest(schema, modules);
  return t;
}

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

async function seedUser(t: ReturnType<typeof convexTest>, subject: string) {
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

async function seedBody(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Shelburne Pond',
      searchText: 'Shelburne Pond',
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [0, 0],
            [0, 1],
            [1, 1],
            [1, 0],
            [0, 0],
          ],
        ],
      },
      bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      centroid: { lat: 0.5, lng: 0.5 },
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  );
}

type Actor = Awaited<ReturnType<typeof seedUser>>;

async function seedReport(actor: Actor, waterBodyId: Id<'waterBodies'>) {
  return actor.as.mutation(api.reports.create, {
    waterBodyId,
    skateEndTime: Date.now(),
    iceTypes: ['black_ice'],
    skateQuality: 'great',
  }) as Promise<Id<'reports'>>;
}

async function points(t: ReturnType<typeof convexTest>, id: Id<'profiles'>) {
  return (await t.run((ctx) => ctx.db.get(id)))?.reputationPoints ?? 0;
}

/** Make every queued notification due and flush it — the settle window, fast-forwarded. */
async function flushAllDue(t: ReturnType<typeof harness>) {
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query('notificationQueue').collect()) {
      await ctx.db.patch(row._id, { flushAfter: Date.now() - 1 });
    }
  });
  await t.mutation(internal.notifications.flushNotificationQueue, {});
  return t.run((ctx) => ctx.db.query('notifications').collect());
}

describe('ratings.rate — helpful', () => {
  test('awards helpful_thumb (+5) to the report author + a report_rated notice', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const rater = await seedUser(t, 'rater');
    const waterBodyId = await seedBody(t);
    const reportId = await seedReport(author, waterBodyId);
    const before = await points(t, author.id);

    await rater.as.mutation(api.ratings.rate, {
      targetType: 'report',
      targetId: reportId,
      verdict: 'helpful',
    });

    expect(await points(t, author.id)).toBe(before + 5);
    // The notice settles in the queue first (N8 / D169) — nothing lands in the inbox until the flush
    // re-reads the thumb and finds it still helpful.
    expect(await t.run((ctx) => ctx.db.query('notifications').collect())).toHaveLength(0);
    const notes = (await flushAllDue(t)).filter((n) => n.userId === author.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.type).toBe('report_rated');
    expect(notes[0]?.payload).toMatchObject({
      kind: 'thumb',
      targetType: 'report',
      targetId: reportId,
      actorIds: [rater.id],
      count: 1,
    });
  });

  test('a thumb retracted inside the settle window never sends (D169)', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const rater = await seedUser(t, 'rater');
    const waterBodyId = await seedBody(t);
    const reportId = await seedReport(author, waterBodyId);
    const args = { targetType: 'report' as const, targetId: reportId };

    await rater.as.mutation(api.ratings.rate, { ...args, verdict: 'helpful' });
    await rater.as.mutation(api.ratings.rate, { ...args, verdict: 'unhelpful' });
    expect(await flushAllDue(t)).toHaveLength(0);

    // …and the flip-flop — helpful → unhelpful → helpful — is one row and one notification.
    await rater.as.mutation(api.ratings.rate, { ...args, verdict: 'helpful' });
    await rater.as.mutation(api.ratings.rate, { ...args, verdict: 'unhelpful' });
    await rater.as.mutation(api.ratings.rate, { ...args, verdict: 'helpful' });
    expect(await t.run((ctx) => ctx.db.query('notificationQueue').collect())).toHaveLength(1);
    const notes = await flushAllDue(t);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.payload).toMatchObject({ actorIds: [rater.id], count: 1 });
  });

  test('several thumbs inside one window coalesce, and a retracted one drops out of the count', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const a = await seedUser(t, 'rater-a');
    const b = await seedUser(t, 'rater-b');
    const c = await seedUser(t, 'rater-c');
    const waterBodyId = await seedBody(t);
    const reportId = await seedReport(author, waterBodyId);
    const args = { targetType: 'report' as const, targetId: reportId };

    for (const rater of [a, b, c]) {
      await rater.as.mutation(api.ratings.rate, { ...args, verdict: 'helpful' });
    }
    await b.as.mutation(api.ratings.rate, { ...args, verdict: 'unhelpful' });

    const notes = await flushAllDue(t);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.payload).toMatchObject({ actorIds: [a.id, c.id], count: 2 });
  });

  test('is one-vote-per-rater — a repeat helpful is a no-op', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const rater = await seedUser(t, 'rater');
    const waterBodyId = await seedBody(t);
    const reportId = await seedReport(author, waterBodyId);
    const before = await points(t, author.id);

    const args = { targetType: 'report' as const, targetId: reportId, verdict: 'helpful' as const };
    const first = await rater.as.mutation(api.ratings.rate, args);
    const second = await rater.as.mutation(api.ratings.rate, args);

    expect(second).toBe(first);
    expect(await points(t, author.id)).toBe(before + 5); // not +10
  });

  test('rejects rating your own content', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const reportId = await seedReport(author, waterBodyId);
    await expect(
      author.as.mutation(api.ratings.rate, {
        targetType: 'report',
        targetId: reportId,
        verdict: 'helpful',
      }),
    ).rejects.toThrow(/your own content/);
  });
});

describe('ratings.rate — unhelpful', () => {
  test('writes no points and routes an auto_low_quality flag at the threshold without hiding', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const reportId = await seedReport(author, waterBodyId);
    const before = await points(t, author.id);

    // Three distinct downvotes → net-unhelpful 3 crosses the threshold.
    for (const name of ['d1', 'd2', 'd3']) {
      const downvoter = await seedUser(t, name);
      await downvoter.as.mutation(api.ratings.rate, {
        targetType: 'report',
        targetId: reportId,
        verdict: 'unhelpful',
      });
    }

    expect(await points(t, author.id)).toBe(before); // unhelpful never scores
    const flags = await t.run((ctx) =>
      ctx.db
        .query('contentFlags')
        .withIndex('by_target', (q) => q.eq('targetType', 'report').eq('targetId', reportId))
        .collect(),
    );
    const auto = flags.filter((f) => f.reason === 'auto_low_quality');
    expect(auto).toHaveLength(1); // one flag, deduped — not one per downvoter
    const report = await t.run((ctx) => ctx.db.get(reportId));
    expect(report?.moderationStatus).toBe('visible'); // never hidden by score (D3)
  });

  test('one rater flipping their vote cannot run up the occurrence count', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const reportId = await seedReport(author, waterBodyId);

    const downvoters = [];
    // Three crosses the threshold and files the flag; the next two are further people piling on,
    // which is what an occurrence means here.
    for (const name of ['d1', 'd2', 'd3', 'd4', 'd5']) {
      const downvoter = await seedUser(t, name);
      await downvoter.as.mutation(api.ratings.rate, {
        targetType: 'report',
        targetId: reportId,
        verdict: 'unhelpful',
      });
      downvoters.push(downvoter);
    }

    const autoFlag = async () => {
      const flags = await t.run((ctx) =>
        ctx.db
          .query('contentFlags')
          .withIndex('by_target', (q) => q.eq('targetType', 'report').eq('targetId', reportId))
          .collect(),
      );
      return flags.filter((f) => f.reason === 'auto_low_quality')[0];
    };
    expect((await autoFlag())?.occurrences).toBe(3); // filed at d3, then d4 and d5 each counted once

    // Now one of them changes their mind, twice. An identical re-vote already short-circuits, so the
    // way back into the auto-flag path is a *flip* — and `occurrences` is what a moderator reads to
    // decide the D57 lever, so it has to be a fact about the content rather than something a single
    // rater can author about someone else's report.
    const flipper = downvoters[0];
    for (let i = 0; i < 3; i++) {
      await flipper?.as.mutation(api.ratings.rate, {
        targetType: 'report',
        targetId: reportId,
        verdict: 'helpful',
      });
      await flipper?.as.mutation(api.ratings.rate, {
        targetType: 'report',
        targetId: reportId,
        verdict: 'unhelpful',
      });
    }

    expect((await autoFlag())?.occurrences).toBe(3); // unmoved by six round trips
  });

  test('discards a thumbs-down across a block relationship, but keeps thumbs-up', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const grudge = await seedUser(t, 'grudge');
    const waterBodyId = await seedBody(t);
    const reportId = await seedReport(author, waterBodyId);
    await t.run((ctx) =>
      ctx.db.insert('blocks', {
        blockerId: author.id,
        blockedId: grudge.id,
        createdAt: Date.now(),
      }),
    );

    const discarded = await grudge.as.mutation(api.ratings.rate, {
      targetType: 'report',
      targetId: reportId,
      verdict: 'unhelpful',
    });
    expect(discarded).toBeNull();
    const rows = await t.run((ctx) =>
      ctx.db
        .query('reportRatings')
        .withIndex('by_target', (q) => q.eq('targetType', 'report').eq('targetId', reportId))
        .collect(),
    );
    expect(rows).toHaveLength(0); // nothing recorded

    // A thumbs-up from the same blocked user still counts.
    const before = await points(t, author.id);
    await grudge.as.mutation(api.ratings.rate, {
      targetType: 'report',
      targetId: reportId,
      verdict: 'helpful',
    });
    expect(await points(t, author.id)).toBe(before + 5);
  });

  test('reverses the award when a helpful is changed to unhelpful', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const rater = await seedUser(t, 'rater');
    const waterBodyId = await seedBody(t);
    const reportId = await seedReport(author, waterBodyId);
    const before = await points(t, author.id);

    await rater.as.mutation(api.ratings.rate, {
      targetType: 'report',
      targetId: reportId,
      verdict: 'helpful',
    });
    expect(await points(t, author.id)).toBe(before + 5);

    await rater.as.mutation(api.ratings.rate, {
      targetType: 'report',
      targetId: reportId,
      verdict: 'unhelpful',
    });
    expect(await points(t, author.id)).toBe(before); // +5 then −5, honestly reconciled
  });
});

describe('ratings.summaryForTarget', () => {
  test('returns tallies and the viewer’s own verdict', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const rater = await seedUser(t, 'rater');
    const waterBodyId = await seedBody(t);
    const reportId = await seedReport(author, waterBodyId);
    await rater.as.mutation(api.ratings.rate, {
      targetType: 'report',
      targetId: reportId,
      verdict: 'helpful',
    });

    const mine = await rater.as.query(api.ratings.summaryForTarget, {
      targetType: 'report',
      targetId: reportId,
    });
    expect(mine).toMatchObject({ helpful: 1, unhelpful: 0, mine: 'helpful' });

    const theirs = await author.as.query(api.ratings.summaryForTarget, {
      targetType: 'report',
      targetId: reportId,
    });
    expect(theirs.mine).toBeNull();
  });
});
