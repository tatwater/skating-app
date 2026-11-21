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
import { undoState } from './lib/undo';
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
      await w.p.actor.as.mutation(api.corpusRequests.decline, { requestId: first, note: 'No' });
      return w.t.run(async (ctx) => {
        const rows = await ctx.db.query('moderationActions').collect();
        return rows.find((x) => x.action === 'decline_request' && x.targetId === first)
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
      await w.p.colleague.as.mutation(api.corpusRequests.decline, { requestId: first, note: 'No' });
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
