/**
 * **The photo's moderation axis** (B01-5e, D222): `setModerationStatus` on a photo — a hide restorable
 * indefinitely, a removal on the 30-day purge clock, a restore clearing it — each a verdict on the
 * uploader's record (D248), refused on the moderator's own photo (D269); its undo; the uploader's delete
 * of a held photo withdrawing it (the fork 1 ruling); an author's edit keeping every held photo; and the
 * Inbox's photo item and its three decisions, one rule for read and write.
 */
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { AUTHOR_DELETED_RESTORE } from './lib/authorDeletion';
import { OWN_CONTENT_REFUSAL } from './lib/ownContent';
import { PHOTO_PURGE_DELAY_MS } from './lib/photoAccess';
import { ERASED_ALREADY, RECORD_CHECK_ON_ITEM, TAKEDOWN_ALREADY } from './lib/recordRules';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const T0 = Date.UTC(2026, 11, 2, 12);
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

const NOTIF_PREFS = {
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

async function person(t: T, subject: string, role: Doc<'profiles'>['role'] = 'member') {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: `${subject} Test-Person`,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: T0 - 86_400_000,
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

async function lake(t: T) {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Lake Morey',
      searchText: 'Lake Morey',
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: {
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
      },
      bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      centroid: { lat: 0.5, lng: 0.5 },
      dedupStatus: 'clean' as const,
      createdAt: T0,
    }),
  );
}

/** A photo with two real stored blobs. */
async function photo(
  t: T,
  uploaderId: Id<'profiles'>,
  over: Partial<Doc<'photos'>> = {},
): Promise<Id<'photos'>> {
  return t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob(['full']));
    const thumbStorageId = await ctx.storage.store(new Blob(['thumb']));
    return ctx.db.insert('photos', {
      storageId,
      thumbStorageId,
      uploaderId,
      placeOnMap: false,
      createdAt: T0,
      caption: 'Black ice off the point',
      ...over,
    });
  });
}

async function reportWith(
  t: T,
  authorId: Id<'profiles'>,
  waterBodyId: Id<'waterBodies'>,
  photoIds: Id<'photos'>[],
) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert('reports', {
      authorId,
      waterBodyId,
      point: { lat: 0.5, lng: 0.5 },
      skateEndTime: T0,
      reportTime: T0,
      source: 'native' as const,
      iceTypes: [{ type: 'black_ice' as const }],
      surfaceTags: [],
      photoIds,
      moderationStatus: 'visible' as const,
      hazardIdsCreated: [],
      createdAt: T0,
      updatedAt: T0,
    });
    for (const p of photoIds) await ctx.db.patch(p, { reportId: id });
    return id;
  });
}

async function world() {
  const t = convexTest(schema, modules);
  const uploader = await person(t, 'uploader');
  const skater = await person(t, 'skater');
  const mod = await person(t, 'mod', 'moderator');
  const mod2 = await person(t, 'mod2', 'moderator');
  const waterBodyId = await lake(t);
  const photoId = await photo(t, uploader.id);
  const reportId = await reportWith(t, uploader.id, waterBodyId, [photoId]);
  return { t, uploader, skater, mod, mod2, waterBodyId, photoId, reportId };
}

const photoRow = (t: T, id: Id<'photos'>) => t.run((ctx) => ctx.db.get(id));
const verdictsOn = (t: T, id: Id<'photos'>) =>
  t.run((ctx) =>
    ctx.db
      .query('contentVerdicts')
      .withIndex('by_target_at', (q) => q.eq('targetType', 'photo').eq('targetId', id))
      .collect(),
  );

describe('setModerationStatus on a photo', () => {
  test('hide → restore: the status, the verdict on the uploader, nothing on the purge clock', async () => {
    const { t, mod, uploader, photoId } = await world();
    const hid = await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'photo',
      targetId: photoId,
      status: 'hidden',
      reason: 'A face in frame',
    });
    expect(hid.undoable).toBe(true);
    let row = await photoRow(t, photoId);
    expect(row?.moderationStatus).toBe('hidden');
    expect(row?.moderatedAt).toBeGreaterThanOrEqual(T0);
    expect(row?.purgeAt).toBeUndefined();
    let verdicts = await verdictsOn(t, photoId);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({
      subjectUserId: uploader.id,
      kind: 'hidden',
      standing: true,
    });
    // Restorable indefinitely: a year on, still.
    vi.setSystemTime(T0 + 365 * 86_400_000);
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'photo',
      targetId: photoId,
      status: 'visible',
    });
    row = await photoRow(t, photoId);
    expect(row?.moderationStatus).toBe('visible');
    expect(row?.purgeAt).toBeUndefined();
    verdicts = await verdictsOn(t, photoId);
    expect(verdicts.every((v) => !v.standing)).toBe(true);
  });

  test('remove starts the 30-day clock; restore clears it; a hide after a removal clears it', async () => {
    const { t, mod, photoId } = await world();
    const set = (status: 'hidden' | 'removed' | 'visible') =>
      mod.as.mutation(api.moderation.setModerationStatus, {
        targetType: 'photo',
        targetId: photoId,
        status,
        reason: 'x',
      });
    await set('removed');
    const removed = await photoRow(t, photoId);
    expect(removed?.purgeAt).toBe((removed?.moderatedAt ?? 0) + PHOTO_PURGE_DELAY_MS);
    await set('visible');
    expect((await photoRow(t, photoId))?.purgeAt).toBeUndefined();
    await set('removed');
    await set('hidden');
    const row = await photoRow(t, photoId);
    expect(row?.moderationStatus).toBe('hidden');
    expect(row?.purgeAt).toBeUndefined();
  });

  test('refusals: a member, the moderator’s own photo (D269), a takedown already held (D270), a purged photo', async () => {
    const { t, mod, skater, waterBodyId, photoId } = await world();
    await expect(
      skater.as.mutation(api.moderation.setModerationStatus, {
        targetType: 'photo',
        targetId: photoId,
        status: 'hidden',
        reason: 'x',
      }),
    ).rejects.toThrow('Requires moderator role');
    const own = await photo(t, mod.id);
    await reportWith(t, mod.id, waterBodyId, [own]);
    await expect(
      mod.as.mutation(api.moderation.setModerationStatus, {
        targetType: 'photo',
        targetId: own,
        status: 'removed',
        reason: 'x',
      }),
    ).rejects.toThrow(OWN_CONTENT_REFUSAL);
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'photo',
      targetId: photoId,
      status: 'hidden',
      reason: 'x',
    });
    await expect(
      mod.as.mutation(api.moderation.setModerationStatus, {
        targetType: 'photo',
        targetId: photoId,
        status: 'hidden',
        reason: 'again',
      }),
    ).rejects.toThrow(TAKEDOWN_ALREADY.hidden);
    await t.run((ctx) => ctx.db.patch(photoId, { purgedAt: T0, moderationStatus: 'removed' }));
    await expect(
      mod.as.mutation(api.moderation.setModerationStatus, {
        targetType: 'photo',
        targetId: photoId,
        status: 'visible',
      }),
    ).rejects.toThrow(ERASED_ALREADY);
  });

  test('its undo: a removal undone puts it back up, clock cleared, verdict ended; overtaken by a later write', async () => {
    const { t, mod, mod2, photoId } = await world();
    const removed = await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'photo',
      targetId: photoId,
      status: 'removed',
      reason: 'x',
    });
    await mod2.as.mutation(api.undo.run, { actionId: removed.actionId });
    const row = await photoRow(t, photoId);
    expect(row?.moderationStatus).toBe('visible');
    expect(row?.purgeAt).toBeUndefined();
    expect((await verdictsOn(t, photoId)).some((v) => v.standing)).toBe(false);
    // A newer decision overtakes the first: its undo is refused.
    const hid = await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'photo',
      targetId: photoId,
      status: 'hidden',
      reason: 'y',
    });
    await mod2.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'photo',
      targetId: photoId,
      status: 'visible',
    });
    await expect(mod.as.mutation(api.undo.run, { actionId: hid.actionId })).rejects.toThrow();
  });
});

describe('the uploader’s delete (photos.remove, fork 1)', () => {
  test('an unheld photo is deleted, row and blobs', async () => {
    const { t, uploader } = await world();
    const loose = await photo(t, uploader.id);
    const out = await uploader.as.mutation(api.photos.remove, { photoId: loose });
    expect(out.outcome).toBe('deleted');
    expect(await photoRow(t, loose)).toBeNull();
  });

  test('a flagged photo is withdrawn: removed at once, on the 30-day clock, its flag still open, final', async () => {
    const { t, uploader, skater, mod, photoId } = await world();
    const flagId = await skater.as.mutation(api.contentFlags.flag, {
      targetType: 'photo',
      targetId: photoId,
      reason: 'inappropriate',
    });
    const out = await uploader.as.mutation(api.photos.remove, { photoId });
    expect(out.outcome).toBe('withdrawn');
    const row = await photoRow(t, photoId);
    expect(row?.moderationStatus).toBe('removed');
    expect(row?.purgeAt).toBe((row?.moderatedAt ?? 0) + PHOTO_PURGE_DELAY_MS);
    const clock = row?.purgeAt;
    expect((await t.run((ctx) => ctx.db.get(flagId)))?.status).toBe('open');
    const audit = await t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_target_action', (q) =>
          q.eq('targetType', 'photo').eq('targetId', photoId).eq('action', 'author_delete'),
        )
        .collect(),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorId).toBe(uploader.id);
    // Idempotent: a second delete writes nothing more.
    await uploader.as.mutation(api.photos.remove, { photoId });
    expect((await photoRow(t, photoId))?.purgeAt).toBe(clock);
    // Final: no moderator brings it back.
    await expect(
      mod.as.mutation(api.moderation.setModerationStatus, {
        targetType: 'photo',
        targetId: photoId,
        status: 'visible',
      }),
    ).rejects.toThrow(AUTHOR_DELETED_RESTORE);
  });

  test('a hidden photo goes to removed, its verdict standing, its clock started; an earlier clock is kept', async () => {
    const { t, uploader, mod, photoId } = await world();
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'photo',
      targetId: photoId,
      status: 'hidden',
      reason: 'x',
    });
    vi.setSystemTime(T0 + 5_000);
    await uploader.as.mutation(api.photos.remove, { photoId });
    const row = await photoRow(t, photoId);
    expect(row?.moderationStatus).toBe('removed');
    expect(row?.purgeAt).toBeGreaterThanOrEqual(T0 + 5_000 + PHOTO_PURGE_DELAY_MS);
    expect(row?.purgeAt).toBeLessThan(T0 + 6_000 + PHOTO_PURGE_DELAY_MS);
    expect((await verdictsOn(t, photoId)).filter((v) => v.standing)).toHaveLength(1);

    const removed = await photo(t, uploader.id, {
      moderationStatus: 'removed',
      purgeAt: T0 + 1_000,
    });
    await uploader.as.mutation(api.photos.remove, { photoId: removed });
    expect((await photoRow(t, removed))?.purgeAt).toBe(T0 + 1_000);
  });

  test('another skater’s photo is refused', async () => {
    const { skater, photoId } = await world();
    await expect(skater.as.mutation(api.photos.remove, { photoId })).rejects.toThrow(
      'Not your photo',
    );
  });
});

describe('the record sheet sees a photo', () => {
  test('the item pane: the withdrawal read, Overturn on a withdrawn photo’s standing verdict', async () => {
    const { t, uploader, mod, photoId } = await world();
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'photo',
      targetId: photoId,
      status: 'hidden',
      reason: 'x',
    });
    let pane = await mod.as.query(api.contentRecord.item, {
      targetType: 'photo',
      targetId: photoId,
    });
    expect(pane?.can).toEqual({ restore: { ok: true, needsReason: false } });
    await uploader.as.mutation(api.photos.remove, { photoId });
    pane = await mod.as.query(api.contentRecord.item, { targetType: 'photo', targetId: photoId });
    expect(Object.keys(pane?.can ?? {})).toEqual(['overturn']);
    expect(pane?.purgeAt).toBe((await photoRow(t, photoId))?.purgeAt);
    expect(pane?.purgeAt).toEqual(expect.any(Number));
  });

  test('a photo item carries a staff-only thumbnail (content.thumbUrl), none once purged; its kind counts', async () => {
    const { t, uploader, mod, photoId } = await world();
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'photo',
      targetId: photoId,
      status: 'removed',
      reason: 'x',
    });
    const pane = await mod.as.query(api.contentRecord.item, {
      targetType: 'photo',
      targetId: photoId,
    });
    expect((pane?.content as { thumbUrl?: string | null } | undefined)?.thumbUrl).toEqual(
      expect.any(String),
    );
    const counts = await t.run(async (ctx) => {
      const { readVerdictCounts } = await import('./lib/contentVerdicts');
      return readVerdictCounts(ctx, uploader.id);
    });
    expect(counts.byKind.photo).toBe(1);
    await t.run((ctx) => ctx.db.patch(photoId, { purgedAt: T0, caption: undefined }));
    const tomb = await mod.as.query(api.contentRecord.item, {
      targetType: 'photo',
      targetId: photoId,
    });
    expect((tomb?.content as { thumbUrl?: string | null } | undefined)?.thumbUrl).toBeNull();
  });

  test('a list row that didn’t read the withdrawal points Restore at the item', async () => {
    const { recordFactsOf, recordLevers } = await import('./lib/recordRules');
    const viewer = {
      _id: 'm' as Id<'profiles'>,
      role: 'moderator' as const,
      canEditLedger: undefined,
      deletionRequestedAt: undefined,
    };
    const doc = { uploaderId: 'u', moderationStatus: 'hidden' } as unknown as Doc<'photos'>;
    expect(recordLevers(viewer, recordFactsOf('photo', doc, 'hidden')).restore).toEqual({
      ok: false,
      why: RECORD_CHECK_ON_ITEM,
    });
    expect(
      recordLevers(viewer, recordFactsOf('photo', doc, 'hidden', { photoWithdrawn: false }))
        .restore,
    ).toEqual({ ok: true, needsReason: false });
  });
});

describe('an author’s edit keeps every held photo (D248)', () => {
  test('a flagged or moderated photo left out of the edit stays attached; a loose one drops', async () => {
    const { t, uploader, skater, mod, waterBodyId } = await world();
    const keepFlagged = await photo(t, uploader.id);
    const keepHidden = await photo(t, uploader.id);
    const drop = await photo(t, uploader.id);
    const reportId = await reportWith(t, uploader.id, waterBodyId, [keepFlagged, keepHidden, drop]);
    await skater.as.mutation(api.contentFlags.flag, {
      targetType: 'photo',
      targetId: keepFlagged,
      reason: 'inappropriate',
    });
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'photo',
      targetId: keepHidden,
      status: 'hidden',
      reason: 'x',
    });
    const fresh = await photo(t, uploader.id);
    const { applyEditKeepingHeld } = await editHarness();
    const after = await applyEditKeepingHeld(t, reportId, [fresh]);
    expect(after).toEqual([fresh, keepFlagged, keepHidden]);
    expect((await photoRow(t, drop))?.reportId).toBeUndefined();
    expect((await photoRow(t, keepFlagged))?.reportId).toBe(reportId);
  });
});

/**
 * The edit's photo rule through the same helpers `reports.update` runs (`keepHeldPhotos`, then the
 * back-links), so the rule is held without the whole report contract's fixture.
 */
async function editHarness() {
  const { keepHeldPhotos, syncReportPhotoLinks } = await import('./lib/photoAccess');
  return {
    applyEditKeepingHeld: (t: T, reportId: Id<'reports'>, sent: Id<'photos'>[]) =>
      t.run(async (ctx) => {
        const report = (await ctx.db.get(reportId)) as Doc<'reports'>;
        const next = await keepHeldPhotos(ctx, sent, report.photoIds);
        await syncReportPhotoLinks(ctx, reportId, report.photoIds, next);
        await ctx.db.patch(reportId, { photoIds: next });
        return next;
      }),
  };
}

// ── The Inbox's photo item (board 2.7) ─────────────────────────────────────────────────────────

async function photoItem(t: T, flagId: Id<'contentFlags'>): Promise<Id<'inboxItems'>> {
  return t.run(async (ctx) => {
    const m = await ctx.db
      .query('inboxItemMembers')
      .withIndex('by_source', (q) => q.eq('sourceTable', 'contentFlags').eq('sourceId', flagId))
      .first();
    if (!m) throw new Error('no item');
    return m.itemId;
  });
}

describe('the Inbox photo item', () => {
  test('serves the stage, the strip in order, the flag and the uploader; a takedown and its undo', async () => {
    const { t, uploader, skater, mod, mod2, waterBodyId } = await world();
    const ids = [
      await photo(t, uploader.id),
      await photo(t, uploader.id),
      await photo(t, uploader.id),
    ];
    await reportWith(t, uploader.id, waterBodyId, ids);
    const target = ids[1] as Id<'photos'>;
    const flagId = await skater.as.mutation(api.contentFlags.flag, {
      targetType: 'photo',
      targetId: target,
      reason: 'inappropriate',
    });
    const itemId = await photoItem(t, flagId);
    const read = await mod.as.query(api.inbox.item, { ref: itemId });
    const view = read.item as Extract<NonNullable<typeof read.item>, { kind: 'flag' }>;
    expect(view.kind).toBe('flag');
    const tgt = view.target as Extract<typeof view.target, { targetType: 'photo'; exists: true }>;
    expect(tgt.photo).toMatchObject({
      photoId: target,
      indexOnReport: 1,
      photoCount: 3,
      moderationStatus: 'visible',
      moderatedAt: null,
      canReveal: true,
      siblingsCut: false,
    });
    // The thumbnail only: the full image comes from the reveal read, keyed by the photo.
    expect(tgt.photo.thumbUrl).toEqual(expect.any(String));
    expect('url' in tgt.photo).toBe(false);
    const revealed = await mod.as.query(api.inbox.photoReveal, { photoId: target });
    expect(revealed.url).toEqual(expect.any(String));
    await expect(skater.as.query(api.inbox.photoReveal, { photoId: target })).rejects.toThrow();
    // The others only, never the flagged photo itself; each with its own open flag, if any.
    expect(tgt.photo.siblings.map((s) => s.photoId)).toEqual([ids[0], ids[2]]);
    expect(tgt.photo.siblings.map((s) => s.openFlagId)).toEqual([null, null]);
    const sibFlag = await skater.as.mutation(api.contentFlags.flag, {
      targetType: 'photo',
      targetId: ids[2] as Id<'photos'>,
      reason: 'spam',
    });
    const again = (await mod.as.query(api.inbox.item, { ref: itemId })).item as typeof view;
    const again2 = again.target as typeof tgt;
    expect(again2.photo.siblings.map((s) => s.openFlagId)).toEqual([null, sibFlag]);
    expect(view.author?.person.userId).toBe(uploader.id);
    expect(view.flags).toHaveLength(1);
    expect(view.can.hide).toBeNull();

    const out = await mod.as.mutation(api.inboxWrites.takeDown, {
      itemId,
      status: 'removed',
      reason: 'Not ice',
    });
    expect(out).toMatchObject({ status: 'removed', flagsClosed: 1, undoable: true });
    const down = await photoRow(t, target);
    expect(down?.purgeAt).toBe((down?.moderatedAt ?? 0) + PHOTO_PURGE_DELAY_MS);
    expect((await t.run((ctx) => ctx.db.get(flagId)))?.status).toBe('actioned');

    await mod2.as.mutation(api.undo.run, { actionId: out.actionId });
    const back = await photoRow(t, target);
    expect(back?.moderationStatus).toBe('visible');
    expect(back?.purgeAt).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(flagId)))?.status).toBe('open');
  });

  test('restoreAndDismiss for a photo already down; dismissFlags leaves it up', async () => {
    const { t, uploader, skater, mod, photoId } = await world();
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'photo',
      targetId: photoId,
      status: 'hidden',
      reason: 'x',
    });
    const flagId = await skater.as.mutation(api.contentFlags.flag, {
      targetType: 'photo',
      targetId: photoId,
      reason: 'inappropriate',
    });
    const itemId = await photoItem(t, flagId);
    const read = await mod.as.query(api.inbox.item, { ref: itemId });
    expect(read.item?.can.restore).toBeNull();
    expect(read.item?.can.hide).toBeUndefined();
    await mod.as.mutation(api.inboxWrites.restoreAndDismiss, { itemId });
    expect((await photoRow(t, photoId))?.moderationStatus).toBe('visible');

    const other = await photo(t, uploader.id);
    const f2 = await skater.as.mutation(api.contentFlags.flag, {
      targetType: 'photo',
      targetId: other,
      reason: 'spam',
    });
    await mod.as.mutation(api.inboxWrites.dismissFlags, { itemId: await photoItem(t, f2) });
    expect((await photoRow(t, other))?.moderationStatus ?? 'visible').toBe('visible');
  });

  test('D269: the moderator’s own photo — refused at the item’s can and at the write, one sentence', async () => {
    const { t, mod, skater, waterBodyId } = await world();
    const own = await photo(t, mod.id);
    await reportWith(t, mod.id, waterBodyId, [own]);
    const flagId = await skater.as.mutation(api.contentFlags.flag, {
      targetType: 'photo',
      targetId: own,
      reason: 'inappropriate',
    });
    const itemId = await photoItem(t, flagId);
    const read = await mod.as.query(api.inbox.item, { ref: itemId });
    expect(read.item?.can.remove).toBe(OWN_CONTENT_REFUSAL);
    await expect(
      mod.as.mutation(api.inboxWrites.takeDown, { itemId, status: 'removed', reason: 'x' }),
    ).rejects.toThrow(OWN_CONTENT_REFUSAL);
  });

  test('a withdrawn photo: Restore refused at can and write by the same sentence', async () => {
    const { t, uploader, skater, mod, photoId } = await world();
    const flagId = await skater.as.mutation(api.contentFlags.flag, {
      targetType: 'photo',
      targetId: photoId,
      reason: 'inappropriate',
    });
    await uploader.as.mutation(api.photos.remove, { photoId });
    const itemId = await photoItem(t, flagId);
    const read = await mod.as.query(api.inbox.item, { ref: itemId });
    expect(read.item?.can.restore).toBe(AUTHOR_DELETED_RESTORE);
    const tgt = (read.item as { target: { withdrawal: string | null } }).target;
    expect(tgt.withdrawal).toBe('deleted');
    await expect(mod.as.mutation(api.inboxWrites.restoreAndDismiss, { itemId })).rejects.toThrow(
      AUTHOR_DELETED_RESTORE,
    );
  });
});

describe('a photo takedown tells its flagger once', () => {
  /** Make every queued notification due and flush it — the settle window, fast-forwarded. */
  async function flushAllDue(t: T) {
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('notificationQueue').collect()) {
        await ctx.db.patch(row._id, { flushAfter: Date.now() - 1 });
      }
    });
    await t.mutation(internal.notifications.flushNotificationQueue, {});
    await t.mutation(internal.notifications.flushNotificationQueue, {});
    return t.run((ctx) => ctx.db.query('notifications').collect());
  }

  test('told once; an undo inside the settle window tells no one', async () => {
    const { t, skater, mod, mod2, uploader } = await world();
    const told = async (undo: boolean) => {
      const p = await photo(t, uploader.id);
      const flagId = await skater.as.mutation(api.contentFlags.flag, {
        targetType: 'photo',
        targetId: p,
        reason: 'inappropriate',
      });
      const out = await mod.as.mutation(api.inboxWrites.takeDown, {
        itemId: await photoItem(t, flagId),
        status: 'hidden',
        reason: 'x',
      });
      if (undo) await mod2.as.mutation(api.undo.run, { actionId: out.actionId });
      return flagId;
    };
    const undone = await told(true);
    const kept = await told(false);
    const sent = await flushAllDue(t);
    const about = (flagId: string) =>
      sent.filter((n) => n.userId === skater.id && JSON.stringify(n).includes(flagId));
    expect(about(kept)).toHaveLength(1);
    expect(about(undone)).toHaveLength(0);
  });
});
