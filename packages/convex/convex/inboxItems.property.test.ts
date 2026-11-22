/**
 * **The Inbox's one writer, held by random histories** (B01-5, *The one writer's property test*).
 *
 * Random sequences of source events — flags of every reason on a few targets, filed, retracted,
 * resolved or dismissed, closed by an access ruling; asks filed, retracted, declined with their
 * siblings (whole, or the primary first and the siblings in a later drain page), an admit resolved to
 * a catalog feature, landmark asks by place; a drawn body approved, rejected or merged; a body merged
 * moving its asks and access reports; tickets filed and resolved; and an undo of any stamped decision
 * — are applied through the real mutations, and after **every** step the stored items must be what the
 * source rows say:
 *
 * - every source with a member owed has exactly one, in an item asking its question (its key; a
 *   landmark ask, a place on its body), open while the source is open;
 * - no item without a member, no open item without an open member, no two open items on one key;
 * - every member of a decided item is closed, and its audit row is on one of them;
 * - `memberCount`, `filedAt` and `rankKey` are what the members derive;
 * - every `inboxCounts` row is the tally of the items, and no tally lacks a row;
 * - the drift repair's check finds nothing to fix.
 *
 * Two hooks are builder S2's (B01-5's appendix): `closeRow`'s in `lib/requestDecisions.ts` and the
 * drawn review's in `waterBodies.approve`/`reject`. Until they land, the flags below are `false` and
 * this test applies each hook itself, right after the write it follows — exactly the call S2 adds;
 * the integrator flips both to `true` when S2's commits are in, and from then on this test proves
 * S2's real hooks too.
 */

import { requestNameKeyFor } from '@skating/core';
import { ConvexError } from 'convex/values';
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import type { Polygon } from 'geojson';
import { describe, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { writeAudit } from './lib/audit';
import { closeFlagsUnder } from './lib/inboxFlags';
import {
  asksSameQuestion,
  bodySource,
  countKeysOf,
  decideItem,
  deriveItem,
  factsOf,
  flagSource,
  type InboxSource,
  requestSource,
  ticketSource,
} from './lib/inboxItems';
import { inboxDrift } from './lib/inboxRepair';
import { fileLandmarkProposals } from './lib/landmarkProposals';
import { closeRow } from './lib/requestDecisions';
import schema from './schema';

/** S2's hook in `closeRow` (both the primary and every sibling page) — flipped at integration. */
const CLOSE_ROW_HOOKED = true;
/** S2's hook in `waterBodies.approve` / `reject` — flipped at integration. */
const REVIEW_HOOKED = true;

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

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

const square = (x: number, y: number): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [x, y],
      [x, y + 1],
      [x + 1, y + 1],
      [x + 1, y],
      [x, y],
    ],
  ],
});

const CANDIDATES = ['EXT-A', 'EXT-B'].map((externalId, i) => ({
  source: '3dhp' as const,
  externalId,
  name: `Unseen Pond ${i}`,
  featureType: 39000,
  polygon: square(20 + i, 20),
  bbox: { minLat: 20, minLng: 20 + i, maxLat: 21, maxLng: 21 + i },
  centroid: { lat: 20.5, lng: 20.5 + i },
  surfaceAreaSqM: 40_000,
  serviceUrl: 'https://example.invalid/3dhp',
  fetchedAt: 1,
}));

type World = {
  t: T;
  members: { id: Id<'profiles'>; as: ReturnType<T['withIdentity']> }[];
  mods: { id: Id<'profiles'>; as: ReturnType<T['withIdentity']> }[];
  admin: { id: Id<'profiles'>; as: ReturnType<T['withIdentity']> };
  bodies: Id<'waterBodies'>[];
  reports: Id<'reports'>[];
  drawn: Id<'waterBodies'>[];
  /** Decisions whose primary closed and whose siblings wait for a drain page. */
  pendingDrains: Doc<'waterBodyRequests'>[];
  /**
   * Sources written raw, as before the backfill reached them: no member yet, and none owed while they
   * stay open — but a decision on one must record it, and its undo put it back (PR #170).
   */
  unfiled: Set<string>;
};

async function person(t: T, subject: string, role: 'member' | 'moderator' | 'admin') {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: `${subject} Test-Person`,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

async function seedBody(t: T, externalId: string, x: number) {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        states: ['VT'],
        externalId,
        osmId: externalId,
        name: `Pond ${externalId}`,
        type: 'lakePond',
        polygon: square(x, 0),
        bbox: { minLat: 0, minLng: x, maxLat: 1, maxLng: x + 1 },
        centroid: { lat: 0.5, lng: x + 0.5 },
        surfaceAreaSqM: 1_000_000,
      },
    ],
  });
  const body = (await t.run((ctx) => ctx.db.query('waterBodies').collect())).find(
    (b) => b.externalId === externalId,
  );
  if (!body) throw new Error('seed failed');
  return body._id;
}

async function world(): Promise<World> {
  const t = harness();
  const members = [
    await person(t, 'user_s0', 'member'),
    await person(t, 'user_s1', 'member'),
    await person(t, 'user_s2', 'member'),
  ];
  const mods = [await person(t, 'user_m0', 'moderator'), await person(t, 'user_m1', 'moderator')];
  const admin = await person(t, 'user_admin', 'admin');
  // Two active bodies and a third to merge away; the second is made dormant for `activate` asks.
  const bodies = [
    await seedBody(t, 'osm/A', 0),
    await seedBody(t, 'osm/B', 3),
    await seedBody(t, 'osm/L', 6),
  ];
  await t.run((ctx) =>
    ctx.db.patch(bodies[1] as Id<'waterBodies'>, {
      dormant: { since: Date.now(), reason: 'inactive' as const },
    }),
  );
  const reports = await t.run(async (ctx) => {
    const out: Id<'reports'>[] = [];
    for (const [i, m] of members.slice(0, 2).entries()) {
      out.push(
        await ctx.db.insert('reports', {
          authorId: m.id,
          waterBodyId: bodies[0] as Id<'waterBodies'>,
          point: { lat: 0.5, lng: 0.5 },
          skateEndTime: Date.now() - (i + 1) * 3_600_000,
          reportTime: Date.now(),
          source: 'native',
          iceTypes: [],
          surfaceTags: [],
          photoIds: [],
          moderationStatus: 'visible',
          hazardIdsCreated: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
    }
    return out;
  });
  // Two skaters' drawings, each from a track over open land.
  const drawn: Id<'waterBodies'>[] = [];
  for (const [i, m] of members.slice(0, 2).entries()) {
    const T0 = Date.UTC(2026, 0, 15, 14 + i);
    const activityId = await m.as.mutation(api.gpsActivities.ingestTrack, {
      idempotencyKey: `track-${i}`,
      path: {
        type: 'LineString',
        coordinates: Array.from({ length: 20 }, (_, k) => [40 + i * 3 + k * 0.01, 40.5]),
      },
      startTime: T0,
      endTime: T0 + 45 * 60_000,
    });
    drawn.push(
      await m.as.mutation(api.waterBodies.create, {
        name: `Drawn ${i}`,
        type: 'lakePond',
        activityId,
        confirmedNew: true,
      }),
    );
  }
  return { t, members, mods, admin, bodies, reports, drawn, pendingDrains: [], unfiled: new Set() };
}

// ── The events ─────────────────────────────────────────────────────────────────────────────────

const REASONS = ['unsafe_false_report', 'spam', 'no_public_access', 'other'] as const;

type Ev =
  | { k: 'flag'; who: number; target: number; reason: number }
  | { k: 'retractFlag'; i: number }
  | { k: 'resolve'; i: number; dismiss: boolean; stamped: boolean }
  | { k: 'rule'; body: number; verdict: 'none' | 'open' }
  | { k: 'ask'; who: number; kind: number }
  | { k: 'landmark'; who: number; spot: number }
  | { k: 'retractAsk'; i: number }
  | { k: 'decline'; i: number }
  | { k: 'primaryOnly'; i: number }
  | { k: 'drain' }
  | { k: 'resolveAdmit'; i: number; ext: number }
  | { k: 'review'; d: number; verb: 'approve' | 'reject' | 'merge' }
  | { k: 'mergeBody' }
  | { k: 'ticket'; who: number; category: number }
  | { k: 'resolveTicket'; i: number }
  | { k: 'undo'; i: number }
  | { k: 'rawFlag'; who: number; target: number; reason: number }
  | { k: 'rawAsk'; who: number; name: number }
  | { k: 'takedown'; i: number };

const ev: fc.Arbitrary<Ev> = fc.oneof(
  {
    weight: 9,
    arbitrary: fc.record({
      k: fc.constant('flag' as const),
      who: fc.nat(3),
      target: fc.oneof(fc.nat(5), fc.constantFrom(0, 3)),
      reason: fc.oneof(fc.nat(3), fc.constantFrom(0, 2)),
    }),
  },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('retractFlag' as const), i: fc.nat(20) }) },
  {
    weight: 3,
    arbitrary: fc.record({
      k: fc.constant('resolve' as const),
      i: fc.nat(20),
      dismiss: fc.boolean(),
      stamped: fc.boolean(),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant('rule' as const),
      body: fc.nat(2),
      verdict: fc.constantFrom('none' as const, 'open' as const),
    }),
  },
  {
    weight: 8,
    arbitrary: fc.record({
      k: fc.constant('ask' as const),
      who: fc.nat(2),
      kind: fc.oneof(fc.nat(5), fc.constantFrom(0, 3, 4)),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ k: fc.constant('landmark' as const), who: fc.nat(2), spot: fc.nat(2) }),
  },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('retractAsk' as const), i: fc.nat(20) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('decline' as const), i: fc.nat(20) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('primaryOnly' as const), i: fc.nat(20) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('drain' as const) }) },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant('resolveAdmit' as const),
      i: fc.nat(20),
      ext: fc.nat(1),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant('review' as const),
      d: fc.nat(1),
      verb: fc.constantFrom('approve' as const, 'reject' as const, 'merge' as const),
    }),
  },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('mergeBody' as const) }) },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant('ticket' as const),
      who: fc.nat(2),
      category: fc.nat(3),
    }),
  },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('resolveTicket' as const), i: fc.nat(20) }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant('undo' as const), i: fc.nat(20) }) },
  {
    weight: 3,
    arbitrary: fc.record({
      k: fc.constant('rawFlag' as const),
      who: fc.nat(3),
      target: fc.nat(5),
      reason: fc.nat(3),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ k: fc.constant('rawAsk' as const), who: fc.nat(2), name: fc.nat(1) }),
  },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('takedown' as const), i: fc.nat(20) }) },
);

/** Swallow the real mutations' own refusals (a dupe, a D269 own-content refusal, a decided row…). */
async function attempt(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (err) {
    // Only a refusal the server words (D268); anything else is a bug and fails the run.
    if (!(err instanceof ConvexError)) throw err;
  }
}

const pick = <X>(rows: readonly X[], i: number): X | undefined =>
  rows.length === 0 ? undefined : rows[i % rows.length];

/** S2's closeRow hook, applied by hand until it lands: each decided ask's member closes. */
async function applyCloseRowHook(ctx: MutationCtx) {
  if (CLOSE_ROW_HOOKED) return;
  for (const r of await ctx.db.query('waterBodyRequests').collect()) {
    if (r.status !== 'approved' && r.status !== 'declined') continue;
    const audit = (
      await ctx.db
        .query('moderationActions')
        .withIndex('by_target', (q) => q.eq('targetType', 'waterBodyRequest').eq('targetId', r._id))
        .collect()
    ).at(-1);
    const primary = (audit?.metadata as { withRequestId?: Id<'waterBodyRequests'> } | undefined)
      ?.withRequestId;
    const primaryAudit = primary
      ? (
          await ctx.db
            .query('moderationActions')
            .withIndex('by_target', (q) =>
              q.eq('targetType', 'waterBodyRequest').eq('targetId', primary),
            )
            .collect()
        ).at(-1)
      : audit;
    await decideItem(ctx, requestSource(r._id), {
      ...(primaryAudit ? { actionId: primaryAudit._id } : {}),
      ...(r.decidedByUserId ? { actorId: r.decidedByUserId } : {}),
    });
  }
}

/** S2's review hook, applied by hand until it lands. */
async function applyReviewHook(ctx: MutationCtx, id: Id<'waterBodies'>) {
  if (REVIEW_HOOKED) return;
  const audit = (
    await ctx.db
      .query('moderationActions')
      .withIndex('by_target', (q) => q.eq('targetType', 'waterbody').eq('targetId', id))
      .collect()
  ).at(-1);
  await decideItem(ctx, bodySource(id), audit ? { actionId: audit._id } : {});
}

async function apply(w: World, e: Ev): Promise<void> {
  const { t } = w;
  const flags = () => t.run((ctx) => ctx.db.query('contentFlags').collect());
  const asks = () => t.run((ctx) => ctx.db.query('waterBodyRequests').collect());
  switch (e.k) {
    case 'flag': {
      const who = e.who < 3 ? w.members[e.who] : w.mods[0];
      const targets: [Doc<'contentFlags'>['targetType'], string][] = [
        ['report', w.reports[0] as string],
        ['report', w.reports[1] as string],
        ['user', w.members[2]?.id as string],
        ['waterbody', w.bodies[0] as string],
        ['waterbody', w.bodies[2] as string],
        ['waterbody', w.bodies[1] as string],
      ];
      const [targetType, targetId] = targets[e.target % targets.length] as [
        Doc<'contentFlags'>['targetType'],
        string,
      ];
      await attempt(() =>
        (who as World['admin']).as.mutation(api.contentFlags.flag, {
          targetType,
          targetId,
          reason: REASONS[e.reason % REASONS.length] as (typeof REASONS)[number],
          note: 'seen it',
        }),
      );
      return;
    }
    case 'retractFlag': {
      const f = pick(await flags(), e.i);
      if (!f) return;
      const by = [...w.members, ...w.mods].find((p) => p.id === f.flaggerId);
      if (by) await attempt(() => by.as.mutation(api.contentFlags.retract, { flagId: f._id }));
      return;
    }
    case 'resolve': {
      const f = pick(
        (await flags()).filter((x) => x.status === 'open'),
        e.i,
      );
      if (!f) return;
      const resolution = e.dismiss ? 'dismissed' : 'actioned';
      if (!e.stamped) {
        // The legacy path: one flag, its audit row written after (no stamp).
        await attempt(() =>
          (w.mods[1] as World['admin']).as.mutation(api.moderation.resolveFlag, {
            flagId: f._id,
            resolution,
            reason: 'checked',
          }),
        );
        return;
      }
      // The Inbox's decision (S2's `dismissFlags` / `takeDown` shape): every open flag of the item,
      // one audit row first, stamped on each.
      await t.run(async (ctx) => {
        const member = await ctx.db
          .query('inboxItemMembers')
          .withIndex('by_source', (q) => q.eq('sourceTable', 'contentFlags').eq('sourceId', f._id))
          .first();
        if (!member) return;
        const open = await ctx.db
          .query('inboxItemMembers')
          .withIndex('by_item_status', (q) => q.eq('itemId', member.itemId).eq('status', 'open'))
          .collect();
        const actorId = w.mods[1]?.id as Id<'profiles'>;
        const actor = await ctx.db.get(actorId);
        if (!actor) return;
        const now = Date.now();
        const actionId = await writeAudit(ctx, {
          actorId,
          action: e.dismiss ? 'dismiss_flag' : 'resolve_flag',
          targetType: 'contentFlag',
          targetId: f._id,
          reason: 'checked',
          createdAt: now,
        });
        // Through the batch closer every flag decision uses: one recount per item.
        const rows: Doc<'contentFlags'>[] = [];
        for (const m of open) {
          const row = await ctx.db.get(m.sourceId as Id<'contentFlags'>);
          if (row) rows.push(row);
        }
        await closeFlagsUnder(ctx, actor, rows, {
          resolution,
          decision: resolution,
          reason: 'checked',
          defaulted: false,
          now,
          lead: actionId,
        });
      });
      return;
    }
    case 'rule':
      await attempt(() =>
        (w.mods[0] as World['admin']).as.mutation(api.waterBodies.setPublicAccess, {
          waterBodyId: w.bodies[e.body % 3] as Id<'waterBodies'>,
          verdict: e.verdict,
        }),
      );
      return;
    case 'ask': {
      const who = w.members[e.who % 3] as World['admin'];
      const kinds = [
        { kind: 'name_bay' as const, waterBodyId: w.bodies[0], name: 'Cove' },
        { kind: 'name_bay' as const, waterBodyId: w.bodies[0], name: 'North Bay' },
        { kind: 'takedown' as const, waterBodyId: w.bodies[2] },
        { kind: 'activate' as const, waterBodyId: w.bodies[1] },
        { kind: 'admit' as const },
        { kind: 'name_bay' as const, waterBodyId: w.bodies[2], name: 'Cove' },
      ];
      const k = kinds[e.kind % kinds.length] as (typeof kinds)[number];
      await attempt(() =>
        who.as.mutation(api.corpusRequests.create, {
          kind: k.kind,
          coord: k.kind === 'admit' ? { lat: 30 + e.who, lng: 30 } : { lat: 0.5, lng: 0.5 },
          ...('waterBodyId' in k ? { waterBodyId: k.waterBodyId } : {}),
          ...('name' in k ? { name: k.name } : {}),
        }),
      );
      return;
    }
    case 'landmark': {
      const spots = [
        { name: 'the Narrows', coord: { lat: 0.5, lng: 0.5 } },
        { name: 'the Narrows', coord: { lat: 0.5001, lng: 0.5001 } },
        { name: 'Long Point', coord: { lat: 0.2, lng: 0.2 } },
      ];
      const who = w.members[e.who % 3] as World['admin'];
      await t.run(async (ctx) => {
        const body = await ctx.db.get(w.bodies[0] as Id<'waterBodies'>);
        if (!body) return;
        await fileLandmarkProposals(
          ctx,
          who.id,
          body,
          w.reports[0] as Id<'reports'>,
          [spots[e.spot % spots.length] as (typeof spots)[number]],
          [],
        );
      });
      return;
    }
    case 'retractAsk': {
      const r = pick(await asks(), e.i);
      if (!r) return;
      const by = w.members.find((p) => p.id === r.requesterId);
      if (by) await attempt(() => by.as.mutation(api.corpusRequests.retract, { requestId: r._id }));
      return;
    }
    case 'decline': {
      const r = pick(
        (await asks()).filter((x) => x.status === 'open'),
        e.i,
      );
      if (!r) return;
      await attempt(() =>
        (w.mods[0] as World['admin']).as.mutation(api.corpusRequests.decline, {
          requestId: r._id,
          note: 'not this one',
        }),
      );
      await t.run(applyCloseRowHook);
      return;
    }
    case 'primaryOnly': {
      // A decision whose first page closed only its primary: the siblings wait for a drain page.
      const r = pick(
        (await asks()).filter((x) => x.status === 'open'),
        e.i,
      );
      if (!r) return;
      const now = Date.now();
      await t.run(async (ctx) => {
        await closeRow(ctx, r, {
          requestId: r._id,
          status: 'declined',
          actorId: w.mods[0]?.id as Id<'profiles'>,
          now,
          note: 'not this one',
        });
        await applyCloseRowHook(ctx);
      });
      w.pendingDrains.push({ ...r, decidedAt: now });
      return;
    }
    case 'drain': {
      const r = w.pendingDrains.shift();
      if (!r) return;
      await t.mutation(internal.corpusRequests.closeSiblings, {
        requestId: r._id,
        status: 'declined',
        actorId: w.mods[0]?.id as Id<'profiles'>,
        now: r.decidedAt as number,
        note: 'not this one',
      });
      await t.run(applyCloseRowHook);
      return;
    }
    case 'resolveAdmit': {
      const r = pick(
        (await asks()).filter((x) => x.kind === 'admit' && x.status === 'open'),
        e.i,
      );
      if (!r) return;
      await t.mutation(internal.corpusRequests.recordResolution, {
        requestId: r._id,
        resolvedAt: Date.now(),
        candidate: CANDIDATES[e.ext % CANDIDATES.length],
      });
      return;
    }
    case 'review': {
      const id = w.drawn[e.d % w.drawn.length] as Id<'waterBodies'>;
      const mod = w.mods[0] as World['admin'];
      if (e.verb === 'merge') {
        await attempt(() =>
          mod.as.mutation(api.waterBodies.merge, {
            survivorId: w.bodies[0] as Id<'waterBodies'>,
            loserId: id,
          }),
        );
        return;
      }
      await attempt(() =>
        mod.as.mutation(e.verb === 'approve' ? api.waterBodies.approve : api.waterBodies.reject, {
          waterBodyId: id,
        }),
      );
      await t.run((ctx) => applyReviewHook(ctx, id));
      return;
    }
    case 'mergeBody':
      // The third body merged into the first: its asks and access reports move to the survivor.
      await attempt(() =>
        (w.mods[0] as World['admin']).as.mutation(api.waterBodies.merge, {
          survivorId: w.bodies[0] as Id<'waterBodies'>,
          loserId: w.bodies[2] as Id<'waterBodies'>,
        }),
      );
      return;
    case 'ticket':
      await attempt(() =>
        (w.members[e.who % 3] as World['admin']).as.mutation(api.support.create, {
          category: (['bug', 'account', 'safety', 'other'] as const)[e.category % 4] as 'bug',
          body: 'Something is off',
        }),
      );
      return;
    case 'resolveTicket': {
      const tk = pick(
        (await t.run((ctx) => ctx.db.query('supportTickets').collect())).filter(
          (x) => x.status !== 'resolved',
        ),
        e.i,
      );
      if (tk) await w.admin.as.mutation(api.support.resolve, { ticketId: tk._id });
      return;
    }
    case 'rawFlag': {
      const flagger = (e.who < 3 ? w.members[e.who] : w.mods[0]) as World['admin'];
      const targets: [Doc<'contentFlags'>['targetType'], string][] = [
        ['report', w.reports[0] as string],
        ['report', w.reports[1] as string],
        ['user', w.members[2]?.id as string],
        ['waterbody', w.bodies[0] as string],
        ['waterbody', w.bodies[2] as string],
        ['waterbody', w.bodies[1] as string],
      ];
      const [targetType, targetId] = targets[e.target % targets.length] as [
        Doc<'contentFlags'>['targetType'],
        string,
      ];
      const id = await t.run(async (ctx) => {
        // One open flag per flagger per target, as the table keeps it.
        const mine = (await ctx.db.query('contentFlags').collect()).some(
          (f) =>
            f.flaggerId === flagger.id &&
            f.targetId === targetId &&
            (f.status === 'open' || f.status === 'reviewing'),
        );
        if (mine) return null;
        return ctx.db.insert('contentFlags', {
          flaggerId: flagger.id,
          targetType,
          targetId,
          reason: REASONS[e.reason % REASONS.length] as (typeof REASONS)[number],
          status: 'open',
          origin: 'user',
          createdAt: Date.now(),
        });
      });
      if (id) w.unfiled.add(id);
      return;
    }
    case 'rawAsk': {
      const asker = w.members[e.who] as World['admin'];
      const name = ['Cove', 'North Bay'][e.name % 2] as string;
      const id = await t.run((ctx) =>
        ctx.db.insert('waterBodyRequests', {
          kind: 'name_bay',
          status: 'open',
          requesterId: asker.id,
          coord: { lat: 0.4, lng: 0.4 },
          waterBodyId: w.bodies[0] as Id<'waterBodies'>,
          name,
          nameKey: requestNameKeyFor('name_bay', name),
          createdAt: Date.now(),
        }),
      );
      w.unfiled.add(id);
      return;
    }
    case 'takedown': {
      // The Inbox's takedown on a flagged report: every open flag on it, in every lane, closed in
      // pages of one batch each — filed or not.
      const itemId = await t.run(async (ctx) => {
        const items = (await ctx.db.query('inboxItems').collect()).filter(
          (i) => i.status === 'open' && i.kind === 'flag' && i.key.includes(':report:'),
        );
        return pick(items, e.i)?._id ?? null;
      });
      if (!itemId) return;
      await attempt(() =>
        w.admin.as.mutation(api.inboxWrites.takeDown, {
          itemId,
          status: 'hidden',
          reason: 'Fabricated',
        }),
      );
      return;
    }
    case 'undo': {
      // The real undo engine on a decision's audit row (`undo.run`): `reopen_flag`,
      // `reopen_request`, `return_to_review` — each reopens its sources and then its items through
      // `reopenItem`, so a missing call is caught here. The decider undoes it (a refusal — overtaken,
      // not undoable — changes nothing, and the invariants still hold).
      const target = await t.run(async (ctx) => {
        const decided = (await ctx.db.query('inboxItems').collect()).filter(
          (i) => i.status === 'decided' && i.decisionActionId !== undefined,
        );
        const item = pick(decided, e.i);
        return item?.decisionActionId
          ? { actionId: item.decisionActionId, by: item.decidedByUserId }
          : null;
      });
      if (!target) return;
      const who = [...w.mods, w.admin].find((p) => p.id === target.by) ?? w.admin;
      await attempt(() =>
        who.as.mutation(api.undo.run, { actionId: target.actionId, reason: 'Undone' }),
      );
      return;
    }
  }
}

// ── The invariants ─────────────────────────────────────────────────────────────────────────────

async function invariants(t: T, unfiled: ReadonlySet<string> = new Set()): Promise<string[]> {
  return t.run(async (ctx) => {
    const holes: string[] = [];
    const items = await ctx.db.query('inboxItems').collect();
    const members = await ctx.db.query('inboxItemMembers').collect();
    const byId = new Map(items.map((i) => [i._id as string, i]));
    const sources: InboxSource[] = [
      ...(await ctx.db.query('contentFlags').collect()).map((r) => flagSource(r._id)),
      ...(await ctx.db.query('waterBodyRequests').collect()).map((r) => requestSource(r._id)),
      ...(await ctx.db.query('waterBodies').collect()).map((r) => bodySource(r._id)),
      ...(await ctx.db.query('supportTickets').collect()).map((r) => ticketSource(r._id)),
    ];
    for (const source of sources) {
      const facts = await factsOf(ctx, source);
      const mine = members.filter(
        (m) => m.sourceTable === source.table && m.sourceId === source.id,
      );
      const at = `${source.table}:${source.id}`;
      if (facts === null) {
        if (mine.length > 0) holes.push(`${at}: a member for a source owed none`);
        continue;
      }
      // A raw source the backfill hasn't reached owes no member while it stays open.
      if (mine.length === 0 && facts.state === 'open' && unfiled.has(source.id)) continue;
      if (mine.length !== 1) {
        holes.push(`${at}: ${mine.length} members (${facts.state})`);
        continue;
      }
      const m = mine[0] as Doc<'inboxItemMembers'>;
      const item = byId.get(m.itemId);
      if (!item) {
        holes.push(`${at}: its item is gone`);
        continue;
      }
      if (facts.state === 'open') {
        if (m.status !== 'open' || item.status !== 'open')
          holes.push(`${at}: open source, ${m.status} member in a ${item.status} item`);
        if (!asksSameQuestion(item, facts)) holes.push(`${at}: in ${item.key}, asks ${facts.key}`);
        if (item.lane !== facts.lane) holes.push(`${at}: lane ${item.lane}, owes ${facts.lane}`);
      } else if (m.status !== 'closed') {
        holes.push(`${at}: decided source, open member`);
      }
    }
    // One question, one item — by the test's own rule for what a question is, written apart from the
    // writer's keys, so a writer that keys a question wrongly can't agree with itself.
    const itemsOfQuestion = new Map<string, Set<string>>();
    const askQuestion = (q: string, itemId: string) => {
      const set = itemsOfQuestion.get(q) ?? new Set<string>();
      set.add(itemId);
      itemsOfQuestion.set(q, set);
    };
    for (const f of await ctx.db.query('contentFlags').collect()) {
      if (f.status !== 'open' && f.status !== 'reviewing') continue;
      const m = members.find((x) => x.sourceTable === 'contentFlags' && x.sourceId === f._id);
      const lane =
        f.reason === 'unsafe_false_report'
          ? 'S'
          : f.reason === 'no_public_access' && f.targetType === 'waterbody'
            ? 'A'
            : 'C';
      if (m) askQuestion(`flag|${lane}|${f.targetType}|${f.targetId}`, m.itemId);
    }
    for (const r of await ctx.db.query('waterBodyRequests').collect()) {
      if (r.status !== 'open' || r.kind === 'name_landmark' || r.origin === 'seed') continue;
      const m = members.find((x) => x.sourceTable === 'waterBodyRequests' && x.sourceId === r._id);
      const q =
        r.kind === 'admit'
          ? `admit|${r.candidateExternalId ?? r._id}`
          : r.kind === 'name_bay'
            ? `bay|${r.waterBodyId}|${(r.name ?? '').toLowerCase()}`
            : `${r.kind}|${r.waterBodyId}`;
      if (m) askQuestion(q, m.itemId);
    }
    for (const [q, set] of itemsOfQuestion) {
      if (set.size > 1) holes.push(`${q}: one question in ${set.size} items`);
    }
    const openKeys = new Set<string>();
    const tally = new Map<string, number>();
    for (const item of items) {
      const mine = members.filter((m) => m.itemId === item._id);
      if (mine.length === 0) holes.push(`${item.key}: an item with no member`);
      if (item.status === 'open') {
        if (!mine.some((m) => m.status === 'open'))
          holes.push(`${item.key}: open with no open member`);
        if (openKeys.has(item.key)) holes.push(`${item.key}: two open items`);
        openKeys.add(item.key);
      } else {
        if (mine.some((m) => m.status === 'open'))
          holes.push(`${item.key}: decided with an open member`);
        if (
          item.decisionActionId &&
          !mine.some((m) => m.closedByActionId === item.decisionActionId)
        ) {
          holes.push(`${item.key}: its decision's audit row is on none of its members`);
        }
      }
      const d = await deriveItem(ctx, item);
      if (
        d.memberCount !== item.memberCount ||
        d.filedAt !== item.filedAt ||
        d.rankKey !== item.rankKey
      ) {
        holes.push(
          `${item.key}: stored ${item.memberCount}/${item.filedAt}/${item.rankKey}, derived ${d.memberCount}/${d.filedAt}/${d.rankKey}`,
        );
      }
      for (const k of countKeysOf(item)) tally.set(k, (tally.get(k) ?? 0) + 1);
    }
    for (const row of await ctx.db.query('inboxCounts').collect()) {
      if ((tally.get(row.key) ?? 0) !== row.count)
        holes.push(`count ${row.key}: ${row.count}, tally ${tally.get(row.key) ?? 0}`);
      tally.delete(row.key);
    }
    for (const [k, n] of tally) if (n !== 0) holes.push(`count ${k}: no row, tally ${n}`);
    for (const item of items) {
      const drift = await inboxDrift(ctx, item);
      if (drift.length > 0) holes.push(`${item.key}: the repair would fix ${drift.join(', ')}`);
    }
    return holes;
  });
}

/**
 * One random run of histories. The 44 runs are four tests of 11, each its own fresh draw, so none
 * holds a runner for long (a slower runner, under coverage, was timing whole suites out).
 */
async function histories(numRuns: number) {
  await fc.assert(
    fc.asyncProperty(fc.array(ev, { minLength: 10, maxLength: 40 }), async (events) => {
      const w = await world();
      for (const [n, e] of events.entries()) {
        await apply(w, e);
        const holes = await invariants(w.t, w.unfiled);
        if (holes.length > 0) {
          throw new Error(`after step ${n} (${JSON.stringify(e)}):\n${holes.join('\n')}`);
        }
      }
    }),
    { numRuns, endOnFailure: true },
  );
}

describe('the one writer, under random histories', () => {
  test.each(['first', 'second', 'third', 'fourth'])(
    'after every step, the stored items are what the source rows say (%s draw)',
    () => histories(11),
  );
});
