/**
 * "No public access" — corroboration, the moderator verdict, and the re-report gate (N6f).
 *
 * Two properties carry the design and each has its own block below:
 *
 * 1. **An unconfirmed report changes nothing on the body.** The whole reason a report doesn't dim a
 *    lake for everyone is that one account would otherwise be able to dim any lake in the corpus.
 * 2. **A re-import preserves the demotion, not just the verdict.** `importCanonical` patches a named
 *    field list so `publicAccess` survives by omission — but it *re-scores* from area + boost, so the
 *    demotion is the half that silently reverts. That test is the one that would have caught it.
 */

import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

const HALF = 0.05;
const AREA_SQM = 5_000_000;

function square(lat: number, lng: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [lng - HALF, lat - HALF],
        [lng + HALF, lat - HALF],
        [lng + HALF, lat + HALF],
        [lng - HALF, lat + HALF],
        [lng - HALF, lat - HALF],
      ],
    ],
  };
}

/** The canonical record, shared by the seed and the re-import so the round trip is a true no-op. */
function canonical(name = 'Private Pond', externalId = 'way/1', lat = 44, lng = -72) {
  return {
    name,
    type: 'lakePond' as const,
    source: 'osm' as const,
    externalId,
    osmId: externalId,
    polygon: square(lat, lng),
    bbox: { minLat: lat - HALF, minLng: lng - HALF, maxLat: lat + HALF, maxLng: lng + HALF },
    centroid: { lat, lng },
    surfaceAreaSqM: AREA_SQM,
  };
}

async function seedBody(
  t: ReturnType<typeof convexTest>,
  externalId = 'way/1',
  name = 'Private Pond',
) {
  const body = canonical(name, externalId);
  const id = (await t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      ...body,
      searchText: name,
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  )) as Id<'waterBodies'>;
  await t.mutation(internal.waterBodies.importCanonical, { bodies: [body] });
  return id;
}

async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  role: 'member' | 'moderator' | 'admin' = 'member',
) {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
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
        nearbyReportDigest: false,
        greatReportNearby: false,
      },
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

type Identity = Awaited<ReturnType<typeof seedUser>>;

function report(user: Identity, waterBodyId: Id<'waterBodies'>, note?: string) {
  return user.as.mutation(api.contentFlags.flag, {
    targetType: 'waterbody',
    targetId: waterBodyId,
    reason: 'no_public_access',
    ...(note !== undefined ? { note } : {}),
  });
}

const bodyRow = (t: ReturnType<typeof convexTest>, id: Id<'waterBodies'>) =>
  t.run((ctx) => ctx.db.get(id));

describe('reporting — an unconfirmed claim touches nothing', () => {
  test('a report files a queue row and leaves the body exactly as it was', async () => {
    const t = convexTest(schema, modules);
    const id = await seedBody(t);
    const before = await bodyRow(t, id);
    const member = await seedUser(t, 'member');

    await report(member, id, 'Gate and posted signs on the only road in');

    const after = await bodyRow(t, id);
    expect(after?.publicAccess).toBeUndefined();
    // The demotion is the thing that must not move on an unconfirmed claim.
    expect(after?.minVisibleZoom).toBe(before?.minVisibleZoom);
    expect(after?.displayScore).toBe(before?.displayScore);

    const flags = await t.run((ctx) => ctx.db.query('contentFlags').collect());
    expect(flags).toHaveLength(1);
    expect(flags[0]?.reason).toBe('no_public_access');
    expect(flags[0]?.status).toBe('open');
  });

  test('the same person reporting twice is one claim, not two', async () => {
    const t = convexTest(schema, modules);
    const id = await seedBody(t);
    const member = await seedUser(t, 'member');

    await report(member, id);
    await report(member, id);

    expect(await t.query(api.waterBodies.pendingAccessReportCount, { waterBodyId: id })).toBe(1);
  });

  test('distinct people corroborate, and the count is the open-row count', async () => {
    const t = convexTest(schema, modules);
    const id = await seedBody(t);
    for (const name of ['a', 'b', 'c']) {
      await report(await seedUser(t, name), id);
    }
    expect(await t.query(api.waterBodies.pendingAccessReportCount, { waterBodyId: id })).toBe(3);
  });

  test('a signed-out visitor cannot report', async () => {
    const t = convexTest(schema, modules);
    const id = await seedBody(t);
    await expect(
      t.mutation(api.contentFlags.flag, {
        targetType: 'waterbody',
        targetId: id,
        reason: 'no_public_access',
      }),
    ).rejects.toThrow();
  });

  test('myAccessFlags returns the caller’s own open reports and nobody else’s', async () => {
    const t = convexTest(schema, modules);
    const mine = await seedBody(t, 'way/1', 'Mine');
    const theirs = await seedBody(t, 'way/2', 'Theirs');
    const me = await seedUser(t, 'me');
    const them = await seedUser(t, 'them');

    await report(me, mine);
    await report(them, theirs);

    expect(await me.as.query(api.contentFlags.myAccessFlags, {})).toEqual([mine]);
    // Signed out, the map still renders — it just has nothing of yours to fade.
    expect(await t.query(api.contentFlags.myAccessFlags, {})).toEqual([]);
  });
});

describe('the moderator verdict', () => {
  test('a member cannot rule', async () => {
    const t = convexTest(schema, modules);
    const id = await seedBody(t);
    const member = await seedUser(t, 'member');
    await expect(
      member.as.mutation(api.waterBodies.setPublicAccess, { waterBodyId: id, verdict: 'none' }),
    ).rejects.toThrow(/moderator/i);
  });

  test('“none” dims and demotes, resolves the reports, and audits with prev', async () => {
    const t = convexTest(schema, modules);
    const id = await seedBody(t);
    const before = await bodyRow(t, id);
    const reporter = await seedUser(t, 'reporter');
    await report(reporter, id);
    const mod = await seedUser(t, 'mod', 'moderator');

    await mod.as.mutation(api.waterBodies.setPublicAccess, {
      waterBodyId: id,
      verdict: 'none',
      note: 'Ringed by posted parcels',
    });

    const after = await bodyRow(t, id);
    expect(after?.publicAccess?.verdict).toBe('none');
    expect(after?.publicAccess?.decidedByUserId).toBe(mod.id);
    expect(after?.publicAccess?.note).toBe('Ringed by posted parcels');
    // Demoted: it draws LATER, i.e. at a higher zoom number.
    expect(after?.minVisibleZoom).toBeGreaterThan(before?.minVisibleZoom as number);

    // The cell rows carry the new zoom too — they are the read range, not just a stamp.
    const cells = await t.run((ctx) =>
      ctx.db
        .query('waterBodyCells')
        .filter((q) => q.eq(q.field('waterBodyId'), id))
        .collect(),
    );
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) expect(cell.minVisibleZoom).toBe(after?.minVisibleZoom);

    const flags = await t.run((ctx) => ctx.db.query('contentFlags').collect());
    expect(flags[0]?.status).toBe('actioned');

    const audits = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    const audit = audits[0];
    expect(audit?.action).toBe('set_public_access');
    expect(audit?.reason).toContain('closing 1 report');
    const metadata = audit?.metadata as { prev?: { publicAccess: unknown } } | undefined;
    expect(metadata?.prev?.publicAccess).toBeNull();
  });

  test('“open” dismisses the reports and changes no pixel', async () => {
    const t = convexTest(schema, modules);
    const id = await seedBody(t);
    const before = await bodyRow(t, id);
    await report(await seedUser(t, 'reporter'), id);
    const mod = await seedUser(t, 'mod', 'moderator');

    await mod.as.mutation(api.waterBodies.setPublicAccess, { waterBodyId: id, verdict: 'open' });

    const after = await bodyRow(t, id);
    expect(after?.publicAccess?.verdict).toBe('open');
    expect(after?.minVisibleZoom).toBe(before?.minVisibleZoom);

    const flags = await t.run((ctx) => ctx.db.query('contentFlags').collect());
    expect(flags[0]?.status).toBe('dismissed');
  });

  test('clearing restores the original zoom and leaves reports open', async () => {
    const t = convexTest(schema, modules);
    const id = await seedBody(t);
    const before = await bodyRow(t, id);
    const mod = await seedUser(t, 'mod', 'moderator');

    await mod.as.mutation(api.waterBodies.setPublicAccess, { waterBodyId: id, verdict: 'none' });
    await report(await seedUser(t, 'reporter'), id);
    await mod.as.mutation(api.waterBodies.setPublicAccess, { waterBodyId: id, verdict: null });

    const after = await bodyRow(t, id);
    expect(after?.publicAccess).toBeUndefined();
    expect(after?.minVisibleZoom).toBe(before?.minVisibleZoom);
    // The question is unsettled again, so the queue should still show the job.
    const flags = await t.run((ctx) => ctx.db.query('contentFlags').collect());
    expect(flags[0]?.status).toBe('open');
  });

  test('refuses a note long enough to be a paragraph', async () => {
    const t = convexTest(schema, modules);
    const id = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await expect(
      mod.as.mutation(api.waterBodies.setPublicAccess, {
        waterBodyId: id,
        verdict: 'none',
        note: 'x'.repeat(200),
      }),
    ).rejects.toThrow(/Keep the note under/);
  });
});

/**
 * The gate is a note requirement, not a block — land is sold and gates go up, so a permanent refusal
 * would eventually be wrong and leave the person who just got turned away with nowhere to go.
 */
describe('the re-report gate under an “open” verdict', () => {
  /** Returns the moderator too — seeding a second one with the same subject breaks `unique()`. */
  async function ruledOpen(t: ReturnType<typeof convexTest>) {
    const id = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.waterBodies.setPublicAccess, { waterBodyId: id, verdict: 'open' });
    return { id, mod };
  }

  test('a note-less report is refused, and the refusal names the review date', async () => {
    const t = convexTest(schema, modules);
    const { id } = await ruledOpen(t);
    const member = await seedUser(t, 'member');
    await expect(report(member, id)).rejects.toThrow(/found public access/);
    expect(await t.query(api.waterBodies.pendingAccessReportCount, { waterBodyId: id })).toBe(0);
  });

  test('whitespace is not a note', async () => {
    const t = convexTest(schema, modules);
    const { id } = await ruledOpen(t);
    const member = await seedUser(t, 'member');
    await expect(report(member, id, '   ')).rejects.toThrow(/found public access/);
  });

  test('a report saying what changed gets through', async () => {
    const t = convexTest(schema, modules);
    const { id } = await ruledOpen(t);
    const member = await seedUser(t, 'member');
    await report(member, id, 'New owner gated the town road in November');
    expect(await t.query(api.waterBodies.pendingAccessReportCount, { waterBodyId: id })).toBe(1);
  });

  test('clearing the verdict re-opens note-less reporting', async () => {
    const t = convexTest(schema, modules);
    const { id, mod } = await ruledOpen(t);
    await mod.as.mutation(api.waterBodies.setPublicAccess, { waterBodyId: id, verdict: null });
    await report(await seedUser(t, 'member'), id);
    expect(await t.query(api.waterBodies.pendingAccessReportCount, { waterBodyId: id })).toBe(1);
  });

  test('the gate is scoped to this reason — other flags on the body are untouched', async () => {
    const t = convexTest(schema, modules);
    const { id } = await ruledOpen(t);
    const member = await seedUser(t, 'member');
    await member.as.mutation(api.contentFlags.flag, {
      targetType: 'waterbody',
      targetId: id,
      reason: 'spam',
    });
    const flags = await t.run((ctx) => ctx.db.query('contentFlags').collect());
    expect(flags.map((f) => f.reason)).toEqual(['spam']);
  });

  test('a “none” verdict gates nothing — the body already says so', async () => {
    const t = convexTest(schema, modules);
    const id = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.waterBodies.setPublicAccess, { waterBodyId: id, verdict: 'none' });
    await report(await seedUser(t, 'member'), id);
    expect(await t.query(api.waterBodies.pendingAccessReportCount, { waterBodyId: id })).toBe(1);
  });
});

describe('the queue lane', () => {
  test('collapses per-lake and ranks by how many people agree', async () => {
    const t = convexTest(schema, modules);
    const quiet = await seedBody(t, 'way/1', 'Quiet Pond');
    const loud = await seedBody(t, 'way/2', 'Loud Pond');
    for (const name of ['a', 'b', 'c']) await report(await seedUser(t, name), loud);
    await report(await seedUser(t, 'd'), quiet);
    const mod = await seedUser(t, 'mod', 'moderator');

    const queue = await mod.as.query(api.moderation.listFlags, {});
    expect(queue.accessReports.map((g) => [g.name, g.count])).toEqual([
      ['Loud Pond', 3],
      ['Quiet Pond', 1],
    ]);
    // Collapsed OUT of the flat lanes — one job should reach a moderator once.
    expect(queue.standard).toHaveLength(0);
  });

  test('carries the reporters’ notes and marks a dispute of a prior review', async () => {
    const t = convexTest(schema, modules);
    const id = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.waterBodies.setPublicAccess, { waterBodyId: id, verdict: 'open' });
    await report(await seedUser(t, 'member'), id, 'New owner gated the road');

    const queue = await mod.as.query(api.moderation.listFlags, {});
    expect(queue.accessReports[0]?.notes).toEqual(['New owner gated the road']);
    expect(queue.accessReports[0]?.disputesReviewFrom).toBeDefined();
  });

  test('a fresh report on an unruled body is not a dispute', async () => {
    const t = convexTest(schema, modules);
    const id = await seedBody(t);
    await report(await seedUser(t, 'member'), id);
    const mod = await seedUser(t, 'mod', 'moderator');
    const queue = await mod.as.query(api.moderation.listFlags, {});
    expect(queue.accessReports[0]?.disputesReviewFrom).toBeUndefined();
  });

  test('the queue names the lake rather than rendering it as “(deleted)”', async () => {
    // The trap `resolveFlagTarget` documents: a target type filed without a resolver case triages as
    // a report about nothing.
    const t = convexTest(schema, modules);
    const id = await seedBody(t, 'way/1', 'Named Pond');
    await report(await seedUser(t, 'member'), id);
    const mod = await seedUser(t, 'mod', 'moderator');
    const queue = await mod.as.query(api.moderation.listFlags, {});
    expect(queue.accessReports[0]?.name).toBe('Named Pond');
  });
});

/**
 * The regression test for the trap in `scoreFields`.
 *
 * `importCanonical` preserves `publicAccess` for free — it patches a named field list and does not
 * name it. But it *re-scores* from area + boost, so without threading the verdict through, a campaign
 * would keep the ruling and quietly restore the body's undemoted zoom. The second assertion is the one
 * that matters; the first passes either way.
 */
describe('a re-import preserves the ruling AND the demotion', () => {
  test('minVisibleZoom survives a canonical re-import', async () => {
    const t = convexTest(schema, modules);
    const id = await seedBody(t);
    const undemoted = (await bodyRow(t, id))?.minVisibleZoom;
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.waterBodies.setPublicAccess, { waterBodyId: id, verdict: 'none' });
    const demoted = (await bodyRow(t, id))?.minVisibleZoom;
    expect(demoted).toBeGreaterThan(undemoted as number);

    await t.mutation(internal.waterBodies.importCanonical, { bodies: [canonical()] });

    const after = await bodyRow(t, id);
    expect(after?.publicAccess?.verdict).toBe('none'); // preserved by omission
    expect(after?.minVisibleZoom).toBe(demoted); // preserved by threading — the real assertion
  });

  test('setCuratedBoost keeps the demotion', async () => {
    const t = convexTest(schema, modules);
    const id = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.waterBodies.setPublicAccess, { waterBodyId: id, verdict: 'none' });
    const demoted = (await bodyRow(t, id))?.minVisibleZoom as number;

    await mod.as.mutation(api.waterBodies.setCuratedBoost, { waterBodyId: id, curatedBoost: 0 });

    expect((await bodyRow(t, id))?.minVisibleZoom).toBe(demoted);
  });

  /**
   * The other half of the same trap, in the opposite direction.
   *
   * `scoreFields` takes richness too, and the bulk paths drop it for a cost reason that does not
   * apply to one body under a moderator's hand. Re-scoring an access ruling without it would demote
   * the body further than the ruling asks — and then *clearing* the verdict would leave it below
   * where it started, on a body nobody had ruled anything about, until the next `backfillCells`.
   */
  test('a ruling keeps the richness the body has earned', async () => {
    const t = convexTest(schema, modules);
    const id = await seedBody(t);
    // Give the body something to be rich about, then score it the way the corpus sweep would.
    await t.run((ctx) =>
      ctx.db.insert('putIns', {
        waterBodyId: id,
        coord: { lat: 44, lng: -72 },
        source: 'official' as const,
        status: 'visible' as const,
        createdAt: Date.now(),
      }),
    );
    await t.mutation(internal.waterBodies.backfillCells, {});
    const rich = (await bodyRow(t, id))?.displayScore as number;

    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.waterBodies.setPublicAccess, { waterBodyId: id, verdict: 'none' });
    await mod.as.mutation(api.waterBodies.setPublicAccess, { waterBodyId: id, verdict: null });

    expect((await bodyRow(t, id))?.displayScore).toBe(rich);
  });

  test('backfillCells keeps the demotion', async () => {
    const t = convexTest(schema, modules);
    const id = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.waterBodies.setPublicAccess, { waterBodyId: id, verdict: 'none' });
    const demoted = (await bodyRow(t, id))?.minVisibleZoom as number;

    await t.mutation(internal.waterBodies.backfillCells, {});

    expect((await bodyRow(t, id))?.minVisibleZoom).toBe(demoted);
  });
});
