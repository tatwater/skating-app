/**
 * **No rule is decided from a window** (B01-5, PR #170). A rule that reads "the newest 100" or "the
 * first 8" answers wrongly once a much-flagged target's own rows push the deciding one past the cap —
 * the fifth Greptile pass found the flag reopen did exactly that. Every rule below is answered by an
 * exact indexed lookup, or reads to a bound a writer holds, or refuses at its bound in words; each case
 * is the same answer however many rows sit beside the deciding one:
 * - the flag reopen rule — the reporter's new filing, or an open automatic flag of the reason, as the
 *   newest, the 101st newest and the oldest of the target's flags, on an undo's first page (the whole
 *   undo refused) and on a later page (that flag left closed, named on the undo's lead row);
 * - a filing's one-open-flag dedupe, either open status;
 * - the own-filing-in-another-lane check, however many closed members of theirs fill the item;
 * - the undo's gathers, held to the closers' caps, refusing past them; the request drain's cap;
 * - a put-in's suppression check, refusing past its read; an item's count, a floor past its bound.
 */

import { makeFunctionReference } from 'convex/server';
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  DECISION_FLAGS_MAX,
  FLAGS_READ,
  REOPEN_FACT_READS,
  UNDO_TOO_LARGE,
} from './lib/inboxFlags';
import { fileMember, flagSource, MAX_MEMBERS, PAGE_SEAM, requestSource } from './lib/inboxItems';
import { OWN_FILING_REFUSAL } from './lib/inboxRules';
import { OPEN_FLAG_STATUSES } from './lib/openFlags';
import { REQUEST_SIBLINGS_MAX } from './lib/requestDecisions';
import { UNDO_GROUP_TOO_LARGE } from './lib/undoHandlersCorpus';
import { launchRefusalOf, SUPPRESSION_ROWS_READ, SUPPRESSION_UNCHECKED } from './putIns';
import schema from './schema';
import { RULING_REPORTS_READ } from './waterBodies';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
type Person = { id: Id<'profiles'>; as: ReturnType<T['withIdentity']> };
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
  moderatorDecision: false,
};

const SAME_PERSON =
  'The same person has flagged this again since, so this one can’t be reopened beside it.';
const SAME_KIND =
  'A flag of the same kind is open on this now, so this one can’t be reopened beside it.';

afterEach(() => {
  PAGE_SEAM.sources = Number.POSITIVE_INFINITY;
});

async function world() {
  const t = harness();
  const person = async (subject: string, role: 'member' | 'admin' = 'member'): Promise<Person> => {
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
  };
  const actor = await person('actor', 'admin');
  const reporter = await person('reporter');
  const lead = await person('lead');
  const rater = await person('rater');
  const others: Person[] = [];
  for (let i = 0; i < 4; i++) others.push(await person(`o${i}`));
  const report = await t.run(async (ctx) => {
    const lake = await ctx.db.insert('waterBodies', {
      name: 'Pond',
      searchText: 'Pond',
      type: 'lakePond',
      source: 'osm',
      dedupStatus: 'clean',
      polygon: {
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
      },
      centroid: { lat: 0.5, lng: 0.5 },
      bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      createdAt: NOW,
    } as never);
    return ctx.db.insert('reports', {
      authorId: others[3]?.id as Id<'profiles'>,
      waterBodyId: lake as Id<'waterBodies'>,
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
    });
  });
  return { t, actor, reporter, lead, rater, others, report };
}
type W = Awaited<ReturnType<typeof world>>;

/** A flag on the report written raw (the window's rows need no item), filed when `member`. */
const insertFlag = (
  w: W,
  flaggerId: Id<'profiles'>,
  fields: Partial<Doc<'contentFlags'>> = {},
  member = false,
) =>
  w.t.run(async (ctx) => {
    const id = await ctx.db.insert('contentFlags', {
      flaggerId,
      targetType: 'report',
      targetId: w.report,
      reason: 'spam',
      status: 'open',
      origin: 'user',
      subjectUserId: w.others[3]?.id,
      createdAt: Date.now(),
      ...fields,
    });
    if (member) await fileMember(ctx, flagSource(id));
    return id;
  });

/** `n` open flags of other people on the report — none the reporter's, none automatic. */
const crowd = (w: W, n: number) =>
  w.t.run(async (ctx) => {
    for (let i = 0; i < n; i++) {
      await ctx.db.insert('contentFlags', {
        flaggerId: w.others[i % 3]?.id as Id<'profiles'>,
        targetType: 'report',
        targetId: w.report,
        reason: 'spam',
        status: 'open',
        origin: 'user',
        createdAt: Date.now(),
      });
    }
  });

const itemOf = (w: W, id: string) =>
  w.t.run(async (ctx) => {
    const m = await ctx.db
      .query('inboxItemMembers')
      .withIndex('by_source', (q) => q.eq('sourceTable', 'contentFlags').eq('sourceId', id))
      .first();
    return m?.itemId as Id<'inboxItems'>;
  });

const statusOf = (w: W, id: Id<'contentFlags'>) =>
  w.t.run(async (ctx) => (await ctx.db.get(id))?.status);

const undo = (w: W, actionId: Id<'moderationActions'>) =>
  w.actor.as.mutation(api.undo.run, { actionId, reason: 'Undone' });

/** Every scheduled reopen page, run in turn — each its own execution. */
async function drainReopens(t: T) {
  const seen = new Set<string>();
  for (let pages = 0; pages < 50; pages++) {
    const next = (await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())).find(
      (s) =>
        !seen.has(s._id) && s.state.kind === 'pending' && s.name === 'inboxWrites:reopenFlagsRest',
    );
    if (!next) return pages;
    seen.add(next._id);
    await t.mutation(makeFunctionReference<'mutation'>(next.name), next.args[0] as never);
  }
  throw new Error('a reopen never ended');
}

/** Where the deciding flag sits among the target's flags: `before` older than it, `after` newer. */
const POSITIONS = [
  { name: 'alone on the target', before: 0, after: 0 },
  { name: 'the newest of 151', before: 150, after: 0 },
  { name: 'the 101st newest', before: 50, after: 100 },
  { name: 'the oldest of 151', before: 0, after: 150 },
] as const;

/** The flag that decides the rule: the reporter's own new filing, or an open automatic flag. */
const KINDS = [
  {
    name: 'person-filed',
    sentence: SAME_PERSON,
    closed: (w: W) => insertFlag(w, w.reporter.id, {}, true),
    decider: (w: W) => insertFlag(w, w.reporter.id),
  },
  {
    name: 'automatic',
    sentence: SAME_KIND,
    closed: (w: W) => insertFlag(w, w.rater.id, { origin: 'auto' }, true),
    decider: (w: W) => insertFlag(w, w.rater.id, { origin: 'auto' }),
  },
  {
    name: 'automatic, from before `origin` (absent)',
    sentence: SAME_KIND,
    closed: (w: W) => insertFlag(w, w.rater.id, { origin: 'auto' }, true),
    decider: (w: W) => insertFlag(w, w.rater.id, { origin: undefined }),
  },
] as const;

describe('the flag reopen rule: the deciding flag, wherever it sits among the target’s flags', () => {
  for (const kind of KINDS) {
    for (const at of POSITIONS) {
      test(`${kind.name}, ${at.name} — the undo’s first page: the whole undo refused`, async () => {
        const w = await world();
        const closed = await kind.closed(w);
        const out = await w.actor.as.mutation(api.inboxWrites.dismissFlags, {
          itemId: await itemOf(w, closed),
        });
        await crowd(w, at.before);
        await kind.decider(w);
        await crowd(w, at.after);
        await expect(undo(w, out.actionId)).rejects.toThrow(kind.sentence);
        expect(await statusOf(w, closed)).toBe('dismissed');
      });

      test(`${kind.name}, ${at.name} — a later page: that flag left closed, named on the lead row`, async () => {
        const w = await world();
        // The lead flag first (the dismissal's own row), the flag the rule refuses on the next page.
        const first = await insertFlag(w, w.lead.id, { createdAt: Date.now() - 1000 }, true);
        const closed = await kind.closed(w);
        const out = await w.actor.as.mutation(api.inboxWrites.dismissFlags, {
          itemId: await itemOf(w, first),
        });
        await crowd(w, at.before);
        await kind.decider(w);
        await crowd(w, at.after);
        PAGE_SEAM.sources = 1;
        await undo(w, out.actionId);
        expect(await drainReopens(w.t)).toBe(1);
        expect(await statusOf(w, first)).toBe('open');
        expect(await statusOf(w, closed)).toBe('dismissed');
        const leadRow = await w.t.run(async (ctx) =>
          (await ctx.db.query('moderationActions').collect()).find(
            (r) => r.action === 'reopen_flag' && r.targetId === first,
          ),
        );
        expect(leadRow?.metadata?.flagsLeftClosed).toEqual([
          { flagId: closed, why: kind.sentence },
        ]);
        expect(leadRow?.metadata?.reopened).toEqual([first]);
      });
    }
  }

  test('a flag beside the lead the rule refuses, on the first page: left closed, the undo runs — as its offer, which asks the lead, says', async () => {
    const w = await world();
    const first = await insertFlag(w, w.lead.id, { createdAt: Date.now() - 1000 }, true);
    const closed = await KINDS[0].closed(w);
    const out = await w.actor.as.mutation(api.inboxWrites.dismissFlags, {
      itemId: await itemOf(w, first),
    });
    await KINDS[0].decider(w);
    const offer = await w.actor.as.query(api.undo.latestOwn, {
      targetType: 'contentFlag',
      targetId: first,
    });
    expect(offer?.undo).toMatchObject({ state: 'available' });
    await undo(w, out.actionId);
    expect([await statusOf(w, first), await statusOf(w, closed)]).toEqual(['open', 'dismissed']);
  });

  test('the same answer at five thousand: the reporter’s new filing the oldest of them', async () => {
    const w = await world();
    const closed = await KINDS[0].closed(w);
    const out = await w.actor.as.mutation(api.inboxWrites.dismissFlags, {
      itemId: await itemOf(w, closed),
    });
    await KINDS[0].decider(w);
    for (let i = 0; i < 5; i++) await crowd(w, 1000);
    await expect(undo(w, out.actionId)).rejects.toThrow(SAME_PERSON);
  });

  test('other people’s open flags, any number, never refuse: the ordinary case reopens', async () => {
    const w = await world();
    const closed = await KINDS[0].closed(w);
    const out = await w.actor.as.mutation(api.inboxWrites.dismissFlags, {
      itemId: await itemOf(w, closed),
    });
    await crowd(w, 150);
    // An automatic flag of another reason, and the reporter's own closed flag elsewhere, neither count.
    await insertFlag(w, w.rater.id, { origin: 'auto', reason: 'harassment' });
    await insertFlag(w, w.reporter.id, { status: 'dismissed' });
    await undo(w, out.actionId);
    expect(await statusOf(w, closed)).toBe('open');
    // Each answer is a handful of point reads, not a scan.
    expect(REOPEN_FACT_READS).toBe(1 + 2 * OPEN_FLAG_STATUSES.length);
  });

  test('a superseded flag is refused however many rows are newer than its successor', async () => {
    const w = await world();
    const closed = await insertFlag(w, w.rater.id, { origin: 'auto' }, true);
    const out = await w.actor.as.mutation(api.inboxWrites.dismissFlags, {
      itemId: await itemOf(w, closed),
    });
    // The recurrence filed a new row carrying the count, then closed; 150 newer rows follow.
    await insertFlag(w, w.rater.id, {
      origin: 'auto',
      supersedesFlagId: closed,
      status: 'dismissed',
    });
    await crowd(w, 150);
    await expect(undo(w, out.actionId)).rejects.toThrow('A newer flag has taken this one’s place');
  });
});

describe('a filing’s one open flag per person per target', () => {
  test('a repeat returns the open one — `reviewing` too — however many flags the target holds', async () => {
    const w = await world();
    await crowd(w, 150);
    const reviewing = await insertFlag(w, w.reporter.id, { status: 'reviewing' });
    await crowd(w, 150);
    const again = await w.reporter.as.mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: w.report,
      reason: 'spam',
    });
    expect(again).toBe(reviewing);
    // Closed, a new filing is a new flag.
    await w.t.run((ctx) => ctx.db.patch(reviewing, { status: 'dismissed' }));
    const fresh = await w.reporter.as.mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: w.report,
      reason: 'spam',
    });
    expect(fresh).not.toBe(reviewing);
  });
});

describe('the own-filing check in another lane', () => {
  test('a staffer’s open flag in the safety lane refuses their takedown, however many closed ones of theirs sit before it', async () => {
    const w = await world();
    // The safety item, opened by someone else; nine closed members of the actor's in it, then theirs.
    const safety = await insertFlag(w, w.lead.id, { reason: 'unsafe_false_report' }, true);
    const safetyItem = await itemOf(w, safety);
    await w.t.run(async (ctx) => {
      for (let i = 0; i < 9; i++) {
        await ctx.db.insert('inboxItemMembers', {
          itemId: safetyItem,
          sourceTable: 'contentFlags',
          sourceId: `closed-${i}`,
          filedByUserId: w.actor.id,
          status: 'closed',
          filedAt: NOW - 10_000 + i,
        });
      }
    });
    await insertFlag(w, w.actor.id, { reason: 'unsafe_false_report' }, true);
    const content = await insertFlag(w, w.reporter.id, {}, true);
    await expect(
      w.actor.as.mutation(api.inboxWrites.takeDown, {
        itemId: await itemOf(w, content),
        status: 'hidden',
        reason: 'Spam',
      }),
    ).rejects.toThrow(OWN_FILING_REFUSAL);
  });
});

describe('the undo’s gathers: every row the decision closed, or refused', () => {
  test('the closers’ caps are within the flag gather, and a request decision stamps at most `MAX_MEMBERS`', () => {
    expect(OPEN_FLAG_STATUSES.length * FLAGS_READ).toBeLessThanOrEqual(DECISION_FLAGS_MAX);
    expect(RULING_REPORTS_READ).toBeLessThanOrEqual(DECISION_FLAGS_MAX);
    expect(MAX_MEMBERS).toBeLessThanOrEqual(DECISION_FLAGS_MAX);
    expect(REQUEST_SIBLINGS_MAX + 1).toBe(MAX_MEMBERS);
  });

  test('a flag decision stamping more than any closer does: its undo refused whole', async () => {
    const w = await world();
    const closed = await KINDS[0].closed(w);
    const out = await w.actor.as.mutation(api.inboxWrites.dismissFlags, {
      itemId: await itemOf(w, closed),
    });
    const item = await itemOf(w, closed);
    await w.t.run(async (ctx) => {
      for (let i = 0; i < DECISION_FLAGS_MAX; i++) {
        await ctx.db.insert('inboxItemMembers', {
          itemId: item,
          sourceTable: 'contentFlags',
          sourceId: `stamped-${i}`,
          status: 'closed',
          closedByActionId: out.actionId,
          filedAt: NOW,
        });
      }
    });
    await expect(undo(w, out.actionId)).rejects.toThrow(UNDO_TOO_LARGE);
    expect(await statusOf(w, closed)).toBe('dismissed');
  });

  test('a request decision stamping more than its cap: its undo refused whole', async () => {
    const w = await world();
    const ask = await w.t.run(async (ctx) => {
      const id = await ctx.db.insert('waterBodyRequests', {
        kind: 'admit',
        status: 'open',
        requesterId: w.reporter.id,
        coord: { lat: 1, lng: 1 },
        createdAt: NOW - 1000,
      });
      await fileMember(ctx, requestSource(id));
      return id;
    });
    await w.actor.as.mutation(api.corpusRequests.decline, { requestId: ask, note: 'No' });
    const row = await w.t.run(async (ctx) =>
      (await ctx.db.query('moderationActions').collect()).find(
        (r) => r.action === 'decline_request',
      ),
    );
    const item = await w.t.run(
      async (ctx) =>
        (
          await ctx.db
            .query('inboxItemMembers')
            .withIndex('by_source', (q) =>
              q.eq('sourceTable', 'waterBodyRequests').eq('sourceId', ask),
            )
            .first()
        )?.itemId as Id<'inboxItems'>,
    );
    await w.t.run(async (ctx) => {
      for (let i = 0; i < MAX_MEMBERS; i++) {
        await ctx.db.insert('inboxItemMembers', {
          itemId: item,
          sourceTable: 'waterBodyRequests',
          sourceId: `stamped-${i}`,
          status: 'closed',
          closedByActionId: row?._id,
          filedAt: NOW,
        });
      }
    });
    await expect(undo(w, row?._id as Id<'moderationActions'>)).rejects.toThrow(
      UNDO_GROUP_TOO_LARGE,
    );
  });

  test('the request drain stops at its cap: the rest stay open, shown in their item', async () => {
    const w = await world();
    const asks = await w.t.run(async (ctx) => {
      const out: Id<'waterBodyRequests'>[] = [];
      for (const [i, p] of [w.reporter, w.lead, w.rater].entries()) {
        const id = await ctx.db.insert('waterBodyRequests', {
          kind: 'admit',
          status: 'open',
          requesterId: p.id,
          coord: { lat: 1, lng: 1 },
          candidateExternalId: 'osm:way/1',
          createdAt: NOW - 1000 + i,
        });
        await fileMember(ctx, requestSource(id));
        out.push(id);
      }
      return out;
    });
    const [primary] = asks as [Id<'waterBodyRequests'>];
    const decidedAt = Date.now() + 1;
    await w.t.run((ctx) =>
      ctx.db.patch(primary, { status: 'declined', decidedAt, decidedByUserId: w.actor.id }),
    );
    // A later page whose earlier pages read all but one of the cap: it closes one, schedules none.
    await w.t.mutation(internal.corpusRequests.closeSiblings, {
      requestId: primary,
      status: 'declined',
      actorId: w.actor.id,
      now: decidedAt,
      closedSoFar: REQUEST_SIBLINGS_MAX - 1,
    });
    const after = await w.t.run(async (ctx) =>
      Promise.all(asks.slice(1).map(async (id) => (await ctx.db.get(id))?.status)),
    );
    expect(after.sort()).toEqual(['declined', 'open']);
    const scheduled = await w.t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    expect(scheduled.filter((s) => s.name === 'corpusRequests:closeSiblings')).toEqual([]);
  });
});

describe('bounds that refuse, or say they stopped', () => {
  test('a put-in’s suppression check past its read refuses in words, never decides on a window', () => {
    const row = { status: 'visible', coord: { lat: 0, lng: 0 } } as Doc<'putIns'>;
    const far = { coord: { lat: 10, lng: 10 } };
    expect(launchRefusalOf(row, Array(SUPPRESSION_ROWS_READ).fill(far))).toBeNull();
    expect(launchRefusalOf(row, Array(SUPPRESSION_ROWS_READ + 1).fill(far))).toBe(
      SUPPRESSION_UNCHECKED,
    );
  });

  test('an item’s count is a floor once it reaches the most an item counts', async () => {
    const w = await world();
    const closed = await KINDS[0].closed(w);
    const item = await itemOf(w, closed);
    const read = async () => {
      const got = await w.actor.as.query(api.inbox.item, { ref: item, now: NOW });
      return got.item as { memberCount: number; memberCountIsFloor: boolean };
    };
    expect(await read()).toMatchObject({ memberCount: 1, memberCountIsFloor: false });
    await w.t.run((ctx) => ctx.db.patch(item, { memberCount: MAX_MEMBERS }));
    expect(await read()).toMatchObject({ memberCount: MAX_MEMBERS, memberCountIsFloor: true });
    // The list row says so too.
    const page = await w.actor.as.query(api.inbox.listPage, { lane: 'all', now: NOW });
    expect(page.rows.find((r) => r.itemId === item)).toMatchObject({
      memberCount: MAX_MEMBERS,
      memberCountIsFloor: true,
    });
  });
});
