/**
 * **The rule and the write agree, cell by cell** (B01-5; D217, D268): for each Inbox verb, on each
 * kind and subject state — up, hidden, removed, withdrawn by its author, erased, retracted by its
 * author, already decided, the viewer's own content, the viewer's own filing — the item read's rule
 * (`lib/inboxRules.inboxVerbRefusal`, over the facts `inbox.item` reads) is asked, then the real write
 * is run, and the two must agree: allowed ↔ the write succeeds; refused ↔ the write refuses with the
 * same sentence. A lever is never drawn that its write refuses, and a refusal reads the same in both.
 *
 * (A seed-origin ask is never an item, so there is no rule to ask: D289's exemption is
 * `inboxOrigin.test.ts`'s.)
 */

import { ConvexError } from 'convex/values';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { InboxVerb } from './inbox';
import { inboxVerbRefusal } from './lib/inboxRules';
import { InboxReader, itemOfRef, itemView } from './lib/inboxViews';
import { ReadBudget } from './lib/readBudget';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
type As = ReturnType<T['withIdentity']>;
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

const square = (x: number): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [x - 0.5, -0.5],
      [x - 0.5, 0.5],
      [x + 0.5, 0.5],
      [x + 0.5, -0.5],
      [x - 0.5, -0.5],
    ],
  ],
});

type W = Awaited<ReturnType<typeof world>>;

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
        createdAt: NOW,
      }),
    );
    return { id, as: t.withIdentity({ subject }) };
  };
  // The viewer is an admin, so only the rules under test refuse (support and body.remove are admin's).
  const viewer = await person('viewer', 'admin');
  const other = await person('other', 'moderator');
  const author = await person('author', 'member');
  const filer = await person('filer', 'member');
  const lake = async (externalId: string, x: number) => {
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          source: 'osm',
          states: ['NH'],
          externalId,
          osmId: externalId,
          name: `Pond ${externalId}`,
          type: 'lakePond',
          polygon: square(x),
          bbox: { minLat: -0.5, minLng: x - 0.5, maxLat: 0.5, maxLng: x + 0.5 },
          centroid: { lat: 0, lng: x },
          surfaceAreaSqM: 1_000_000,
        },
      ],
    });
    const row = (await t.run((ctx) => ctx.db.query('waterBodies').collect())).find(
      (b) => b.externalId === externalId,
    );
    return row?._id as Id<'waterBodies'>;
  };
  const active = await lake('osm/A', 0);
  const dormant = await lake('osm/B', 3);
  await t.run((ctx) =>
    ctx.db.patch(dormant, { dormant: { since: NOW, reason: 'inactive' as const } }),
  );
  const report = (authorId: Id<'profiles'>, extra: Partial<Doc<'reports'>> = {}) =>
    t.run((ctx) =>
      ctx.db.insert('reports', {
        authorId,
        waterBodyId: active,
        point: { lat: 0, lng: 0 },
        skateEndTime: NOW - 3_600_000,
        reportTime: NOW,
        source: 'native',
        iceTypes: [],
        surfaceTags: [],
        photoIds: [],
        notes: 'Held fine',
        moderationStatus: 'visible',
        hazardIdsCreated: [],
        createdAt: NOW,
        updatedAt: NOW,
        ...extra,
      }),
    );
  return { t, viewer, other, author, filer, active, dormant, report };
}

/** What a cell sets up: the item's ref, and what each write needs. */
type Setup = {
  ref: string;
  targetId?: string;
  waterBodyId?: Id<'waterBodies'>;
  requestId?: Id<'waterBodyRequests'>;
  ticketId?: Id<'supportTickets'>;
};

async function itemIdOf(w: W, ref: string): Promise<Id<'inboxItems'>> {
  const item = await w.t.run((ctx) => itemOfRef(ctx, ref));
  if (!item) throw new Error(`no item for ${ref}`);
  return item._id;
}

/** The real write a verb is. */
async function write(w: W, verb: InboxVerb, s: Setup): Promise<void> {
  const as = w.viewer.as;
  const itemId = () => itemIdOf(w, s.ref);
  switch (verb) {
    case 'dismiss':
      await as.mutation(api.inboxWrites.dismissFlags, { itemId: await itemId() });
      return;
    case 'hide':
    case 'remove':
      await as.mutation(api.inboxWrites.takeDown, {
        itemId: await itemId(),
        status: verb === 'hide' ? 'hidden' : 'removed',
        reason: 'Checked',
      });
      return;
    case 'restore':
      await as.mutation(api.inboxWrites.restoreAndDismiss, { itemId: await itemId() });
      return;
    case 'pin':
    case 'unpin':
    case 'retract':
      await as.mutation(api.inboxWrites.alertVerdict, {
        itemId: await itemId(),
        verb,
        reason: 'Checked',
      });
      return;
    case 'ruleClosed':
    case 'ruleAccessible':
    case 'clearRuling':
      await as.mutation(api.inboxWrites.ruleAccess, {
        itemId: await itemId(),
        verdict: verb === 'ruleClosed' ? 'none' : verb === 'ruleAccessible' ? 'open' : null,
        reason: 'Checked',
      });
      return;
    case 'approve':
      await as.mutation(api.corpusRequests.approve, {
        requestId: s.requestId as Id<'waterBodyRequests'>,
      });
      return;
    case 'decline':
      await as.mutation(api.corpusRequests.decline, {
        requestId: s.requestId as Id<'waterBodyRequests'>,
        note: 'No',
      });
      return;
    case 'lookUpAgain':
      await as.mutation(api.corpusRequests.reresolve, {
        requestId: s.requestId as Id<'waterBodyRequests'>,
      });
      return;
    case 'approveDrawn':
      await as.mutation(api.waterBodies.approve, {
        waterBodyId: s.waterBodyId as Id<'waterBodies'>,
      });
      return;
    case 'rejectDrawn':
      await as.mutation(api.waterBodies.reject, {
        waterBodyId: s.waterBodyId as Id<'waterBodies'>,
      });
      return;
    case 'resolve':
      await as.mutation(api.support.resolve, { ticketId: s.ticketId as Id<'supportTickets'> });
      return;
    default:
      throw new Error(`no write for ${verb} yet`);
  }
}

/** The rule's answer for the viewer, over the facts the item read reads. */
async function rule(w: W, verb: InboxVerb, s: Setup): Promise<string | null> {
  return w.t.run(async (ctx) => {
    const item = await itemOfRef(ctx, s.ref);
    if (!item) throw new Error(`no item for ${s.ref}`);
    const viewer = (await ctx.db.get(w.viewer.id)) as Doc<'profiles'>;
    const r = new InboxReader(ctx, new ReadBudget(), Date.now(), viewer._id, true);
    const built = await itemView(r, item);
    return inboxVerbRefusal(ctx, viewer, item, verb, built?.facts ?? {});
  });
}

const sentence = (err: unknown) =>
  err instanceof ConvexError ? String(err.data) : `NOT A REFUSAL: ${(err as Error)?.message}`;

// ── The cells ──────────────────────────────────────────────────────────────────────────────────

type Cell = { kind: string; state: string; verbs: InboxVerb[]; setup: (w: W) => Promise<Setup> };

const flagOn = async (
  _w: W,
  by: As,
  targetType: Doc<'contentFlags'>['targetType'],
  targetId: string,
  reason: Doc<'contentFlags'>['reason'] = 'spam',
) => {
  const flagId = await by.mutation(api.contentFlags.flag, { targetType, targetId, reason });
  return { ref: `flag:${flagId}`, targetId };
};
const CONTENT_VERBS: InboxVerb[] = ['dismiss', 'hide', 'remove', 'restore'];
const takeDownBy = (
  w: W,
  targetType: 'report' | 'post' | 'comment' | 'hazard',
  targetId: string,
  status: 'hidden' | 'removed',
) =>
  w.other.as.mutation(api.moderation.setModerationStatus, {
    targetType,
    targetId,
    status,
    reason: 'Earlier',
  });

const reportCells: Cell[] = [
  {
    kind: 'report',
    state: 'up',
    verbs: CONTENT_VERBS,
    setup: async (w) => flagOn(w, w.filer.as, 'report', await w.report(w.author.id)),
  },
  {
    kind: 'report',
    state: 'hidden',
    verbs: CONTENT_VERBS,
    setup: async (w) => {
      const r = await w.report(w.author.id);
      const s = await flagOn(w, w.filer.as, 'report', r);
      await takeDownBy(w, 'report', r, 'hidden');
      return s;
    },
  },
  {
    kind: 'report',
    state: 'removed',
    verbs: CONTENT_VERBS,
    setup: async (w) => {
      const r = await w.report(w.author.id);
      const s = await flagOn(w, w.filer.as, 'report', r);
      await takeDownBy(w, 'report', r, 'removed');
      return s;
    },
  },
  {
    kind: 'report',
    state: 'withdrawn by its author',
    verbs: CONTENT_VERBS,
    setup: async (w) => {
      const r = await w.report(w.author.id);
      const s = await flagOn(w, w.filer.as, 'report', r);
      await w.author.as.mutation(api.reports.remove, { reportId: r });
      return s;
    },
  },
  {
    kind: 'report',
    state: 'hidden, then withdrawn by its author',
    verbs: CONTENT_VERBS,
    setup: async (w) => {
      const r = await w.report(w.author.id);
      const s = await flagOn(w, w.filer.as, 'report', r);
      await takeDownBy(w, 'report', r, 'hidden');
      await w.author.as.mutation(api.reports.remove, { reportId: r });
      return s;
    },
  },
  {
    kind: 'report',
    state: 'gone',
    verbs: CONTENT_VERBS,
    setup: async (w) => {
      const r = await w.report(w.author.id);
      const s = await flagOn(w, w.filer.as, 'report', r);
      await w.t.run((ctx) => ctx.db.delete(r));
      return s;
    },
  },
  {
    kind: 'report',
    state: 'already decided',
    verbs: CONTENT_VERBS,
    setup: async (w) => {
      const s = await flagOn(w, w.filer.as, 'report', await w.report(w.author.id));
      await w.other.as.mutation(api.inboxWrites.dismissFlags, { itemId: await itemIdOf(w, s.ref) });
      return s;
    },
  },
  {
    kind: 'report',
    state: 'the viewer’s own content',
    verbs: CONTENT_VERBS,
    setup: async (w) => flagOn(w, w.filer.as, 'report', await w.report(w.viewer.id)),
  },
  {
    kind: 'report',
    state: 'the viewer’s own filing',
    verbs: CONTENT_VERBS,
    setup: async (w) => flagOn(w, w.viewer.as, 'report', await w.report(w.author.id)),
  },
];

const comment = async (w: W, erased: boolean) => {
  const r = await w.report(w.author.id);
  const c = await w.t.run((ctx) =>
    ctx.db.insert('comments', {
      reportId: r,
      authorId: w.author.id,
      body: 'Rude',
      source: 'native',
      moderationStatus: 'visible',
      createdAt: NOW,
    }),
  );
  const s = await flagOn(w, w.filer.as, 'comment', c);
  if (erased) await w.t.run((ctx) => ctx.db.patch(c, { erasedAt: NOW, body: '' }));
  return s;
};
const post = async (w: W, hidden: boolean) => {
  const r = await w.report(w.author.id);
  const p = await w.t.run((ctx) =>
    ctx.db.insert('posts', {
      authorId: w.author.id,
      title: 'Today',
      reportIds: [r],
      photoIds: [],
      latestSkateEndTime: NOW,
      moderationStatus: 'visible',
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
  await w.t.run((ctx) => ctx.db.patch(r, { postId: p }));
  const s = await flagOn(w, w.filer.as, 'post', p);
  if (hidden) await takeDownBy(w, 'post', p, 'hidden');
  return s;
};
const hazard = async (w: W, hidden: boolean) => {
  const h = await w.t.run((ctx) =>
    ctx.db.insert('hazards', {
      waterBodyId: w.active,
      type: 'open_water',
      geometryKind: 'point_radius',
      geometry: { type: 'Point', coordinates: [0, 0] },
      bbox: { minLat: 0, minLng: 0, maxLat: 0, maxLng: 0 },
      createdByUserId: w.author.id,
      photoIds: [],
      status: 'active',
      moderationStatus: 'visible',
      firstReportedAt: NOW,
      lastConfirmedAt: NOW,
      confirmCount: 0,
      goneCount: 0,
      createdAt: NOW,
    }),
  );
  const s = await flagOn(w, w.filer.as, 'hazard', h);
  if (hidden) await takeDownBy(w, 'hazard', h, 'hidden');
  return s;
};
const otherContentCells: Cell[] = [
  { kind: 'comment', state: 'up', verbs: CONTENT_VERBS, setup: (w) => comment(w, false) },
  { kind: 'comment', state: 'erased', verbs: CONTENT_VERBS, setup: (w) => comment(w, true) },
  { kind: 'post', state: 'up', verbs: CONTENT_VERBS, setup: (w) => post(w, false) },
  { kind: 'post', state: 'hidden', verbs: CONTENT_VERBS, setup: (w) => post(w, true) },
  { kind: 'hazard', state: 'up', verbs: CONTENT_VERBS, setup: (w) => hazard(w, false) },
  { kind: 'hazard', state: 'hidden', verbs: CONTENT_VERBS, setup: (w) => hazard(w, true) },
];

const alert = async (w: W, by: Id<'profiles'>, extra: Partial<Doc<'accessAlerts'>> = {}) =>
  w.t.run(async (ctx) => {
    const putInId = await ctx.db.insert('putIns', {
      waterBodyId: w.active,
      coord: { lat: 0.1, lng: 0.1 },
      source: 'osm',
      status: 'visible',
      createdAt: NOW,
    });
    return ctx.db.insert('accessAlerts', {
      targetType: 'put_in',
      putInId,
      waterBodyId: w.active,
      reason: 'gate_locked',
      kind: 'blocker',
      createdByUserId: by,
      createdAt: NOW,
      season: 2026,
      status: 'active',
      confirmCount: 0,
      denyCount: 0,
      ...extra,
    });
  });
const ALERT_VERBS: InboxVerb[] = ['dismiss', 'pin', 'unpin', 'retract'];
const alertCells: Cell[] = [
  {
    kind: 'alert',
    state: 'up',
    verbs: ALERT_VERBS,
    setup: async (w) => flagOn(w, w.filer.as, 'accessAlert', await alert(w, w.author.id), 'other'),
  },
  {
    kind: 'alert',
    state: 'pinned',
    verbs: ALERT_VERBS,
    setup: async (w) => {
      const a = await alert(w, w.author.id);
      const s = await flagOn(w, w.filer.as, 'accessAlert', a, 'other');
      await w.other.as.mutation(api.accessAlerts.setOfficial, {
        accessAlertId: a,
        official: true,
        reason: 'Confirmed',
      });
      return s;
    },
  },
  {
    kind: 'alert',
    state: 'retracted by its author',
    verbs: ALERT_VERBS,
    setup: async (w) => {
      const a = await alert(w, w.author.id);
      const s = await flagOn(w, w.filer.as, 'accessAlert', a, 'other');
      await w.author.as.mutation(api.accessAlerts.retract, { accessAlertId: a });
      return s;
    },
  },
  {
    kind: 'alert',
    state: 'already decided',
    verbs: ALERT_VERBS,
    setup: async (w) => {
      const s = await flagOn(w, w.filer.as, 'accessAlert', await alert(w, w.author.id), 'other');
      await w.other.as.mutation(api.inboxWrites.dismissFlags, { itemId: await itemIdOf(w, s.ref) });
      return s;
    },
  },
  {
    kind: 'alert',
    state: 'the viewer’s own content',
    verbs: ALERT_VERBS,
    setup: async (w) => flagOn(w, w.filer.as, 'accessAlert', await alert(w, w.viewer.id), 'other'),
  },
  {
    kind: 'alert',
    state: 'the viewer’s own filing',
    verbs: ALERT_VERBS,
    setup: async (w) => flagOn(w, w.viewer.as, 'accessAlert', await alert(w, w.author.id), 'other'),
  },
];

const ACCESS_VERBS: InboxVerb[] = ['ruleClosed', 'ruleAccessible', 'clearRuling'];
const accessCells: Cell[] = [
  {
    kind: 'access',
    state: 'no ruling',
    verbs: ACCESS_VERBS,
    setup: async (w) => ({
      ...(await flagOn(w, w.filer.as, 'waterbody', w.active, 'no_public_access')),
      waterBodyId: w.active,
    }),
  },
  {
    kind: 'access',
    state: 'disputing an accessible ruling',
    verbs: ACCESS_VERBS,
    setup: async (w) => {
      await w.other.as.mutation(api.waterBodies.setPublicAccess, {
        waterBodyId: w.active,
        verdict: 'open',
      });
      const flagId = await w.filer.as.mutation(api.contentFlags.flag, {
        targetType: 'waterbody',
        targetId: w.active,
        reason: 'no_public_access',
        note: 'Gated now',
      });
      return { ref: `flag:${flagId}`, waterBodyId: w.active };
    },
  },
  {
    kind: 'access',
    state: 'already decided',
    verbs: ACCESS_VERBS,
    setup: async (w) => {
      const s = await flagOn(w, w.filer.as, 'waterbody', w.active, 'no_public_access');
      await w.other.as.mutation(api.waterBodies.setPublicAccess, {
        waterBodyId: w.active,
        verdict: 'none',
      });
      return { ...s, waterBodyId: w.active };
    },
  },
  {
    kind: 'access',
    state: 'the viewer’s own filing',
    verbs: ACCESS_VERBS,
    setup: async (w) => ({
      ...(await flagOn(w, w.viewer.as, 'waterbody', w.active, 'no_public_access')),
      waterBodyId: w.active,
    }),
  },
];

const ask = async (w: W, by: As, kind: 'activate' | 'admit' | 'name_bay') => {
  const requestId = await by.mutation(api.corpusRequests.create, {
    kind,
    coord:
      kind === 'admit' ? { lat: 30, lng: 30 } : { lat: 0.2, lng: kind === 'activate' ? 3.2 : 0.2 },
    ...(kind === 'admit' ? {} : { waterBodyId: kind === 'activate' ? w.dormant : w.active }),
    ...(kind === 'name_bay' ? { name: 'Shaker Cove' } : {}),
  });
  return { ref: `request:${requestId}`, requestId };
};
const requestCells: Cell[] = [
  {
    kind: 'request (activate)',
    state: 'open',
    verbs: ['approve', 'decline'],
    setup: (w) => ask(w, w.author.as, 'activate'),
  },
  {
    kind: 'request (activate)',
    state: 'already decided',
    verbs: ['approve', 'decline'],
    setup: async (w) => {
      const s = await ask(w, w.author.as, 'activate');
      await w.other.as.mutation(api.corpusRequests.decline, { requestId: s.requestId, note: 'No' });
      return s;
    },
  },
  {
    kind: 'request (activate)',
    state: 'the viewer’s own filing',
    verbs: ['approve', 'decline'],
    setup: (w) => ask(w, w.viewer.as, 'activate'),
  },
  {
    kind: 'request (admit, unmatched)',
    state: 'open',
    verbs: ['approve', 'lookUpAgain', 'decline'],
    setup: (w) => ask(w, w.author.as, 'admit'),
  },
  {
    kind: 'place (bay, not drawn)',
    state: 'open',
    verbs: ['approve', 'decline'],
    setup: (w) => ask(w, w.author.as, 'name_bay'),
  },
];

const drawn = async (_w: W, by: As, i: number) => {
  const T0 = Date.UTC(2026, 0, 15, 14 + i);
  const activityId = await by.mutation(api.gpsActivities.ingestTrack, {
    idempotencyKey: `track-${i}`,
    path: {
      type: 'LineString',
      coordinates: Array.from({ length: 20 }, (_, k) => [40 + k * 0.01, 40.5]),
    },
    startTime: T0,
    endTime: T0 + 45 * 60_000,
  });
  const waterBodyId = await by.mutation(api.waterBodies.create, {
    name: 'Drawn',
    type: 'lakePond',
    activityId,
    confirmedNew: true,
  });
  return { ref: `body:${waterBodyId}`, waterBodyId };
};
const DRAWN_VERBS: InboxVerb[] = ['approveDrawn', 'rejectDrawn'];
const drawnCells: Cell[] = [
  { kind: 'drawn', state: 'pending', verbs: DRAWN_VERBS, setup: (w) => drawn(w, w.author.as, 0) },
  {
    kind: 'drawn',
    state: 'already decided',
    verbs: DRAWN_VERBS,
    setup: async (w) => {
      const s = await drawn(w, w.author.as, 0);
      await w.other.as.mutation(api.waterBodies.reject, { waterBodyId: s.waterBodyId });
      return s;
    },
  },
  {
    kind: 'drawn',
    state: 'the viewer’s own filing',
    verbs: DRAWN_VERBS,
    setup: (w) => drawn(w, w.viewer.as, 0),
  },
];

const ticket = async (_w: W, by: As) => {
  const ticketId = await by.mutation(api.support.create, { category: 'bug', body: 'Broken' });
  return { ref: `ticket:${ticketId}`, ticketId };
};
const ticketCells: Cell[] = [
  { kind: 'ticket', state: 'open', verbs: ['resolve'], setup: (w) => ticket(w, w.author.as) },
  {
    kind: 'ticket',
    state: 'already decided',
    verbs: ['resolve'],
    setup: async (w) => {
      const s = await ticket(w, w.author.as);
      await w.t.run((ctx) => ctx.db.patch(w.other.id, { role: 'admin' }));
      await w.other.as.mutation(api.support.resolve, { ticketId: s.ticketId });
      return s;
    },
  },
  {
    kind: 'ticket',
    state: 'the viewer’s own filing',
    verbs: ['resolve'],
    setup: (w) => ticket(w, w.viewer.as),
  },
];

/**
 * A takedown, an unpin and a retraction close every open flag on the target, in every lane (D289): one
 * the viewer filed in another lane refuses them, while a dismissal — this item's flags only — stands.
 */
const crossLaneCells: Cell[] = [
  {
    kind: 'report',
    state: 'another lane’s open flag on this target is the viewer’s own',
    verbs: CONTENT_VERBS,
    setup: async (w) => {
      const r = await w.report(w.author.id);
      await flagOn(w, w.viewer.as, 'report', r, 'unsafe_false_report');
      return flagOn(w, w.filer.as, 'report', r, 'spam');
    },
  },
  {
    kind: 'alert',
    state: 'another lane’s open flag on this target is the viewer’s own',
    verbs: ALERT_VERBS,
    setup: async (w) => {
      const a = await alert(w, w.author.id);
      await flagOn(w, w.viewer.as, 'accessAlert', a, 'unsafe_false_report');
      return flagOn(w, w.filer.as, 'accessAlert', a, 'other');
    },
  },
];

/** A verb outside an item's choices is refused in plain words, never a write on the wrong thing. */
const choiceCells: Cell[] = [
  {
    kind: 'person',
    state: 'flagged',
    verbs: ['dismiss', 'hide', 'remove', 'restore', 'pin', 'unpin', 'retract'],
    setup: async (w) => flagOn(w, w.filer.as, 'user', w.author.id, 'harassment'),
  },
  {
    kind: 'report',
    state: 'up, with an alert’s verbs',
    verbs: ['pin', 'unpin', 'retract'],
    setup: async (w) => flagOn(w, w.filer.as, 'report', await w.report(w.author.id)),
  },
  {
    kind: 'alert',
    state: 'up, with content’s verbs',
    verbs: ['hide', 'remove', 'restore'],
    setup: async (w) => flagOn(w, w.filer.as, 'accessAlert', await alert(w, w.author.id), 'other'),
  },
];

const CELLS: Cell[] = [
  ...crossLaneCells,
  ...choiceCells,
  ...reportCells,
  ...otherContentCells,
  ...alertCells,
  ...accessCells,
  ...requestCells,
  ...drawnCells,
  ...ticketCells,
];

/** Every cell: the rule's answer and the write's outcome. */
async function runCells(): Promise<{ size: number; disagreements: string[] }> {
  const disagreements: string[] = [];
  let size = 0;
  for (const cell of CELLS) {
    for (const verb of cell.verbs) {
      size++;
      const w = await world();
      const s = await cell.setup(w);
      const said = await rule(w, verb, s);
      let did: string | null = null;
      try {
        await write(w, verb, s);
      } catch (err) {
        did = sentence(err);
      }
      if (said !== did) {
        disagreements.push(
          `${cell.kind} · ${cell.state} · ${verb}: rule ${JSON.stringify(said)}, write ${JSON.stringify(did)}`,
        );
      }
    }
  }
  return { size, disagreements };
}

/**
 * Disagreements whose fix is in a write outside this builder's files — each a seam request in the
 * report, with its file and line. Listed so the table passes until each lands, and failing once one
 * agrees and is still here, so the list only shrinks.
 */
const AWAITING_THE_WRITE: Record<string, string> = {};

describe('the rule and the write', () => {
  test('agree in every cell', async () => {
    const { size, disagreements } = await runCells();
    expect(size).toBe(137);
    const cellOf = (d: string) => d.slice(0, d.indexOf(':'));
    expect(disagreements.filter((d) => !(cellOf(d) in AWAITING_THE_WRITE))).toEqual([]);
    // A seam that landed comes off the list.
    expect(
      Object.keys(AWAITING_THE_WRITE).filter((c) => !disagreements.some((d) => cellOf(d) === c)),
    ).toEqual([]);
  }, 600_000);
});

// Shared with the moderator pass (`inboxRulesVsWritesModerator.test.ts`).
// biome-ignore lint/suspicious/noExportsInTest: the moderator pass runs these same cells, kept apart from builder S2's cells here.
export { CELLS, type Cell, itemIdOf, rule, type Setup, sentence, type W, world, write };
