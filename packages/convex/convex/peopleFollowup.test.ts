/**
 * The People server's follow-up (B01 §5.7, B01-4b): what the list and person pages asked for, one rule
 * for the Overview and the lanes, the audit-reason cap (D261), the parked-lapse mirror, and the bounds.
 */
import { AUDIT_REASON_MAX, AUDIT_REASON_TOO_LONG } from '@skating/core';
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  composed,
  composedOf,
  fitComposed,
  typed,
  writeAudit,
  writePersonAudit,
} from './lib/audit';
import { rebuildBodyLibrary } from './lib/bodyLibrary';
import { LAST_EDITOR_MESSAGE } from './lib/ledgerEditors';
import { LEDGER_NEUTRAL_REFUSAL } from './lib/peopleCan';
import { markReady, refreshPersonRow } from './lib/peopleRows';
import { ReadBudget } from './lib/readBudget';
import { readTenure } from './lib/staffTenure';
import { startOfCurrentState } from './lib/stateSince';
import { MIRRORS_CHECKED } from './peopleJobs';
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

/** A person write's answer, narrowed to the case that offers its undo (the test says it must). */
function undoable<R extends { undoable: boolean }>(out: R): Extract<R, { undoable: true }> {
  if (!out.undoable) throw new Error('expected the write to offer its undo');
  return out as Extract<R, { undoable: true }>;
}

// ── D261: the audit-reason cap ──

describe('an audit reason is capped at the one place it enters the log (D261)', () => {
  test('2,000 characters pass; one more is refused with a plain message, whatever the writer', async () => {
    const t = await setup();
    await seed(t, 'mod', { role: 'moderator' });
    const skater = await seed(t, 'skater');
    const until = T0 + 3 * DAY;
    const at = 'x'.repeat(AUDIT_REASON_MAX);
    await as(t, 'mod').mutation(api.moderation.suspendUser, {
      userId: skater,
      reason: at,
      suspendedUntil: until,
    });
    await expect(
      as(t, 'mod').mutation(api.moderation.banUser, { userId: skater, reason: `${at}y` }),
    ).rejects.toThrow(AUDIT_REASON_TOO_LONG);
    // The refused write left nothing behind: the suspension stands.
    expect((await t.run((ctx) => ctx.db.get(skater)))?.status).toBe('suspended');
    // A row from before the cap is left alone and still reads.
    await t.run((ctx) =>
      ctx.db.insert('moderationActions', {
        action: 'ban',
        targetType: 'user',
        targetId: skater,
        reason: 'z'.repeat(AUDIT_REASON_MAX * 2),
        createdAt: T0 - DAY,
      }),
    );
    const history = await as(t, 'mod').query(api.people.history, { userId: skater });
    expect(history?.rows.some((r) => r.reason.length === AUDIT_REASON_MAX * 2)).toBe(true);
  });

  test('an undo nobody typed a reason for quotes the row’s own, fitted — never refused for it', async () => {
    const t = await setup();
    await seed(t, 'mod', { role: 'moderator' });
    const skater = await seed(t, 'skater');
    const banned = undoable(
      await as(t, 'mod').mutation(api.moderation.banUser, {
        userId: skater,
        reason: 'x'.repeat(AUDIT_REASON_MAX),
      }),
    );
    // Undoing a ban gives back, so it asks no reason: the engine's line quotes the ban's whole one.
    await as(t, 'mod').mutation(api.undo.run, { actionId: banned.actionId });
    expect((await t.run((ctx) => ctx.db.get(skater)))?.status).toBe('active');
    const undo = await t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_undoes', (q) => q.eq('undoesActionId', banned.actionId))
        .first(),
    );
    expect(undo?.reason.startsWith('Undid ban: xxx')).toBe(true);
    expect(undo?.reason.endsWith('…')).toBe(true);
    expect(undo?.reason.length).toBe(AUDIT_REASON_MAX);
  });
});

describe('a reason the system composes is shortened to fit, never refused (D261)', () => {
  const LONG = 'N'.repeat(3_000);
  const BODY = {
    searchText: 'x',
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
  };
  const newestReason = (t: T, targetId: string) =>
    t.run(async (ctx) => {
      const rows = (await ctx.db.query('moderationActions').collect()).filter(
        (r) => r.targetId === targetId,
      );
      return rows[rows.length - 1]?.reason ?? null;
    });

  test('fitting: at most the cap, the fixed words kept in order, whole when it fits', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 40 }), { minLength: 1, maxLength: 4 }),
        fc.array(fc.string({ maxLength: 5_000 }), { maxLength: 3 }),
        (fixedParts, values) => {
          const fixed = [...fixedParts];
          while (fixed.length < values.length + 1) fixed.push('');
          const reason = composedOf(fixed, values.slice(0, fixed.length - 1));
          const whole = fixed.reduce((o, p, i) => o + p + (reason.values[i] ?? ''), '');
          const fitted = fitComposed(reason);
          expect(fitted.length).toBeLessThanOrEqual(AUDIT_REASON_MAX);
          if (whole.length <= AUDIT_REASON_MAX) expect(fitted).toBe(whole);
          expect(fitted.startsWith(fixed[0] as string)).toBe(true);
          let at = 0;
          for (const part of fixed) {
            const i = fitted.indexOf(part, at);
            expect(i).toBeGreaterThanOrEqual(0);
            at = i + part.length;
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  test('a merge into a body with a 3,000-character name goes through, its reason fitted', async () => {
    const t = await setup();
    await seed(t, 'adm', { role: 'admin' });
    const [survivor, loser] = await t.run(async (ctx) => [
      await ctx.db.insert('waterBodies', { ...BODY, name: LONG }),
      await ctx.db.insert('waterBodies', { ...BODY, name: 'Loser Pond' }),
    ]);
    await as(t, 'adm').mutation(api.waterBodies.merge, { survivorId: survivor, loserId: loser });
    const reason = await newestReason(t, loser);
    expect(reason?.length).toBeLessThanOrEqual(AUDIT_REASON_MAX);
    expect(reason?.startsWith('Merged into NNN')).toBe(true);
    expect(reason?.endsWith('…')).toBe(true);
  });

  test('a landmark and a place name with 3,000-character names: removed and dismissed, reasons fitted', async () => {
    const t = await setup();
    await seed(t, 'adm', { role: 'admin' });
    const { landmark, place } = await t.run(async (ctx) => {
      const body = await ctx.db.insert('waterBodies', { ...BODY, name: 'Pond' });
      const landmark = await ctx.db.insert('bodyLandmarks', {
        waterBodyId: body,
        name: LONG,
        kind: 'other',
        point: { lat: 0.5, lng: 0.5 },
        source: 'gnis',
        externalIds: ['gnis:x'],
        aliases: [],
        createdAt: 0,
        updatedAt: 0,
      });
      const place = await ctx.db.insert('corpusPlaceNames', {
        name: LONG,
        askKey: 'long',
        aliases: [],
        messages: 3,
        skatedMessages: 1,
        states: ['VT'],
        waterBodyId: body,
        status: 'open',
        createdAt: T0,
        updatedAt: T0,
      });
      return { landmark, place };
    });
    await as(t, 'adm').mutation(api.landmarks.remove, { landmarkId: landmark });
    await as(t, 'adm').mutation(api.corpusPlaceNames.dismiss, {
      id: place,
      reason: 'not_a_place',
      note: 'x'.repeat(500),
    } as never);
    const reasons = await t.run(async (ctx) =>
      (await ctx.db.query('moderationActions').collect()).map((r) => r.reason),
    );
    const removed = reasons.find((r) => r.startsWith('Removed "'));
    const dismissed = reasons.find((r) => r.startsWith('Dismissed "'));
    for (const r of [removed, dismissed]) {
      expect(r?.length).toBeLessThanOrEqual(AUDIT_REASON_MAX);
      expect(r).toContain('…');
    }
  });

  test('a system write (no actor, as a job writes) with a composed reason is written, not refused', async () => {
    const t = await setup();
    const id = await t.run(async (ctx) => {
      const body = await ctx.db.insert('waterBodies', { ...BODY, name: 'Pond' });
      await writeAudit(ctx, {
        action: 'remove',
        targetType: 'waterbody',
        targetId: body,
        reason: composed`Auto-delisted "${LONG}": no longer fits ${LONG}. Redraw it.`,
      });
      return body;
    });
    const reason = await newestReason(t, id);
    expect(reason?.length).toBeLessThanOrEqual(AUDIT_REASON_MAX);
    expect(reason?.startsWith('Auto-delisted "N')).toBe(true);
    expect(reason?.endsWith('. Redraw it.')).toBe(true);
    // What a person typed stays refused past the cap, through the same writer.
    await expect(
      t.run((ctx) =>
        writeAudit(ctx, {
          action: 'remove',
          targetType: 'waterbody',
          targetId: id,
          reason: 'y'.repeat(AUDIT_REASON_MAX + 1),
        }),
      ),
    ).rejects.toThrow(AUDIT_REASON_TOO_LONG);
  });
});

test('the People entry takes only a tagged reason (a type check, never run)', () => {
  const never = (ctx: Parameters<typeof writePersonAudit>[0]) => {
    // @ts-expect-error A bare string can't be a person write's reason: it must be typed or composed.
    void writePersonAudit(ctx, { action: 'ban', targetType: 'user', targetId: 'x', reason: 'r' });
    void writePersonAudit(ctx, {
      action: 'ban',
      targetType: 'user',
      targetId: 'x',
      // @ts-expect-error Nor a literal spelled to look like one: only `typed` and `composed` make them.
      reason: { typed: 'r' },
    });
    void writePersonAudit(ctx, {
      action: 'ban',
      targetType: 'user',
      targetId: 'x',
      reason: typed('r'),
    });
  };
  expect(typeof never).toBe('function');
  expect(() => typed('x'.repeat(AUDIT_REASON_MAX + 1))).toThrow(AUDIT_REASON_TOO_LONG);
});

// ── Ids at the edge ──

describe('a person read given something that is not a profile id says no such person', () => {
  test('a malformed id and another table’s id read as null, not a validator error', async () => {
    const t = await setup();
    await seed(t, 'adm', { role: 'admin' });
    const flagId = await t.run(async (ctx) =>
      ctx.db.insert('contentFlags', {
        flaggerId: (await ctx.db.query('profiles').first())?._id as Id<'profiles'>,
        targetType: 'report',
        targetId: 'r',
        reason: 'spam',
        status: 'open',
        subjectUserId: null,
        createdAt: T0,
      }),
    );
    const a = as(t, 'adm');
    for (const userId of ['x', flagId, ` ${flagId} `]) {
      expect(await a.query(api.people.person, { userId })).toBeNull();
      expect(await a.query(api.people.history, { userId })).toBeNull();
      expect(await a.query(api.people.decisions, { userId })).toBeNull();
      expect(await a.query(api.people.staffStats, { userId })).toBeNull();
      expect(await a.query(api.people.staffSeason, { userId })).toBeNull();
      expect(await a.query(api.people.reportTrend, { userId })).toBeNull();
    }
  });
});

// ── Every person write returns its audit row ──

describe('every person write returns the audit row it wrote (the undo toast’s handle)', () => {
  test('discipline, roles and the ledger', async () => {
    const t = await setup();
    await seed(t, 'adm', { role: 'admin', canEditLedger: true });
    const skater = await seed(t, 'skater');
    const other = await seed(t, 'other', { role: 'admin' });
    const a = as(t, 'adm');
    const writes = [
      () =>
        a.mutation(api.moderation.setPostingPermission, {
          userId: skater,
          permission: 'comments',
          allowed: false,
          reason: 'r',
        }),
      () =>
        a.mutation(api.moderation.setBountyPostLimit, { userId: skater, limit: 1, reason: 'r' }),
      () =>
        a.mutation(api.moderation.suspendUser, {
          userId: skater,
          reason: 'r',
          suspendedUntil: T0 + DAY,
        }),
      () => a.mutation(api.moderation.banUser, { userId: skater, reason: 'r' }),
      () => a.mutation(api.moderation.unbanUser, { userId: skater }),
      () => a.mutation(api.admin.grantRole, { userId: skater, role: 'moderator' }),
      () => a.mutation(api.admin.revokeRole, { userId: skater, reason: 'r' }),
      () => a.mutation(api.ledger.grantEditor, { userId: other }),
      () => a.mutation(api.ledger.revokeEditor, { userId: other, reason: 'r' }),
    ];
    for (const write of writes) {
      const out = undoable(await write());
      const row = await t.run((ctx) => ctx.db.get(out.actionId));
      expect(row?.targetId).toBe(out.userId);
      // Whether its undo asks a reason: the toast's lookup gives the same answer (one rule).
      const toast = await a.query(api.undo.latestOwn, { targetType: 'user', targetId: out.userId });
      expect(toast?.actionId).toBe(out.actionId);
      expect(toast?.undo).toEqual({ state: 'available', needsReason: out.undoNeedsReason });
      // It is the newest row on the person: exactly the one this write made.
      const newest = await t.run((ctx) =>
        ctx.db
          .query('moderationActions')
          .withIndex('by_target', (q) => q.eq('targetType', 'user').eq('targetId', out.userId))
          .order('desc')
          .first(),
      );
      expect(newest?._id).toBe(out.actionId);
    }
  });
});

describe('undoNeedsReason: the write, the toast and the undo agree for every person verb', () => {
  const VERBS: Array<{
    verb: string;
    prep?: Partial<Doc<'profiles'>>;
    // biome-ignore lint/suspicious/noExplicitAny: each write's own answer
    write: (a: ReturnType<typeof as>, id: Id<'profiles'>) => Promise<any>;
  }> = [
    {
      verb: 'right off',
      write: (a, id) =>
        a.mutation(api.moderation.setPostingPermission, {
          userId: id,
          permission: 'comments',
          allowed: false,
          reason: 'r',
        }),
    },
    {
      verb: 'right back',
      prep: { canPostComments: false },
      write: (a, id) =>
        a.mutation(api.moderation.setPostingPermission, {
          userId: id,
          permission: 'comments',
          allowed: true,
        }),
    },
    {
      verb: 'bounty limit lowered',
      write: (a, id) =>
        a.mutation(api.moderation.setBountyPostLimit, { userId: id, limit: 0, reason: 'r' }),
    },
    {
      verb: 'bounty limit raised',
      prep: { activeBountyPostLimit: 0 },
      write: (a, id) => a.mutation(api.moderation.setBountyPostLimit, { userId: id, limit: 9 }),
    },
    {
      verb: 'suspend',
      write: (a, id) =>
        a.mutation(api.moderation.suspendUser, {
          userId: id,
          reason: 'r',
          suspendedUntil: T0 + DAY,
        }),
    },
    {
      verb: 'ban',
      write: (a, id) => a.mutation(api.moderation.banUser, { userId: id, reason: 'r' }),
    },
    {
      verb: 'lift',
      prep: { status: 'banned' },
      write: (a, id) => a.mutation(api.moderation.unbanUser, { userId: id }),
    },
    {
      verb: 'promote',
      write: (a, id) => a.mutation(api.admin.grantRole, { userId: id, role: 'moderator' }),
    },
    {
      verb: 'demote',
      prep: { role: 'moderator' },
      write: (a, id) => a.mutation(api.admin.revokeRole, { userId: id, reason: 'r' }),
    },
    {
      verb: 'ledger given',
      prep: { role: 'admin' },
      write: (a, id) => a.mutation(api.ledger.grantEditor, { userId: id }),
    },
    {
      verb: 'ledger taken',
      prep: { role: 'admin', canEditLedger: true },
      write: (a, id) => a.mutation(api.ledger.revokeEditor, { userId: id, reason: 'r' }),
    },
  ];
  for (const { verb, prep, write } of VERBS) {
    test(verb, async () => {
      const t = await setup();
      await seed(t, 'adm', { role: 'admin', canEditLedger: true });
      const id = await seed(t, 'them', prep);
      const a = as(t, 'adm');
      const out = await write(a, id);
      const toast = await a.query(api.undo.latestOwn, { targetType: 'user', targetId: id });
      expect(toast?.undo).toEqual({ state: 'available', needsReason: out.undoNeedsReason });
      // The undo itself: refused without a reason exactly when it asks one.
      const bare = a.mutation(api.undo.run, { actionId: out.actionId });
      if (out.undoNeedsReason) await expect(bare).rejects.toThrow(/reason/i);
      else await bare;
    });
  }
});

describe('a person write offers its undo only when the undo is available to this viewer now', () => {
  const STATES: Record<string, Partial<Doc<'profiles'>>> = {
    active: {},
    suspended: { status: 'suspended', suspendedUntil: T0 + DAY },
    // Run out, not yet reset by the sweep.
    lapsed: { status: 'suspended', suspendedUntil: T0 - DAY },
    openEnded: { status: 'suspended' },
    banned: { status: 'banned' },
    restricted: { canPostComments: false, canFlag: false, activeBountyPostLimit: 0 },
    moderator: { role: 'moderator' },
    admin: { role: 'admin' },
    holder: { role: 'admin', canEditLedger: true },
  };
  // biome-ignore lint/suspicious/noExplicitAny: each write's own answer
  const WRITES: Record<string, (a: ReturnType<typeof as>, id: Id<'profiles'>) => Promise<any>> = {
    suspend: (a, id) =>
      a.mutation(api.moderation.suspendUser, {
        userId: id,
        reason: 'r',
        suspendedUntil: T0 + 2 * DAY,
      }),
    ban: (a, id) => a.mutation(api.moderation.banUser, { userId: id, reason: 'r' }),
    lift: (a, id) => a.mutation(api.moderation.unbanUser, { userId: id }),
    rightOff: (a, id) =>
      a.mutation(api.moderation.setPostingPermission, {
        userId: id,
        permission: 'reports',
        allowed: false,
        reason: 'r',
      }),
    rightBack: (a, id) =>
      a.mutation(api.moderation.setPostingPermission, {
        userId: id,
        permission: 'comments',
        allowed: true,
      }),
    bounty: (a, id) =>
      a.mutation(api.moderation.setBountyPostLimit, { userId: id, limit: 3, reason: 'r' }),
    promote: (a, id) => a.mutation(api.admin.grantRole, { userId: id, role: 'admin' }),
    demote: (a, id) => a.mutation(api.admin.revokeRole, { userId: id, reason: 'r' }),
    ledgerOn: (a, id) => a.mutation(api.ledger.grantEditor, { userId: id }),
    ledgerOff: (a, id) => a.mutation(api.ledger.revokeEditor, { userId: id, reason: 'r' }),
  };

  test('returned ⇒ available, not returned ⇒ not available, over every state and every person write', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...Object.keys(STATES)),
        fc.constantFrom(...Object.keys(WRITES)),
        async (state, write) => {
          vi.setSystemTime(T0);
          const t = await setup();
          await seed(t, 'adm', { role: 'admin', canEditLedger: true });
          const id = await seed(t, 'them', STATES[state]);
          const a = as(t, 'adm');
          // A write the server refuses offers nothing: there is no answer to read.
          const out = await (WRITES[write] as NonNullable<(typeof WRITES)[string]>)(a, id).catch(
            () => null,
          );
          if (out === null) return;
          const toast = await a.query(api.undo.latestOwn, { targetType: 'user', targetId: id });
          if (out.undoable) {
            expect(toast?.actionId, `${state}/${write}`).toBe(out.actionId);
            expect(toast?.undo, `${state}/${write}`).toEqual({
              state: 'available',
              needsReason: out.undoNeedsReason,
            });
          } else {
            expect(out.actionId, `${state}/${write}`).toBeUndefined();
            expect(toast?.undo.state, `${state}/${write}`).not.toBe('available');
          }
        },
      ),
      { numRuns: 24 },
    );
  });

  test('the cases that can’t be undone now say so: a lift of a run-out suspension, of an active account', async () => {
    for (const state of ['lapsed', 'active', 'openEnded'] as const) {
      vi.setSystemTime(T0);
      const t = await setup();
      await seed(t, 'adm', { role: 'admin' });
      const id = await seed(t, 'them', STATES[state]);
      const out = await as(t, 'adm').mutation(api.moderation.unbanUser, { userId: id });
      expect(out, state).toEqual({ userId: id, undoable: false });
    }
  });
});

// ── `can`: the ledger sentence for holders only, and every give-back spelled out ──

describe('can', () => {
  test('the last-editor refusal names the holder only to holders; the write still says it', async () => {
    const t = await setup();
    await seed(t, 'mod', { role: 'moderator' });
    await seed(t, 'plain', { role: 'admin' });
    const holder = await seed(t, 'holder', { role: 'admin', canEditLedger: true });
    const forMod = await as(t, 'mod').query(api.people.person, { userId: holder });
    // Before, a moderator read `{ ok: false, why: LAST_EDITOR_MESSAGE }` here.
    expect(forMod?.can.suspend).toEqual({ ok: false, why: 'Only an admin can moderate an admin' });
    const forAdmin = await as(t, 'plain').query(api.people.person, { userId: holder });
    expect(forAdmin?.can.suspend).toEqual({ ok: false, why: LEDGER_NEUTRAL_REFUSAL });
    expect(forAdmin?.can.ban).toEqual({ ok: false, why: LEDGER_NEUTRAL_REFUSAL });
    expect(forAdmin?.can.role.moderator).toEqual({ ok: false, why: LEDGER_NEUTRAL_REFUSAL });
    // The holder themself reads it in full on their own page's refusals (self first, here), and
    // the write keeps its own words for anyone who presses it.
    await expect(
      as(t, 'plain').mutation(api.moderation.banUser, { userId: holder, reason: 'r' }),
    ).rejects.toThrow(LAST_EDITOR_MESSAGE);
  });

  test('every give-back and the bounty limit both ways, as the writes answer them', async () => {
    const t = await setup();
    await seed(t, 'mod', { role: 'moderator' });
    const skater = await seed(t, 'skater', {
      canPostComments: false,
      canFlag: false,
      status: 'suspended',
      suspendedUntil: T0 + DAY,
    });
    const can = (await as(t, 'mod').query(api.people.person, { userId: skater }))?.can;
    expect(can?.restore).toEqual({
      reports: { ok: true, needsReason: false },
      hazards: { ok: true, needsReason: false },
      comments: { ok: true, needsReason: false },
    });
    expect(can?.flaggingOn).toEqual({ ok: true, needsReason: false });
    expect(can?.bountyRaise).toEqual({ ok: true, needsReason: false });
    expect(can?.bountyLower).toEqual({ ok: true, needsReason: true });
    expect(can?.extend).toEqual({ ok: true, needsReason: true });
    // Each, pressed, goes through without a reason where none is asked.
    await as(t, 'mod').mutation(api.moderation.setPostingPermission, {
      userId: skater,
      permission: 'comments',
      allowed: true,
    });
    await as(t, 'mod').mutation(api.moderation.setBountyPostLimit, { userId: skater, limit: 9 });
    // Not suspended: no suspension to extend.
    const active = await seed(t, 'active');
    expect(
      (await as(t, 'mod').query(api.people.person, { userId: active }))?.can.extend,
    ).toMatchObject({ ok: false });
  });
});

// ── The person page's new fields ──

describe('people.person: when, the public profile, labels and appeals', () => {
  test('rights since, ledger since, the public profile, flag labels, appeal text for admins', async () => {
    const t = await setup();
    await seed(t, 'mod', { role: 'moderator' });
    const adm = await seed(t, 'adm', { role: 'admin', canEditLedger: true });
    const skater = await seed(t, 'skater', { profileVisibility: 'private' });
    vi.setSystemTime(T0 - 2 * DAY);
    await as(t, 'adm').mutation(api.moderation.setPostingPermission, {
      userId: skater,
      permission: 'hazards',
      allowed: false,
      reason: 'r',
    });
    vi.setSystemTime(T0);
    const body = await t.run((ctx) =>
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
    await t.run(async (ctx) => {
      await rebuildBodyLibrary(ctx, body);
      const report = await ctx.db.insert('reports', {
        authorId: skater,
        waterBodyId: body,
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
      });
      await ctx.db.insert('contentFlags', {
        flaggerId: adm,
        targetType: 'report',
        targetId: report,
        reason: 'spam',
        status: 'open',
        subjectUserId: skater,
        createdAt: T0,
      });
      await ctx.db.insert('supportTickets', {
        userId: skater,
        clerkUserId: 'skater',
        category: 'account',
        status: 'open',
        body: 'Please lift it',
        createdAt: T0,
      });
    });
    const forAdm = await as(t, 'adm').query(api.people.person, { userId: skater });
    expect(forAdm?.rightsSince).toEqual({
      reports: null,
      hazards: T0 - 2 * DAY,
      comments: null,
      flagging: null,
    });
    expect(forAdm?.rightsSinceCapped).toBe(false);
    expect(forAdm?.publicProfile).toEqual({ opens: true, private: true, path: '/u/skater' });
    expect(forAdm?.open.flags[0]?.targetLabel).toBe('Mascoma Lake');
    expect(forAdm?.open.flagLabelsCapped).toBe(false);
    expect(forAdm?.open.appeals?.[0]?.body).toBe('Please lift it');
    expect(
      (await as(t, 'mod').query(api.people.person, { userId: skater }))?.open.appeals,
    ).toBeNull();
    // The ledger's grant time, holders only.
    await as(t, 'adm').mutation(api.ledger.grantEditor, {
      userId: await seed(t, 'two', { role: 'admin' }),
    });
    const two = (await t.run((ctx) => ctx.db.query('profiles').collect())).find(
      (p) => p.username === 'two',
    )?._id as Id<'profiles'>;
    expect((await as(t, 'adm').query(api.people.person, { userId: two }))?.ledger?.since).toBe(T0);
    // A deleted account's profile doesn't open.
    const gone = await seed(t, 'gone', { status: 'deleted', deletedAt: T0 });
    expect(
      (await as(t, 'adm').query(api.people.person, { userId: gone }))?.publicProfile.opens,
    ).toBe(false);
  });

  test('the bounty season line: this season’s asks, or not recorded outside the gate’s record', async () => {
    const t = await setup();
    await seed(t, 'mod', { role: 'moderator' });
    const skater = await seed(t, 'skater');
    const body = await t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        name: 'Pond',
        searchText: 'Pond',
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
    await t.run(async (ctx) => {
      for (const decision of ['allowed', 'capped', 'capped', 'suppressed'] as const) {
        await ctx.db.insert('bountyGateEvents', {
          waterBodyId: body,
          requesterId: skater,
          decision,
          weatherReopened: false,
          createdAt: T0 - DAY,
        });
      }
      // Last season: not this season's.
      await ctx.db.insert('bountyGateEvents', {
        waterBodyId: body,
        requesterId: skater,
        decision: 'capped',
        weatherReopened: false,
        createdAt: Date.UTC(2026, 5, 1),
      });
    });
    const line = (await as(t, 'mod').query(api.people.person, { userId: skater }))?.bountySeason;
    expect(line).toEqual({
      since: Date.UTC(2026, 6, 1),
      asks: { count: 4, capped: false },
      overLimit: { count: 2, capped: false },
      hadRecentReport: { count: 1, capped: false },
    });
    // Late in the season, its start is past the gate's 180-day record: not recorded.
    vi.setSystemTime(Date.UTC(2027, 1, 1));
    expect(
      (await as(t, 'mod').query(api.people.person, { userId: skater }))?.bountySeason,
    ).toBeNull();
  });
});

describe('a person at the worst case on every axis at once: every read answers, never throws', () => {
  test('flags, tickets, filed flags, decisions, restrictions, right rows and asks all at their caps', async () => {
    const t = await setup();
    const REASON = 'r'.repeat(AUDIT_REASON_MAX);
    await seed(t, 'adm', { role: 'admin', canEditLedger: true });
    await seed(t, 'adm2', { role: 'admin', canEditLedger: true });
    const big = await seed(t, 'big', {
      role: 'admin',
      canEditLedger: true,
      status: 'suspended',
      suspendedUntil: T0 + DAY,
      statusReason: REASON,
      canPostReports: false,
      canPostHazards: false,
      canPostComments: false,
      canFlag: false,
      activeBountyPostLimit: 0,
    });
    await t.run(async (ctx) => {
      const body = await ctx.db.insert('waterBodies', {
        name: 'B'.repeat(3_000),
        searchText: 'b',
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
      });
      const reports: Id<'reports'>[] = [];
      for (let i = 0; i < 25; i++) {
        reports.push(
          await ctx.db.insert('reports', {
            authorId: big,
            waterBodyId: body,
            point: { lat: 0.5, lng: 0.5 },
            skateEndTime: T0,
            reportTime: T0,
            source: 'native' as const,
            iceTypes: [{ type: 'black_ice' as const }],
            surfaceTags: [],
            photoIds: [],
            moderationStatus: 'visible' as const,
            hazardIdsCreated: [],
            notes: REASON,
            createdAt: T0,
            updatedAt: T0,
          }),
        );
      }
      for (const status of ['open', 'reviewing'] as const) {
        for (let i = 0; i <= 50; i++) {
          await ctx.db.insert('contentFlags', {
            flaggerId: big,
            targetType: 'user',
            targetId: big,
            reason: 'spam',
            status,
            subjectUserId: big,
            createdAt: T0 - i,
          });
        }
        for (let i = 0; i <= 100; i++) {
          await ctx.db.insert('contentFlags', {
            flaggerId: big,
            targetType: 'report',
            targetId: reports[i % reports.length] as string,
            reason: 'spam',
            status,
            subjectUserId: big,
            createdAt: T0 - i,
          });
        }
      }
      for (let i = 0; i <= 50; i++) {
        await ctx.db.insert('supportTickets', {
          userId: big,
          clerkUserId: 'big',
          category: 'account',
          status: 'open',
          body: 'b'.repeat(5_000),
          createdAt: T0 - i,
        });
      }
      for (let i = 0; i < 60; i++) {
        await ctx.db.insert('moderationActions', {
          actorId: big,
          action: 'set_posting_permission',
          targetType: 'user',
          targetId: big,
          reason: REASON,
          metadata: { permission: 'comments', allowed: true, note: REASON },
          createdAt: T0 - 10_000 - i,
        });
      }
      for (let i = 0; i < 300; i++) {
        await ctx.db.insert('moderationActions', {
          actorId: big,
          action: 'hide',
          targetType: 'report',
          targetId: reports[i % reports.length] as string,
          reason: REASON,
          createdAt: T0 - 1_000 - i,
        });
      }
      for (let i = 0; i <= 500; i++) {
        await ctx.db.insert('bountyGateEvents', {
          waterBodyId: body,
          requesterId: big,
          decision: 'capped',
          weatherReopened: false,
          createdAt: T0 - i,
        });
      }
    });
    const a = as(t, 'adm');
    const person = await a.query(api.people.person, { userId: big });
    // The fixed parts are always there, whatever the variable parts spent.
    expect(person?.publicProfile).toMatchObject({ opens: true });
    expect(person?.ledger).toMatchObject({ editor: true });
    expect(person?.can.role.member).toBeDefined();
    expect(person?.open.flagsCapped).toBe(true);
    expect(person?.bountySeason?.asks.capped).toBe(true);
    // And every other read of them answers.
    expect(await a.query(api.people.history, { userId: big })).not.toBeNull();
    expect(await a.query(api.people.decisions, { userId: big })).not.toBeNull();
    expect(await a.query(api.people.staffStats, { userId: big })).not.toBeNull();
    expect(await a.query(api.people.staffSeason, { userId: big })).not.toBeNull();
    expect(await a.query(api.people.reportTrend, { userId: big })).not.toBeNull();
    for (const lane of ['flagged', 'appeals', 'staff', 'suspended', 'restricted']) {
      expect((await a.query(api.people.listPage, { lane })).rows.length, lane).toBeGreaterThan(0);
    }
  });
});

describe('a “since” is the start of the current unbroken state (lib/stateSince)', () => {
  test('property: the last real transition into the current state; capped exactly when it lies past the rows read', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ by: fc.integer({ min: 0, max: 3 }), off: fc.boolean() }), {
          minLength: 1,
          maxLength: 30,
        }),
        fc.integer({ min: 1, max: 30 }),
        (ops, window) => {
          // Each op records what it found and what it set; repeats by other staff change nothing.
          let state = false;
          const history = ops.map((op, i) => {
            const row = { at: i + 1, before: state, after: op.off, by: op.by };
            state = op.off;
            return row;
          });
          const newestFirst = [...history].reverse();
          const read = newestFirst.slice(0, window);
          const complete = window >= history.length;
          const got = startOfCurrentState(
            read,
            (r) => ({ at: r.at, after: r.after, before: r.before }),
            state,
            complete,
          );
          const last = newestFirst.find((r) => r.before !== r.after);
          if (last === undefined) {
            // Never changed from where the record starts: no start on record.
            expect(got).toMatchObject({ since: null, capped: !complete });
          } else if (read.includes(last)) {
            expect(got).toMatchObject({ since: last.at, capped: false });
          } else {
            expect(got).toMatchObject({ since: null, capped: true });
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  test('rows about something else are passed over; a row with no prev is a change; a change that led elsewhere says not recorded', () => {
    type Row = { at: number; after?: string; before?: string };
    const since = (rows: Row[], complete: boolean) =>
      startOfCurrentState(
        rows,
        (r) => ({ at: r.at, after: r.after, before: r.before }),
        'off',
        complete,
      );
    // A row that isn't about this state (another right's, a bounty limit's) is skipped.
    expect(
      since(
        [{ at: 3 }, { at: 2, after: 'off', before: 'off' }, { at: 1, after: 'off', before: 'on' }],
        true,
      ),
    ).toMatchObject({ since: 1, capped: false });
    // A row from before `prev` was recorded is taken as the change, though it may have repeated.
    expect(
      since(
        [
          { at: 2, after: 'off' },
          { at: 1, after: 'off', before: 'on' },
        ],
        true,
      ),
    ).toEqual({
      since: 2,
      row: { at: 2, after: 'off' },
      capped: false,
    });
    // The newest real change led elsewhere: the record and the state disagree — not recorded, never
    // capped, and never an older row's date.
    expect(
      since(
        [
          { at: 2, after: 'on', before: 'off' },
          { at: 1, after: 'off', before: 'on' },
        ],
        false,
      ),
    ).toEqual({ since: null, row: null, capped: false });
    // Only repeats and unrelated rows: capped exactly when rows were left unread.
    expect(since([{ at: 2 }, { at: 1, after: 'off', before: 'off' }], false)).toMatchObject({
      since: null,
      capped: true,
    });
    expect(since([], true)).toEqual({ since: null, row: null, capped: false });
  });

  test('a second moderator restricting a right already off, or banning a banned account, moves no date', async () => {
    const t = await setup();
    await seed(t, 'mod', { role: 'moderator' });
    await seed(t, 'mod2', { role: 'moderator' });
    const skater = await seed(t, 'skater');
    const restrict = (who: string) =>
      as(t, who).mutation(api.moderation.setPostingPermission, {
        userId: skater,
        permission: 'comments',
        allowed: false,
        reason: 'r',
      });
    vi.setSystemTime(T0 - 3 * DAY);
    await restrict('mod');
    await as(t, 'mod').mutation(api.moderation.banUser, { userId: skater, reason: 'first' });
    vi.setSystemTime(T0 - DAY);
    await restrict('mod2');
    await as(t, 'mod2').mutation(api.moderation.banUser, { userId: skater, reason: 'again' });
    vi.setSystemTime(T0);
    const p = await as(t, 'mod').query(api.people.person, { userId: skater });
    expect(p?.rightsSince.comments).toBe(T0 - 3 * DAY);
    expect(p?.statusNote).toMatchObject({ action: 'ban', at: T0 - 3 * DAY, atCapped: false });
    // The date is the start's; who and why are the newest write's, never one's words on the other.
    expect(p?.statusNote).toMatchObject({ reason: 'again' });
    expect(p?.statusNote?.by?.username).toBe('mod2');
  });

  test('a suspension’s new window keeps its start; a walk that runs out of rows says can’t say', async () => {
    const t = await setup();
    await seed(t, 'mod', { role: 'moderator' });
    const skater = await seed(t, 'skater');
    vi.setSystemTime(T0 - 20 * DAY);
    await as(t, 'mod').mutation(api.moderation.suspendUser, {
      userId: skater,
      reason: 'r',
      suspendedUntil: T0 + 30 * DAY,
    });
    for (let i = 0; i < 12; i++) {
      vi.setSystemTime(T0 - 19 * DAY + i * DAY);
      await as(t, 'mod').mutation(api.moderation.suspendUser, {
        userId: skater,
        reason: 'r',
        suspendedUntil: T0 + 31 * DAY + i,
      });
      if (i === 1) {
        // Two new windows in: the walk reaches the start, which they didn't move.
        const early = await as(t, 'mod').query(api.people.person, { userId: skater });
        expect(early?.statusNote).toMatchObject({ at: T0 - 20 * DAY, atCapped: false });
      }
    }
    vi.setSystemTime(T0);
    const p = await as(t, 'mod').query(api.people.person, { userId: skater });
    // Twelve new windows after the start: past the ten rows the note walks back, so it can't say.
    expect(p?.statusNote).toMatchObject({ at: null, atCapped: true });
  });

  test('a suspension after one that had run out (before the sweep reset it) begins a new one', async () => {
    const t = await setup();
    await seed(t, 'mod', { role: 'moderator' });
    await seed(t, 'mod2', { role: 'moderator' });
    const skater = await seed(t, 'skater');
    vi.setSystemTime(T0 - 20 * DAY);
    await as(t, 'mod').mutation(api.moderation.suspendUser, {
      userId: skater,
      reason: 'first',
      suspendedUntil: T0 - 10 * DAY,
    });
    // The window ran out; no sweep ran, so the stored status still says suspended.
    vi.setSystemTime(T0 - 5 * DAY);
    await as(t, 'mod2').mutation(api.moderation.suspendUser, {
      userId: skater,
      reason: 'second',
      suspendedUntil: T0 + 10 * DAY,
    });
    vi.setSystemTime(T0);
    const p = await as(t, 'mod').query(api.people.person, { userId: skater });
    expect(p?.statusNote).toMatchObject({ at: T0 - 5 * DAY, atCapped: false });
    expect(p?.statusNote?.by?.username).toBe('mod2');
  });

  test('the walk is held to its weight: heavy repeats past one document say can’t say, before the row count', async () => {
    const t = await setup();
    const mod = await seed(t, 'mod', { role: 'moderator' });
    const skater = await seed(t, 'skater');
    vi.setSystemTime(T0 - 10 * DAY);
    await as(t, 'mod').mutation(api.moderation.banUser, { userId: skater, reason: 'first' });
    await t.run(async (ctx) => {
      // Three repeats of the ban, each weighing over a third of a document.
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert('moderationActions', {
          actorId: mod,
          action: 'ban',
          targetType: 'user',
          targetId: skater,
          reason: 'again',
          metadata: {
            prev: { status: 'banned', statusReason: 'first', suspendedUntil: null },
            note: 'n'.repeat(400_000),
          },
          createdAt: T0 - 5 * DAY + i,
        });
      }
    });
    vi.setSystemTime(T0);
    const p = await as(t, 'mod').query(api.people.person, { userId: skater });
    // Within ten rows, but past the walk's weight: the start lies past it, so it can't say.
    expect(p?.statusNote).toMatchObject({ at: null, atCapped: true });
  });
});

// ── The list page ──

describe('people.listPage: keys, ends, ages and the Staff lane', () => {
  test('Flagged rows carry their oldest open flag, the order they are listed in', async () => {
    const t = await setup();
    await seed(t, 'mod', { role: 'moderator' });
    const filer = await seed(t, 'filer');
    const early = await seed(t, 'early');
    const late = await seed(t, 'late');
    await t.run(async (ctx) => {
      for (const [who, at] of [
        [late, T0 - DAY],
        [early, T0 - 3 * DAY],
        [early, T0 - 2 * DAY],
      ] as const) {
        await ctx.db.insert('contentFlags', {
          flaggerId: filer,
          targetType: 'user',
          targetId: who,
          reason: 'spam',
          status: 'open',
          subjectUserId: who,
          createdAt: at,
        });
      }
    });
    const page = await as(t, 'mod').query(api.people.listPage, { lane: 'flagged' });
    expect(page.rows.map((r) => [r.userId, r.oldestOpenAt])).toEqual([
      [early, T0 - 3 * DAY],
      [late, T0 - DAY],
    ]);
    // A later page is keyed by the lane's order: the first person leaving moves nothing.
    const first = await as(t, 'mod').query(api.people.listPage, { lane: 'flagged', pageSize: 1 });
    await t.run(async (ctx) => {
      for (const f of await ctx.db.query('contentFlags').collect()) {
        if (f.targetId === early) await ctx.db.patch(f._id, { status: 'actioned' });
      }
    });
    const rest = await as(t, 'mod').query(api.people.listPage, {
      lane: 'flagged',
      cursor: first.continueCursor,
    });
    expect(rest.rows.map((r) => r.userId)).toEqual([late]);
  });

  test('a page read to its end cursor neither drops nor repeats a row when an earlier page grows', async () => {
    const t = await setup();
    await seed(t, 'mod', { role: 'moderator' });
    for (const name of ['b', 'd', 'f', 'h']) await seed(t, name);
    const first = await as(t, 'mod').query(api.people.listPage, { lane: 'everyone', pageSize: 2 });
    const second = await as(t, 'mod').query(api.people.listPage, {
      lane: 'everyone',
      pageSize: 2,
      cursor: first.continueCursor,
    });
    // Someone joins inside the second page's range: read to its end, it grows by them and drops no
    // one into the next page (read by count alone, `h` would fall off it).
    await seed(t, 'e');
    const again = await as(t, 'mod').query(api.people.listPage, {
      lane: 'everyone',
      pageSize: 2,
      cursor: first.continueCursor,
      endCursor: second.continueCursor,
    });
    expect(second.rows.map((r) => r.username)).toEqual(['f', 'h']);
    expect(again.rows.map((r) => r.username)).toEqual(['e', 'f', 'h']);
    expect(again.continueCursor).toBe(second.continueCursor);
  });

  test('Staff rows: last seen in the console (within the record), role since as the strip says, this week’s decisions', async () => {
    const t = await setup();
    const adm = await seed(t, 'adm', { role: 'admin' });
    const mod = await seed(t, 'mod', { role: 'moderator' });
    const skater = await seed(t, 'skater');
    await as(t, 'adm').mutation(api.admin.grantRole, { userId: skater, role: 'moderator' });
    await as(t, 'adm').mutation(api.moderation.suspendUser, {
      userId: await seed(t, 's2'),
      reason: 'r',
      suspendedUntil: T0 + DAY,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert('consolePresence', { userId: adm, seenAt: T0 - 60_000 });
      // Seen before the previous season began: past the record's retention, not recorded.
      await ctx.db.insert('consolePresence', { userId: mod, seenAt: Date.UTC(2024, 0, 1) });
    });
    const rows = (await as(t, 'adm').query(api.people.listPage, { lane: 'staff' })).rows;
    const byId = new Map(rows.map((r) => [r.userId, r.staff]));
    expect(byId.get(adm)?.lastSeenInConsoleAt).toBe(T0 - 60_000);
    expect(byId.get(mod)?.lastSeenInConsoleAt).toBeNull();
    const stats = await as(t, 'adm').query(api.people.staffStats, { userId: skater });
    expect(byId.get(skater)?.roleSince).toBe(stats?.roleSince?.at);
    // Seeded straight into the table, never stamped: it can't say yet — capped, not "not recorded".
    expect(byId.get(mod)).toMatchObject({ roleSince: null, roleSinceCapped: true });
    expect(byId.get(skater)?.roleSince).toBe(T0);
    const admStats = await as(t, 'adm').query(api.people.staffStats, { userId: adm });
    expect(byId.get(adm)?.decisionsThisWeek).toEqual(admStats?.decisions.thisWeek);
    expect(byId.get(adm)?.decisionsThisWeek.count).toBe(2);
    // Other lanes don't carry the Staff columns.
    const everyone = await as(t, 'adm').query(api.people.listPage, { lane: 'everyone' });
    expect(everyone.rows.every((r) => r.staff === null && r.oldestOpenAt === null)).toBe(true);
  });

  test('a role undone twice: the row’s stamp and the strip agree on the original date', async () => {
    const t = await setup();
    await seed(t, 'adm', { role: 'admin' });
    const skater = await seed(t, 'skater');
    const grant = undoable(
      await as(t, 'adm').mutation(api.admin.grantRole, {
        userId: skater,
        role: 'moderator',
      }),
    );
    vi.setSystemTime(T0 + 1_000);
    await as(t, 'adm').mutation(api.undo.run, { actionId: grant.actionId, reason: 'oops' });
    const undo = await t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_undoes', (q) => q.eq('undoesActionId', grant.actionId))
        .first(),
    );
    vi.setSystemTime(T0 + 2_000);
    await as(t, 'adm').mutation(api.undo.run, {
      actionId: undo?._id as Id<'moderationActions'>,
    });
    const row = await t.run((ctx) =>
      ctx.db
        .query('peopleRows')
        .withIndex('by_user', (q) => q.eq('userId', skater))
        .first(),
    );
    const stats = await as(t, 'adm').query(api.people.staffStats, { userId: skater });
    expect(row?.roleSince).toBe(T0);
    expect(stats?.roleSince?.at).toBe(T0);
  });

  test('an admin reads a Staff lane of many staff, each seen lately, whole — not over its budget', async () => {
    const t = await setup();
    const ids = [await seed(t, 'adm', { role: 'admin' })];
    for (let i = 0; i < 40; i++) ids.push(await seed(t, `m${i}`, { role: 'moderator' }));
    await t.run(async (ctx) => {
      for (const id of ids) await ctx.db.insert('consolePresence', { userId: id, seenAt: T0 - 1 });
    });
    const page = await as(t, 'adm').query(api.people.listPage, { lane: 'staff', pageSize: 100 });
    expect(page.rows).toHaveLength(41);
    expect(page.rows.every((r) => r.staff?.lastSeenInConsoleAt === T0 - 1)).toBe(true);
    expect(page.rows.every((r) => r.staff?.lastSeenCapped === false)).toBe(true);
    expect(page.rows.every((r) => r.staff?.decisionsThisWeek.capped === false)).toBe(true);
  });

  test('staff who share a name are each listed once across pages', async () => {
    const t = await setup();
    await seed(t, 'adm', { role: 'admin' });
    // Created in one order, keyed (rank, name, id) in another: the page must cut by the key.
    for (let i = 0; i < 4; i++)
      await seed(t, `twin${i}`, { role: 'moderator', displayName: 'Sam' });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page: { rows: { userId: string }[]; isDone: boolean; continueCursor: string } =
        await as(t, 'adm').query(api.people.listPage, { lane: 'staff', pageSize: 1, cursor });
      seen.push(...page.rows.map((r) => r.userId));
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  test('a page read to its end keeps that end as its continue cursor when its last row leaves', async () => {
    const t = await setup();
    await seed(t, 'adm', { role: 'admin' });
    const a = await seed(t, 'a', { role: 'moderator' });
    await seed(t, 'b', { role: 'moderator' });
    const first = await as(t, 'adm').query(api.people.listPage, { lane: 'staff', pageSize: 2 });
    await as(t, 'adm').mutation(api.admin.revokeRole, { userId: a, reason: 'r' });
    const again = await as(t, 'adm').query(api.people.listPage, {
      lane: 'staff',
      pageSize: 2,
      endCursor: first.continueCursor,
    });
    expect(again.continueCursor).toBe(first.continueCursor);
  });
});

describe('people.person under a heavy page', () => {
  async function lake(t: T, name: string) {
    return t.run(async (ctx) => {
      const body = await ctx.db.insert('waterBodies', {
        name,
        searchText: name,
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
      });
      await rebuildBodyLibrary(ctx, body);
      return body;
    });
  }

  const report = (authorId: Id<'profiles'>, waterBodyId: Id<'waterBodies'>) => ({
    authorId,
    waterBodyId,
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
  });

  test('a dozen flagged Reports on one lake: every flag labeled, the lake read once, nothing thrown', async () => {
    const t = await setup();
    const adm = await seed(t, 'adm', { role: 'admin' });
    const skater = await seed(t, 'skater');
    const body = await lake(t, 'Mascoma Lake');
    await t.run(async (ctx) => {
      for (let i = 0; i < 12; i++) {
        const r = await ctx.db.insert('reports', report(skater, body));
        await ctx.db.insert('contentFlags', {
          flaggerId: adm,
          targetType: 'report',
          targetId: r,
          reason: 'spam',
          status: 'open',
          subjectUserId: skater,
          createdAt: T0 + i,
        });
      }
    });
    const page = await as(t, 'adm').query(api.people.person, { userId: skater });
    expect(page?.open.flags).toHaveLength(12);
    expect(page?.open.flags.every((f) => f.targetLabel === 'Mascoma Lake')).toBe(true);
    expect(page?.open.flagLabelsCapped).toBe(false);
    expect(page?.publicProfile.opens).toBe(true);
  });

  test('a flagged Post is labeled by the lake of the Report it carries, as the Inbox names it', async () => {
    const t = await setup();
    const adm = await seed(t, 'adm', { role: 'admin' });
    const skater = await seed(t, 'skater');
    const body = await lake(t, 'Sunapee');
    await t.run(async (ctx) => {
      const r = await ctx.db.insert('reports', report(skater, body));
      const post = await ctx.db.insert('posts', {
        authorId: skater,
        reportIds: [r],
        photoIds: [],
        latestSkateEndTime: T0,
        moderationStatus: 'visible',
        createdAt: T0,
        updatedAt: T0,
      });
      await ctx.db.insert('contentFlags', {
        flaggerId: adm,
        targetType: 'post',
        targetId: post,
        reason: 'spam',
        status: 'open',
        subjectUserId: skater,
        createdAt: T0,
      });
    });
    const page = await as(t, 'adm').query(api.people.person, { userId: skater });
    expect(page?.open.flags[0]?.targetLabel).toBe('Sunapee');
  });

  test('a staffer whose flagging was switched off before promotion has no "off since" for it', async () => {
    const t = await setup();
    await seed(t, 'adm', { role: 'admin' });
    const mod = await seed(t, 'mod');
    await as(t, 'adm').mutation(api.moderation.setPostingPermission, {
      userId: mod,
      permission: 'flagging',
      allowed: false,
      reason: 'r',
    });
    await as(t, 'adm').mutation(api.admin.grantRole, { userId: mod, role: 'moderator' });
    const page = await as(t, 'adm').query(api.people.person, { userId: mod });
    expect(page?.rights.flagging).toBe(true);
    expect(page?.rightsSince.flagging).toBeNull();
    expect(page?.rightsSinceCapped).toBe(false);
  });
});

describe('lib/staffTenure at its edges', () => {
  test('a read with no budget left says short; a stamp for someone with no row does nothing', async () => {
    const t = await setup();
    const adm = await seed(t, 'adm', { role: 'admin' });
    const read = await t.run((ctx) => readTenure(ctx, new ReadBudget(0), adm, 'admin', true));
    expect(read).toMatchObject({ roleShort: true, tenure: { staffSince: null, roleSince: null } });
    const rowless = await t.run((ctx) =>
      ctx.db.insert('profiles', {
        clerkUserId: 'rowless',
        displayName: 'rowless',
        username: 'rowless',
        driveTimePrefMinutes: 60,
        profileVisibility: 'public' as const,
        notificationPrefs: NOTIF_PREFS,
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role: 'moderator' as const,
        status: 'active' as const,
        createdAt: T0,
      }),
    );
    await t.mutation(internal.peopleJobs.stampOne, { userId: rowless });
    expect(
      await t.run((ctx) =>
        ctx.db
          .query('peopleRows')
          .withIndex('by_user', (q) => q.eq('userId', rowless))
          .first(),
      ),
    ).toBeNull();
  });

  test('a demotion to member clears the stamp', async () => {
    const t = await setup();
    await seed(t, 'adm', { role: 'admin' });
    const skater = await seed(t, 'skater');
    await as(t, 'adm').mutation(api.admin.grantRole, { userId: skater, role: 'moderator' });
    await as(t, 'adm').mutation(api.admin.revokeRole, { userId: skater, reason: 'r' });
    const row = await t.run((ctx) =>
      ctx.db
        .query('peopleRows')
        .withIndex('by_user', (q) => q.eq('userId', skater))
        .first(),
    );
    expect(row?.tenureAt).toBeUndefined();
    expect(row?.roleSince).toBeUndefined();
  });
});

describe('a page bounded by its end holds at most the cap and says where to split, on every lane', () => {
  test('a range holding more rows than the cap: capped, with a split signal', async () => {
    const t = await setup();
    await seed(t, 'adm', { role: 'admin' });
    // 205 suspended moderators, all matching one search: in Everyone, Staff, Suspended and the search.
    await t.run(async (ctx) => {
      for (let i = 0; i < 205; i++) {
        const id = await ctx.db.insert('profiles', {
          clerkUserId: `m${i}`,
          displayName: `skater ${String(i).padStart(3, '0')}`,
          username: `m${String(i).padStart(3, '0')}`,
          driveTimePrefMinutes: 60,
          profileVisibility: 'public' as const,
          notificationPrefs: NOTIF_PREFS,
          dateOfBirth: Date.UTC(1990, 0, 1),
          reputationPoints: 0,
          role: 'moderator' as const,
          status: 'suspended' as const,
          suspendedUntil: T0 + DAY + i,
          createdAt: T0 - 30 * DAY,
        });
        await refreshPersonRow(ctx, id);
      }
    });
    const a = as(t, 'adm');
    const cases: Array<{ lane: string; search?: string }> = [
      { lane: 'everyone' },
      { lane: 'staff' },
      { lane: 'suspended' },
      { lane: 'everyone', search: 'skater' },
    ];
    for (const c of cases) {
      // The range's end: read it through by pages of 100.
      let cursor: string | null = null;
      let end = '';
      for (let i = 0; i < 4; i++) {
        const page: { continueCursor: string; isDone: boolean } = await a.query(
          api.people.listPage,
          { ...c, pageSize: 100, cursor },
        );
        end = page.continueCursor;
        cursor = page.continueCursor;
        if (page.isDone) break;
      }
      const bounded = await a.query(api.people.listPage, { ...c, cursor: null, endCursor: end });
      expect(bounded.rows.length, c.lane).toBeLessThanOrEqual(200);
      expect(bounded.isDone, c.lane).toBe(false);
      expect((bounded as { pageStatus?: string }).pageStatus, c.lane).toMatch(/^Split/);
    }
  });
});

// ── staffStats: who undid, and the time bound ──

describe('people.staffStats', () => {
  test('undone by others names who, most first', async () => {
    const t = await setup();
    const matt = await seed(t, 'matt', { role: 'moderator' });
    const adm = await seed(t, 'adm', { role: 'admin' });
    await t.run(async (ctx) => {
      for (let i = 0; i < 2; i++) {
        const root = await ctx.db.insert('moderationActions', {
          actorId: matt,
          action: 'set_posting_permission',
          targetType: 'user',
          targetId: `x${i}`,
          reason: 'r',
          undoTop: 1,
          undoTopActorId: adm,
          createdAt: T0 - 1_000 - i,
        });
        await ctx.db.insert('moderationActions', {
          actorId: adm,
          action: 'set_posting_permission',
          targetType: 'user',
          targetId: `x${i}`,
          reason: 'r',
          undoesActionId: root,
          undoRoot: root,
          undoDepth: 1,
          createdAt: T0 - 500,
        });
      }
    });
    const s = await as(t, 'adm').query(api.people.staffStats, { userId: matt });
    expect(s?.decisions.undoneByOthers).toMatchObject({
      count: 2,
      capped: false,
      by: [{ userId: adm, displayName: 'adm', count: 2 }],
      byMore: 0,
    });
  });

  test('a week past the time bound says capped rather than running long', async () => {
    const t = await setup();
    const matt = await seed(t, 'matt', { role: 'moderator' });
    await seed(t, 'adm', { role: 'admin' });
    await t.run(async (ctx) => {
      for (let i = 0; i < 420; i++) {
        const flag = await ctx.db.insert('contentFlags', {
          flaggerId: matt,
          targetType: 'report',
          targetId: `r${i}`,
          reason: 'spam',
          status: 'actioned',
          subjectUserId: null,
          createdAt: T0 - DAY,
        });
        await ctx.db.insert('moderationActions', {
          actorId: matt,
          action: 'resolve_flag',
          targetType: 'contentFlag',
          targetId: flag,
          reason: 'r',
          createdAt: T0 - 1_000,
        });
      }
    });
    const s = await as(t, 'adm').query(api.people.staffStats, { userId: matt });
    expect(s?.decisions.thisWeek).toEqual({ count: 420, capped: false });
    expect(s?.timeToDecide).toMatchObject({ medianMs: null, decided: 420, capped: true });
  });

  test('the time bound counts the reads of both loops, exactly: 200 roots and 200 filings fit, one filing more is capped', async () => {
    const week = async (filings: number) => {
      const t = await setup();
      const matt = await seed(t, 'matt', { role: 'moderator' });
      const adm = await seed(t, 'adm', { role: 'admin' });
      await t.run(async (ctx) => {
        // Undos whose chain's first row is someone else's, outside the staffer's own read: a read each.
        for (let i = 0; i < 200; i++) {
          const root = await ctx.db.insert('moderationActions', {
            actorId: adm,
            action: 'set_posting_permission',
            targetType: 'user',
            targetId: `x${i}`,
            reason: 'r',
            undoTop: 1,
            undoTopActorId: matt,
            createdAt: T0 - 2 * DAY,
          });
          await ctx.db.insert('moderationActions', {
            actorId: matt,
            action: 'set_posting_permission',
            targetType: 'user',
            targetId: `x${i}`,
            reason: 'r',
            undoesActionId: root,
            undoRoot: root,
            undoDepth: 1,
            createdAt: T0 - 1_000,
          });
        }
        // Decisions on flags with no filing time on the row: a read each.
        for (let i = 0; i < filings; i++) {
          const flag = await ctx.db.insert('contentFlags', {
            flaggerId: adm,
            targetType: 'report',
            targetId: `r${i}`,
            reason: 'spam',
            status: 'actioned',
            subjectUserId: null,
            createdAt: T0 - DAY,
          });
          await ctx.db.insert('moderationActions', {
            actorId: matt,
            action: 'resolve_flag',
            targetType: 'contentFlag',
            targetId: flag,
            reason: 'r',
            createdAt: T0 - 1_000,
          });
        }
      });
      return as(t, 'adm').query(api.people.staffStats, { userId: matt });
    };
    const at = await week(200);
    expect(at?.decisions.undoneByOthers.capped).toBe(false);
    expect(at?.timeToDecide).toMatchObject({ decided: 200, capped: false });
    const past = await week(201);
    expect(past?.decisions.undoneByOthers.capped).toBe(false);
    expect(past?.timeToDecide).toMatchObject({ medianMs: null, decided: 201, capped: true });
  });
});

// ── The parked-lapse mirror, counted by Machinery ──

describe('a parked lapse is a small row Machinery counts', () => {
  test('three failed resets park it in the mirror; a lift clears it', async () => {
    const t = await setup();
    const adm = await seed(t, 'adm', { role: 'admin' });
    const skater = await seed(t, 'skater', { status: 'suspended', suspendedUntil: T0 - DAY });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rows = await import('./lib/peopleRows');
    for (let i = 0; i < 3; i++) {
      // Only this spy is restored each time: `restoreAllMocks` would take `quiet` with it.
      const poison = vi.spyOn(rows, 'refreshPersonRow').mockRejectedValueOnce(new Error('poison'));
      await t.mutation(internal.peopleJobs.sweepLapsedSuspensions, {});
      poison.mockRestore();
    }
    quiet.mockRestore();
    const health = await as(t, 'adm').query(api.recurringJobs.health, {});
    const lapses = health.jobs.find((j) => j.job === 'reset lapsed suspensions');
    expect(lapses).toMatchObject({ parked: 1, failing: 0 });
    await as(t, 'adm').mutation(api.moderation.unbanUser, { userId: skater });
    const after = await as(t, 'adm').query(api.recurringJobs.health, {});
    expect(after.jobs.find((j) => j.job === 'reset lapsed suspensions')).toMatchObject({
      parked: 0,
    });
    void adm;
  });
});

describe('the mirror check laps: kept mirrors never hold a stale one behind them', () => {
  test('more kept mirrors than a page, a stale one behind: reached within two daily runs', async () => {
    const t = await setup();
    const kept = MIRRORS_CHECKED + 5;
    const staleKey = await t.run(async (ctx) => {
      for (let i = 0; i < kept; i++) {
        // Parked, but in their deletion window: the retry passes them by and the check keeps them.
        const id = await ctx.db.insert('profiles', {
          clerkUserId: `k${i}`,
          displayName: `k${i}`,
          username: `k${i}`,
          driveTimePrefMinutes: 60,
          profileVisibility: 'public' as const,
          notificationPrefs: NOTIF_PREFS,
          dateOfBirth: Date.UTC(1990, 0, 1),
          reputationPoints: 0,
          role: 'member' as const,
          status: 'suspended' as const,
          suspendedUntil: T0 - DAY,
          deletionRequestedAt: T0 - DAY,
          lapseAttempts: 3,
          lapseErrorClass: 'x',
          lapseParkedAt: T0 - 5 * DAY,
          createdAt: T0 - 30 * DAY,
        });
        await ctx.db.insert('jobFailures', {
          job: 'lapses',
          key: id,
          attempts: 3,
          errorClass: 'x',
          firstFailedAt: T0 - 9 * DAY,
          lastFailedAt: T0 - 9 * DAY + i,
          parkedAt: T0 - 9 * DAY,
        });
      }
      // A mirror whose lapse went another way (the account is active now), newest of all.
      const gone = await ctx.db.insert('profiles', {
        clerkUserId: 'gone',
        displayName: 'gone',
        username: 'gone',
        driveTimePrefMinutes: 60,
        profileVisibility: 'public' as const,
        notificationPrefs: NOTIF_PREFS,
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role: 'member' as const,
        status: 'active' as const,
        createdAt: T0 - 30 * DAY,
      });
      await ctx.db.insert('jobFailures', {
        job: 'lapses',
        key: gone,
        attempts: 3,
        errorClass: 'x',
        firstFailedAt: T0 - DAY,
        lastFailedAt: T0 - DAY,
        parkedAt: T0 - DAY,
      });
      return gone as string;
    });
    const staleLeft = async () =>
      (await t.run((ctx) => ctx.db.query('jobFailures').collect())).some((f) => f.key === staleKey);
    // Each run walks every parked lapse (a few a pass, chained), then checks a page of mirrors.
    vi.useFakeTimers();
    let runs = 0;
    while ((await staleLeft()) && runs < 2) {
      vi.setSystemTime(T0 + runs * DAY);
      await t.mutation(internal.peopleJobs.retryLapsedDaily, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers, 200);
      runs++;
    }
    expect(await staleLeft()).toBe(false);
    // The kept ones are all still there.
    const left = await t.run((ctx) => ctx.db.query('jobFailures').collect());
    expect(left).toHaveLength(kept);
  });
});

describe('a lapse parked before the mirror existed heals in one daily run', () => {
  test('passed by (in its deletion window) or failing again, each gets its mirror; health counts them', async () => {
    const t = await setup();
    const adm = await seed(t, 'adm', { role: 'admin' });
    await t.run(async (ctx) => {
      for (const [name, leaving] of [
        ['passed', true],
        ['failing', false],
      ] as const) {
        await ctx.db.insert('profiles', {
          clerkUserId: name,
          displayName: name,
          username: name,
          driveTimePrefMinutes: 60,
          profileVisibility: 'public' as const,
          notificationPrefs: NOTIF_PREFS,
          dateOfBirth: Date.UTC(1990, 0, 1),
          reputationPoints: 0,
          role: 'member' as const,
          status: 'suspended' as const,
          suspendedUntil: T0 - DAY,
          ...(leaving ? { deletionRequestedAt: T0 - DAY } : {}),
          lapseAttempts: 3,
          lapseErrorClass: 'x',
          lapseParkedAt: T0 - 5 * DAY,
          createdAt: T0 - 30 * DAY,
        });
      }
    });
    const before = await as(t, 'adm').query(api.recurringJobs.health, {});
    expect(before.jobs.find((j) => j.job === 'reset lapsed suspensions')).toMatchObject({
      parked: 0,
    });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rows = await import('./lib/peopleRows');
    const poison = vi.spyOn(rows, 'refreshPersonRow').mockRejectedValue(new Error('poison'));
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    await t.mutation(internal.peopleJobs.retryLapsedDaily, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers, 50);
    poison.mockRestore();
    quiet.mockRestore();
    const after = await as(t, 'adm').query(api.recurringJobs.health, {});
    expect(after.jobs.find((j) => j.job === 'reset lapsed suspensions')).toMatchObject({
      parked: 2,
    });
    void adm;
  });
});

describe('a sweep’s run record carries no ready', () => {
  test('the lapse sweep and the daily retry record runs, never readiness; a backfill’s does', async () => {
    const t = await setup();
    await t.run(async (ctx) => {
      // An old record from before the field went optional: cleared by the next run.
      await ctx.db.insert('peopleJobRuns', {
        job: 'lapseSweep',
        run: 1,
        ready: false,
        running: false,
        cursor: null,
        failed: 0,
        chains: true,
        pass: 0,
        updatedAt: T0,
      });
    });
    await t.mutation(internal.peopleJobs.sweepLapsedSuspensions, {});
    await t.mutation(internal.peopleJobs.retryLapsedDaily, {});
    const rows = await t.run((ctx) => ctx.db.query('peopleJobRuns').collect());
    for (const job of ['lapseSweep', 'lapseRetry']) {
      const row = rows.find((r) => r.job === job);
      expect(row, job).toBeDefined();
      expect('ready' in (row as object), job).toBe(false);
    }
    expect(rows.find((r) => r.job === 'rows')?.ready).toBe(true);
  });
});

// ── The avatar URL cap ──

describe('an avatar URL past the cap is not stored', () => {
  test('the Clerk mirror keeps a normal URL and drops an over-long one', async () => {
    const t = await setup();
    const skater = await seed(t, 'skater');
    const sync = (profileImageUrl: string) =>
      t.mutation(internal.profiles.applyClerkMirrors, {
        clerkUserId: 'skater',
        profileImageUrl,
      } as never);
    await sync('https://img.example/a.png');
    expect((await t.run((ctx) => ctx.db.get(skater)))?.profileImageUrl).toBe(
      'https://img.example/a.png',
    );
    await sync(`https://img.example/${'a'.repeat(3_000)}`);
    expect((await t.run((ctx) => ctx.db.get(skater)))?.profileImageUrl).toBeUndefined();
  });
});
