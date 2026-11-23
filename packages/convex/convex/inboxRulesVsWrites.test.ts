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

import { requestNameKeyFor } from '@skating/core';
import { ConvexError } from 'convex/values';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { InboxVerb } from './inbox';
import { bodySource, fileMember, requestSource } from './lib/inboxItems';
import { inboxCanWithCodes, inboxVerbRefusal } from './lib/inboxRules';
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
  moderatorDecision: false,
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
  /** For `sameAs`: the landmark the moderator names — the item's lookalike, where it has one. */
  landmarkId?: Id<'bodyLandmarks'>;
};

/** The survivor a Drawn item's bar shows — its overlap's body — as the lever sends it (B01-5d). */
async function survivorShown(w: W, ref: string): Promise<Id<'waterBodies'>> {
  const read = await w.viewer.as.query(api.inbox.item, { ref });
  const item = read.item;
  if (item?.kind === 'drawn' && item.overlap) return item.overlap.body.waterBodyId;
  // No overlap: the bar draws no lever, and the rule refuses before any survivor is read.
  return w.active;
}

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
    case 'sameAs': {
      // *Same place*: `approve` with the landmark the dialog showed, as it showed it.
      const landmark = await w.t.run((ctx) => ctx.db.get(s.landmarkId as Id<'bodyLandmarks'>));
      if (!landmark) throw new Error('a sameAs cell names a landmark');
      await as.mutation(api.corpusRequests.approve, {
        requestId: s.requestId as Id<'waterBodyRequests'>,
        sameAs: { landmarkId: landmark._id, name: landmark.name, point: landmark.point },
      });
      return;
    }
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
    case 'mergeDrawn':
      await as.mutation(api.inboxWrites.mergeDrawn, {
        itemId: await itemId(),
        survivorId: await survivorShown(w, s.ref),
      });
      return;
    case 'resolve':
      await as.mutation(api.support.resolve, { ticketId: s.ticketId as Id<'supportTickets'> });
      return;
    case 'reopen':
      await as.mutation(api.support.reopen, { ticketId: s.ticketId as Id<'supportTickets'> });
      return;
    case 'note':
      await as.mutation(api.support.addNote, {
        ticketId: s.ticketId as Id<'supportTickets'>,
        body: 'Checked',
      });
      return;
    case 'reply':
      await as.mutation(api.support.reply, {
        ticketId: s.ticketId as Id<'supportTickets'>,
        body: 'Thanks',
      });
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

/** The refusal code the item's read serves for the viewer (`canCode`, B01-5d). */
async function codeOf(w: W, verb: InboxVerb, s: Setup): Promise<string | undefined> {
  return w.t.run(async (ctx) => {
    const item = await itemOfRef(ctx, s.ref);
    if (!item) throw new Error(`no item for ${s.ref}`);
    const viewer = (await ctx.db.get(w.viewer.id)) as Doc<'profiles'>;
    const r = new InboxReader(ctx, new ReadBudget(), Date.now(), viewer._id, true);
    const built = await itemView(r, item);
    return (await inboxCanWithCodes(ctx, viewer, item, built?.facts)).canCode[verb];
  });
}

/** A place ask's *Approve* refused because its bay or landmark isn't drawn yet — the write's words. */
const AWAITS_DRAWING = / yet — (draw|add) it in the lake editor first, then approve\.$/;

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

/** A photo on a report (B01-5e), with real blobs, flagged by the filer (or `by`). */
const photoFlag = async (w: W, uploader: Id<'profiles'>, by: As = w.filer.as) => {
  const r = await w.report(uploader);
  const p = await w.t.run(async (ctx) => {
    const id = await ctx.db.insert('photos', {
      moderationStatus: 'visible' as const,
      storageId: await ctx.storage.store(new Blob(['full'])),
      thumbStorageId: await ctx.storage.store(new Blob(['thumb'])),
      uploaderId: uploader,
      placeOnMap: false,
      reportId: r,
      createdAt: NOW,
    });
    await ctx.db.patch(r, { photoIds: [id] });
    return id;
  });
  return flagOn(w, by, 'photo', p);
};
const photoDownBy = (w: W, photoId: string, status: 'hidden' | 'removed') =>
  w.other.as.mutation(api.moderation.setModerationStatus, {
    targetType: 'photo',
    targetId: photoId,
    status,
    reason: 'Earlier',
  });
/** The photo's own cells (B01-5e, D222): its axis, its uploader's withdrawal, its tombstone. */
const photoCells: Cell[] = [
  { kind: 'photo', state: 'up', verbs: CONTENT_VERBS, setup: (w) => photoFlag(w, w.author.id) },
  {
    kind: 'photo',
    state: 'hidden',
    verbs: CONTENT_VERBS,
    setup: async (w) => {
      const s = await photoFlag(w, w.author.id);
      await photoDownBy(w, s.targetId, 'hidden');
      return s;
    },
  },
  {
    kind: 'photo',
    state: 'removed',
    verbs: CONTENT_VERBS,
    setup: async (w) => {
      const s = await photoFlag(w, w.author.id);
      await photoDownBy(w, s.targetId, 'removed');
      return s;
    },
  },
  {
    kind: 'photo',
    state: 'withdrawn by its uploader',
    verbs: CONTENT_VERBS,
    setup: async (w) => {
      const s = await photoFlag(w, w.author.id);
      await w.author.as.mutation(api.photos.remove, { photoId: s.targetId as Id<'photos'> });
      return s;
    },
  },
  {
    kind: 'photo',
    state: 'hidden, then withdrawn by its uploader',
    verbs: CONTENT_VERBS,
    setup: async (w) => {
      const s = await photoFlag(w, w.author.id);
      await photoDownBy(w, s.targetId, 'hidden');
      await w.author.as.mutation(api.photos.remove, { photoId: s.targetId as Id<'photos'> });
      return s;
    },
  },
  {
    kind: 'photo',
    state: 'purged',
    verbs: CONTENT_VERBS,
    setup: async (w) => {
      const s = await photoFlag(w, w.author.id);
      await photoDownBy(w, s.targetId, 'removed');
      await w.t.run((ctx) =>
        ctx.db.patch(s.targetId as Id<'photos'>, { purgedAt: NOW, purgeAt: undefined }),
      );
      return s;
    },
  },
  {
    kind: 'photo',
    state: 'already decided',
    verbs: CONTENT_VERBS,
    setup: async (w) => {
      const s = await photoFlag(w, w.author.id);
      await w.other.as.mutation(api.inboxWrites.dismissFlags, { itemId: await itemIdOf(w, s.ref) });
      return s;
    },
  },
  {
    kind: 'photo',
    state: 'the viewer’s own photo',
    verbs: CONTENT_VERBS,
    setup: (w) => photoFlag(w, w.viewer.id),
  },
  {
    kind: 'photo',
    state: 'the viewer’s own filing',
    verbs: CONTENT_VERBS,
    setup: (w) => photoFlag(w, w.author.id, w.viewer.as),
  },
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
  // *Look up again* asks the rule too (B01-5d): the viewer's own admit, and one decided.
  {
    kind: 'request (admit, unmatched)',
    state: 'the viewer’s own filing',
    verbs: ['approve', 'lookUpAgain', 'decline'],
    setup: (w) => ask(w, w.viewer.as, 'admit'),
  },
  {
    kind: 'request (admit, unmatched)',
    state: 'already decided',
    verbs: ['lookUpAgain'],
    setup: async (w) => {
      const s = await ask(w, w.author.as, 'admit');
      await w.other.as.mutation(api.corpusRequests.decline, {
        requestId: s.requestId as Id<'waterBodyRequests'>,
        note: 'No',
      });
      return s;
    },
  },
  {
    kind: 'place (bay, not drawn)',
    state: 'open',
    verbs: ['approve', 'decline'],
    setup: (w) => ask(w, w.author.as, 'name_bay'),
  },
  // Waiting on a drawing, but decided already: the earlier rule answers, and no code rides with it.
  {
    kind: 'place (bay, not drawn)',
    state: 'already decided',
    verbs: ['approve'],
    setup: async (w) => {
      const s = await ask(w, w.author.as, 'name_bay');
      await w.other.as.mutation(api.corpusRequests.decline, {
        requestId: s.requestId as Id<'waterBodyRequests'>,
        note: 'No',
      });
      return s;
    },
  },
  // Waiting on a drawing, but the viewer's own: the earlier rule answers, and no code rides with it.
  {
    kind: 'place (bay, not drawn)',
    state: 'the viewer’s own filing',
    verbs: ['approve'],
    setup: (w) => ask(w, w.viewer.as, 'name_bay'),
  },
  // An approval's bay closes the asks by every one of its names — past the ask's own item (PR #170).
  {
    kind: 'place (bay, drawn with an alias)',
    state: 'a sibling in another item is someone else’s',
    verbs: ['approve', 'decline'],
    setup: (w) => aliasedBay(w, w.other.as),
  },
  {
    kind: 'place (bay, drawn with an alias)',
    state: 'a sibling in another item is the viewer’s own',
    verbs: ['approve', 'decline'],
    setup: (w) => aliasedBay(w, w.viewer.as),
  },
];

/**
 * A landmark on `waterBodyId` named "Long Point": at the ask's own spot (it answers the ask), or far
 * across the lake (a lookalike — the same name at another place, which *Same place* answers).
 */
const longPoint = (w: W, waterBodyId: Id<'waterBodies'>, at: 'spot' | 'far') =>
  w.t.run((ctx) =>
    ctx.db.insert('bodyLandmarks', {
      waterBodyId,
      name: 'Long Point',
      kind: 'point',
      point:
        at === 'spot'
          ? { lat: 0.2, lng: waterBodyId === w.active ? 0.2 : 3.2 }
          : { lat: -0.3, lng: -0.3 },
      source: 'moderator',
      externalIds: [],
      aliases: [],
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );

/**
 * A "Long Point" landmark ask on the active lake, filed into the Inbox (a report files these, D202),
 * and the landmark `sameAs` names: a lookalike across the lake, or one standing at the ask's spot.
 */
async function landmarkAsk(
  w: W,
  by: Id<'profiles'>,
  landmark: 'lookalike' | 'answering',
): Promise<Setup> {
  const landmarkId = await longPoint(w, w.active, landmark === 'lookalike' ? 'far' : 'spot');
  const requestId = await w.t.run(async (ctx) => {
    const id = await ctx.db.insert('waterBodyRequests', {
      kind: 'name_landmark',
      status: 'open',
      requesterId: by,
      coord: { lat: 0.2, lng: 0.2 },
      waterBodyId: w.active,
      name: 'Long Point',
      nameKey: requestNameKeyFor('name_landmark', 'Long Point'),
      createdAt: NOW - 1000,
    });
    await fileMember(ctx, requestSource(id));
    return id;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  return { ref: `request:${requestId}`, requestId, landmarkId };
}

/**
 * A restore or takedown ask: an admin decides it both ways (`body.remove`, B01-5c ruled). As an admin
 * here; the moderator pass runs the same cells from a moderator's chair, where both verbs refuse.
 */
const adminAsk = async (w: W, by: As, kind: 'takedown' | 'restore'): Promise<Setup> => {
  if (kind === 'restore') {
    await w.t.run((ctx) =>
      ctx.db.patch(w.active, { removedAt: Date.now(), removalReason: 'landowner_request' }),
    );
    await w.t.mutation(internal.waterBodies.backfillCells, {});
  }
  const requestId = await by.mutation(api.corpusRequests.create, {
    kind,
    coord: { lat: 0.2, lng: 0.2 },
    waterBodyId: w.active,
  });
  return { ref: `request:${requestId}`, requestId };
};
const adminAskCells: Cell[] = (['takedown', 'restore'] as const).flatMap((kind) => [
  {
    kind: `request (${kind})`,
    state: 'open, decided by an admin',
    verbs: ['approve', 'decline'] as InboxVerb[],
    setup: (w: W) => adminAsk(w, w.author.as, kind),
  },
  {
    kind: `request (${kind})`,
    state: 'already decided',
    verbs: ['approve', 'decline'] as InboxVerb[],
    setup: async (w: W) => {
      const s = await adminAsk(w, w.author.as, kind);
      await w.t.run((ctx) => ctx.db.patch(w.other.id, { role: 'admin' }));
      await w.other.as.mutation(api.corpusRequests.decline, {
        requestId: s.requestId as Id<'waterBodyRequests'>,
        note: 'No',
      });
      return s;
    },
  },
  {
    kind: `request (${kind})`,
    state: 'the viewer’s own filing',
    verbs: ['approve', 'decline'] as InboxVerb[],
    setup: (w: W) => adminAsk(w, w.viewer.as, kind),
  },
]);

/** *Same place* on asks that aren't a landmark's lookalike: the rule says so, and so must the write. */
const sameAsCells: Cell[] = [
  {
    kind: 'place (landmark, a lookalike)',
    state: 'open',
    verbs: ['approve', 'sameAs', 'decline'],
    setup: (w) => landmarkAsk(w, w.author.id, 'lookalike'),
  },
  {
    kind: 'place (landmark, a lookalike)',
    state: 'already decided',
    verbs: ['sameAs'],
    setup: async (w) => {
      const s = await landmarkAsk(w, w.author.id, 'lookalike');
      await w.other.as.mutation(api.corpusRequests.decline, {
        requestId: s.requestId as Id<'waterBodyRequests'>,
        note: 'No',
      });
      return s;
    },
  },
  {
    kind: 'place (landmark, a lookalike)',
    state: 'the viewer’s own filing',
    verbs: ['approve', 'sameAs', 'decline'],
    setup: (w) => landmarkAsk(w, w.viewer.id, 'lookalike'),
  },
  {
    kind: 'place (landmark, answered at its spot)',
    state: 'open',
    verbs: ['approve', 'decline'],
    setup: (w) => landmarkAsk(w, w.author.id, 'answering'),
  },
  {
    kind: 'place (landmark, answered at its spot)',
    state: 'asked by Same place',
    verbs: ['sameAs'],
    setup: (w) => landmarkAsk(w, w.author.id, 'answering'),
  },
  {
    kind: 'place (bay, not drawn)',
    state: 'a landmark of its name on the lake',
    verbs: ['sameAs'],
    setup: async (w) => ({
      ...(await ask(w, w.author.as, 'name_bay')),
      landmarkId: await longPoint(w, w.active, 'far'),
    }),
  },
  {
    kind: 'request (activate)',
    state: 'a landmark on the lake',
    verbs: ['sameAs'],
    setup: async (w) => ({
      ...(await ask(w, w.author.as, 'activate')),
      landmarkId: await longPoint(w, w.dormant, 'spot'),
    }),
  },
];

/**
 * "Northwest Bay" drawn with the alias "NW Bay"; the author asks by its name and `sibling` by its
 * alias — another key, so another item, which the approval's drain closes too.
 */
async function aliasedBay(w: W, sibling: As): Promise<Setup> {
  await w.t.run((ctx) =>
    ctx.db.insert('waterBodySubAreas', {
      waterBodyId: w.active,
      name: 'Northwest Bay',
      aliases: ['NW Bay'],
      searchText: 'Northwest Bay NW Bay',
      polygon: square(0),
      bbox: { minLat: -0.5, minLng: -0.5, maxLat: 0.5, maxLng: 0.5 },
      centroid: { lat: 0, lng: 0 },
      surfaceAreaSqM: 40_000,
      displayScore: 1,
      minVisibleZoom: 10,
      createdByUserId: w.other.id,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
  const at = { coord: { lat: 0.2, lng: 0.2 }, waterBodyId: w.active, kind: 'name_bay' as const };
  const requestId = await w.author.as.mutation(api.corpusRequests.create, {
    ...at,
    name: 'Northwest Bay',
  });
  await sibling.mutation(api.corpusRequests.create, { ...at, name: 'NW Bay' });
  // A moment for the wall clock to pass the asks (a decision drains those that existed by its now).
  await new Promise((resolve) => setTimeout(resolve, 25));
  return { ref: `request:${requestId}`, requestId };
}

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

/**
 * A skater's drawing over known water (B01-5d): written as `waterBodies.create` leaves one whose
 * dedup scan matched — pending, the matches ranked in `duplicateCandidateIds` — and filed. (A track
 * over a known lake resolves to it, so `create` itself would refuse to draw one.) `candidates` are the
 * known bodies in rank order; the drawing lies inside the first lake's water.
 */
async function drawnOver(
  w: W,
  by: Id<'profiles'>,
  candidates: Id<'waterBodies'>[],
): Promise<Setup & { waterBodyId: Id<'waterBodies'> }> {
  const waterBodyId = await w.t.run(async (ctx) => {
    const id = await ctx.db.insert('waterBodies', {
      name: 'Drawn East Bay',
      searchText: 'Drawn East Bay',
      type: 'lakePond',
      source: 'user',
      reviewStatus: 'pending',
      dedupStatus: 'suspected_duplicate',
      duplicateCandidateIds: candidates,
      createdByUserId: by,
      polygon: {
        type: 'Polygon',
        coordinates: [
          [
            [-0.2, -0.2],
            [-0.2, 0.2],
            [0.2, 0.2],
            [0.2, -0.2],
            [-0.2, -0.2],
          ],
        ],
      },
      bbox: { minLat: -0.2, minLng: -0.2, maxLat: 0.2, maxLng: 0.2 },
      centroid: { lat: 0, lng: 0 },
      surfaceAreaSqM: 40_000,
      createdAt: NOW,
    } as never);
    await fileMember(ctx, bodySource(id as Id<'waterBodies'>));
    return id as Id<'waterBodies'>;
  });
  return { ref: `body:${waterBodyId}`, waterBodyId };
}
/** A second known lake over the same water — the drawing's other candidate. */
async function twinLake(w: W): Promise<Id<'waterBodies'>> {
  return w.t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Pond twin',
      searchText: 'Pond twin',
      type: 'lakePond',
      source: 'osm',
      dedupStatus: 'clean',
      polygon: square(0),
      bbox: { minLat: -0.5, minLng: -0.5, maxLat: 0.5, maxLng: 0.5 },
      centroid: { lat: 0, lng: 0 },
      surfaceAreaSqM: 1_000_000,
      createdAt: NOW,
    } as never),
  ) as Promise<Id<'waterBodies'>>;
}
const MERGE_VERBS: InboxVerb[] = ['approveDrawn', 'mergeDrawn', 'rejectDrawn'];

const drawnCells: Cell[] = [
  {
    kind: 'drawn',
    state: 'pending',
    verbs: [...DRAWN_VERBS, 'mergeDrawn'],
    setup: (w) => drawn(w, w.author.as, 0),
  },
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
  // Merge into a known body (B01-5d): the drawing's live survivor is the rule's fact and the write's.
  {
    kind: 'drawn (over a known body)',
    state: 'pending',
    verbs: MERGE_VERBS,
    setup: (w) => drawnOver(w, w.author.id, [w.active]),
  },
  {
    kind: 'drawn (over a known body)',
    state: 'already decided',
    verbs: ['mergeDrawn'],
    setup: async (w) => {
      const s = await drawnOver(w, w.author.id, [w.active]);
      await w.other.as.mutation(api.waterBodies.reject, { waterBodyId: s.waterBodyId });
      return s;
    },
  },
  {
    kind: 'drawn (over a known body)',
    state: 'the viewer’s own filing',
    verbs: ['mergeDrawn'],
    setup: (w) => drawnOver(w, w.viewer.id, [w.active]),
  },
  {
    kind: 'drawn (over a known body)',
    state: 'its first candidate merged away since',
    verbs: ['mergeDrawn'],
    setup: async (w) => {
      const twin = await twinLake(w);
      const s = await drawnOver(w, w.author.id, [twin, w.active]);
      await w.other.as.mutation(api.waterBodies.merge, { survivorId: w.active, loserId: twin });
      return s;
    },
  },
  {
    kind: 'drawn (over a known body)',
    state: 'its only candidate gone',
    verbs: ['mergeDrawn'],
    setup: async (w) => {
      const twin = await twinLake(w);
      const s = await drawnOver(w, w.author.id, [twin]);
      await w.t.run((ctx) => ctx.db.delete(twin));
      return s;
    },
  },
  // R10-A: a merge waits while an unmerge still runs on either body (`waterBodies.unmergeActionId`).
  {
    kind: 'drawn (over a known body)',
    state: 'an unmerge still running on its survivor',
    verbs: ['mergeDrawn'],
    setup: async (w) => {
      const s = await drawnOver(w, w.author.id, [w.active]);
      await w.t.run(async (ctx) => {
        const unmergeId = await ctx.db.insert('moderationActions', {
          actorId: w.other.id,
          action: 'unmerge_waterbody',
          targetType: 'waterbody',
          targetId: w.active,
          reason: 'Two lakes',
          metadata: { done: false },
          createdAt: NOW,
        });
        await ctx.db.patch(w.active, { unmergeActionId: unmergeId });
      });
      return s;
    },
  },
  {
    kind: 'drawn (over a known body)',
    state: 'the lists together pass a cap',
    verbs: ['mergeDrawn'],
    setup: async (w) => {
      const s = await drawnOver(w, w.author.id, [w.active]);
      const links = (n: number, tag: string) =>
        Array.from({ length: n }, (_, i) => ({
          label: `${tag} ${i}`,
          url: `https://example.org/${tag}/${i}`,
        }));
      await w.t.run(async (ctx) => {
        await ctx.db.patch(w.active, { referenceLinks: links(5, 'lake') });
        await ctx.db.patch(s.waterBodyId as Id<'waterBodies'>, {
          referenceLinks: links(5, 'drawn'),
        });
      });
      return s;
    },
  },
];

const ticket = async (_w: W, by: As) => {
  const ticketId = await by.mutation(api.support.create, { category: 'bug', body: 'Broken' });
  return { ref: `ticket:${ticketId}`, ticketId };
};
/** Every verb a ticket has (B01-5f): each answered in each state, drawn or not. */
const TICKET_VERBS: InboxVerb[] = ['reply', 'note', 'resolve', 'reopen'];
const ticketCells: Cell[] = [
  { kind: 'ticket', state: 'open', verbs: TICKET_VERBS, setup: (w) => ticket(w, w.author.as) },
  {
    kind: 'ticket',
    state: 'already decided',
    verbs: TICKET_VERBS,
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
    verbs: TICKET_VERBS,
    setup: (w) => ticket(w, w.viewer.as),
  },
  {
    kind: 'ticket',
    state: 'the viewer’s own filing, decided',
    verbs: TICKET_VERBS,
    setup: async (w) => {
      const s = await ticket(w, w.viewer.as);
      await w.t.run((ctx) => ctx.db.patch(w.other.id, { role: 'admin' }));
      await w.other.as.mutation(api.support.resolve, { ticketId: s.ticketId });
      return s;
    },
  },
  {
    kind: 'ticket',
    state: 'filed before its filer had a profile',
    verbs: TICKET_VERBS,
    setup: (w) => ticket(w, w.t.withIdentity({ subject: 'user_unprovisioned' })),
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

/** The table's groups, each its own test (so none holds a slow runner for long). */
const GROUPS: Record<string, Cell[]> = {
  'cross-lane': crossLaneCells,
  choice: choiceCells,
  report: reportCells,
  'other content': otherContentCells,
  photo: photoCells,
  alert: alertCells,
  access: accessCells,
  request: requestCells,
  'admin’s asks': adminAskCells,
  sameAs: sameAsCells,
  drawn: drawnCells,
  ticket: ticketCells,
};
const ALL_CELLS: Cell[] = Object.values(GROUPS).flat();

/** A group's cells: the rule's answer and the write's outcome. */
async function runCells(cells: Cell[]): Promise<{ size: number; disagreements: string[] }> {
  const disagreements: string[] = [];
  let size = 0;
  for (const cell of cells) {
    for (const verb of cell.verbs) {
      size++;
      const w = await world();
      const s = await cell.setup(w);
      const said = await rule(w, verb, s);
      const code = await codeOf(w, verb, s);
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
      // `awaitsDrawing` exactly where the write refuses an Approve for a drawing not made yet (B01-5d).
      const awaits = verb === 'approve' && did !== null && AWAITS_DRAWING.test(did);
      if ((code === 'awaitsDrawing') !== awaits) {
        disagreements.push(
          `${cell.kind} · ${cell.state} · ${verb}: canCode ${JSON.stringify(code)}, write ${JSON.stringify(did)}`,
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
  test('the table holds every cell', () => {
    // 141 through B01-5b; B01-5c added *Same place*'s ten and a restore's and a takedown's twelve.
    // B01-5d added *Merge into*'s nine — the overlap, the drawer, decided, a first candidate merged
    // away, a candidate gone, the lists' cap, the drawing over new water — and a bay ask awaiting
    // its drawing that is decided, or the viewer's own (its code must not ride an earlier refusal).
    // The order pass added *Look up again*'s own and decided cells, the viewer's own admit's approve
    // and decline, and the viewer's own landmark ask's approve and decline; R10-A a drawing whose
    // survivor is mid-unmerge. B01-5f gave a ticket all four of its verbs in each state (open,
    // decided, the viewer's own, the viewer's own decided, and filed before a profile existed): 3
    // cells became 20. B01-5e added a photo's nine states × its four verbs (198 → 234).
    expect(ALL_CELLS.reduce((n, c) => n + c.verbs.length, 0)).toBe(234);
  });

  test.each(Object.keys(GROUPS))('agree in every %s cell', async (group) => {
    const cells = GROUPS[group] as Cell[];
    const { size, disagreements } = await runCells(cells);
    expect(size).toBe(cells.reduce((n, c) => n + c.verbs.length, 0));
    const cellOf = (d: string) => d.slice(0, d.indexOf(':'));
    expect(disagreements.filter((d) => !(cellOf(d) in AWAITING_THE_WRITE))).toEqual([]);
    // A seam that landed comes off the list.
    const mine = Object.keys(AWAITING_THE_WRITE).filter((c) =>
      cells.some((cell) => c.startsWith(`${cell.kind} · ${cell.state}`)),
    );
    expect(mine.filter((c) => !disagreements.some((d) => cellOf(d) === c))).toEqual([]);
  });
});

describe('a decision asks who decides before it weighs its inputs (B01-5d)', () => {
  test('the viewer’s own ask declined with no note hears that it is theirs, not to say why', async () => {
    const w = await world();
    const s = await ask(w, w.viewer.as, 'activate');
    await expect(
      w.viewer.as.mutation(api.corpusRequests.decline, {
        requestId: s.requestId as Id<'waterBodyRequests'>,
        note: '  ',
      }),
    ).rejects.toThrow('You filed this, so another staff member decides it.');
  });
});

/**
 * The cells the moderator pass runs: every cell but one awaiting its write — that pass has no list of
 * its own, so a cell joins it once its write agrees and its entry above comes off.
 */
const CELLS: Cell[] = ALL_CELLS.filter(
  (c) => !c.verbs.some((verb) => `${c.kind} · ${c.state} · ${verb}` in AWAITING_THE_WRITE),
);

// Shared with the moderator pass (`inboxRulesVsWritesModerator.test.ts`).
// biome-ignore lint/suspicious/noExportsInTest: the moderator pass runs these same cells, kept apart from builder S2's cells here.
export { CELLS, type Cell, itemIdOf, rule, type Setup, sentence, type W, world, write };
