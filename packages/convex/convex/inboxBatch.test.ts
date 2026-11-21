/**
 * **A decision that closes many members of one item recounts it once** (B01-5, PR #170): a decision's
 * every closer — the sibling drain, a takedown's flags across lanes, a ruling's reports, an undo that
 * reopens them — runs as one Inbox batch, so an item at the member bound is decided within Convex's
 * per-transaction limits, and its counts come out exact.
 */

import { requestNameKeyFor } from '@skating/core';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { fileMember, flagSource, MAX_MEMBERS, requestSource } from './lib/inboxItems';
import { inboxDrift } from './lib/inboxRepair';
import { OWN_FILING_REFUSAL } from './lib/inboxRules';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
const NOW = Date.now();

const PREFS = {
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
const SQUARE: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 0],
    ],
  ],
};

async function people(t: T, n: number, prefix = 'p') {
  return t.run(async (ctx) => {
    const ids: Id<'profiles'>[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(
        await ctx.db.insert('profiles', {
          clerkUserId: `${prefix}${i}`,
          displayName: `${prefix}${i} Test-Person`,
          username: `${prefix}${i}`,
          driveTimePrefMinutes: 60,
          profileVisibility: 'public',
          notificationPrefs: PREFS,
          dateOfBirth: Date.UTC(1990, 0, 1),
          reputationPoints: 0,
          role: 'member',
          status: 'active',
          createdAt: 1,
        }),
      );
    }
    return ids;
  });
}

async function staff(t: T, subject: string, role: 'moderator' | 'admin' = 'admin') {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: `${subject} Test-Person`,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active',
      createdAt: 1,
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

async function lake(t: T, externalId = 'osm/A') {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        states: ['VT'],
        externalId,
        osmId: externalId,
        name: `Pond ${externalId}`,
        type: 'lakePond',
        polygon: SQUARE,
        bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
        centroid: { lat: 0.5, lng: 0.5 },
        surfaceAreaSqM: 1_000_000,
      },
    ],
  });
  return t.run(async (ctx) => {
    const rows = await ctx.db.query('waterBodies').collect();
    return rows.find((b) => b.externalId === externalId)?._id as Id<'waterBodies'>;
  });
}

/**
 * Convex's per-transaction limits (docs: Limits → Transactions), held as a test seam: convex-test
 * enforces them only on a nested call given them, so every decision and drain page here runs as one.
 */
const CONVEX_LIMITS = {
  bytesRead: 16 * 1024 * 1024,
  documentsRead: 32_000,
  databaseQueries: 4_096,
  documentsWritten: 16_000,
};

/** A function run under {@link CONVEX_LIMITS}, as `subject` when given. */
async function limited(
  t: T,
  // biome-ignore lint/suspicious/noExplicitAny: any public or internal mutation reference
  fn: any,
  args: Record<string, unknown>,
  subject?: string,
): Promise<unknown> {
  const as = subject ? t.withIdentity({ subject }) : t;
  return as.run((ctx) =>
    (
      ctx as unknown as { runMutation: (f: unknown, a: unknown, o: unknown) => Promise<unknown> }
    ).runMutation(fn, args, { transactionLimits: LIMITS.now }),
  );
}

/** The limits every limited call runs under: Convex's, or a tighter set a test puts in force. */
const LIMITS = { now: CONVEX_LIMITS };

/** Run `body` with every limited call (the decision, each later page) under `limits`. */
async function under<R>(limits: Partial<typeof CONVEX_LIMITS>, body: () => Promise<R>): Promise<R> {
  LIMITS.now = { ...CONVEX_LIMITS, ...limits };
  try {
    return await body();
  } finally {
    LIMITS.now = CONVEX_LIMITS;
  }
}

/** Every scheduled drain page run to the end, by hand (each page schedules the next). */
async function drain(t: T) {
  const seen = new Set<string>();
  for (let pages = 0; pages < 400; pages++) {
    const next = (await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())).find(
      (s) =>
        !seen.has(s._id) && (s.name.includes('closeSiblings') || s.name.includes('closeFlagsRest')),
    );
    if (!next) return pages;
    seen.add(next._id);
    await limited(
      t,
      next.name.includes('closeSiblings')
        ? internal.corpusRequests.closeSiblings
        : internal.inboxWrites.closeFlagsRest,
      next.args[0] as never,
    );
  }
  throw new Error('the drain did not end');
}

/** The stored Inbox: per item, its status, count, and its open and closed members. */
async function itemsNow(t: T) {
  return t.run(async (ctx) => {
    const items = await ctx.db.query('inboxItems').collect();
    const members = await ctx.db.query('inboxItemMembers').collect();
    const counts = await ctx.db.query('inboxCounts').collect();
    return {
      items: items.map((i) => ({
        key: i.key,
        status: i.status,
        memberCount: i.memberCount,
        open: members.filter((m) => m.itemId === i._id && m.status === 'open').length,
        closed: members.filter((m) => m.itemId === i._id && m.status === 'closed').length,
      })),
      members,
      counts: Object.fromEntries(counts.filter((c) => c.count !== 0).map((c) => [c.key, c.count])),
      drift: (await Promise.all(items.map(async (i) => (await inboxDrift(ctx, i)).length))).reduce(
        (a, b) => a + b,
        0,
      ),
    };
  });
}

/** `n` open bay asks for one bay on `lakeId`, each filed into the one item its question is. */
async function bayAsks(
  t: T,
  lakeId: Id<'waterBodies'>,
  askers: Id<'profiles'>[],
  opts: { name?: string; file?: (i: number) => boolean } = {},
) {
  const name = opts.name ?? 'North Bay';
  const ids: Id<'waterBodyRequests'>[] = [];
  for (let start = 0; start < askers.length; start += 50) {
    ids.push(
      ...(await t.run(async (ctx) => {
        const out: Id<'waterBodyRequests'>[] = [];
        for (let i = start; i < Math.min(start + 50, askers.length); i++) {
          const id = await ctx.db.insert('waterBodyRequests', {
            kind: 'name_bay',
            status: 'open',
            requesterId: askers[i] as Id<'profiles'>,
            coord: { lat: 0.5, lng: 0.5 },
            waterBodyId: lakeId,
            name,
            nameKey: requestNameKeyFor('name_bay', name),
            createdAt: NOW - 1000 + i,
          });
          if (opts.file?.(i) ?? true) await fileMember(ctx, requestSource(id));
          out.push(id);
        }
        return out;
      })),
    );
  }
  return ids;
}

describe('the sibling drain at the member bound', () => {
  test('declining one of 500 asks for one bay closes them all, page by page, with exact counts', async () => {
    const t = harness();
    const lakeId = await lake(t);
    const askers = await people(t, MAX_MEMBERS);
    const mod = await staff(t, 'mod');
    const asks = await bayAsks(t, lakeId, askers);
    const before = await itemsNow(t);
    expect(before.items).toEqual([
      expect.objectContaining({ status: 'open', memberCount: MAX_MEMBERS, open: MAX_MEMBERS }),
    ]);
    await limited(
      t,
      api.corpusRequests.decline,
      { requestId: asks[0] as Id<'waterBodyRequests'>, note: 'not a bay' },
      'mod',
    );
    void mod;
    const pages = await drain(t);
    expect(pages).toBeGreaterThan(0);
    const after = await itemsNow(t);
    const statuses = await t.run(async (ctx) =>
      (await ctx.db.query('waterBodyRequests').collect()).map((r) => r.status),
    );
    expect(new Set(statuses)).toEqual(new Set(['declined']));
    expect(after.items).toEqual([
      expect.objectContaining({ status: 'decided', memberCount: MAX_MEMBERS, closed: MAX_MEMBERS }),
    ]);
    expect(after.counts).toEqual({ decided: 1 });
    expect(after.drift).toBe(0);
  });
});

/** `n` open flags on one target, from `flaggers[i]`, each filed into its lane's item. */
async function flagsOn(
  t: T,
  target: { targetType: Doc<'contentFlags'>['targetType']; targetId: string },
  flaggers: Id<'profiles'>[],
  reason: (i: number) => Doc<'contentFlags'>['reason'],
  subjectUserId?: Id<'profiles'>,
) {
  const ids: Id<'contentFlags'>[] = [];
  for (let start = 0; start < flaggers.length; start += 50) {
    ids.push(
      ...(await t.run(async (ctx) => {
        const out: Id<'contentFlags'>[] = [];
        for (let i = start; i < Math.min(start + 50, flaggers.length); i++) {
          const id = await ctx.db.insert('contentFlags', {
            flaggerId: flaggers[i] as Id<'profiles'>,
            ...target,
            reason: reason(i),
            status: 'open',
            origin: 'user',
            ...(subjectUserId ? { subjectUserId } : {}),
            createdAt: NOW - 1000 + i,
          });
          await fileMember(ctx, flagSource(id));
          out.push(id);
        }
        return out;
      })),
    );
  }
  return ids;
}

async function aReport(t: T, authorId: Id<'profiles'>, waterBodyId: Id<'waterBodies'>) {
  return t.run((ctx) =>
    ctx.db.insert('reports', {
      authorId,
      waterBodyId,
      point: { lat: 0.5, lng: 0.5 },
      skateEndTime: NOW - 3_600_000,
      reportTime: NOW - 3_600_000,
      source: 'native',
      iceTypes: [],
      surfaceTags: [],
      photoIds: [],
      moderationStatus: 'visible',
      hazardIdsCreated: [],
      createdAt: NOW - 3_600_000,
      updatedAt: NOW - 3_600_000,
    }),
  );
}

describe('a takedown and a ruling at the member bound, and their undos', () => {
  test('removing a report with 450 Content and 50 Safety flags closes them all in one write; the undo reopens them', async () => {
    const t = harness();
    const lakeId = await lake(t);
    const [author] = await people(t, 1, 'author');
    const flaggers = await people(t, MAX_MEMBERS);
    await staff(t, 'admin');
    const reportId = await aReport(t, author as Id<'profiles'>, lakeId);
    const flags = await flagsOn(
      t,
      { targetType: 'report', targetId: reportId },
      flaggers,
      (i) => (i < 450 ? 'spam' : 'unsafe_false_report'),
      author,
    );
    const before = await itemsNow(t);
    expect(before.items.map((i) => i.memberCount).sort((a, b) => a - b)).toEqual([50, 450]);
    const itemId = await t.run(
      async (ctx) =>
        (await ctx.db.query('inboxItems').collect()).find((i) => i.memberCount === 450)?._id,
    );
    const result = (await limited(
      t,
      api.inboxWrites.takeDown,
      { itemId, status: 'removed', reason: 'Fabricated' },
      'admin',
    )) as { actionId: Id<'moderationActions'> };
    await drain(t);
    const after = await itemsNow(t);
    expect(after.items.map((i) => [i.status, i.memberCount, i.closed])).toEqual([
      ['decided', 450, 450],
      ['decided', 50, 50],
    ]);
    expect(after.counts).toEqual({ decided: 2 });
    expect(after.drift).toBe(0);
    const statuses = await t.run(async (ctx) =>
      Promise.all(flags.map(async (id) => (await ctx.db.get(id))?.status)),
    );
    expect(new Set(statuses)).toEqual(new Set(['actioned']));
    // The one undo restores the report and reopens every flag, in both lanes.
    await limited(t, api.undo.run, { actionId: result.actionId, reason: 'Undone' }, 'admin');
    const undone = await itemsNow(t);
    expect(undone.items.map((i) => [i.status, i.memberCount, i.open])).toEqual([
      ['open', 450, 450],
      ['open', 50, 50],
    ]);
    expect(undone.drift).toBe(0);
  });

  test('a ruling on a body with 500 access reports closes them all in one write; the undo reopens them', async () => {
    const t = harness();
    const lakeId = await lake(t);
    const flaggers = await people(t, MAX_MEMBERS);
    await staff(t, 'admin');
    await flagsOn(
      t,
      { targetType: 'waterbody', targetId: lakeId },
      flaggers,
      () => 'no_public_access',
    );
    const itemId = await t.run(async (ctx) => (await ctx.db.query('inboxItems').first())?._id);
    const ruled = (await limited(
      t,
      api.inboxWrites.ruleAccess,
      { itemId, verdict: 'none', reason: 'Posted no trespassing' },
      'admin',
    )) as { actionId: Id<'moderationActions'> };
    await drain(t);
    const after = await itemsNow(t);
    expect(after.items.map((i) => [i.status, i.memberCount, i.closed])).toEqual([
      ['decided', MAX_MEMBERS, MAX_MEMBERS],
    ]);
    expect(after.drift).toBe(0);
    await limited(t, api.undo.run, { actionId: ruled.actionId, reason: 'Undone' }, 'admin');
    const undone = await itemsNow(t);
    expect(undone.items.map((i) => [i.status, i.memberCount, i.open])).toEqual([
      ['open', MAX_MEMBERS, MAX_MEMBERS],
    ]);
    expect(undone.drift).toBe(0);
  });
});

// ── Decide, then undo, whether or not the backfill had filed the sources ─────────────────────────

type Filing = 'none' | 'some' | 'all';

/** Raw open sources, filed by the state: `none` files only what the write needs to name its item. */
async function rawFlags(
  t: T,
  target: { targetType: Doc<'contentFlags'>['targetType']; targetId: string },
  flaggers: Id<'profiles'>[],
  reasons: Doc<'contentFlags'>['reason'][],
  filed: (i: number) => boolean,
  subjectUserId?: Id<'profiles'>,
) {
  return t.run(async (ctx) => {
    const ids: Id<'contentFlags'>[] = [];
    for (const [i, reason] of reasons.entries()) {
      const id = await ctx.db.insert('contentFlags', {
        flaggerId: flaggers[i] as Id<'profiles'>,
        ...target,
        reason,
        status: 'open',
        origin: 'user',
        ...(subjectUserId ? { subjectUserId } : {}),
        createdAt: NOW - 1000 + i,
      });
      if (filed(i)) await fileMember(ctx, flagSource(id));
      ids.push(id);
    }
    return ids;
  });
}

const filedBy = (state: Filing, need: number[]) => (i: number) =>
  need.includes(i) || state === 'all' || (state === 'some' && i % 2 === 1);

/** The audit row a write left on `targetId` with `action`, newest first. */
async function rowOn(t: T, targetId: string, action: string) {
  return t.run(async (ctx) => {
    const rows = await ctx.db
      .query('moderationActions')
      .withIndex('by_target')
      .order('desc')
      .collect();
    return rows.find((r) => r.targetId === targetId && r.action === action)
      ?._id as Id<'moderationActions'>;
  });
}

/**
 * After the undo: every source the decision closed is open again with one open member, no key has two
 * open items, every item is what its members say, and the counts are their sum.
 */
async function expectBack(t: T, sources: { table: string; id: string }[]) {
  const now = await itemsNow(t);
  const rows = await t.run(async (ctx) =>
    Promise.all(sources.map((s) => ctx.db.get(s.id as Id<'contentFlags'>))),
  );
  for (const row of rows) {
    const r = row as { status?: string; reviewStatus?: string } | null;
    expect(r?.reviewStatus ?? r?.status).toMatch(/^(open|pending)$/);
  }
  for (const s of sources) {
    const mine = now.members.filter((m) => m.sourceId === s.id);
    expect(
      mine.map((m) => m.status),
      `${s.table} ${s.id}`,
    ).toEqual(['open']);
  }
  const openKeys = now.items.filter((i) => i.status === 'open').map((i) => i.key);
  expect(new Set(openKeys).size).toBe(openKeys.length);
  expect(now.items.filter((i) => i.status === 'decided' && i.closed > 0)).toEqual([]);
  expect(now.drift).toBe(0);
}

const STATES: Filing[] = ['none', 'some', 'all'];

/**
 * A moment for the wall clock to pass the rows just written: convex-test hands out `_creationTime`
 * ahead of it under a burst of inserts, and a decision drains only the asks that existed by its `now`.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

describe('a decision records every source it closes, filed or not; its undo puts each back', () => {
  test.each(STATES)('a decline and its sibling drain — sources filed: %s', async (state) => {
    const t = harness();
    const lakeId = await lake(t);
    const askers = await people(t, 4);
    await staff(t, 'admin');
    const asks = await bayAsks(t, lakeId, askers, { file: filedBy(state, []) });
    await settle();
    await limited(t, api.corpusRequests.decline, { requestId: asks[0], note: 'no' }, 'admin');
    await drain(t);
    const decided = await itemsNow(t);
    expect(decided.members.filter((m) => m.status === 'closed')).toHaveLength(4);
    const row = await rowOn(t, asks[0] as string, 'decline_request');
    await limited(t, api.undo.run, { actionId: row, reason: 'Undone' }, 'admin');
    await expectBack(
      t,
      asks.map((id) => ({ table: 'waterBodyRequests', id })),
    );
  });

  test.each(STATES)('a takedown across two lanes — sources filed: %s', async (state) => {
    const t = harness();
    const lakeId = await lake(t);
    const [author] = await people(t, 1, 'author');
    const flaggers = await people(t, 4);
    await staff(t, 'admin');
    const reportId = await aReport(t, author as Id<'profiles'>, lakeId);
    const flags = await rawFlags(
      t,
      { targetType: 'report', targetId: reportId },
      flaggers,
      ['spam', 'spam', 'unsafe_false_report', 'unsafe_false_report'],
      filedBy(state, [0]),
      author,
    );
    const itemId = await t.run(async (ctx) => (await ctx.db.query('inboxItems').first())?._id);
    const done = (await limited(
      t,
      api.inboxWrites.takeDown,
      { itemId, status: 'hidden', reason: 'Fabricated' },
      'admin',
    )) as { actionId: Id<'moderationActions'> };
    await drain(t);
    expect((await itemsNow(t)).members.filter((m) => m.status === 'closed')).toHaveLength(4);
    await limited(t, api.undo.run, { actionId: done.actionId, reason: 'Undone' }, 'admin');
    await expectBack(
      t,
      flags.map((id) => ({ table: 'contentFlags', id })),
    );
  });

  test.each(STATES)('a ruling on a body’s access reports — sources filed: %s', async (state) => {
    const t = harness();
    const lakeId = await lake(t);
    const flaggers = await people(t, 4);
    await staff(t, 'admin');
    const flags = await rawFlags(
      t,
      { targetType: 'waterbody', targetId: lakeId },
      flaggers,
      ['no_public_access', 'no_public_access', 'no_public_access', 'no_public_access'],
      filedBy(state, [0]),
    );
    const itemId = await t.run(async (ctx) => (await ctx.db.query('inboxItems').first())?._id);
    const ruled = (await limited(
      t,
      api.inboxWrites.ruleAccess,
      { itemId, verdict: 'none', reason: 'Posted' },
      'admin',
    )) as { actionId: Id<'moderationActions'> };
    await drain(t);
    expect((await itemsNow(t)).members.filter((m) => m.status === 'closed')).toHaveLength(4);
    await limited(t, api.undo.run, { actionId: ruled.actionId, reason: 'Undone' }, 'admin');
    await expectBack(
      t,
      flags.map((id) => ({ table: 'contentFlags', id })),
    );
  });

  test.each(STATES)('a dismissal of an item’s flags — sources filed: %s', async (state) => {
    const t = harness();
    const lakeId = await lake(t);
    const [author] = await people(t, 1, 'author');
    const flaggers = await people(t, 3);
    await staff(t, 'admin');
    const reportId = await aReport(t, author as Id<'profiles'>, lakeId);
    const flags = await rawFlags(
      t,
      { targetType: 'report', targetId: reportId },
      flaggers,
      ['spam', 'spam', 'spam'],
      filedBy(state, [0]),
      author,
    );
    const itemId = await t.run(async (ctx) => (await ctx.db.query('inboxItems').first())?._id);
    const done = (await limited(t, api.inboxWrites.dismissFlags, { itemId }, 'admin')) as {
      actionId: Id<'moderationActions'>;
    };
    await drain(t);
    // A dismissal closes this item's flags: those filed into it (the rest wait for the backfill).
    const closed = (await itemsNow(t)).members.filter((m) => m.status === 'closed');
    await limited(t, api.undo.run, { actionId: done.actionId, reason: 'Undone' }, 'admin');
    await expectBack(
      t,
      closed.map((m) => ({ table: 'contentFlags', id: m.sourceId })),
    );
    void flags;
  });

  test.each(['none', 'all'] as const)('a single flag’s resolution — filed: %s', async (state) => {
    const t = harness();
    const lakeId = await lake(t);
    const [author] = await people(t, 1, 'author');
    const flaggers = await people(t, 1);
    await staff(t, 'admin');
    const reportId = await aReport(t, author as Id<'profiles'>, lakeId);
    const [flag] = await rawFlags(
      t,
      { targetType: 'report', targetId: reportId },
      flaggers,
      ['spam'],
      () => state === 'all',
      author,
    );
    await limited(
      t,
      api.moderation.resolveFlag,
      { flagId: flag, resolution: 'dismissed', reason: 'fine' },
      'admin',
    );
    const row = await rowOn(t, flag as string, 'dismiss_flag');
    await limited(t, api.undo.run, { actionId: row, reason: 'Undone' }, 'admin');
    await expectBack(t, [{ table: 'contentFlags', id: flag as string }]);
  });

  test.each(['none', 'all'] as const)('a drawn body’s approval — filed: %s', async (state) => {
    const t = harness();
    const [drawer] = await people(t, 1, 'drawer');
    await staff(t, 'admin');
    const body = await t.run(async (ctx) => {
      const id = (await ctx.db.insert('waterBodies', {
        name: 'Drawn',
        searchText: 'Drawn',
        type: 'lakePond',
        source: 'user',
        dedupStatus: 'clean',
        reviewStatus: 'pending',
        createdByUserId: drawer,
        polygon: SQUARE,
        centroid: { lat: 0.5, lng: 0.5 },
        bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
        createdAt: NOW - 1000,
      } as never)) as Id<'waterBodies'>;
      if (state === 'all') {
        const { bodySource } = await import('./lib/inboxItems');
        await fileMember(ctx, bodySource(id));
      }
      return id;
    });
    await limited(t, api.waterBodies.approve, { waterBodyId: body }, 'admin');
    const row = await rowOn(t, body as string, 'approve_waterbody');
    await limited(t, api.undo.run, { actionId: row, reason: 'Undone' }, 'admin');
    await expectBack(t, [{ table: 'waterBodies', id: body as string }]);
  });
});

describe('a closer sized by the transaction it is in (the limits as a seam)', () => {
  test('a tight transaction cuts the drain into more pages, and it still closes every ask exactly', async () => {
    const t = harness();
    const lakeId = await lake(t);
    const askers = await people(t, 60);
    await staff(t, 'admin');
    const asks = await bayAsks(t, lakeId, askers);
    await settle();
    const pages = await under({ documentsRead: 1_800 }, async () => {
      await limited(t, api.corpusRequests.decline, { requestId: asks[0], note: 'no' }, 'admin');
      return drain(t);
    });
    expect(pages).toBeGreaterThan(1);
    const after = await itemsNow(t);
    expect(after.items).toEqual([
      expect.objectContaining({ status: 'decided', memberCount: 60, closed: 60 }),
    ]);
    expect(after.counts).toEqual({ decided: 1 });
    expect(after.drift).toBe(0);
  });

  test('a tight transaction pages a takedown’s flags, and every one closes under its row', async () => {
    const t = harness();
    const lakeId = await lake(t);
    const [author] = await people(t, 1, 'author');
    const flaggers = await people(t, 120);
    await staff(t, 'admin');
    const reportId = await aReport(t, author as Id<'profiles'>, lakeId);
    await flagsOn(t, { targetType: 'report', targetId: reportId }, flaggers, () => 'spam', author);
    const itemId = await t.run(async (ctx) => (await ctx.db.query('inboxItems').first())?._id);
    const pages = await under({ documentsRead: 1_800 }, async () => {
      await limited(
        t,
        api.inboxWrites.takeDown,
        { itemId, status: 'hidden', reason: 'Fabricated' },
        'admin',
      );
      return drain(t);
    });
    expect(pages).toBeGreaterThan(0);
    const after = await itemsNow(t);
    expect(after.items.map((i) => [i.status, i.memberCount, i.closed])).toEqual([
      ['decided', 120, 120],
    ]);
    expect(after.drift).toBe(0);
    const stamped = await t.run(async (ctx) =>
      (await ctx.db.query('inboxItemMembers').collect()).map((m) => m.closedByActionId),
    );
    expect(new Set(stamped).size).toBe(1);
  });

  test('a takedown undone while its later pages wait: they stop, and nothing closes after the undo', async () => {
    const t = harness();
    const lakeId = await lake(t);
    const [author] = await people(t, 1, 'author');
    const flaggers = await people(t, 120);
    await staff(t, 'admin');
    const reportId = await aReport(t, author as Id<'profiles'>, lakeId);
    const flags = await flagsOn(
      t,
      { targetType: 'report', targetId: reportId },
      flaggers,
      () => 'spam',
      author,
    );
    const itemId = await t.run(async (ctx) => (await ctx.db.query('inboxItems').first())?._id);
    await under({ documentsRead: 1_800 }, async () => {
      const done = (await limited(
        t,
        api.inboxWrites.takeDown,
        { itemId, status: 'hidden', reason: 'Fabricated' },
        'admin',
      )) as { actionId: Id<'moderationActions'> };
      // Some flags are still open: the undo lands before their page runs.
      await limited(t, api.undo.run, { actionId: done.actionId, reason: 'Undone' }, 'admin');
      await drain(t);
    });
    const statuses = await t.run(async (ctx) =>
      Promise.all(flags.map(async (id) => (await ctx.db.get(id))?.status)),
    );
    expect(new Set(statuses)).toEqual(new Set(['open']));
    const after = await itemsNow(t);
    expect(after.items.map((i) => [i.status, i.open])).toEqual([['open', 120]]);
    expect(after.drift).toBe(0);
  });
});

// ── D289 over every source a decision closes ───────────────────────────────────────────────────

/** "Northwest Bay", drawn with the alias "NW Bay", on `lakeId`. */
async function aliasedBayOn(t: T, lakeId: Id<'waterBodies'>, by: Id<'profiles'>) {
  await t.run((ctx) =>
    ctx.db.insert('waterBodySubAreas', {
      waterBodyId: lakeId,
      name: 'Northwest Bay',
      aliases: ['NW Bay'],
      searchText: 'Northwest Bay NW Bay',
      polygon: SQUARE,
      bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      centroid: { lat: 0.5, lng: 0.5 },
      surfaceAreaSqM: 40_000,
      displayScore: 1,
      minVisibleZoom: 10,
      createdByUserId: by,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
}

const statusesOf = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.query('waterBodyRequests').collect()).map((r) => [r.name, r.status]),
  );

describe('no staffer decides an ask they filed, in any item the decision reaches (D289)', () => {
  test('an approval whose bay’s alias reaches the approver’s own ask in another item is refused whole', async () => {
    const t = harness();
    const lakeId = await lake(t);
    const [skater] = await people(t, 1, 'skater');
    const mod = await staff(t, 'mod', 'moderator');
    const other = await staff(t, 'other', 'moderator');
    await aliasedBayOn(t, lakeId, other.id);
    const at = { kind: 'name_bay' as const, coord: { lat: 0.5, lng: 0.5 }, waterBodyId: lakeId };
    const theirs = await t
      .withIdentity({ subject: 'skater0' })
      .mutation(api.corpusRequests.create, { ...at, name: 'Northwest Bay' });
    await mod.as.mutation(api.corpusRequests.create, { ...at, name: 'NW Bay' });
    await settle();
    // Two keys, two items: the moderator's ask isn't a member of the one they'd approve.
    expect((await itemsNow(t)).items).toHaveLength(2);
    // The drawer says so before the write does — and the decline (its own key only) is theirs to make.
    const view = await mod.as.query(api.inbox.item, { ref: `request:${theirs}` });
    expect(view.item?.can.approve).toBe(OWN_FILING_REFUSAL);
    expect(view.item?.can.decline).toBeNull();
    await expect(
      mod.as.mutation(api.corpusRequests.approve, { requestId: theirs }),
    ).rejects.toThrow(OWN_FILING_REFUSAL);
    expect(await statusesOf(t)).toEqual([
      ['Northwest Bay', 'open'],
      ['NW Bay', 'open'],
    ]);
    // A colleague's approval closes both, as one answer.
    await other.as.mutation(api.corpusRequests.approve, { requestId: theirs });
    expect(await statusesOf(t)).toEqual([
      ['Northwest Bay', 'approved'],
      ['NW Bay', 'approved'],
    ]);
    void skater;
  });

  test('a script’s ask is exempt alone: its app-filed sibling by the approver refuses the approval', async () => {
    const t = harness();
    const lakeId = await lake(t);
    const mod = await staff(t, 'mod', 'moderator');
    const other = await staff(t, 'other', 'moderator');
    await aliasedBayOn(t, lakeId, other.id);
    const seeded = await t.run((ctx) =>
      ctx.db.insert('waterBodyRequests', {
        kind: 'name_bay',
        status: 'open',
        origin: 'seed',
        requesterId: other.id,
        coord: { lat: 0.5, lng: 0.5 },
        waterBodyId: lakeId,
        name: 'Northwest Bay',
        nameKey: requestNameKeyFor('name_bay', 'Northwest Bay'),
        createdAt: NOW - 1000,
      }),
    );
    await mod.as.mutation(api.corpusRequests.create, {
      kind: 'name_bay',
      coord: { lat: 0.5, lng: 0.5 },
      waterBodyId: lakeId,
      name: 'NW Bay',
    });
    await settle();
    await expect(
      mod.as.mutation(api.corpusRequests.approve, { requestId: seeded }),
    ).rejects.toThrow(OWN_FILING_REFUSAL);
    // The seed's own staff requester still decides it when no app-filed sibling is theirs.
    await other.as.mutation(api.corpusRequests.approve, { requestId: seeded });
    expect((await statusesOf(t)).map(([, s]) => s)).toEqual(['approved', 'approved']);
  });

  test('an own ask the backfill hasn’t filed yet is seen by the write’s own scan', async () => {
    const t = harness();
    const lakeId = await lake(t);
    const askers = await people(t, 1);
    const mod = await staff(t, 'mod', 'moderator');
    const [theirs] = await bayAsks(t, lakeId, askers);
    // The moderator's ask for the same bay, written raw: no member, so no item knows it is theirs.
    await bayAsks(t, lakeId, [mod.id], { file: () => false });
    await settle();
    await expect(
      mod.as.mutation(api.corpusRequests.decline, {
        requestId: theirs as Id<'waterBodyRequests'>,
        note: 'No',
      }),
    ).rejects.toThrow(OWN_FILING_REFUSAL);
    expect((await statusesOf(t)).map(([, s]) => s)).toEqual(['open', 'open']);
  });

  test('the undo of an approval that closed the undoer’s own ask in another item: neither offered nor run', async () => {
    const t = harness();
    const lakeId = await lake(t);
    await people(t, 1, 'skater');
    const sib = await staff(t, 'sib', 'moderator');
    const actor = await staff(t, 'actor', 'moderator');
    await aliasedBayOn(t, lakeId, actor.id);
    const at = { kind: 'name_bay' as const, coord: { lat: 0.5, lng: 0.5 }, waterBodyId: lakeId };
    const theirs = await t
      .withIdentity({ subject: 'skater0' })
      .mutation(api.corpusRequests.create, { ...at, name: 'Northwest Bay' });
    await sib.as.mutation(api.corpusRequests.create, { ...at, name: 'NW Bay' });
    await settle();
    await actor.as.mutation(api.corpusRequests.approve, { requestId: theirs });
    const row = await rowOn(t, theirs as string, 'approve_request');
    const offer = await t.run(async (ctx) => {
      const { undoState } = await import('./lib/undo');
      const viewer = (await ctx.db.get(sib.id)) as Doc<'profiles'>;
      return undoState(ctx, viewer, (await ctx.db.get(row)) as Doc<'moderationActions'>, 'one');
    });
    expect(offer.state).not.toBe('available');
    await expect(
      sib.as.mutation(api.undo.run, { actionId: row, reason: 'Undone' }),
    ).rejects.toThrow(OWN_FILING_REFUSAL);
    // The approver undoes it: both reopen.
    await actor.as.mutation(api.undo.run, { actionId: row, reason: 'Undone' });
    expect((await statusesOf(t)).map(([, s]) => s)).toEqual(['open', 'open']);
  });

  test('a landmark’s approval reaching the approver’s ask by an alias, in another item, is refused', async () => {
    const t = harness();
    const lakeId = await lake(t);
    const mod = await staff(t, 'mod', 'moderator');
    const other = await staff(t, 'other', 'moderator');
    await people(t, 1, 'skater');
    await t.run((ctx) =>
      ctx.db.insert('bodyLandmarks', {
        waterBodyId: lakeId,
        name: 'Long Point',
        kind: 'point',
        point: { lat: 0.5, lng: 0.5 },
        source: 'moderator',
        externalIds: [],
        aliases: ['Gull Point'],
        createdAt: NOW,
        updatedAt: NOW,
      } as never),
    );
    const [skater] = await t.run(async (ctx) =>
      (await ctx.db.query('profiles').collect()).filter((p) => p.clerkUserId === 'skater0'),
    );
    // Landmark asks are filed from reports (`fileLandmarkProposals`); written here as it writes them.
    const landmarkAsk = (requesterId: Id<'profiles'>, name: string) =>
      t.run(async (ctx) => {
        const id = await ctx.db.insert('waterBodyRequests', {
          kind: 'name_landmark',
          status: 'open',
          requesterId,
          coord: { lat: 0.5, lng: 0.5 },
          waterBodyId: lakeId,
          name,
          nameKey: requestNameKeyFor('name_landmark', name),
          createdAt: NOW - 1000,
        });
        await fileMember(ctx, requestSource(id));
        return id;
      });
    const theirs = await landmarkAsk(skater?._id as Id<'profiles'>, 'Long Point');
    await landmarkAsk(mod.id, 'Gull Point');
    await settle();
    expect((await itemsNow(t)).items).toHaveLength(2);
    // The drawer draws the approval as the moderator's own to leave; the decline reaches only its place.
    const view = await mod.as.query(api.inbox.item, { ref: `request:${theirs}` });
    expect(view.item?.can.approve).toBe(OWN_FILING_REFUSAL);
    expect(view.item?.can.decline).toBeNull();
    await expect(
      mod.as.mutation(api.corpusRequests.approve, { requestId: theirs }),
    ).rejects.toThrow(OWN_FILING_REFUSAL);
    await other.as.mutation(api.corpusRequests.approve, { requestId: theirs });
    expect((await statusesOf(t)).map(([, s]) => s)).toEqual(['approved', 'approved']);
  });
});
