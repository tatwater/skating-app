/**
 * Account deletion (D33/D62) — the grace window, the three buckets, and the two invariants that would
 * be silent failures if they broke: the second tombstone must not break authentication, and finalize
 * must not pull a departing skater's published tracks off the aggregate map.
 */
import {
  DELETED_DISPLAY_NAME,
  DELETION_GRACE_MS,
  deletedClerkUserId,
  deletedUsername,
  needsProfileSetup,
  RISK_ACK_VERSION,
} from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

/**
 * Fake timers from before the first schedule, per the note in `subAreas.test.ts`: finalize is a
 * `scheduler.runAfter(0)` chain, and convex-test leaves such a job `pending` until a timer fires —
 * so without this `finishAllScheduledFunctions` drains nothing and every assertion reads a row the
 * job never reached, failing as a plausible-looking "the deletion didn't happen".
 */
function harness() {
  vi.useFakeTimers();
  // **Pinned, not merely faked** (D62 amendment). Content now has a lifetime — anything more than 30
  // days past its skate is erased the moment its author asks to be deleted — so a fixture dated
  // `T0` against a real wall clock silently becomes "six months old" and gets purged by tests that
  // meant to assert it survives. Pinning `now` to `T0` makes every fixture fresh by default and makes
  // aging an explicit act: `T0 - LONG_AGO`.
  vi.setSystemTime(T0);
  return convexTest(schema, modules);
}

afterEach(() => {
  vi.useRealTimers();
});

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

const ADULT_DOB = Date.UTC(1990, 0, 1);
const T0 = Date.UTC(2026, 0, 15, 14, 0, 0);
/** Comfortably past the 30-day purge line, for content a test wants erased. */
const LONG_AGO = 60 * 24 * 3600_000;

/** What `seedUser` hands back: the profile id plus a client bound to that identity. */
type SeededUser = Awaited<ReturnType<typeof seedUser>>;

async function seedUser(t: ReturnType<typeof convexTest>, subject: string) {
  const id = (await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      homeCoord: { lat: 44.5, lng: -73.2 },
      homeTownLabel: 'Burlington, VT',
      bio: 'I skate.',
      profileImageUrl: 'https://img.clerk.com/x',
      outerRadiusMeters: 90_000,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: ADULT_DOB,
      reputationPoints: 40,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: T0,
    }),
  )) as Id<'profiles'>;
  return { id, as: t.withIdentity({ subject }) };
}

async function seedBody(t: ReturnType<typeof convexTest>, offset = 0) {
  const externalId = `osm/del-${offset}`;
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm' as const,
        externalId,
        name: 'Shelburne Pond',
        type: 'lakePond' as const,
        polygon: {
          type: 'Polygon' as const,
          coordinates: [
            [
              [offset, offset],
              [offset, offset + 1],
              [offset + 1, offset + 1],
              [offset + 1, offset],
              [offset, offset],
            ],
          ],
        },
        bbox: { minLat: offset, minLng: offset, maxLat: offset + 1, maxLng: offset + 1 },
        centroid: { lat: offset + 0.5, lng: offset + 0.5 },
      },
    ],
  });
  const bodies = await t.run((ctx) => ctx.db.query('waterBodies').collect());
  // biome-ignore lint/style/noNonNullAssertion: the import above just wrote it.
  return bodies.find((b) => b.externalId === externalId)!._id;
}

/** Drive the staged job to completion the way the scheduler would. */
async function finalize(t: ReturnType<typeof convexTest>, userId: Id<'profiles'>) {
  await t.mutation(internal.accountDeletion.finalizeNow, { userId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

/** Same, but forcing the continuation path — several pages per stage instead of one. */
async function finalizePaged(
  t: ReturnType<typeof convexTest>,
  userId: Id<'profiles'>,
  pageSize: number,
) {
  await t.run((ctx) => ctx.db.patch(userId, { deletionRequestedAt: Date.now() }));
  await t.mutation(internal.accountDeletion.finalizeAccount, { userId, pageSize });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

describe('the grace window', () => {
  /**
   * The founder's correction to this whole flow, asserted as one test: **the request is the
   * deletion**, and the 30 days keep only the login and the still-useful content.
   *
   * The `status` assertion is the subtle one. It stays `active` on purpose — `status` is what
   * `requireProfile` reads, and reads have to keep working or the person can't get back in to
   * cancel. So "already mostly deleted" is expressed by the scrubbed fields and the read gates, not
   * by the security status, and this test pins that pair together.
   */
  test('requesting deletion wipes the profile immediately — the login is all that is kept', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');

    const { scheduledFor } = await user.as.mutation(api.accountDeletion.requestDeletion, {});
    const profile = await t.run((ctx) => ctx.db.get(user.id));

    // Gone now, not in 30 days.
    expect(profile?.displayName).toBe(DELETED_DISPLAY_NAME);
    expect(profile?.bio).toBeUndefined();
    expect(profile?.profileImageUrl).toBeUndefined();
    expect(profile?.homeCoord).toBeUndefined();
    expect(profile?.homeTownLabel).toBeUndefined();

    // Kept, each for a reason the code comments spell out: the sign-in, the reserved handle, and the
    // date of birth — scrubbing which would let a minor come back from a cancel as an adult.
    expect(profile?.clerkUserId).toBe('leaver');
    expect(profile?.username).toBe('leaver');
    expect(profile?.dateOfBirth).toBe(ADULT_DOB);
    expect(profile?.status).toBe('active');
    expect(scheduledFor).toBe((profile?.deletionRequestedAt ?? 0) + DELETION_GRACE_MS);
    // Still able to call authenticated functions — that's how they get back in to cancel.
    expect(await user.as.query(api.profiles.current, {})).not.toBeNull();
  });

  test('a ghost stops existing for everyone else — no profile, no search result', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const viewer = await seedUser(t, 'viewer');

    expect(await viewer.as.query(api.profiles.getPublicProfile, { username: 'leaver' })).not.toBe(
      null,
    );
    await user.as.mutation(api.accountDeletion.requestDeletion, {});

    expect(await viewer.as.query(api.profiles.getPublicProfile, { username: 'leaver' })).toBeNull();
    expect(await viewer.as.query(api.profiles.searchProfiles, { query: 'leaver' })).toEqual([]);
    // But not to themselves: they have to be able to see where they are and how to get back.
    expect(await user.as.query(api.profiles.getPublicProfile, { username: 'leaver' })).not.toBe(
      null,
    );
  });

  test('their surviving content reads as the tombstone from the moment they ask', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const viewer = await seedUser(t, 'viewer');
    const bodyId = await seedBody(t);
    await user.as.mutation(api.reports.create, { waterBodyId: bodyId, skateEndTime: T0 });
    await t.run((ctx) => ctx.db.patch(user.id, { reputationPoints: 500 }));

    await user.as.mutation(api.accountDeletion.requestDeletion, {});

    const feed = await viewer.as.query(api.reports.listFeed, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    // The report is still there — it's recent, and it's the community's now.
    expect(feed.page).toHaveLength(1);
    // The author isn't. No name, no ring, and no handle to click through to a page that 404s.
    expect(feed.page[0]?.author?.displayName).toBe(DELETED_DISPLAY_NAME);
    expect(feed.page[0]?.author?.username).toBe('');
    expect(feed.page[0]?.author?.trustClass ?? null).toBeNull();
  });

  /**
   * The other half of the founder's rule, and the irreversible one — restated by the D62 **second**
   * amendment, which is what this test now pins.
   *
   * The first amendment erased aged content outright. The correction draws the line between what a
   * person *typed* and what they *observed*: the observation is the community's and stays, the prose
   * is theirs and goes. So the assertion pair below is the whole posture in six lines — the row
   * survives, the words don't, and cancelling brings back neither.
   */
  test('aged words are redacted at the request, and cancelling does not bring them back', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const bodyId = await seedBody(t);
    const old = await user.as.mutation(api.reports.create, {
      waterBodyId: bodyId,
      skateEndTime: T0 - LONG_AGO,
      notes: 'Ridge across the north bay, water in the crack.',
    });
    const recent = await user.as.mutation(api.reports.create, {
      waterBodyId: bodyId,
      skateEndTime: T0 - 24 * 3600_000,
      notes: 'Glass all the way out.',
    });

    await user.as.mutation(api.accountDeletion.requestDeletion, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // The report is still on the lake. What they wrote about it is not.
    const aged = await t.run((ctx) => ctx.db.get(old));
    expect(aged).not.toBeNull();
    expect(aged?.notes).toBeUndefined();
    expect(aged?.skateEndTime).toBe(T0 - LONG_AGO); // the observation is untouched
    // Inside the window, the prose is untouched — this is a 30-day clock, not a flag on the account.
    expect((await t.run((ctx) => ctx.db.get(recent)))?.notes).toBe('Glass all the way out.');

    await user.as.mutation(api.accountDeletion.cancelDeletion, {});
    expect((await t.run((ctx) => ctx.db.get(old)))?.notes).toBeUndefined(); // still gone. The point.
    expect((await t.run((ctx) => ctx.db.get(recent)))?.notes).toBe('Glass all the way out.');
  });

  /**
   * Every free-text field, not just the obvious one. `iceThickness.readings[].note` is prose in a
   * nested array rather than a column, which is exactly the shape a redaction pass forgets — and the
   * readings themselves have to survive it, since a measurement is the most valuable thing a report
   * carries.
   */
  test('redaction reaches the notes nested inside thickness readings, and spares the readings', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const bodyId = await seedBody(t);
    const reportId = await user.as.mutation(api.reports.create, {
      waterBodyId: bodyId,
      skateEndTime: T0 - LONG_AGO,
      iceThickness: {
        readings: [
          { valueCm: 12, method: 'measured' as const, note: 'by the boat launch, my usual spot' },
          { valueCm: 9, method: 'estimated' as const },
        ],
      },
    });

    await user.as.mutation(api.accountDeletion.requestDeletion, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const report = await t.run((ctx) => ctx.db.get(reportId));
    expect(report?.iceThickness?.readings).toHaveLength(2);
    expect(report?.iceThickness?.readings[0]?.valueCm).toBe(12);
    expect(report?.iceThickness?.readings[0]?.note).toBeUndefined();
    expect(report?.iceThickness?.readings[1]?.method).toBe('estimated');
  });

  /**
   * Comments keep their shell so the thread keeps its shape (D62 second amendment). A reply whose
   * parent vanished is unreachable — the thread is keyed by `reportId` — so the row survives, marked,
   * and the client renders the standing-in line instead of a blank bubble.
   */
  test('an aged comment keeps its place in the thread and loses its text', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const other = await seedUser(t, 'stayer');
    const bodyId = await seedBody(t);
    const reportId = await other.as.mutation(api.reports.create, {
      waterBodyId: bodyId,
      skateEndTime: T0 - 24 * 3600_000,
    });
    const commentId = await user.as.mutation(api.comments.create, {
      reportId,
      body: 'I was out here last week too.',
    });
    // Age the comment past the line — `createdAt` is its clock, since a comment has no skate.
    await t.run((ctx) => ctx.db.patch(commentId, { createdAt: T0 - LONG_AGO }));

    await user.as.mutation(api.accountDeletion.requestDeletion, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const row = await t.run((ctx) => ctx.db.get(commentId));
    expect(row).not.toBeNull(); // the hole this avoids is in somebody else's conversation
    expect(row?.body).toBe('');
    expect(row?.redactedAt).toBeDefined();

    const thread = await other.as.query(api.comments.listByReport, { reportId });
    expect(thread).toHaveLength(1);
    expect(thread[0]?.comment?.redacted).toBe(true);
    expect(thread[0]?.comment?.author?.displayName).toBe(DELETED_DISPLAY_NAME);
  });

  /**
   * D62 amendment: *"put-ins survive — access is the corpus's single most-discussed concern."*
   *
   * Worth a test even though nothing in the deletion path mentions put-ins any more, because the
   * *reason* it now holds is indirect and a future change could break it without touching anything
   * named `putIn`. Derived markers aren't stored — `listForBody` recomputes them from a body's live
   * reports on every read — so the marker survives precisely because the report does. Under the first
   * amendment it didn't, and the purge had to materialize a row to compensate.
   *
   * It also pins `lastUsedAt`: put-ins are exempt from every ageing rule in the app, so the date is
   * how a three-winters-old access point avoids reading as current (D3).
   */
  test("a departed skater's put-in survives, dated by the skate that revealed it", async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const bodyId = await seedBody(t);
    await user.as.mutation(api.reports.create, {
      waterBodyId: bodyId,
      skateEndTime: T0 - LONG_AGO,
      point: { lat: 0.5, lng: 0.02 },
    });

    const before = await user.as.query(api.putIns.listForBody, { waterBodyId: bodyId });
    expect(before).toHaveLength(1);

    await user.as.mutation(api.accountDeletion.requestDeletion, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // The report is still there — redacted, not erased — and so is the way onto the ice.
    const reports = await t.run((ctx) => ctx.db.query('reports').collect());
    expect(reports).toHaveLength(1);
    const after = await user.as.query(api.putIns.listForBody, { waterBodyId: bodyId });
    expect(after).toHaveLength(1);
    expect(after[0]?.coord.lat).toBeCloseTo(before[0]?.coord.lat ?? 0, 4);
    // Dated by the skate, so the marker can say how old the access claim is.
    expect(after[0]?.lastUsedAt).toBe(T0 - LONG_AGO);
  });

  test('a withheld put-in stays withheld — leaving is not the moment to publish it', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const bodyId = await seedBody(t);
    await user.as.mutation(api.reports.create, {
      waterBodyId: bodyId,
      skateEndTime: T0 - LONG_AGO,
      point: { lat: 0.5, lng: 0.02 },
      showPutIn: false,
    });

    await user.as.mutation(api.accountDeletion.requestDeletion, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await user.as.query(api.putIns.listForBody, { waterBodyId: bodyId })).toEqual([]);
  });

  test('cancelling leaves the profile empty, so the app sends them back through onboarding', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    await user.as.mutation(api.accountDeletion.requestDeletion, {});
    await user.as.mutation(api.accountDeletion.cancelDeletion, {});

    const profile = await t.run((ctx) => ctx.db.get(user.id));
    expect(profile?.deletionRequestedAt).toBeUndefined();
    expect(profile?.displayName).toBe(DELETED_DISPLAY_NAME); // NOT restored — it was really deleted
    expect(needsProfileSetup(profile)).toBe(true);
    // And the handle they reserved is still theirs to take back.
    expect(profile?.username).toBe('leaver');
  });

  /**
   * The launch sync runs on every cold start and writes `displayName` straight out of Clerk. Without
   * its ghost branch it would un-delete the person's identity the next time they opened the app,
   * which is not a corner case — it's the first thing that happens.
   */
  test('the Clerk launch sync cannot un-wipe a ghost', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    await user.as.mutation(api.accountDeletion.requestDeletion, {});

    await user.as.mutation(api.profiles.upsertFromClerk, {
      displayName: 'Leaver Again',
      username: 'leaver',
      dateOfBirth: ADULT_DOB,
      riskAckVersion: RISK_ACK_VERSION,
    });

    const profile = await t.run((ctx) => ctx.db.get(user.id));
    expect(profile?.displayName).toBe(DELETED_DISPLAY_NAME);
  });

  test('asking twice does not restart the clock', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');

    const first = await user.as.mutation(api.accountDeletion.requestDeletion, {});
    await t.run((ctx) => ctx.db.patch(user.id, { deletionRequestedAt: T0 - 5 * 24 * 3600_000 }));
    const second = await user.as.mutation(api.accountDeletion.requestDeletion, {});

    expect(second.scheduledFor).toBeLessThan(first.scheduledFor);
  });

  test('cancelling clears the stamp', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    await user.as.mutation(api.accountDeletion.requestDeletion, {});

    expect(await user.as.mutation(api.accountDeletion.cancelDeletion, {})).toEqual({
      cancelled: true,
    });
    const profile = await t.run((ctx) => ctx.db.get(user.id));
    expect(profile?.deletionRequestedAt).toBeUndefined();
    // Idempotent: cancelling twice is not an error.
    expect(await user.as.mutation(api.accountDeletion.cancelDeletion, {})).toEqual({
      cancelled: false,
    });
  });

  test('the sweep only finalizes accounts past the window', async () => {
    const t = harness();
    const fresh = await seedUser(t, 'fresh');
    const due = await seedUser(t, 'due');
    await t.run(async (ctx) => {
      await ctx.db.patch(fresh.id, { deletionRequestedAt: Date.now() });
      await ctx.db.patch(due.id, { deletionRequestedAt: Date.now() - DELETION_GRACE_MS - 1000 });
    });

    const result = await t.mutation(internal.accountDeletion.finalizeDueDeletions, {});
    expect(result).toMatchObject({ due: 1, started: 1 });
  });

  /**
   * The bug this suite exists for, caught only by running the cron against dev.
   *
   * A Convex index on an *optional* field is **not sparse**: rows without the field are in it, and
   * `undefined` sorts before every number. So `lte('deletionRequestedAt', cutoff)` matched every
   * profile that had never asked to be deleted, and the first real tick reported `due: 2, started: 2`
   * on a deployment where nobody had requested anything. Only `finalizeAccount`'s re-check of the
   * stamp stopped it from scrubbing both accounts.
   *
   * Both guards are asserted here — the range bound *and* the per-account re-check — because the
   * failure mode is "delete every user", which is not a place to depend on one of them.
   */
  test('the sweep never picks up an account that never asked (the undefined-sorts-first trap)', async () => {
    const t = harness();
    const untouched = await seedUser(t, 'never_asked');
    await seedUser(t, 'also_never_asked');

    const result = await t.mutation(internal.accountDeletion.finalizeDueDeletions, {});
    expect(result).toEqual({ due: 0, started: 0, skipped: 0, redacting: 0 });

    // And the second guard, independently: even handed the id directly, finalize declines.
    const direct = await t.mutation(internal.accountDeletion.finalizeAccount, {
      userId: untouched.id,
    });
    expect(direct).toEqual({ stopped: 'cancelled' });
    const profile = await t.run((ctx) => ctx.db.get(untouched.id));
    expect(profile?.status).toBe('active');
    expect(profile?.displayName).toBe('never_asked');
  });

  test('cancelling mid-flight stops the job before anything irreversible happens', async () => {
    const t = harness();
    const user = await seedUser(t, 'waverer');
    await t.run((ctx) => ctx.db.patch(user.id, { deletionRequestedAt: T0 }));

    await t.run((ctx) => ctx.db.patch(user.id, { deletionRequestedAt: undefined }));
    const result = await t.mutation(internal.accountDeletion.finalizeAccount, { userId: user.id });

    expect(result).toEqual({ stopped: 'cancelled' });
    const profile = await t.run((ctx) => ctx.db.get(user.id));
    expect(profile?.status).toBe('active');
    expect(profile?.displayName).toBe('waverer');
  });
});

/**
 * Read-only while a deletion is pending (D62 amendment, N5a).
 *
 * The window exists to keep *useful* content around while its author reconsiders, so accepting new
 * content into it is self-defeating: a report posted in hour 719 is erased hours later while it's
 * still the freshest thing on the lake. Contributing and leaving are contradictory acts, and the app
 * makes you pick one.
 *
 * The property that matters most is the second suite below — **what stays open**. A gate that also
 * blocked flagging or blocking would trade a tidy rule for a real safety cost, and it's the kind of
 * over-reach that reads as caution.
 */
describe('read-only while a deletion is pending', () => {
  async function pendingUser(t: ReturnType<typeof convexTest>, subject = 'leaver') {
    const user = await seedUser(t, subject);
    await user.as.mutation(api.accountDeletion.requestDeletion, {});
    return user;
  }

  test('contributions are refused, with a message that names the way back', async () => {
    const t = harness();
    const bodyId = await seedBody(t);
    const user = await pendingUser(t);

    await expect(
      user.as.mutation(api.reports.create, { waterBodyId: bodyId, skateEndTime: T0 }),
    ).rejects.toThrow(/scheduled for deletion/i);
  });

  test('every contribution surface is gated, not just reports', async () => {
    const t = harness();
    const bodyId = await seedBody(t);
    const author = await seedUser(t, 'author');
    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId: bodyId,
      skateEndTime: T0,
    });
    const user = await pendingUser(t);

    await expect(user.as.mutation(api.comments.create, { reportId, body: 'nice' })).rejects.toThrow(
      /scheduled for deletion/i,
    );
    await expect(
      user.as.mutation(api.ratings.rate, {
        targetType: 'report' as const,
        targetId: reportId,
        verdict: 'helpful' as const,
      }),
    ).rejects.toThrow(/scheduled for deletion/i);
    await expect(user.as.mutation(api.photos.generateUploadUrl, {})).rejects.toThrow(
      /scheduled for deletion/i,
    );
    await expect(user.as.mutation(api.strava.beginConnect, {})).rejects.toThrow(
      /scheduled for deletion/i,
    );
  });

  /**
   * The exemptions, asserted as a set. Each is here for its own reason: a hazard is no less dangerous
   * because the person who spotted it is leaving; self-protection outlives the account; and the last
   * two are the door out — an export to take with you, and the button that undoes all of this.
   */
  test('protective and account-management actions stay open', async () => {
    const t = harness();
    const bodyId = await seedBody(t);
    const author = await seedUser(t, 'author');
    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId: bodyId,
      skateEndTime: T0,
    });
    const user = await pendingUser(t);

    await expect(
      user.as.mutation(api.contentFlags.flag, {
        targetType: 'report' as const,
        targetId: reportId,
        reason: 'unsafe_false_report' as const,
      }),
    ).resolves.toBeDefined();
    await expect(
      user.as.mutation(api.blocks.block, { targetUserId: author.id }),
    ).resolves.toBeDefined();
    await expect(
      user.as.mutation(api.waterBodyFavorites.toggle, { waterBodyId: bodyId }),
    ).resolves.toBeDefined();
    await expect(user.as.mutation(api.dataExport.requestExport, {})).resolves.toBeDefined();
    await expect(user.as.mutation(api.accountDeletion.cancelDeletion, {})).resolves.toEqual({
      cancelled: true,
    });
  });

  test('cancelling restores posting — the gate is the stamp, nothing else', async () => {
    const t = harness();
    const bodyId = await seedBody(t);
    const user = await pendingUser(t);

    await user.as.mutation(api.accountDeletion.cancelDeletion, {});

    await expect(
      user.as.mutation(api.reports.create, { waterBodyId: bodyId, skateEndTime: T0 }),
    ).resolves.toBeDefined();
  });

  /**
   * The reason the gate exists, stated as a property rather than a message check: with contributions
   * closed, a departed user's newest `skateEndTime` can never be later than their request — so
   * everything they hold is already past the 30-day relevance window when finalization runs, and the
   * N5a purge needs no deferred second sweep.
   */
  test('a pending account cannot produce content newer than its own request', async () => {
    const t = harness();
    const bodyId = await seedBody(t);
    const user = await pendingUser(t);
    const requestedAt = (await t.run((ctx) => ctx.db.get(user.id)))?.deletionRequestedAt ?? 0;

    await expect(
      user.as.mutation(api.reports.create, { waterBodyId: bodyId, skateEndTime: requestedAt + 1 }),
    ).rejects.toThrow(/scheduled for deletion/i);

    const reports = await t.run((ctx) =>
      ctx.db
        .query('reports')
        .filter((q) => q.eq(q.field('authorId'), user.id))
        .collect(),
    );
    expect(reports).toHaveLength(0);
  });
});

/**
 * PR #29 review (Greptile P1, security). Finalization is a chain of separately scheduled mutations,
 * and until the `lock` stage existed the account stayed fully usable across all of them — so a write
 * that landed between two stages went into a table an earlier stage had already drained, and no later
 * stage rescans. The 30-day window makes that unlikely rather than impossible: nobody is locked out
 * during it, so "asked a month ago, forgot, is using the app right now" is an ordinary state.
 */
describe('the finalization lock', () => {
  /** Run only the first stage, leaving the rest of the chain pending — the mid-finalization window. */
  async function lockOnly(t: ReturnType<typeof convexTest>, userId: Id<'profiles'>) {
    await t.run((ctx) => ctx.db.patch(userId, { deletionRequestedAt: Date.now() }));
    await t.mutation(internal.accountDeletion.finalizeAccount, { userId });
  }

  test('an account being finalized cannot write between stages', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    await lockOnly(t, user.id);

    expect((await t.run((ctx) => ctx.db.get(user.id)))?.status).toBe('deleting');
    // Every one of these lands in a table `erase` has already drained or is about to.
    await expect(user.as.mutation(api.dataExport.requestExport, {})).rejects.toThrow(/not active/i);
    await expect(
      user.as.mutation(api.support.create, { category: 'other' as const, body: 'wait, come back' }),
    ).rejects.toThrow(/not active/i);
    await expect(user.as.mutation(api.accountDeletion.cancelDeletion, {})).rejects.toThrow(
      /not active/i,
    );
  });

  test('the private tables are still empty once the chain finishes', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    await lockOnly(t, user.id);

    // A write attempted mid-chain must not exist to survive it.
    await expect(user.as.mutation(api.dataExport.requestExport, {})).rejects.toThrow();
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.run((ctx) => ctx.db.query('dataExports').collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.get(user.id))).toMatchObject({ status: 'deleted' });
  });

  /**
   * The other half of making the lock safe: a `deleting` row is an unfinished job, not a finished one.
   * If the sweep skipped it the way it skips `deleted`, a chain lost to a dropped scheduler tick would
   * leave a permanently half-deleted account that nothing ever revisits.
   */
  test('a chain that died mid-flight is re-driven by the next sweep', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    await t.run((ctx) =>
      ctx.db.patch(user.id, {
        deletionRequestedAt: Date.now() - DELETION_GRACE_MS - 1000,
        status: 'deleting' as const, // locked, then the chain vanished
      }),
    );

    expect(await t.mutation(internal.accountDeletion.finalizeDueDeletions, {})).toMatchObject({
      started: 1,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.run((ctx) => ctx.db.get(user.id)))?.status).toBe('deleted');

    // …and a finished one is not re-run: the tombstone is not a job to redo.
    await t.run((ctx) => ctx.db.patch(user.id, { deletionRequestedAt: Date.now() - 1 }));
    expect(await t.mutation(internal.accountDeletion.finalizeDueDeletions, {})).toMatchObject({
      started: 0,
    });
  });
});

describe('the tombstone', () => {
  test('scrubs every PII field and keeps the row', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    await finalize(t, user.id);

    const profile = await t.run((ctx) => ctx.db.get(user.id));
    expect(profile).not.toBeNull();
    expect(profile?.status).toBe('deleted');
    expect(profile?.deletedAt).toBeDefined();
    expect(profile?.deletionRequestedAt).toBeUndefined();
    expect(profile?.displayName).toBe(DELETED_DISPLAY_NAME);
    expect(profile?.username).toBe(deletedUsername(user.id));
    expect(profile?.clerkUserId).toBe(deletedClerkUserId(user.id));
    expect(profile?.homeCoord).toBeUndefined();
    expect(profile?.homeTownLabel).toBeUndefined();
    expect(profile?.bio).toBeUndefined();
    expect(profile?.profileImageUrl).toBeUndefined();
    expect(profile?.outerRadiusMeters).toBeUndefined();
  });

  /**
   * `statusReason` is the one PII field on `profiles` that the **operator** wrote rather than the user,
   * which is exactly why the scrub missed it: every other field here is something the person typed
   * about themselves. It is a moderator's free-text account of a suspension or ban, and it routinely
   * names a second person ("repeatedly abusive to @someone"), so leaving it on a tombstone retained
   * prose about a deleted user *and* about somebody still here.
   *
   * Nothing is lost by clearing it — `moderationActions` carries a required `reason` and that audit
   * trail deliberately survives deletion, so accountability for a past action is unaffected.
   */
  test('clears the moderator-written status reason', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    await t.run((ctx) =>
      ctx.db.patch(user.id, {
        status: 'suspended' as const,
        statusReason: 'harassing @author in comments; see ticket 41',
        suspendedUntil: T0 - 1, // lapsed, so the account can still act on its own deletion
      }),
    );

    await finalize(t, user.id);

    expect((await t.run((ctx) => ctx.db.get(user.id)))?.statusReason).toBeUndefined();
  });

  /**
   * The landmine this feature turns on. `by_clerk_user_id` and `by_username` are both read with
   * `.unique()`, which throws on more than one match — so a shared 'deleted' sentinel would work for
   * the first deleted account and break sign-in for the entire app on the second.
   */
  test('a SECOND deleted account does not break authentication', async () => {
    const t = harness();
    const first = await seedUser(t, 'first');
    const second = await seedUser(t, 'second');
    await finalize(t, first.id);
    await finalize(t, second.id);

    const rows = await t.run((ctx) => ctx.db.query('profiles').collect());
    expect(new Set(rows.map((r) => r.clerkUserId)).size).toBe(2);
    expect(new Set(rows.map((r) => r.username)).size).toBe(2);

    // The actual failure mode: a live user signing in walks by_clerk_user_id with .unique().
    const live = await seedUser(t, 'still_here');
    expect(await live.as.query(api.profiles.current, {})).not.toBeNull();
  });

  test('a tombstone cannot call authenticated functions', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    await finalize(t, user.id);

    // The Clerk subject is scrubbed, so the old identity resolves to nothing at all.
    expect(await user.as.query(api.profiles.current, {})).toBeNull();
  });

  /**
   * The reason `lib/authorView` exists. A tombstone is a profile row that still has its
   * `reputationPoints`, so every hand-rolled copy of the author shape happily derived a trust ring for
   * someone with no account — and `publicByIds` had been fixed by hand while the feed and the comment
   * thread hadn't. A deleted skater ringed as "trusted" on a card and unringed on their profile is the
   * kind of inconsistency nobody files and everybody sees.
   */
  test('every surface renders the tombstone identically — name, no ring, flagged deleted', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const viewer = await seedUser(t, 'viewer');
    const bodyId = await seedBody(t);
    const reportId = await user.as.mutation(api.reports.create, {
      waterBodyId: bodyId,
      skateEndTime: T0,
      iceTypes: ['black_ice' as const],
      surfaceTags: [],
    });
    await user.as.mutation(api.comments.create, { reportId, body: 'Still good.' });
    // Enough points that a live author would definitely carry a ring — so "no ring" is a real
    // assertion rather than an artifact of a fresh account scoring null anyway.
    await t.run((ctx) => ctx.db.patch(user.id, { reputationPoints: 500 }));

    await finalize(t, user.id);

    const feed = await viewer.as.query(api.reports.listFeed, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    const thread = await viewer.as.query(api.comments.listByReport, { reportId });
    const byIds = await viewer.as.query(api.profiles.publicByIds, { profileIds: [user.id] });

    const surfaces = [feed.page[0]?.author, thread[0]?.comment?.author, byIds[user.id]];
    for (const author of surfaces) {
      expect(author?.displayName).toBe(DELETED_DISPLAY_NAME);
      expect(author?.trustClass ?? null).toBeNull();
      expect(author?.deleted).toBe(true);
    }
  });

  test('publicByIds renders a tombstone without a linkable handle or a trust ring', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    await finalize(t, user.id);

    const map = await t.query(api.profiles.publicByIds, { profileIds: [user.id] });
    expect(map[user.id]?.displayName).toBe(DELETED_DISPLAY_NAME);
    expect(map[user.id]?.deleted).toBe(true);
    expect(map[user.id]?.trustClass).toBeNull();
    expect(map[user.id]?.profileImageUrl).toBeUndefined();
  });
});

describe('bucket 1 — erase (private artifacts)', () => {
  test('deletes tokens, notifications, favorites, queue rows and blocks in both directions', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const other = await seedUser(t, 'other');
    const bodyId = await seedBody(t);

    const reportId = (await t.run((ctx) =>
      ctx.db.insert('reports', {
        authorId: other.id,
        waterBodyId: bodyId,
        point: { lat: 0.5, lng: 0.5 },
        skateEndTime: T0,
        reportTime: T0,
        source: 'native' as const,
        iceTypes: [],
        surfaceTags: [],
        photoIds: [],
        hazardIdsCreated: [],
        moderationStatus: 'visible' as const,
        createdAt: T0,
        updatedAt: T0,
      }),
    )) as Id<'reports'>;

    await t.run(async (ctx) => {
      await ctx.db.insert('activityConnections', {
        userId: user.id,
        provider: 'strava' as const,
        externalUserId: 'athlete-1',
        accessToken: 'secret',
        refreshToken: 'secret',
        scopes: ['activity:write'],
        connectedAt: T0,
      });
      await ctx.db.insert('notifications', {
        userId: user.id,
        type: 'favorite_report' as const,
        payload: {},
        createdAt: T0,
      });
      await ctx.db.insert('notificationQueue', {
        userId: user.id,
        waterBodyId: bodyId,
        kind: 'digest' as const,
        type: 'nearby_report_digest' as const,
        coalesceKey: `${user.id}:${bodyId}:digest`,
        latestReportId: reportId,
        count: 1,
        flushAfter: T0,
        createdAt: T0,
      });
      await ctx.db.insert('waterBodyFavorites', {
        userId: user.id,
        waterBodyId: bodyId,
        createdAt: T0,
      });
      await ctx.db.insert('blocks', { blockerId: user.id, blockedId: other.id, createdAt: T0 });
      await ctx.db.insert('blocks', { blockerId: other.id, blockedId: user.id, createdAt: T0 });
      await ctx.db.insert('supportTickets', {
        userId: user.id,
        clerkUserId: 'leaver',
        category: 'account' as const,
        body: 'my real name is …',
        status: 'open' as const,
        createdAt: T0,
      });
    });

    await finalize(t, user.id);

    const counts = await t.run(async (ctx) => ({
      connections: (await ctx.db.query('activityConnections').collect()).length,
      notifications: (await ctx.db.query('notifications').collect()).length,
      queue: (await ctx.db.query('notificationQueue').collect()).length,
      favorites: (await ctx.db.query('waterBodyFavorites').collect()).length,
      blocks: (await ctx.db.query('blocks').collect()).length,
      tickets: (await ctx.db.query('supportTickets').collect()).length,
    }));
    expect(counts).toEqual({
      connections: 0,
      notifications: 0,
      queue: 0,
      favorites: 0,
      blocks: 0, // both directions — a block against a tombstone would filter forever
      tickets: 0,
    });
  });

  /**
   * An unattached photo whose blob won't go (PR #29 review). The row has to stay — it's the only
   * pointer the orphan cron could ever find those bytes by — but it must stop being a record *of a
   * person*, and the field that matters is `coord`: a photo taken at home, placed on the map, is the
   * home coordinate D62 goes out of its way to erase everywhere else.
   */
  test('a photo that cannot be reclaimed keeps its pointer and loses its identity', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const stuck = await t.run(async (ctx) => {
      const thumbStorageId = await ctx.storage.store(new Blob(['thumb']));
      return ctx.db.insert('photos', {
        storageId: 'not-a-storage-id', // storage refuses to resolve it — the reclaim can't succeed
        thumbStorageId,
        uploaderId: user.id,
        caption: 'the pond behind my house',
        takenAt: T0,
        coord: { lat: 44.5, lng: -73.2 },
        placeOnMap: true,
        createdAt: T0,
      });
    });

    await finalize(t, user.id);

    const row = await t.run((ctx) => ctx.db.get(stuck));
    expect(row).not.toBeNull(); // kept: nothing else can name that blob
    expect(row?.storageId).toBe('not-a-storage-id');
    expect(row?.caption).toBeUndefined();
    expect(row?.takenAt).toBeUndefined();
    expect(row?.coord).toBeUndefined();
    expect(row?.placeOnMap).toBe(false);
  });
});

describe('bucket 2 — anonymize (the public ice record)', () => {
  /**
   * The observation survives and the prose doesn't — the D62 second-amendment seam, checked on the one
   * path where it used to fail silently.
   *
   * **This test asserted the bug until 2026-07-27.** It went in through `finalize` (i.e. `finalizeNow`,
   * which stamps and finalizes in the same instant), so the `redact` stage's age cutoff sat 30 days in
   * the past and nothing was due — and the test read the resulting un-redacted prose as proof that
   * "content survives intact". It did prove the row survived. It also froze in place the behavior where
   * the operator's remove-me-immediately path redacted the *least* of any route, permanently, because
   * no sweep can reach a tombstone. The finalize stage ignores the cutoff now.
   */
  test('reports and comments survive as observations, with the words cleared', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const bodyId = await seedBody(t);

    const reportId = await user.as.mutation(api.reports.create, {
      waterBodyId: bodyId,
      skateEndTime: T0,
      iceTypes: ['black_ice' as const],
      surfaceTags: [],
      notes: 'Glass from shore to shore.',
    });
    await user.as.mutation(api.comments.create, { reportId, body: 'Still good this morning.' });

    await finalize(t, user.id);

    const report = await t.run((ctx) => ctx.db.get(reportId));
    expect(report).not.toBeNull(); // the row stays — this is the ice record
    expect(report?.authorId).toBe(user.id); // the pointer stands; it just names nobody now
    expect(report?.iceTypes).toEqual(['black_ice']); // the observation is untouched
    expect(report?.skateEndTime).toBe(T0);
    expect(report?.notes).toBeUndefined(); // ...and the words are gone, even at zero age

    // The comment keeps its shape so the thread doesn't lose a parent, marked rather than emptied by
    // accident — `redactedAt` is what both clients render "This comment was deleted" from.
    const comments = await t.run((ctx) => ctx.db.query('comments').collect());
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe('');
    expect(comments[0]?.redactedAt).toBeDefined();
  });
});

/**
 * **Finalization ignores the age cutoff**, and the three ways it bit before it did (2026-07-27).
 *
 * One shared cause: the finalize `redact` stage used the same age gate as the ghost-window sweep, and
 * it is the *last pass that will ever run* — `writeTombstone` clears `deletionRequestedAt`, the row
 * leaves `by_deletion_requested_at`, and no cron can reach it again. So every row the gate skipped there
 * kept its free text permanently, on an account whose owner had asked to be erased.
 *
 * Each of these fails against the old code, and each was invisible: the suite was green, the sweep
 * reported nothing left to do, and the surviving rows all looked correct because the *observation* was
 * meant to survive. Only the prose wasn't.
 */
describe('finalize redacts unconditionally (the age cutoff is a ghost-window rule)', () => {
  test("a hazard the community kept confirming still loses its description — other people's clock cannot outlive the account", async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const bodyId = await seedBody(t);

    // The realistic shape, not a corner: a ridge this person reported months ago that other skaters
    // have been confirming ever since. `lastConfirmedAt` is the clock, and it is the one clock the
    // author does not control — so it kept getting pushed forward past the cutoff, and the description
    // survived the tombstone forever. A hazard the community actively maintains is *precisely* the one
    // this used to leak.
    const hazardId = await t.run((ctx) =>
      ctx.db.insert('hazards', {
        waterBodyId: bodyId,
        type: 'pressure_ridge' as const,
        geometryKind: 'point_radius' as const,
        geometry: { type: 'Point' as const, coordinates: [0.5, 0.5] },
        radiusMeters: 30,
        bbox: { minLat: 0.4, minLng: 0.4, maxLat: 0.6, maxLng: 0.6 },
        createdByUserId: user.id,
        description: 'Runs the whole north bay — I went through here last winter.',
        photoIds: [],
        status: 'active' as const,
        moderationStatus: 'visible' as const,
        firstReportedAt: T0 - LONG_AGO,
        lastConfirmedAt: T0, // somebody else confirmed it today
        confirmCount: 6,
        goneCount: 0,
        createdAt: T0 - LONG_AGO,
      }),
    );

    await user.as.mutation(api.accountDeletion.requestDeletion, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Still there during the window — the promise is "kept while the community maintains it", and that
    // promise is real for as long as cancelling is.
    expect((await t.run((ctx) => ctx.db.get(hazardId)))?.description).toBeDefined();

    // ...but finalization is the end of it, because nothing can come back for this row afterwards.
    vi.setSystemTime(T0 + DELETION_GRACE_MS + 3600_000);
    await t.mutation(internal.accountDeletion.finalizeDueDeletions, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const hazard = await t.run((ctx) => ctx.db.get(hazardId));
    expect(hazard).not.toBeNull(); // the pin stays: it is a warning, and D62 keeps the observation
    expect(hazard?.type).toBe('pressure_ridge');
    expect(hazard?.confirmCount).toBe(6);
    expect(hazard?.description).toBeUndefined(); // the words go
  });

  test('a report skated slightly in the future is still redacted', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const bodyId = await seedBody(t);

    // `SKATE_TIME_FUTURE_TOLERANCE_MS` allows an hour of clock skew, so "a ghost's newest skateEndTime
    // can't postdate their request" was only true ±1h — and the overhang was never due, on any pass.
    const reportId = await user.as.mutation(api.reports.create, {
      waterBodyId: bodyId,
      skateEndTime: T0 + 30 * 60_000,
      iceTypes: ['black_ice' as const],
      surfaceTags: [],
      notes: 'Filed from the ice with a fast watch clock.',
    });

    await finalize(t, user.id);

    const report = await t.run((ctx) => ctx.db.get(reportId));
    expect(report).not.toBeNull();
    expect(report?.notes).toBeUndefined();
  });

  test('the note on a thickness reading goes too — prose nested in an array is still prose', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const bodyId = await seedBody(t);

    const reportId = await user.as.mutation(api.reports.create, {
      waterBodyId: bodyId,
      skateEndTime: T0,
      iceTypes: ['black_ice' as const],
      surfaceTags: [],
      iceThickness: {
        readings: [
          {
            valueCm: 10,
            method: 'measured' as const,
            note: 'through the ridge, water in the hole',
          },
        ],
      },
    });

    await finalize(t, user.id);

    const report = await t.run((ctx) => ctx.db.get(reportId));
    // The measurement is the most valuable thing in a report and is not free text — it stays, and so
    // does how it was taken, which is what decides how much to trust it.
    expect(report?.iceThickness?.readings).toHaveLength(1);
    expect(report?.iceThickness?.readings?.[0]?.valueCm).toBe(10);
    expect(report?.iceThickness?.readings?.[0]?.method).toBe('measured');
    expect(report?.iceThickness?.readings?.[0]?.note).toBeUndefined();
  });
});

describe('flags: the row is about content and survives, the note is prose and does not', () => {
  test('a departing flagger loses their note, and the moderator keeps everything structured', async () => {
    const t = harness();
    const bodyId = await seedBody(t);
    const author = await seedUser(t, 'author');
    const reportId = await author.as.mutation(api.reports.create, {
      waterBodyId: bodyId,
      skateEndTime: T0,
    });
    const user = await seedUser(t, 'leaver');

    // The field most likely in the whole schema to hold one user's prose *about another user* — which
    // is what made keeping it after its author left the worst version of the oversight.
    const flagId = await user.as.mutation(api.contentFlags.flag, {
      targetType: 'report' as const,
      targetId: reportId,
      reason: 'unsafe_false_report' as const,
      note: 'third time @author has posted a reading I know is fake',
    });

    await finalize(t, user.id);

    const flag = await t.run((ctx) => ctx.db.get(flagId as Id<'contentFlags'>));
    expect(flag).not.toBeNull(); // a flag is about content, and the content is still there
    expect(flag?.reason).toBe('unsafe_false_report'); // the structured verdict the queue sorts on
    expect(flag?.targetId).toBe(reportId);
    expect(flag?.note).toBeUndefined(); // the words the person typed
  });
});

describe('bucket 3 — keep, severed from identity (D62)', () => {
  const trackPath = {
    type: 'LineString' as const,
    coordinates: Array.from({ length: 20 }, (_, i) => [0.2 + i * 0.03, 0.5]) as number[][],
  };

  async function seedTrack(user: SeededUser, key: string) {
    return user.as.mutation(api.gpsActivities.ingestTrack, {
      idempotencyKey: key,
      path: trackPath,
      startTime: T0 - 3600_000,
      endTime: T0,
      elapsedSeconds: 3600,
    });
  }

  test('a published track is KEPT and keeps drawing on the aggregate map', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const viewer = await seedUser(t, 'viewer');
    const bodyId = await seedBody(t);
    const activityId = await seedTrack(user, 'published');
    await user.as.mutation(api.reports.create, {
      waterBodyId: bodyId,
      activityId,
      skateEndTime: T0,
      iceTypes: ['black_ice' as const],
      surfaceTags: [],
    });

    await finalize(t, user.id);

    const activity = await t.run((ctx) => ctx.db.get(activityId));
    expect(activity).not.toBeNull();
    expect(activity?.path).toBeDefined();
    // Severed from the person: the provider handle no longer points at a real external activity.
    expect(activity?.providerActivityId.startsWith('severed:')).toBe(true);
    expect(activity?.photoUrls).toBeUndefined();

    // The contribution the founder asked to preserve: it still draws.
    const { tracks } = await viewer.as.query(api.gpsActivities.listTracksForBody, {
      waterBodyId: bodyId,
    });
    expect(tracks).toHaveLength(1);
  });

  /**
   * **The test this suite was missing, and the reason a whole bucket was dead code for a release.**
   *
   * Every other test here reaches finalization through `finalizeNow`, which stamps the request and
   * runs the chain in the same instant — so the content it sees is *fresh*. The real path is the
   * opposite: request, thirty days of clock, then the cron. Under the first D62 amendment those two
   * diverged completely. The purge stage erased every report older than 30 days, which by definition
   * meant every report a ghost had, and each deletion took its linked activity with it — so
   * `severTracks` could never keep anything, the aggregate-map contribution D62 exists to preserve was
   * silently deleted, and the suite reported green because no test ever let 30 days pass.
   *
   * So this one advances the clock and goes in through `finalizeDueDeletions`, asserting the three
   * things the shortcut can't see: the report survives its own ageing, the track survives with it, and
   * the map still draws it.
   */
  test('the real path — request, thirty days, cron — keeps the published track drawing', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const viewer = await seedUser(t, 'viewer');
    const bodyId = await seedBody(t);
    const activityId = await seedTrack(user, 'published');
    const reportId = await user.as.mutation(api.reports.create, {
      waterBodyId: bodyId,
      activityId,
      skateEndTime: T0,
      iceTypes: ['black_ice' as const],
      surfaceTags: [],
      notes: 'Skated the whole north shore, glass.',
    });

    await user.as.mutation(api.accountDeletion.requestDeletion, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Thirty days and change: the grace window lapses and the report ages past the redaction line at
    // the same moment, which is the coincidence the read-only rule engineers on purpose.
    vi.setSystemTime(T0 + DELETION_GRACE_MS + 3600_000);
    const swept = await t.mutation(internal.accountDeletion.finalizeDueDeletions, {});
    expect(swept.started).toBe(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const profile = await t.run((ctx) => ctx.db.get(user.id));
    expect(profile?.status).toBe('deleted');

    // The observation outlives the account; the prose does not.
    const report = await t.run((ctx) => ctx.db.get(reportId));
    expect(report).not.toBeNull();
    expect(report?.notes).toBeUndefined();
    expect(report?.authorId).toBe(user.id); // still pointing at the row, which is now a tombstone

    // And the bucket that used to be unreachable: kept, severed, still on the map.
    const activity = await t.run((ctx) => ctx.db.get(activityId));
    expect(activity?.path).toBeDefined();
    expect(activity?.providerActivityId.startsWith('severed:')).toBe(true);
    const { tracks } = await viewer.as.query(api.gpsActivities.listTracksForBody, {
      waterBodyId: bodyId,
    });
    expect(tracks).toHaveLength(1);
  });

  test('an UNPUBLISHED recording is erased — it was never shared', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    await seedBody(t);
    const activityId = await seedTrack(user, 'private');

    await finalize(t, user.id);

    expect(await t.run((ctx) => ctx.db.get(activityId))).toBeNull();
  });

  test('a track whose report was hidden by a moderator is erased, not kept', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const bodyId = await seedBody(t);
    const activityId = await seedTrack(user, 'hidden');
    const reportId = await user.as.mutation(api.reports.create, {
      waterBodyId: bodyId,
      activityId,
      skateEndTime: T0,
      iceTypes: ['black_ice' as const],
      surfaceTags: [],
    });
    await t.run((ctx) => ctx.db.patch(reportId, { moderationStatus: 'hidden' as const }));

    await finalize(t, user.id);

    // Publish-is-consent (D58 gate 1): a hidden report is not a published one.
    expect(await t.run((ctx) => ctx.db.get(activityId))).toBeNull();
  });

  /**
   * The continuation path, forced with a tiny page size.
   *
   * This is the stage machine's real hazard, and it's silent: a stage that keeps some of what it reads
   * can't just re-`take()` the first page (it would loop on the same kept rows forever), and one that
   * paginates has to actually resume from its cursor or a heavy account's deletion stops partway
   * through — reporting success while leaving private rows behind. Five tracks over pages of two
   * exercises both, at a size a test can afford.
   */
  test('a stage that spans several pages finishes all of them', async () => {
    const t = harness();
    const user = await seedUser(t, 'prolific');
    const bodyId = await seedBody(t);

    // Two published (kept + severed), three unpublished (erased) — so the page boundaries fall across
    // a mix of both outcomes rather than a run of one.
    const publishedIds: Id<'gpsActivities'>[] = [];
    for (let i = 0; i < 5; i++) {
      const activityId = await seedTrack(user, `paged-${i}`);
      if (i < 2) {
        await user.as.mutation(api.reports.create, {
          waterBodyId: bodyId,
          activityId,
          skateEndTime: T0 + i,
          iceTypes: ['black_ice' as const],
          surfaceTags: [],
        });
        publishedIds.push(activityId);
      }
    }

    await finalizePaged(t, user.id, 2);

    const remaining = await t.run((ctx) => ctx.db.query('gpsActivities').collect());
    expect(remaining).toHaveLength(2);
    expect(new Set(remaining.map((a) => a._id))).toEqual(new Set(publishedIds));
    // Every survivor severed — not just the ones that happened to land on the first page.
    for (const a of remaining) expect(a.providerActivityId.startsWith('severed:')).toBe(true);
    // And the machine still reached its last stage.
    expect((await t.run((ctx) => ctx.db.get(user.id)))?.status).toBe('deleted');
  });

  /**
   * The prohibition in D62, as a test. Setting `excludeTracksFromAggregate` during finalize would look
   * like the careful privacy choice and would silently delete the contribution the whole
   * keep-but-sever bucket exists to preserve — with no error and nothing in the diff to notice.
   */
  test('finalize does NOT set excludeTracksFromAggregate', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    await finalize(t, user.id);

    const profile = await t.run((ctx) => ctx.db.get(user.id));
    expect(profile?.excludeTracksFromAggregate).toBeUndefined();
  });

  test('a user who HAD opted out stays opted out — their choice survives them', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    await t.run((ctx) => ctx.db.patch(user.id, { excludeTracksFromAggregate: true }));
    await finalize(t, user.id);

    const profile = await t.run((ctx) => ctx.db.get(user.id));
    expect(profile?.excludeTracksFromAggregate).toBe(true);
  });
});

/**
 * The three findings from the PR #30 review, each of which let a ghost keep something the design says
 * they lose. They share a shape worth naming: **`status` stays `active` for a ghost on purpose**, so
 * every gate that asked about `status` — and every gate composed from `requireProfile` rather than
 * `requireContributor` — silently treated a departing account as an ordinary one.
 */
describe('a ghost is a ghost everywhere (PR #30 review)', () => {
  test('no notification is generated for a departing account', async () => {
    const t = harness();
    const bodyId = await seedBody(t);
    const author = await seedUser(t, 'author');
    const leaver = await seedUser(t, 'leaver');

    // Favorite the lake first — this is deliberately still open during the window, so it's a real
    // subscription rather than a contrived one.
    await leaver.as.mutation(api.waterBodyFavorites.toggle, { waterBodyId: bodyId });
    await leaver.as.mutation(api.accountDeletion.requestDeletion, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    await author.as.mutation(api.reports.create, { waterBodyId: bodyId, skateEndTime: T0 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Their reports are kept, so people go on posting about lakes they follow — but a person who no
    // longer exists on the platform shouldn't be hearing about it, and they can no longer reach the
    // preference that would have turned it off.
    const queued = await t.run((ctx) =>
      ctx.db
        .query('notificationQueue')
        .withIndex('by_user', (q) => q.eq('userId', leaver.id))
        .collect(),
    );
    expect(queued).toHaveLength(0);
  });

  test('a notification queued BEFORE the request is dropped rather than delivered', async () => {
    const t = harness();
    const bodyId = await seedBody(t);
    const author = await seedUser(t, 'author');
    const leaver = await seedUser(t, 'leaver');

    await leaver.as.mutation(api.waterBodyFavorites.toggle, { waterBodyId: bodyId });
    await author.as.mutation(api.reports.create, { waterBodyId: bodyId, skateEndTime: T0 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Queued while they were an ordinary user — the row outlives the state it was queued against.
    expect(
      await t.run((ctx) =>
        ctx.db
          .query('notificationQueue')
          .withIndex('by_user', (q) => q.eq('userId', leaver.id))
          .collect(),
      ),
    ).toHaveLength(1);

    await leaver.as.mutation(api.accountDeletion.requestDeletion, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Past the debounce, so the row is due.
    vi.setSystemTime(T0 + 5 * 60_000);
    const flushed = await t.mutation(internal.notifications.flushNotificationQueue, {});

    expect(flushed).toMatchObject({ delivered: 0, dropped: 1 });
    expect(
      await t.run((ctx) =>
        ctx.db
          .query('notifications')
          .withIndex('by_user', (q) => q.eq('userId', leaver.id))
          .collect(),
      ),
    ).toHaveLength(0);
  });

  /**
   * The gate that was beside `requireContributor` rather than inside it. Ordinary members were
   * read-only during the window; the accounts with the most reach were not.
   */
  test('a departing moderator loses privileged writes but keeps privileged reads', async () => {
    const t = harness();
    const bodyId = await seedBody(t);
    const mod = await seedUser(t, 'mod');
    await t.run((ctx) => ctx.db.patch(mod.id, { role: 'moderator' as const }));

    // Still a moderator, still active: the write works.
    await expect(
      mod.as.mutation(api.waterBodies.setCuratedBoost, { waterBodyId: bodyId, curatedBoost: 2 }),
    ).resolves.not.toThrow();

    await mod.as.mutation(api.accountDeletion.requestDeletion, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // The write is now refused with the member-facing message — same gate, same way back.
    await expect(
      mod.as.mutation(api.waterBodies.setCuratedBoost, { waterBodyId: bodyId, curatedBoost: 5 }),
    ).rejects.toThrow(/scheduled for deletion/i);

    // ...but the read still works. Blocking it would be the same mistake as putting the ghost gate in
    // `requireProfile`: reviewing the state of things on the way out is reasonable.
    await expect(mod.as.query(api.waterBodies.listCurated, {})).resolves.toBeDefined();
  });

  /**
   * The caption is the departed person's prose; whether the photo is *referenced* is a different
   * question, about whether deleting the row would tear a hole in a public report. Deciding the second
   * one first meant the first went unanswered whenever the second couldn't be — here because the blob
   * refuses to delete, and at `REFERENCE_SCAN_CAP` for a prolific enough contributor.
   */
  test('a photo that cannot be deleted still loses its caption', async () => {
    const t = harness();
    const leaver = await seedUser(t, 'leaver');
    const photoId = await t.run((ctx) =>
      ctx.db.insert('photos', {
        storageId: 'not-a-storage-id', // the delete will fail, and the row is kept as its only pointer
        thumbStorageId: 'not-a-storage-id',
        uploaderId: leaver.id,
        caption: 'the pond behind my house',
        placeOnMap: false,
        createdAt: T0 - LONG_AGO, // aged past the line, so the ghost sweep acts on it
      }),
    );

    // The ghost-window sweep alone — no finalization.
    await leaver.as.mutation(api.accountDeletion.requestDeletion, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const photo = await t.run((ctx) => ctx.db.get(photoId));
    expect(photo).not.toBeNull(); // kept: it is the only pointer to the blobs
    expect(photo?.caption).toBeUndefined(); // but the words came off anyway
  });
});
