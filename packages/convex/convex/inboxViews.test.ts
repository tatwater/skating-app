/**
 * What the Inbox shows a moderator of each subject (B01-5, `lib/inboxViews`), through the reads that
 * serve it — `inbox.item` by each ref form and each flag subject, and `listPage`'s row labels —
 * including content that is hidden, removed, withdrawn by its author or erased, and a subject whose
 * row is gone; and a hidden or removed text kept from a viewer without `content.read`.
 */

import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { InboxItemView } from './inbox';
import { fileMember } from './lib/inboxItems';
import { InboxReader, itemView, rowLabel } from './lib/inboxViews';
import { ReadBudget } from './lib/readBudget';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
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

const square: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-0.5, -0.5],
      [-0.5, 0.5],
      [0.5, 0.5],
      [0.5, -0.5],
      [-0.5, -0.5],
    ],
  ],
};

async function world() {
  const t = harness();
  const person = async (subject: string, role: 'member' | 'moderator' = 'member') => {
    const id = await t.run((ctx) =>
      ctx.db.insert('profiles', {
        clerkUserId: subject,
        displayName: `${subject} Test-Person`,
        username: subject,
        driveTimePrefMinutes: 60,
        profileVisibility: 'public' as const,
        notificationPrefs: PREFS,
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 40,
        role,
        status: 'active' as const,
        createdAt: NOW,
      }),
    );
    return { id, as: t.withIdentity({ subject }) };
  };
  const mod = await person('mod', 'moderator');
  const author = await person('author');
  const filer = await person('filer');
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        states: ['NH'],
        externalId: 'osm/A',
        osmId: 'osm/A',
        name: 'Mascoma Lake',
        type: 'lakePond',
        polygon: square,
        bbox: { minLat: -0.5, minLng: -0.5, maxLat: 0.5, maxLng: 0.5 },
        centroid: { lat: 0, lng: 0 },
        surfaceAreaSqM: 1_000_000,
      },
    ],
  });
  const lake = (await t.run((ctx) => ctx.db.query('waterBodies').first()))
    ?._id as Id<'waterBodies'>;
  const report = (extra: Partial<Doc<'reports'>> = {}) =>
    t.run((ctx) =>
      ctx.db.insert('reports', {
        authorId: author.id,
        waterBodyId: lake,
        point: { lat: 0.1, lng: 0.1 },
        place: { town: 'Enfield', state: 'NH' },
        skateEndTime: NOW - 3_600_000,
        reportTime: NOW,
        source: 'native',
        iceTypes: [],
        surfaceTags: [],
        photoIds: [],
        notes: 'Black ice, held fine',
        moderationStatus: 'visible',
        hazardIdsCreated: [],
        createdAt: NOW,
        updatedAt: NOW,
        ...extra,
      }),
    );
  /** File a flag on a target as the filer and read its item as the moderator. */
  const flagOn = async (
    targetType: Doc<'contentFlags'>['targetType'],
    targetId: string,
    reason: Doc<'contentFlags'>['reason'] = 'spam',
  ) => {
    const flagId = await filer.as.mutation(api.contentFlags.flag, { targetType, targetId, reason });
    return {
      flagId,
      read: async () => (await mod.as.query(api.inbox.item, { ref: `flag:${flagId}` })).item,
    };
  };
  return { t, mod, author, filer, lake, report, flagOn };
}

/** The flag item's target, asserting it exists. */
function targetOf(item: InboxItemView | null | undefined) {
  if (item?.kind !== 'flag' || item.target.exists !== true)
    throw new Error('expected a flag on a standing target');
  return item.target;
}

describe('a flag on a report', () => {
  test('visible, hidden, removed, withdrawn by its author, and gone', async () => {
    const w = await world();
    const visible = await w.report();
    const v = targetOf(await (await w.flagOn('report', visible)).read());
    if (v.targetType !== 'report') throw new Error('report');
    expect(v).toMatchObject({
      summary: 'Black ice, held fine',
      moderationStatus: 'visible',
      withdrawnAt: null,
      withdrawal: null,
    });
    expect(v.report).toMatchObject({
      place: 'Enfield, NH',
      notes: 'Black ice, held fine',
      corroborations: { count: 0, capped: false },
    });

    const hidden = await w.report({ moderationStatus: 'hidden' });
    const h = await (await w.flagOn('report', hidden)).read();
    expect(targetOf(h)).toMatchObject({
      moderationStatus: 'hidden',
      summary: 'Black ice, held fine',
    });
    // Content already down: the handler offers Restore, not Hide or Remove.
    expect(Object.keys(h?.can ?? {})).toEqual(['dismiss', 'restore']);

    const removed = await w.report({ moderationStatus: 'removed' });
    expect(targetOf(await (await w.flagOn('report', removed)).read()).moderationStatus).toBe(
      'removed',
    );

    // Withdrawn by its author: not up, though its status still says visible.
    const withdrawn = await w.report({ authorDeletedAt: NOW - 1000 });
    const deleted = targetOf(await (await w.flagOn('report', withdrawn)).read());
    expect([deleted.withdrawnAt, deleted.withdrawal]).toEqual([NOW - 1000, 'deleted']);

    // Gone: the flag stands, its subject reads as not there.
    const gone = await w.report();
    const { read } = await w.flagOn('report', gone);
    await w.t.run((ctx) => ctx.db.delete(gone));
    const item = await read();
    expect(item?.kind === 'flag' && item.target.exists).toBe(false);
    const rows = await w.mod.as.query(api.inbox.listPage, { lane: 'contentFlags', pageSize: 10 });
    const labels = rows.rows.map((r) =>
      r.kind === 'flag' ? [r.target.exists, r.target.withdrawn, r.target.summary] : null,
    );
    expect(labels).toContainEqual([false, false, '(deleted)']);
    expect(labels).toContainEqual([true, true, 'Black ice, held fine']);
  });

  test('a report other skaters’ reports corroborated counts them', async () => {
    const w = await world();
    const r = await w.report();
    await w.t.run(async (ctx) => {
      for (let i = 0; i < 2; i++) {
        await ctx.db.insert('pointEvents', {
          userId: w.author.id,
          delta: 1,
          reason: 'report_corroborated',
          refId: r,
          createdAt: NOW,
        });
      }
      await ctx.db.insert('pointEvents', {
        userId: w.author.id,
        delta: 1,
        reason: 'helpful_thumb',
        refId: r,
        createdAt: NOW,
      } as never);
    });
    const t = targetOf(await (await w.flagOn('report', r)).read());
    if (t.targetType !== 'report') throw new Error('report');
    expect(t.report.corroborations).toEqual({ count: 2, capped: false });
  });
});

describe('each other subject', () => {
  test('a Post and its reports; a comment and the report it hangs on, erased', async () => {
    const w = await world();
    const r = await w.report();
    const post = await w.t.run((ctx) =>
      ctx.db.insert('posts', {
        authorId: w.author.id,
        title: 'North end today',
        body: 'Long write-up',
        reportIds: [r],
        photoIds: [],
        latestSkateEndTime: NOW,
        moderationStatus: 'visible',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    const p = targetOf(await (await w.flagOn('post', post)).read());
    if (p.targetType !== 'post') throw new Error('post');
    expect(p.summary).toBe('North end today');
    expect(p.post).toMatchObject({ title: 'North end today', body: 'Long write-up' });
    expect(p.post.reports.map((x) => x.reportId)).toEqual([r]);

    const comment = await w.t.run((ctx) =>
      ctx.db.insert('comments', {
        reportId: r,
        authorId: w.author.id,
        body: 'You were on 2 inches',
        source: 'native',
        moderationStatus: 'visible',
        createdAt: NOW,
      }),
    );
    const flagged = await w.flagOn('comment', comment);
    // Erased after it was flagged (an erased comment can't be flagged anew).
    await w.t.run((ctx) => ctx.db.patch(comment, { erasedAt: NOW - 5 }));
    const c = targetOf(await flagged.read());
    if (c.targetType !== 'comment') throw new Error('comment');
    expect(c.comment).toMatchObject({
      body: 'You were on 2 inches',
      on: { reportId: r, head: 'Black ice, held fine' },
    });
    expect(c.withdrawnAt).toBe(NOW - 5);
    expect(c.withdrawal).toBe('erased');
  });

  test('a hazard with its votes; a photo with its staff URLs; a body; a person', async () => {
    const w = await world();
    const hazard = await w.t.run(async (ctx) => {
      const id = await ctx.db.insert('hazards', {
        waterBodyId: w.lake,
        type: 'open_water',
        geometryKind: 'point_radius',
        geometry: { type: 'Point', coordinates: [0.2, 0.3] },
        bbox: { minLat: 0.3, minLng: 0.2, maxLat: 0.3, maxLng: 0.2 },
        createdByUserId: w.author.id,
        photoIds: [],
        status: 'active',
        moderationStatus: 'visible',
        description: 'Hole by the launch',
        firstReportedAt: NOW,
        lastConfirmedAt: NOW,
        confirmCount: 1,
        goneCount: 1,
        createdAt: NOW,
      });
      // Every verdict, each a different count, so a fold of two into one side shows (PR #170).
      const cast = {
        still_there: 1,
        healing_unsafe: 2,
        fully_healed: 3,
        never_existed: 4,
      } as const;
      for (const [verdict, n] of Object.entries(cast)) {
        for (let i = 0; i < n; i++) {
          await ctx.db.insert('hazardConfirmations', {
            hazardId: id,
            userId: w.filer.id,
            verdict: verdict as keyof typeof cast,
            via: 'report_flow',
            createdAt: NOW,
          });
        }
      }
      return id;
    });
    const h = targetOf(await (await w.flagOn('hazard', hazard)).read());
    if (h.targetType !== 'hazard') throw new Error('hazard');
    expect(h.summary).toBe('Hazard: open_water');
    expect(h.hazard).toMatchObject({
      note: 'Hole by the launch',
      point: { lat: 0.3, lng: 0.2 },
      votes: { still_there: 1, healing_unsafe: 2, fully_healed: 3, never_existed: 4 },
      votesCapped: false,
    });
    // Past the 200 it reads, each count is a floor, and says so.
    await w.t.run(async (ctx) => {
      for (let i = 0; i < 191; i++) {
        await ctx.db.insert('hazardConfirmations', {
          hazardId: hazard,
          userId: w.filer.id,
          verdict: 'still_there',
          via: 'report_flow',
          createdAt: NOW,
        });
      }
    });
    const many = targetOf(await (await w.flagOn('hazard', hazard)).read());
    if (many.targetType !== 'hazard') throw new Error('hazard');
    expect(many.hazard.votesCapped).toBe(true);
    expect(Object.values(many.hazard.votes).reduce((a, b) => a + b, 0)).toBe(200);

    const r = await w.report();
    const photo = await w.t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(['full']));
      const thumbStorageId = await ctx.storage.store(new Blob(['thumb']));
      const id = await ctx.db.insert('photos', {
        moderationStatus: 'visible' as const,
        storageId,
        thumbStorageId,
        uploaderId: w.author.id,
        caption: 'The crack',
        placeOnMap: false,
        reportId: r,
        createdAt: NOW,
      });
      await ctx.db.patch(r, { photoIds: [id] });
      return id;
    });
    const ph = await (await w.flagOn('photo', photo, 'inappropriate')).read();
    const pt = targetOf(ph);
    if (pt.targetType !== 'photo') throw new Error('photo');
    expect(pt.photo).toMatchObject({ caption: 'The crack', reportId: r, indexOnReport: 0 });
    expect(pt.photo.thumbUrl).toEqual(expect.any(String));
    // A photo has its moderation axis (B01-5e): a takedown is offered by the record's rule.
    expect(ph?.can.hide).toBeNull();
    expect(pt.photo).toMatchObject({ moderationStatus: 'visible', canReveal: true });

    const bodyFlag = await w.flagOn('waterbody', w.lake);
    const b = targetOf(await bodyFlag.read());
    expect(b).toMatchObject({ targetType: 'waterbody', summary: 'Mascoma Lake' });
    const bmap = (await w.mod.as.query(api.inbox.itemMap, { ref: `flag:${bodyFlag.flagId}` })).map;
    expect(bmap?.body?.name).toBe('Mascoma Lake');

    const person = await w.flagOn('user', w.author.id);
    const u = targetOf(await person.read());
    if (u.targetType !== 'user') throw new Error('user');
    expect(u.person.person.displayName).toBe('author Test-Person');
  });

  test('an access alert: as skaters see it, its place and its life', async () => {
    const w = await world();
    const alert = await w.t.run(async (ctx) => {
      const putInId = await ctx.db.insert('putIns', {
        waterBodyId: w.lake,
        coord: { lat: 0.4, lng: 0.4 },
        source: 'osm',
        status: 'visible',
        name: 'Fairlee launch',
        createdAt: NOW,
      });
      return ctx.db.insert('accessAlerts', {
        targetType: 'put_in',
        putInId,
        waterBodyId: w.lake,
        reason: 'gate_locked',
        kind: 'blocker',
        note: 'Chained',
        createdByUserId: w.author.id,
        createdAt: NOW - 3000,
        season: 2026,
        status: 'official',
        pinnedByUserId: w.mod.id,
        lastConfirmedAt: NOW - 1000,
        confirmCount: 2,
        denyCount: 0,
      });
    });
    const item = await (await w.flagOn('accessAlert', alert, 'other')).read();
    const a = targetOf(item);
    if (a.targetType !== 'accessAlert') throw new Error('alert');
    expect(a.alert).toMatchObject({
      place: { name: 'Fairlee launch', targetType: 'put_in' },
      note: 'Chained',
      pinnedBy: { displayName: 'mod Test-Person' },
    });
    expect(a.alert.life.map((e) => e.event)).toEqual(['posted', 'pinned', 'confirmed', 'flagged']);
    // The moderator pinned it but didn't write it: unpin is theirs to use.
    expect(item?.can).toMatchObject({ unpin: null, retract: null });
  });
});

describe('the author block', () => {
  test('their reports, contradictions, earlier actioned flags', async () => {
    const w = await world();
    await w.report({ contradiction: true });
    await w.report({ moderationStatus: 'hidden' });
    const target = await w.report();
    await w.t.run(async (ctx) => {
      await ctx.db.patch(w.author.id, { contradictionCount: 1 });
      await ctx.db.insert('contentFlags', {
        flaggerId: w.filer.id,
        targetType: 'report',
        targetId: 'old',
        reason: 'unsafe_false_report',
        status: 'actioned',
        subjectUserId: w.author.id,
        createdAt: NOW - 9000,
        resolvedAt: NOW - 8000,
      });
    });
    const item = await (await w.flagOn('report', target, 'unsafe_false_report')).read();
    if (item?.kind !== 'flag') throw new Error('flag');
    expect(item.author).toMatchObject({
      reports: { count: 2, capped: false },
      contradicted: { count: 1, capped: false },
      priorActioned: { count: 1, capped: false, lastAt: NOW - 8000 },
      openFlags: { count: 1, capped: false },
    });
    expect(item.author?.contradictedReports).toHaveLength(1);
  });
});

describe('places asked', () => {
  test('a landmark ask with a lookalike, then one a landmark answers; a bay ask until its bay is drawn', async () => {
    const w = await world();
    const ask = async (
      name: string,
      coord: { lat: number; lng: number },
      kind: 'name_landmark' | 'name_bay',
    ) =>
      w.t.run(async (ctx) => {
        const id = await ctx.db.insert('waterBodyRequests', {
          kind,
          status: 'open',
          requesterId: w.author.id,
          coord,
          waterBodyId: w.lake,
          name,
          nameKey: name.toLowerCase(),
          createdAt: NOW,
        });
        await fileMember(ctx, { table: 'waterBodyRequests', id });
        return id;
      });
    const landmark = (name: string, point: { lat: number; lng: number }) =>
      w.t.run((ctx) =>
        ctx.db.insert('bodyLandmarks', {
          waterBodyId: w.lake,
          name,
          kind: 'point',
          point,
          source: 'osm',
          externalIds: [],
          aliases: [],
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
    // A Narrows across the lake: a lookalike, not the answer.
    await landmark('The Narrows', { lat: 0.4, lng: 0.4 });
    const narrows = await ask('the Narrows', { lat: -0.4, lng: -0.4 }, 'name_landmark');
    const p = (await w.mod.as.query(api.inbox.item, { ref: `request:${narrows}` })).item;
    if (p?.kind !== 'place') throw new Error('place');
    expect(p.answeringLandmarkId).toBeNull();
    expect(p.lookalikes).toEqual([
      expect.objectContaining({ kind: 'landmark', name: 'The Narrows', source: 'osm' }),
    ]);
    expect(p.can).toMatchObject({
      sameAs: null,
      approve: expect.stringMatching(/No landmark called/),
    });
    const pmap = (await w.mod.as.query(api.inbox.itemMap, { ref: `request:${narrows}` })).map;
    expect(pmap?.lookalikes).toEqual([
      { id: expect.any(String), at: [0.4, 0.4], name: 'The Narrows' },
    ]);
    // A request row: its kind, its asker, its note.
    await w.author.as.mutation(api.corpusRequests.create, {
      kind: 'takedown',
      coord: { lat: 0, lng: 0 },
      waterBodyId: w.lake,
      note: 'Landowner asked',
    });
    const req = (await w.mod.as.query(api.inbox.listPage, { lane: 'requests' })).rows[0];
    expect(
      req?.kind === 'request' && [
        req.requestKind,
        req.askers,
        req.note,
        req.firstAsker?.displayName,
      ],
    ).toEqual(['takedown', 1, 'Landowner asked', 'author Test-Person']);
    // At the spot: the landmark answers it, and approve is open.
    const at = await landmark('Long Point', { lat: 0.2, lng: 0.2 });
    const point = await ask('Long Point', { lat: 0.2, lng: 0.2 }, 'name_landmark');
    const q = (await w.mod.as.query(api.inbox.item, { ref: `request:${point}` })).item;
    expect(q?.kind === 'place' && q.answeringLandmarkId).toBe(at);
    expect(q?.can.approve).toBeNull();

    const bay = await ask('Shaker Cove', { lat: 0.1, lng: 0.1 }, 'name_bay');
    const before = (await w.mod.as.query(api.inbox.item, { ref: `request:${bay}` })).item;
    expect(before?.can.approve).toMatch(/No sub-area called "Shaker Cove"/);
    const rows = await w.mod.as.query(api.inbox.listPage, { lane: 'placesAsked' });
    expect(rows.rows.map((r) => (r.kind === 'place' ? r.placeKind : null)).sort()).toEqual([
      'name_bay',
      'name_landmark',
      'name_landmark',
    ]);
  });
});

describe('a hidden or removed text, kept from a viewer without content.read', () => {
  test('the row’s summary and the report’s notes are empty to them, whole to staff who may read them', async () => {
    const w = await world();
    const hidden = await w.report({ moderationStatus: 'hidden', notes: 'Something unkind' });
    const { flagId } = await w.flagOn('report', hidden);
    const read = (canReadContent: boolean) =>
      w.t.run(async (ctx) => {
        const member = await ctx.db
          .query('inboxItemMembers')
          .withIndex('by_source', (q) => q.eq('sourceTable', 'contentFlags').eq('sourceId', flagId))
          .first();
        const item = (await ctx.db.get(member?.itemId as Id<'inboxItems'>)) as Doc<'inboxItems'>;
        const r = new InboxReader(ctx, new ReadBudget(), NOW, w.mod.id, canReadContent);
        const row = await rowLabel(r, item);
        const view = await itemView(r, item);
        const target = view?.view.kind === 'flag' ? view.view.target : null;
        return {
          summary: row.kind === 'flag' ? row.target.summary : null,
          notes: target?.exists && target.targetType === 'report' ? target.report.notes : 'n/a',
        };
      });
    expect(await read(false)).toEqual({ summary: '', notes: null });
    expect(await read(true)).toEqual({ summary: 'Something unkind', notes: 'Something unkind' });
  });
});

describe('the rest of each scene', () => {
  test('a hazard’s and an alert’s maps; a retracted alert’s life; a lot beside a put-in', async () => {
    const w = await world();
    const ids = await w.t.run(async (ctx) => {
      const hazard = await ctx.db.insert('hazards', {
        waterBodyId: w.lake,
        type: 'pressure_ridge',
        geometryKind: 'point_radius',
        geometry: { type: 'Point', coordinates: [0.2, 0.3] },
        bbox: { minLat: 0.3, minLng: 0.2, maxLat: 0.3, maxLng: 0.2 },
        createdByUserId: w.author.id,
        photoIds: [],
        status: 'active',
        moderationStatus: 'visible',
        firstReportedAt: NOW,
        lastConfirmedAt: NOW,
        confirmCount: 0,
        goneCount: 0,
        createdAt: NOW,
      });
      const lot = await ctx.db.insert('parkingAreas', {
        coord: { lat: -0.3, lng: -0.3 },
        name: 'State forest lot',
        status: 'visible',
        source: 'osm',
        amenities: [],
        createdAt: NOW,
      });
      await ctx.db.insert('parkingAreaBodies', {
        parkingAreaId: lot,
        waterBodyId: w.lake,
        inferred: false,
        createdAt: NOW,
      });
      const alert = await ctx.db.insert('accessAlerts', {
        targetType: 'parking_area',
        parkingAreaId: lot,
        waterBodyId: w.lake,
        reason: 'gate_locked',
        kind: 'blocker',
        createdByUserId: w.author.id,
        createdAt: NOW - 3000,
        season: 2026,
        status: 'retracted',
        retractedByUserId: w.author.id,
        retractedAt: NOW - 500,
        confirmCount: 0,
        denyCount: 0,
      });
      return { hazard, lot, alert };
    });
    const h = await w.flagOn('hazard', ids.hazard);
    const hm = (await w.mod.as.query(api.inbox.itemMap, { ref: `flag:${h.flagId}` })).map;
    expect(hm?.points).toEqual([{ id: ids.hazard, at: [0.2, 0.3] }]);
    expect(hm?.body?.id).toBe(w.lake);

    const a = await w.flagOn('accessAlert', ids.alert, 'other');
    const item = await a.read();
    const t = targetOf(item);
    if (t.targetType !== 'accessAlert') throw new Error('alert');
    expect(t.alert.life.map((e) => e.event)).toEqual(['posted', 'retracted', 'flagged']);
    expect(item?.can.retract).toMatch(/author already/);
    const am = (await w.mod.as.query(api.inbox.itemMap, { ref: `flag:${a.flagId}` })).map;
    expect(am?.access).toEqual([
      { id: ids.lot, at: [-0.3, -0.3], kind: 'lot', name: 'State forest lot' },
    ]);

    // An access item's map: the body's put-ins and lots.
    await w.filer.as.mutation(api.contentFlags.flag, {
      targetType: 'waterbody',
      targetId: w.lake,
      reason: 'no_public_access',
    });
    const access = (await w.mod.as.query(api.inbox.listPage, { lane: 'accessReports' })).rows[0];
    const map = (await w.mod.as.query(api.inbox.itemMap, { ref: access?.itemId as string })).map;
    expect(map?.access.map((p) => p.kind)).toEqual(['lot']);
  });

  test('a place item’s rows and map; a drawn row; a ticket’s empty map', async () => {
    const w = await world();
    const other = await w.t.run((ctx) =>
      ctx.db.insert('profiles', {
        clerkUserId: 'other',
        displayName: 'other Test-Person',
        username: 'other',
        driveTimePrefMinutes: 60,
        profileVisibility: 'public' as const,
        notificationPrefs: PREFS,
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role: 'member' as const,
        status: 'active' as const,
        createdAt: NOW,
      }),
    );
    for (const who of [w.author.as, w.t.withIdentity({ subject: 'other' })]) {
      await who.mutation(api.corpusRequests.create, {
        kind: 'name_bay',
        coord: { lat: 0.1, lng: 0.1 },
        waterBodyId: w.lake,
        name: 'Shaker Cove',
      });
    }
    const row = (await w.mod.as.query(api.inbox.listPage, { lane: 'placesAsked' })).rows[0];
    expect(
      row?.kind === 'place' && [row.name, row.askers, row.others.map((p) => p.userId)],
    ).toEqual(['Shaker Cove', 2, [other]]);
    const map = (await w.mod.as.query(api.inbox.itemMap, { ref: row?.itemId as string })).map;
    expect(map?.points.map((p) => p.name)).toEqual(['Shaker Cove', 'Shaker Cove']);

    const drawn = await w.t.run(async (ctx) => {
      const id = await ctx.db.insert('waterBodies', {
        name: 'Drawn',
        searchText: 'Drawn',
        type: 'lakePond',
        source: 'user',
        polygon: square,
        bbox: { minLat: -0.5, minLng: -0.5, maxLat: 0.5, maxLng: 0.5 },
        centroid: { lat: 0, lng: 0 },
        createdByUserId: w.author.id,
        reviewStatus: 'pending',
        dedupStatus: 'near_certain',
        duplicateCandidateIds: [w.lake],
        createdAt: NOW,
      } as never);
      await fileMember(ctx, { table: 'waterBodies', id: id as Id<'waterBodies'> });
      return id;
    });
    const drawnRow = (await w.mod.as.query(api.inbox.listPage, { lane: 'drawnBodies' })).rows[0];
    expect(drawnRow?.kind === 'drawn' && [drawnRow.overName, drawnRow.drawer?.displayName]).toEqual(
      ['Mascoma Lake', 'author Test-Person'],
    );
    void drawn;

    const ticket = await w.author.as.mutation(api.support.create, { category: 'bug', body: 'x' });
    const admin = await w.t.run((ctx) =>
      ctx.db.insert('profiles', {
        clerkUserId: 'admin',
        displayName: 'admin Test-Person',
        username: 'admin',
        driveTimePrefMinutes: 60,
        profileVisibility: 'public' as const,
        notificationPrefs: PREFS,
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role: 'admin' as const,
        status: 'active' as const,
        createdAt: NOW,
      }),
    );
    void admin;
    const tmap = (
      await w.t
        .withIdentity({ subject: 'admin' })
        .query(api.inbox.itemMap, { ref: `ticket:${ticket}` })
    ).map;
    expect(tmap).toMatchObject({ kind: 'ticket', body: null, points: [], access: [] });
  });

  test('a report whose body is gone reads as not there; an author past the scan is capped', async () => {
    const w = await world();
    const r = await w.report();
    const { read } = await w.flagOn('report', r);
    await w.t.run(async (ctx) => {
      for (let i = 0; i < 101; i++) {
        await ctx.db.insert('reports', {
          authorId: w.author.id,
          waterBodyId: w.lake,
          point: { lat: 0, lng: 0 },
          skateEndTime: NOW - (i + 2) * 3_600_000,
          reportTime: NOW,
          source: 'native',
          iceTypes: [],
          surfaceTags: [],
          photoIds: [],
          moderationStatus: 'visible',
          hazardIdsCreated: [],
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
    });
    const item = await read();
    if (item?.kind !== 'flag') throw new Error('flag');
    expect(item.author?.reports).toEqual({ count: 100, capped: true });
    await w.t.run((ctx) => ctx.db.delete(w.lake));
    const gone = await read();
    expect(gone?.kind === 'flag' && gone.target.exists).toBe(false);
  });
});
