/**
 * **A moderator may not act on their own content** (D269, B01-4f): the record sheet's writes, its
 * levers, an Inbox ruling on a flag about them, a pin of their alert, and every undo of one — one
 * rule (`lib/ownContent`), refused for every role while `OWN_CONTENT_EXEMPT_ROLES` is empty.
 */
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { OWN_CONTENT_REFUSAL } from './lib/ownContent';
import { markReady, refreshPersonRow } from './lib/peopleRows';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const T0 = Date.UTC(2026, 10, 14, 12);
const DAY = 86_400_000;
type T = ReturnType<typeof convexTest>;

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

async function seed(t: T, subject: string, over: Partial<Doc<'profiles'>> = {}) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: T0 - 30 * DAY,
      ...over,
    });
    await refreshPersonRow(ctx, id);
    return id;
  });
}

async function setup() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await markReady(ctx, 'rows');
    await markReady(ctx, 'flagSubjects');
    await markReady(ctx, 'undoChains');
  });
  return t;
}

const as = (t: T, subject: string) => t.withIdentity({ subject });

async function lake(t: T) {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Mascoma Lake',
      searchText: 'Mascoma Lake',
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [0, 0],
            [0, 1],
            [1, 1],
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

function report(
  t: T,
  authorId: Id<'profiles'>,
  bodyId: Id<'waterBodies'>,
  over: Partial<Doc<'reports'>> = {},
) {
  return t.run((ctx) =>
    ctx.db.insert('reports', {
      authorId,
      waterBodyId: bodyId,
      point: { lat: 0.5, lng: 0.5 },
      skateEndTime: T0,
      reportTime: T0,
      source: 'native' as const,
      iceTypes: [{ type: 'black_ice' as const }],
      surfaceTags: [],
      photoIds: [],
      moderationStatus: 'visible' as const,
      hazardIdsCreated: [],
      createdAt: T0,
      updatedAt: T0,
      ...over,
    }),
  );
}

const ROLES = ['moderator', 'admin'] as const;

describe('the record sheet: no lever, no write, no undo on your own content', () => {
  test.each(ROLES)(
    'a %s cannot hide, remove or restore their own Report; another moderator can',
    async (role) => {
      const t = await setup();
      const me = await seed(t, 'me', { role });
      await seed(t, 'other', { role: 'moderator' });
      const body = await lake(t);
      const mine = await report(t, me, body);
      const hide = (who: string) =>
        as(t, who).mutation(api.moderation.setModerationStatus, {
          targetType: 'report',
          targetId: mine,
          status: 'hidden',
          reason: 'r',
        });
      await expect(hide('me')).rejects.toThrow(OWN_CONTENT_REFUSAL);
      await expect(
        as(t, 'me').mutation(api.moderation.setModerationStatus, {
          targetType: 'report',
          targetId: mine,
          status: 'removed',
          reason: 'r',
        }),
      ).rejects.toThrow(OWN_CONTENT_REFUSAL);
      // The lever says so where it stands: their own item, read by them.
      const theirs = await as(t, 'me').query(api.contentRecord.item, {
        targetType: 'report',
        targetId: mine,
      });
      expect(theirs?.can.hideAgain).toEqual({ ok: false, why: OWN_CONTENT_REFUSAL });
      // Another moderator decides it; its undo is theirs, never the author's.
      const out = await hide('other');
      const row = (out as { actionId?: Id<'moderationActions'> }).actionId;
      expect(row).toBeDefined();
      const toastForMe = await as(t, 'me').query(api.undo.latestOwn, {
        targetType: 'report',
        targetId: mine,
      });
      expect(toastForMe).toBeNull();
      await expect(
        as(t, 'me').mutation(api.undo.run, {
          actionId: row as Id<'moderationActions'>,
          reason: 'r',
        }),
      ).rejects.toThrow(OWN_CONTENT_REFUSAL);
      const restore = await as(t, 'me').query(api.contentRecord.item, {
        targetType: 'report',
        targetId: mine,
      });
      expect(restore?.can.restore).toEqual({ ok: false, why: OWN_CONTENT_REFUSAL });
      await expect(
        as(t, 'me').mutation(api.moderation.setModerationStatus, {
          targetType: 'report',
          targetId: mine,
          status: 'visible',
        }),
      ).rejects.toThrow(OWN_CONTENT_REFUSAL);
    },
  );

  test('a keep or an overturn on what they deleted themselves is refused to them', async () => {
    const t = await setup();
    const me = await seed(t, 'me', { role: 'moderator' });
    await seed(t, 'other', { role: 'moderator' });
    const body = await lake(t);
    const mine = await report(t, me, body, {
      moderationStatus: 'removed',
      authorDeletedAt: T0 - DAY,
    });
    await expect(
      as(t, 'me').mutation(api.moderation.keepOnRecord, {
        targetType: 'report',
        targetId: mine,
        reason: 'r',
      }),
    ).rejects.toThrow(OWN_CONTENT_REFUSAL);
    await as(t, 'other').mutation(api.moderation.keepOnRecord, {
      targetType: 'report',
      targetId: mine,
      reason: 'r',
    });
    await expect(
      as(t, 'me').mutation(api.moderation.overturnVerdict, {
        targetType: 'report',
        targetId: mine,
      }),
    ).rejects.toThrow(OWN_CONTENT_REFUSAL);
  });

  test('a row written before the rule, where a moderator hid their own Report: its undo is refused to them', async () => {
    const t = await setup();
    const me = await seed(t, 'me', { role: 'moderator' });
    const body = await lake(t);
    const mine = await report(t, me, body, { moderationStatus: 'hidden' });
    const row = await t.run((ctx) =>
      ctx.db.insert('moderationActions', {
        actorId: me,
        action: 'hide',
        targetType: 'report',
        targetId: mine,
        reason: 'r',
        metadata: { priorStatus: 'visible', newStatus: 'hidden' },
        createdAt: T0,
      }),
    );
    const toast = await as(t, 'me').query(api.undo.latestOwn, {
      targetType: 'report',
      targetId: mine,
    });
    expect(toast?.actionId).toBe(row);
    expect(toast?.undo).toEqual({ state: 'unavailable', why: OWN_CONTENT_REFUSAL });
  });
});

describe('the Inbox: no ruling on a flag about you or your content', () => {
  test('resolving or dismissing a flag whose subject is the moderator is refused', async () => {
    const t = await setup();
    const me = await seed(t, 'me', { role: 'moderator' });
    const filer = await seed(t, 'filer');
    const body = await lake(t);
    const mine = await report(t, me, body);
    const flag = await t.run((ctx) =>
      ctx.db.insert('contentFlags', {
        flaggerId: filer,
        targetType: 'report',
        targetId: mine,
        reason: 'spam',
        status: 'open',
        subjectUserId: me,
        createdAt: T0,
      }),
    );
    for (const resolution of ['actioned', 'dismissed'] as const) {
      await expect(
        as(t, 'me').mutation(api.moderation.resolveFlag, { flagId: flag, resolution, reason: 'r' }),
      ).rejects.toThrow(OWN_CONTENT_REFUSAL);
    }
  });

  test('a flag the subjects backfill has not stamped is read from its target: refused all the same', async () => {
    const t = await setup();
    const me = await seed(t, 'me', { role: 'moderator' });
    const filer = await seed(t, 'filer');
    const body = await lake(t);
    const mine = await report(t, me, body);
    const [onMine, onMe] = await t.run(async (ctx) => [
      // A content flag filed before subjects were stamped, and a flag on the moderator themselves.
      await ctx.db.insert('contentFlags', {
        flaggerId: filer,
        targetType: 'report',
        targetId: mine,
        reason: 'spam',
        status: 'open',
        createdAt: T0,
      }),
      await ctx.db.insert('contentFlags', {
        flaggerId: filer,
        targetType: 'user',
        targetId: me,
        reason: 'spam',
        status: 'open',
        createdAt: T0,
      }),
    ]);
    for (const flagId of [onMine, onMe]) {
      await expect(
        as(t, 'me').mutation(api.moderation.resolveFlag, {
          flagId: flagId as Id<'contentFlags'>,
          resolution: 'dismissed',
          reason: 'r',
        }),
      ).rejects.toThrow(OWN_CONTENT_REFUSAL);
    }
  });
});

describe('over roles × writes × whose content (property)', () => {
  test('refused exactly when the content is the actor’s own', async () => {
    const WRITES = {
      hide: (a: ReturnType<typeof as>, id: Id<'reports'>) =>
        a.mutation(api.moderation.setModerationStatus, {
          targetType: 'report',
          targetId: id,
          status: 'hidden',
          reason: 'r',
        }),
      remove: (a: ReturnType<typeof as>, id: Id<'reports'>) =>
        a.mutation(api.moderation.setModerationStatus, {
          targetType: 'report',
          targetId: id,
          status: 'removed',
          reason: 'r',
        }),
    };
    const same = fc.asyncProperty(
      fc.constantFrom(...ROLES),
      fc.constantFrom(...(Object.keys(WRITES) as Array<keyof typeof WRITES>)),
      fc.boolean(),
      async (role, write, own) => {
        const t = await setup();
        const me = await seed(t, 'me', { role });
        const someone = await seed(t, 'someone');
        const body = await lake(t);
        const id = await report(t, own ? me : someone, body);
        const out = await WRITES[write](as(t, 'me'), id).then(
          () => 'done',
          (err: Error) => err.message,
        );
        expect(out.includes(OWN_CONTENT_REFUSAL), `${role}/${write}/${own}`).toBe(own);
      },
    );
    // Pinned seeds, so a failure replays; then one run on a fresh seed.
    for (const seed of [20261116, 5]) await fc.assert(same, { seed, numRuns: 6 });
    await fc.assert(same, { numRuns: 3 });
  });
});
