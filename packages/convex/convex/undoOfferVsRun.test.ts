/**
 * **An undo's offer and its write agree, viewer by viewer** (D217: an undo is never shown to someone
 * who couldn't run it). For every undo handler whose write can refuse on who is asking — own content
 * (D269), own filing (D289, a sibling's included), the drawer, a role, a body-side capability — each
 * case is acted through its real mutations, then for each kind of viewer the engine's offer
 * (`undoState`, the toast's scope) is read and the real `undo.run` is attempted in a fresh world: the
 * offer says `available` exactly when the write succeeds.
 */

import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  DECISION_FLAGS_MAX,
  FLAG_REOPEN_COST,
  REOPEN_FACT_READS,
  REOPEN_HEADROOM,
} from './lib/inboxFlags';
import {
  CLOSER_RESERVE,
  fileMember,
  flagSource,
  MAX_MEMBERS,
  MEMBER_BOUND,
  refreshCost,
  requestSource,
} from './lib/inboxItems';
import { REQUEST_PROFILE_BUDGET, ROW_MAX, TX_CALLS, TX_DOCS } from './lib/readBudget';
import { WORST_ASK_COST } from './lib/requestDecisions';
import { undoState } from './lib/undo';
import { undoHandlers } from './lib/undoHandlers';
import { REOPEN_ASK_COST, REOPEN_RESERVE } from './lib/undoHandlersCorpus';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
type As = ReturnType<T['withIdentity']>;

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

const POLYGON = {
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
};

type Viewer =
  | 'actor'
  | 'colleague'
  | 'filer'
  | 'siblingFiler'
  | 'subject'
  | 'drawer'
  | 'moderatorWithoutCapability'
  | 'admin';
type P = { id: Id<'profiles'>; as: As };

async function world() {
  const t = harness();
  const person = async (subject: string, role: 'member' | 'moderator' | 'admin') => {
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
  };
  // Everyone on staff, so only the rule under test refuses.
  const p = {
    actor: await person('actor', 'moderator'),
    colleague: await person('colleague', 'moderator'),
    filer: await person('filer', 'moderator'),
    siblingFiler: await person('sibling', 'moderator'),
    subject: await person('subject', 'moderator'),
    drawer: await person('drawer', 'moderator'),
    moderatorWithoutCapability: await person('plainmod', 'moderator'),
    admin: await person('admin', 'admin'),
    skater: await person('skater', 'member'),
  };
  const lake = await t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Lake Morey',
      searchText: 'Lake Morey',
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: POLYGON,
      bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      centroid: { lat: 0.5, lng: 0.5 },
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  );
  await t.mutation(internal.waterBodies.backfillCells, {});
  const report = (authorId: Id<'profiles'>) =>
    t.run((ctx) =>
      ctx.db.insert('reports', {
        authorId,
        waterBodyId: lake,
        point: { lat: 0.5, lng: 0.5 },
        skateEndTime: Date.now(),
        reportTime: Date.now(),
        source: 'native' as const,
        iceTypes: [],
        surfaceTags: [],
        photoIds: [],
        moderationStatus: 'visible' as const,
        hazardIdsCreated: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
  const itemOfFlag = (flagId: Id<'contentFlags'>) =>
    t.run(async (ctx) => {
      const m = await ctx.db
        .query('inboxItemMembers')
        .withIndex('by_source', (q) => q.eq('sourceTable', 'contentFlags').eq('sourceId', flagId))
        .first();
      return m?.itemId as Id<'inboxItems'>;
    });
  const newest = (action: Doc<'moderationActions'>['action']) =>
    t.run(async (ctx) => {
      const rows = (await ctx.db.query('moderationActions').order('desc').collect()).filter(
        (r) => r.action === action,
      );
      return rows[0]?._id as Id<'moderationActions'>;
    });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
  return { t, p, lake, report, itemOfFlag, newest, tick };
}
type W = Awaited<ReturnType<typeof world>>;

/** A case: the row whose undo is offered, and the viewer kinds it has. */
type Case = {
  name: string;
  viewers: Viewer[];
  setup: (w: W) => Promise<Id<'moderationActions'>>;
};

const flagReport = async (
  _w: W,
  by: P,
  reportId: Id<'reports'>,
  reason: Doc<'contentFlags'>['reason'] = 'spam',
) => by.as.mutation(api.contentFlags.flag, { targetType: 'report', targetId: reportId, reason });

const ALL: Viewer[] = [
  'actor',
  'colleague',
  'filer',
  'siblingFiler',
  'subject',
  'drawer',
  'moderatorWithoutCapability',
  'admin',
];

const CASES: Case[] = [
  {
    name: 'hide (an Inbox takedown) → restore',
    viewers: ALL,
    setup: async (w) => {
      const r = await w.report(w.p.subject.id);
      const f = await flagReport(w, w.p.filer, r);
      const out = await w.p.actor.as.mutation(api.inboxWrites.takeDown, {
        itemId: await w.itemOfFlag(f),
        status: 'hidden',
        reason: 'Abusive',
      });
      return out.actionId;
    },
  },
  {
    name: 'dismiss_flag → reopen_flag',
    viewers: ALL,
    setup: async (w) => {
      const r = await w.report(w.p.subject.id);
      const f = await flagReport(w, w.p.skater, r);
      await flagReport(w, w.p.filer, r, 'harassment');
      const out = await w.p.actor.as.mutation(api.inboxWrites.dismissFlags, {
        itemId: await w.itemOfFlag(f),
      });
      return out.actionId;
    },
  },
  {
    name: 'reopen_flag → dismissed again (a non-lead flag filed by the viewer; the reproduction A)',
    viewers: ALL,
    setup: async (w) => {
      const r = await w.report(w.p.subject.id);
      const f = await flagReport(w, w.p.skater, r);
      await flagReport(w, w.p.filer, r, 'harassment');
      const out = await w.p.colleague.as.mutation(api.inboxWrites.dismissFlags, {
        itemId: await w.itemOfFlag(f),
      });
      await w.p.admin.as.mutation(api.undo.run, { actionId: out.actionId });
      return w.t.run(async (ctx) => {
        const rows = await ctx.db.query('moderationActions').collect();
        return rows.find((x) => x.action === 'reopen_flag' && x.metadata?.reopened)
          ?._id as Id<'moderationActions'>;
      });
    },
  },
  {
    name: 'reopen_flag → dismissed again (a flag joined the item after the reopen; finding 2)',
    viewers: ALL,
    setup: async (w) => {
      const r = await w.report(w.p.subject.id);
      const f = await flagReport(w, w.p.skater, r);
      const out = await w.p.actor.as.mutation(api.inboxWrites.dismissFlags, {
        itemId: await w.itemOfFlag(f),
      });
      await w.p.actor.as.mutation(api.undo.run, { actionId: out.actionId });
      await flagReport(w, w.p.siblingFiler, r, 'harassment');
      return w.newest('reopen_flag');
    },
  },
  {
    name: 'reopen_flag → dismissed again (a reopened flag decided again since)',
    viewers: ALL,
    setup: async (w) => {
      const r = await w.report(w.p.subject.id);
      const f = await flagReport(w, w.p.skater, r);
      const g = await flagReport(w, w.p.filer, r, 'harassment');
      const out = await w.p.colleague.as.mutation(api.inboxWrites.dismissFlags, {
        itemId: await w.itemOfFlag(f),
      });
      await w.p.admin.as.mutation(api.undo.run, { actionId: out.actionId });
      const reopen = await w.t.run(async (ctx) => {
        const rows = await ctx.db.query('moderationActions').collect();
        return rows.find((x) => x.action === 'reopen_flag' && x.metadata?.reopened)
          ?._id as Id<'moderationActions'>;
      });
      // The other one decided again on its own since (not the row's own flag, which would overtake
      // the row): nothing to close it from.
      await w.p.admin.as.mutation(api.moderation.resolveFlag, {
        flagId: g,
        resolution: 'dismissed',
        reason: 'Checked again',
      });
      return reopen;
    },
  },
  {
    name: 'approve_request (a takedown) → reopen_request, the body restored (body.remove)',
    viewers: ALL,
    setup: async (w) => {
      const ask = {
        kind: 'takedown' as const,
        coord: { lat: 0.5, lng: 0.5 },
        waterBodyId: w.lake,
        note: 'Mine',
      };
      const first = await w.p.skater.as.mutation(api.corpusRequests.create, ask);
      await w.p.siblingFiler.as.mutation(api.corpusRequests.create, ask);
      await w.tick();
      await w.p.admin.as.mutation(api.corpusRequests.approve, { requestId: first });
      return w.newest('approve_request').then(async () =>
        w.t.run(async (ctx) => {
          const rows = await ctx.db.query('moderationActions').collect();
          return rows.find((x) => x.action === 'approve_request' && x.targetId === first)
            ?._id as Id<'moderationActions'>;
        }),
      );
    },
  },
  {
    name: 'decline_request → reopen_request (a sibling filed by the viewer)',
    viewers: ALL,
    setup: async (w) => {
      await w.t.run((ctx) =>
        ctx.db.patch(w.lake, { dormant: { since: Date.now(), reason: 'inactive' as const } }),
      );
      const ask = { kind: 'activate' as const, coord: { lat: 0.5, lng: 0.5 }, waterBodyId: w.lake };
      const first = await w.p.skater.as.mutation(api.corpusRequests.create, ask);
      await w.p.siblingFiler.as.mutation(api.corpusRequests.create, ask);
      await w.tick();
      await w.p.actor.as.mutation(api.corpusRequests.decline, {
        requestId: first as Id<'waterBodyRequests'>,
        note: 'No',
      });
      return w.t.run(async (ctx) => {
        const rows = await ctx.db.query('moderationActions').collect();
        return rows.find((x) => x.action === 'decline_request' && x.targetId === first)
          ?._id as Id<'moderationActions'>;
      });
    },
  },
  {
    // PR #170: the approval's bay closed an ask by its alias — another key, another item.
    name: 'approve_request (a bay whose alias closed the viewer’s ask in another item) → reopen_request',
    viewers: ALL,
    setup: async (w) => {
      await w.t.run((ctx) =>
        ctx.db.insert('waterBodySubAreas', {
          waterBodyId: w.lake,
          name: 'Northwest Bay',
          aliases: ['NW Bay'],
          searchText: 'Northwest Bay NW Bay',
          polygon: POLYGON,
          bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
          centroid: { lat: 0.5, lng: 0.5 },
          surfaceAreaSqM: 40_000,
          displayScore: 1,
          minVisibleZoom: 10,
          createdByUserId: w.p.admin.id,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
      const at = { kind: 'name_bay' as const, coord: { lat: 0.5, lng: 0.5 }, waterBodyId: w.lake };
      const first = await w.p.skater.as.mutation(api.corpusRequests.create, {
        ...at,
        name: 'Northwest Bay',
      });
      await w.p.siblingFiler.as.mutation(api.corpusRequests.create, { ...at, name: 'NW Bay' });
      await new Promise((resolve) => setTimeout(resolve, 25));
      await w.p.actor.as.mutation(api.corpusRequests.approve, { requestId: first });
      return w.t.run(async (ctx) => {
        const rows = await ctx.db.query('moderationActions').collect();
        return rows.find((x) => x.action === 'approve_request' && x.targetId === first)
          ?._id as Id<'moderationActions'>;
      });
    },
  },
  {
    name: 'reopen_request → declined again (the reproduction D)',
    viewers: ALL,
    setup: async (w) => {
      await w.t.run((ctx) =>
        ctx.db.patch(w.lake, { dormant: { since: Date.now(), reason: 'inactive' as const } }),
      );
      const ask = { kind: 'activate' as const, coord: { lat: 0.5, lng: 0.5 }, waterBodyId: w.lake };
      const first = await w.p.skater.as.mutation(api.corpusRequests.create, ask);
      await w.p.siblingFiler.as.mutation(api.corpusRequests.create, ask);
      await w.tick();
      await w.p.colleague.as.mutation(api.corpusRequests.decline, {
        requestId: first as Id<'waterBodyRequests'>,
        note: 'No',
      });
      const decline = await w.t.run(async (ctx) => {
        const rows = await ctx.db.query('moderationActions').collect();
        return rows.find((x) => x.action === 'decline_request' && x.targetId === first)
          ?._id as Id<'moderationActions'>;
      });
      await w.p.admin.as.mutation(api.undo.run, { actionId: decline });
      return w.newest('reopen_request');
    },
  },
  {
    name: 'approve_waterbody → return_to_review',
    viewers: ALL,
    setup: async (w) => {
      const id = await drawnBy(w, w.p.drawer.id);
      await w.p.actor.as.mutation(api.waterBodies.approve, { waterBodyId: id });
      return w.newest('approve_waterbody');
    },
  },
  {
    // B01-5c: un-deciding is deciding — reopening a takedown's decline is an admin's, as the decline was.
    name: 'decline_request (a takedown, which only body.remove decides) → reopen_request',
    viewers: ALL,
    setup: async (w) => {
      const first = await w.p.skater.as.mutation(api.corpusRequests.create, {
        kind: 'takedown' as const,
        coord: { lat: 0.5, lng: 0.5 },
        waterBodyId: w.lake,
        note: 'Mine',
      });
      await w.tick();
      const out = await w.p.admin.as.mutation(api.corpusRequests.decline, {
        requestId: first,
        note: 'Not yours',
      });
      return out.actionId;
    },
  },
  {
    // B01-5c: an admin decides a takedown both ways, so declining it again is an admin's too.
    name: 'reopen_request → declined again (a takedown, which only body.remove declines)',
    viewers: ALL,
    setup: async (w) => {
      const ask = {
        kind: 'takedown' as const,
        coord: { lat: 0.5, lng: 0.5 },
        waterBodyId: w.lake,
        note: 'Mine',
      };
      const first = await w.p.skater.as.mutation(api.corpusRequests.create, ask);
      await w.tick();
      const out = await w.p.admin.as.mutation(api.corpusRequests.decline, {
        requestId: first,
        note: 'Not yours',
      });
      await w.p.admin.as.mutation(api.undo.run, { actionId: out.actionId });
      return w.newest('reopen_request');
    },
  },
  // B01-5c: each decision write answers its own row; the table holds that row's offer to its run.
  {
    name: 'approve_request (the row its answer names) → reopen_request',
    viewers: ALL,
    setup: async (w) => (await ANSWERS.approveRequest(w)).actionId,
  },
  {
    name: 'decline_request (the row its answer names; a sibling by the viewer) → reopen_request',
    viewers: ALL,
    setup: async (w) => (await ANSWERS.declineRequest(w)).actionId,
  },
  {
    name: 'approve_waterbody (the row its answer names) → return_to_review',
    viewers: ALL,
    setup: async (w) => (await ANSWERS.approveDrawn(w)).actionId,
  },
  {
    name: 'reject_waterbody (the row its answer names) → return_to_review',
    viewers: ALL,
    setup: async (w) => (await ANSWERS.rejectDrawn(w)).actionId,
  },
  {
    name: 'return_to_review → reviewed again (the reproduction C)',
    viewers: ALL,
    setup: async (w) => {
      const id = await drawnBy(w, w.p.drawer.id);
      await w.p.colleague.as.mutation(api.waterBodies.reject, { waterBodyId: id, reason: 'Field' });
      await w.p.admin.as.mutation(api.undo.run, { actionId: await w.newest('reject_waterbody') });
      return w.newest('return_to_review');
    },
  },
  {
    name: 'pin_access_alert → released',
    viewers: ALL,
    setup: async (w) => {
      const alertId = await alertBy(w, w.p.subject.id);
      await w.p.actor.as.mutation(api.accessAlerts.setOfficial, {
        accessAlertId: alertId,
        official: true,
        reason: 'Town said so',
      });
      return w.newest('pin_access_alert');
    },
  },
  {
    name: 'pin_access_alert (from the Inbox: its flags dismissed) → released, the flags reopened',
    viewers: ALL,
    setup: async (w) => {
      const alertId = await alertBy(w, w.p.subject.id);
      await w.p.filer.as.mutation(api.contentFlags.flag, {
        targetType: 'accessAlert',
        targetId: alertId,
        reason: 'unsafe_false_report',
      });
      const f = await w.p.skater.as.mutation(api.contentFlags.flag, {
        targetType: 'accessAlert',
        targetId: alertId,
        reason: 'other',
      });
      const out = await w.p.actor.as.mutation(api.inboxWrites.alertVerdict, {
        itemId: await w.itemOfFlag(f),
        verb: 'pin',
        reason: 'Town confirmed',
      });
      return out.actionId;
    },
  },
  {
    name: 'retract_access_alert → put back',
    viewers: ALL,
    setup: async (w) => {
      const alertId = await alertBy(w, w.p.subject.id);
      await w.p.actor.as.mutation(api.accessAlerts.retract, {
        accessAlertId: alertId,
        reason: 'Wrong lot',
      });
      return w.newest('retract_access_alert');
    },
  },
  {
    name: 'set_public_access (from the Inbox) → ruled back',
    viewers: ALL,
    setup: async (w) => {
      const f = await w.p.filer.as.mutation(api.contentFlags.flag, {
        targetType: 'waterbody',
        targetId: w.lake,
        reason: 'no_public_access',
      });
      await w.p.skater.as.mutation(api.contentFlags.flag, {
        targetType: 'waterbody',
        targetId: w.lake,
        reason: 'no_public_access',
      });
      const out = await w.p.actor.as
        .mutation(api.inboxWrites.ruleAccess, {
          itemId: await w.itemOfFlag(f),
          verdict: 'open',
        })
        .catch(async () =>
          // The filer is staff and filed one of the reports: rule from the Body console instead.
          w.p.actor.as.mutation(api.waterBodies.setPublicAccess, {
            waterBodyId: w.lake,
            verdict: 'open',
          }),
        );
      void out;
      return w.newest('set_public_access');
    },
  },
  {
    name: 'grant_role → revoked (the subject is the person promoted)',
    viewers: ALL,
    setup: async (w) => {
      await w.t.run((ctx) => ctx.db.patch(w.p.subject.id, { role: 'member' }));
      await w.p.admin.as.mutation(api.admin.grantRole, {
        userId: w.p.subject.id,
        role: 'moderator',
        reason: 'Trusted',
      });
      return w.newest('grant_role');
    },
  },
];

async function drawnBy(w: W, drawer: Id<'profiles'>) {
  return w.t.run(async (ctx) => {
    const id = await ctx.db.insert('waterBodies', {
      name: 'Back Forty',
      searchText: 'Back Forty',
      type: 'lakePond' as const,
      source: 'user' as const,
      reviewStatus: 'pending' as const,
      createdByUserId: drawer,
      polygon: POLYGON,
      bbox: { minLat: 2, minLng: 2, maxLat: 3, maxLng: 3 },
      centroid: { lat: 2.5, lng: 2.5 },
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    });
    const { fileMember, bodySource } = await import('./lib/inboxItems');
    await fileMember(ctx, bodySource(id));
    return id;
  });
}

async function alertBy(w: W, author: Id<'profiles'>) {
  return w.t.run(async (ctx) => {
    const putInId = await ctx.db.insert('putIns', {
      waterBodyId: w.lake,
      coord: { lat: 0.5, lng: 0.001 },
      source: 'osm' as const,
      status: 'visible' as const,
      createdAt: Date.now(),
    });
    return ctx.db.insert('accessAlerts', {
      targetType: 'put_in',
      putInId,
      waterBodyId: w.lake,
      reason: 'gate_locked',
      kind: 'blocker',
      createdByUserId: author,
      createdAt: Date.now(),
      season: 2026,
      status: 'active',
      expiresAt: Date.now() + 86_400_000,
      confirmCount: 0,
      denyCount: 0,
    });
  });
}

/**
 * The four decisions that answer their own row (B01-5c), each by the actor — their answers read here
 * by the table's cases and by the test below that holds each answer to the engine's offer.
 */
const ANSWERS = {
  approveRequest: async (w: W) => {
    await w.t.run((ctx) =>
      ctx.db.patch(w.lake, { dormant: { since: Date.now(), reason: 'inactive' as const } }),
    );
    const ask = { kind: 'activate' as const, coord: { lat: 0.5, lng: 0.5 }, waterBodyId: w.lake };
    const first = await w.p.skater.as.mutation(api.corpusRequests.create, ask);
    await w.p.siblingFiler.as.mutation(api.corpusRequests.create, ask);
    await w.tick();
    return w.p.actor.as.mutation(api.corpusRequests.approve, { requestId: first });
  },
  declineRequest: async (w: W) => {
    await w.t.run((ctx) =>
      ctx.db.patch(w.lake, { dormant: { since: Date.now(), reason: 'inactive' as const } }),
    );
    const ask = { kind: 'activate' as const, coord: { lat: 0.5, lng: 0.5 }, waterBodyId: w.lake };
    const first = await w.p.skater.as.mutation(api.corpusRequests.create, ask);
    await w.p.siblingFiler.as.mutation(api.corpusRequests.create, ask);
    await w.tick();
    return w.p.actor.as.mutation(api.corpusRequests.decline, { requestId: first, note: 'No' });
  },
  approveDrawn: async (w: W) =>
    w.p.actor.as.mutation(api.waterBodies.approve, {
      waterBodyId: await drawnBy(w, w.p.drawer.id),
    }),
  rejectDrawn: async (w: W) =>
    w.p.actor.as.mutation(api.waterBodies.reject, {
      waterBodyId: await drawnBy(w, w.p.drawer.id),
      reason: 'A puddle',
    }),
} satisfies Record<
  string,
  (w: W) => Promise<{ actionId: Id<'moderationActions'>; itemId: Id<'inboxItems'> | null }>
>;

/** Every case × viewer: the offer and the write. */
async function runTable() {
  const disagreements: string[] = [];
  const cells: string[] = [];
  for (const c of CASES) {
    for (const v of c.viewers) {
      const w = await world();
      const actionId = await c.setup(w);
      if (!actionId) throw new Error(`no row for ${c.name}`);
      const viewer = w.p[v];
      const offer = await w.t.run(async (ctx) => {
        const profile = (await ctx.db.get(viewer.id)) as Doc<'profiles'>;
        const row = (await ctx.db.get(actionId)) as Doc<'moderationActions'>;
        return undoState(ctx, profile, row, 'one');
      });
      let ran: string | null = null;
      try {
        await viewer.as.mutation(api.undo.run, { actionId, reason: 'Checked' });
      } catch (err) {
        ran = (err as { data?: unknown }).data
          ? String((err as { data: unknown }).data)
          : String(err);
      }
      const offered = offer.state === 'available';
      cells.push(`${c.name} · ${v}`);
      if (offered !== (ran === null)) {
        disagreements.push(
          `${c.name} · ${v}: offer ${JSON.stringify(offer)}, run ${ran === null ? 'succeeded' : JSON.stringify(ran)}`,
        );
      }
    }
  }
  return { size: cells.length, disagreements };
}

describe('an undo’s offer and its write agree for every viewer (D217)', () => {
  test('every case, every viewer kind', async () => {
    const { size, disagreements } = await runTable();
    expect(size).toBe(CASES.length * ALL.length);
    expect(disagreements).toEqual([]);
  }, 600_000);
});

describe('a decision answers its own row and the offer its undo makes (B01-5c)', () => {
  test.each(Object.keys(ANSWERS) as (keyof typeof ANSWERS)[])('%s', async (name) => {
    const w = await world();
    const out = await ANSWERS[name](w);
    const row = await w.t.run((ctx) => ctx.db.get(out.actionId));
    // Its own row: the decision's, by the actor — the primary ask's, or the drawing's review.
    expect(row).toMatchObject({
      actorId: w.p.actor.id,
      action: {
        approveRequest: 'approve_request',
        declineRequest: 'decline_request',
        approveDrawn: 'approve_waterbody',
        rejectDrawn: 'reject_waterbody',
      }[name],
    });
    // The item it decided: the one its source's member names.
    const member = await w.t.run((ctx) =>
      ctx.db
        .query('inboxItemMembers')
        .withIndex('by_source', (q) =>
          q
            .eq(
              'sourceTable',
              row?.targetType === 'waterbody' ? 'waterBodies' : 'waterBodyRequests',
            )
            .eq('sourceId', row?.targetId as string),
        )
        .first(),
    );
    expect(out.itemId).toBe(member?.itemId);
    expect(out.itemId).not.toBeNull();
    // The engine's offer for the actor, as the toast's scope reads it — and its run agrees.
    const offer = await w.t.run(async (ctx) =>
      undoState(
        ctx,
        (await ctx.db.get(w.p.actor.id)) as Doc<'profiles'>,
        row as Doc<'moderationActions'>,
        'one',
      ),
    );
    expect(out).toMatchObject(
      offer.state === 'available'
        ? { undoable: true, undoNeedsReason: offer.needsReason }
        : { undoable: false },
    );
    expect(out.undoable).toBe(true);
    await w.p.actor.as.mutation(api.undo.run, { actionId: out.actionId, reason: 'Checked' });
  });

  test('a drain writes its siblings’ rows after the primary’s: the answer names the primary’s', async () => {
    const w = await world();
    const out = await ANSWERS.declineRequest(w);
    const rows = await w.t.run(async (ctx) =>
      (await ctx.db.query('moderationActions').order('desc').collect()).filter(
        (r) => r.action === 'decline_request',
      ),
    );
    // "The latest action" is the sibling's row, which its undo refuses ("undo that one").
    expect(rows).toHaveLength(2);
    expect(rows[0]?._id).not.toBe(out.actionId);
    expect(rows[0]?.metadata?.withRequestId).toBeDefined();
    expect(rows[1]?._id).toBe(out.actionId);
    expect(rows[1]?.metadata?.withRequestId).toBeUndefined();
  });
});

// ── Groups of every size the wave supports ─────────────────────────────────────────────────────

/**
 * The member bound in force for these cases — the seam (`MEMBER_BOUND`), with the real bound held by
 * arithmetic below — so a group "at the bound" is built quickly.
 */
const BOUND = 60;
const SIZES = [1, 11, 50, BOUND] as const;

/** `n` people of no role, raw, to file a group's members. */
async function crowd(w: W, n: number): Promise<Id<'profiles'>[]> {
  return w.t.run(async (ctx) => {
    const ids: Id<'profiles'>[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(
        await ctx.db.insert('profiles', {
          clerkUserId: `crowd${i}`,
          displayName: `crowd${i} Test-Person`,
          username: `crowd${i}`,
          driveTimePrefMinutes: 60,
          profileVisibility: 'public' as const,
          notificationPrefs: PREFS,
          dateOfBirth: Date.UTC(1990, 0, 1),
          reputationPoints: 0,
          role: 'member' as const,
          status: 'active' as const,
          createdAt: Date.now(),
        }),
      );
    }
    return ids;
  });
}

/** A group of `n` asks for one dormant body's activation: the skater's first, the sibling filer's last. */
async function askGroup(w: W, n: number): Promise<Id<'waterBodyRequests'>[]> {
  await w.t.run((ctx) =>
    ctx.db.patch(w.lake, { dormant: { since: Date.now(), reason: 'inactive' as const } }),
  );
  const people = [w.p.skater.id, ...(await crowd(w, Math.max(0, n - 2)))];
  if (n > 1) people.push(w.p.siblingFiler.id);
  const ids = await w.t.run(async (ctx) => {
    const out: Id<'waterBodyRequests'>[] = [];
    for (const [i, requesterId] of people.entries()) {
      const id = await ctx.db.insert('waterBodyRequests', {
        kind: 'activate',
        status: 'open',
        requesterId,
        coord: { lat: 0.5, lng: 0.5 },
        waterBodyId: w.lake,
        createdAt: Date.now() - 10_000 + i,
      });
      await fileMember(ctx, requestSource(id));
      out.push(id);
    }
    return out;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  return ids;
}

/** A group of `n` flags on one report: the skater's first, the sibling filer's last. */
async function flagGroup(w: W, n: number) {
  const reportId = await w.report(w.p.subject.id);
  const people = [w.p.skater.id, ...(await crowd(w, Math.max(0, n - 2)))];
  if (n > 1) people.push(w.p.siblingFiler.id);
  const flags = await w.t.run(async (ctx) => {
    const out: Id<'contentFlags'>[] = [];
    for (const [i, flaggerId] of people.entries()) {
      const id = await ctx.db.insert('contentFlags', {
        flaggerId,
        targetType: 'report',
        targetId: reportId,
        reason: 'spam',
        status: 'open',
        origin: 'user',
        subjectUserId: w.p.subject.id,
        createdAt: Date.now() - 10_000 + i,
      });
      await fileMember(ctx, flagSource(id));
      out.push(id);
    }
    return out;
  });
  return { reportId, flags };
}

type GroupCase = {
  name: string;
  setup: (w: W, n: number) => Promise<Id<'moderationActions'>>;
  /**
   * What the staffer who filed one of the group gets: refused, by offer and write alike — or, for a
   * takedown's undo, offered: it reopens the others and leaves theirs closed, named on its row.
   */
  sibling: 'refused' | 'offered';
};

/** The decision row a primary request's decline wrote (its siblings' rows undo with it). */
const declineOf = (w: W, requestId: Id<'waterBodyRequests'> | undefined) =>
  w.t.run(async (ctx) => {
    const rows = await ctx.db.query('moderationActions').collect();
    return rows.find((x) => x.action === 'decline_request' && x.targetId === requestId)
      ?._id as Id<'moderationActions'>;
  });

const GROUP_CASES: GroupCase[] = [
  {
    name: 'decline_request → reopen_request',
    setup: async (w, n) => {
      const [first] = await askGroup(w, n);
      await w.p.actor.as.mutation(api.corpusRequests.decline, {
        requestId: first as Id<'waterBodyRequests'>,
        note: 'No',
      });
      return declineOf(w, first);
    },
    sibling: 'refused',
  },
  {
    name: 'reopen_request → declined again',
    setup: async (w, n) => {
      const [first] = await askGroup(w, n);
      await w.p.actor.as.mutation(api.corpusRequests.decline, {
        requestId: first as Id<'waterBodyRequests'>,
        note: 'No',
      });
      await w.p.actor.as.mutation(api.undo.run, { actionId: await declineOf(w, first) });
      return w.newest('reopen_request');
    },
    sibling: 'refused',
  },
  {
    name: 'dismiss_flag → reopen_flag',
    setup: async (w, n) => {
      const { flags } = await flagGroup(w, n);
      const out = await w.p.actor.as.mutation(api.inboxWrites.dismissFlags, {
        itemId: await w.itemOfFlag(flags[0] as Id<'contentFlags'>),
      });
      return out.actionId;
    },
    sibling: 'refused',
  },
  {
    name: 'reopen_flag → dismissed again',
    setup: async (w, n) => {
      const { flags } = await flagGroup(w, n);
      const out = await w.p.actor.as.mutation(api.inboxWrites.dismissFlags, {
        itemId: await w.itemOfFlag(flags[0] as Id<'contentFlags'>),
      });
      await w.p.actor.as.mutation(api.undo.run, { actionId: out.actionId });
      return w.t.run(async (ctx) => {
        const rows = await ctx.db.query('moderationActions').collect();
        return rows.find((x) => x.action === 'reopen_flag' && x.metadata?.reopened)
          ?._id as Id<'moderationActions'>;
      });
    },
    sibling: 'refused',
  },
  {
    name: 'hide (an Inbox takedown) → restore, every flag reopened',
    setup: async (w, n) => {
      const { flags } = await flagGroup(w, n);
      const out = await w.p.actor.as.mutation(api.inboxWrites.takeDown, {
        itemId: await w.itemOfFlag(flags[0] as Id<'contentFlags'>),
        status: 'hidden',
        reason: 'Checked',
      });
      return out.actionId;
    },
    sibling: 'offered',
  },
];

/** The offer a viewer is shown for `actionId`, and what running it does. */
async function offerAndRun(w: W, viewer: P, actionId: Id<'moderationActions'>) {
  const offer = await w.t.run(async (ctx) => {
    const profile = (await ctx.db.get(viewer.id)) as Doc<'profiles'>;
    const row = (await ctx.db.get(actionId)) as Doc<'moderationActions'>;
    return undoState(ctx, profile, row, 'one');
  });
  let ran: string | null = null;
  try {
    await viewer.as.mutation(api.undo.run, { actionId, reason: 'Checked' });
  } catch (err) {
    ran = (err as { data?: unknown }).data ? String((err as { data: unknown }).data) : String(err);
  }
  return { offer, ran };
}

describe('a group’s undo is offered and runs at every size the wave supports', () => {
  test.each(GROUP_CASES.flatMap((c) => SIZES.map((n) => [c.name, n] as const)))(
    '%s, a group of %i',
    async (name, n) => {
      const c = GROUP_CASES.find((x) => x.name === name) as GroupCase;
      MEMBER_BOUND.members = BOUND;
      try {
        // A colleague who filed none of it: offered, and it runs.
        const w = await world();
        const actionId = await c.setup(w, n);
        const colleague = await offerAndRun(w, w.p.colleague, actionId);
        expect(colleague.offer.state, JSON.stringify(colleague)).toBe('available');
        expect(colleague.ran).toBeNull();
        // The staffer who filed one of the group (any group past one): refused, by offer and write alike.
        if (n > 1) {
          const w2 = await world();
          const again = await c.setup(w2, n);
          const sib = await offerAndRun(w2, w2.p.siblingFiler, again);
          expect(sib.offer.state === 'available', JSON.stringify(sib)).toBe(
            c.sibling === 'offered',
          );
          expect(sib.ran === null).toBe(c.sibling === 'offered');
        }
      } finally {
        MEMBER_BOUND.members = MAX_MEMBERS;
      }
    },
  );
});

describe('the reservations hold at the real bound', () => {
  const row = (action: string, metadata: Record<string, unknown>) =>
    ({ action, targetId: 'primary', metadata }) as unknown as Doc<'moderationActions'>;
  const sized = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  const handlers = undoHandlers();

  test.each([1, 11, 50, MAX_MEMBERS + 1])(
    'every group undo’s offer and refusal check, for a group of %i, fit a request’s opening budget',
    (n) => {
      const checks: [string, Doc<'moderationActions'>][] = [
        [
          'reopen_request',
          row('reopen_request', { reopened: sized('r', n), prev: { status: 'declined' } }),
        ],
        [
          'reopen_flag',
          row('reopen_flag', { reopened: sized('f', n), prev: { status: 'dismissed' } }),
        ],
        ['decline_request', row('decline_request', { kind: 'activate' })],
        ['dismiss_flag', row('dismiss_flag', {})],
        ['hide', row('hide', { priorStatus: 'visible' })],
        ['set_public_access', row('set_public_access', { prev: { publicAccess: null } })],
        ['pin_access_alert', row('pin_access_alert', {})],
      ];
      for (const [action, r] of checks) {
        const handler = handlers[action as keyof typeof handlers];
        if (!handler) throw new Error(`no handler for ${action}`);
        const cost = handler.refusal
          ? (handler.refusalCost?.('one', r) ?? { bytes: ROW_MAX.waterBody, reads: 1 })
          : null;
        if (cost === null) continue;
        // The smaller of the budgets an offer can be checked from: a request's opening one.
        expect(cost.bytes, action).toBeLessThanOrEqual(REQUEST_PROFILE_BUDGET);
        expect(cost.reads, action).toBeLessThanOrEqual(TX_CALLS);
        expect(cost.docs ?? cost.reads, action).toBeLessThanOrEqual(TX_DOCS);
      }
    },
  );

  test('every group undo’s run advances at the real bound: one source at its worst fits a fresh transaction', () => {
    const LIMIT = 16 * 1024 * 1024;
    const refresh = refreshCost(MAX_MEMBERS);
    // A decision's undo, a page of asks: one ask read whole three times and written back.
    expect(REOPEN_ASK_COST.bytesRead + refresh.bytesRead + REOPEN_RESERVE).toBeLessThanOrEqual(
      LIMIT,
    );
    expect(REOPEN_ASK_COST.bytesWritten + REOPEN_RESERVE).toBeLessThanOrEqual(LIMIT);
    // A re-decline, a page of the asks a reopen reopened.
    const ask = WORST_ASK_COST();
    expect(ask.bytesRead + refresh.bytesRead + CLOSER_RESERVE.bytesRead).toBeLessThanOrEqual(LIMIT);
    expect(ask.bytesWritten + CLOSER_RESERVE.bytesWritten).toBeLessThanOrEqual(LIMIT);
    // A flag decision's undo (a dismissal's, a takedown's, a ruling's, a pin's): the gather (every
    // member the decision stamped, at most `DECISION_FLAGS_MAX`), then one flag at least — its exact
    // reopen facts (each row at its longest note), its patch, its row, its member.
    const gathered = (DECISION_FLAGS_MAX + 1) * ROW_MAX.inboxMember;
    expect(FLAG_REOPEN_COST.databaseQueries).toBeGreaterThan(REOPEN_FACT_READS);
    expect(
      gathered + FLAG_REOPEN_COST.bytesRead + refresh.bytesRead + REOPEN_HEADROOM,
    ).toBeLessThanOrEqual(LIMIT);
    expect(FLAG_REOPEN_COST.bytesWritten + REOPEN_HEADROOM).toBeLessThanOrEqual(LIMIT);
  });
});
