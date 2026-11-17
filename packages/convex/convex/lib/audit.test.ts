/**
 * **One normalizer for every audit reason, at the one writer** (B01-4h). A plain string, a typed
 * reason and a composed one are all stored trimmed (`normalizeReason`), so a "nothing changed"
 * comparison and the stored text never differ by outer whitespace — and the only thing the change
 * alters in what any writer stores is that outer whitespace. Rows written before it may hold untrimmed
 * text; every comparison on a reason reads both sides normalized (`sameReason`), so they still match
 * — no backfill. Pinned seeds, plus one random seed, logged.
 */
import { AUDIT_REASON_MAX, AUDIT_REASON_TOO_LONG } from '@skating/core';
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { api } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import schema from '../schema';
import {
  checkedReason,
  composed,
  composedOf,
  fitComposed as fitComposedText,
  normalizeReason,
  sameReason,
  typed,
  writeAudit,
} from './audit';
import { markReady, refreshPersonRow } from './peopleRows';

const modules = import.meta.glob('../**/*.*s');
const SEEDS = [1, 7, 20261116, Math.floor(Math.random() * 2 ** 31)];

/** Whitespace as JavaScript's `trim` reads it: spaces, tabs, line breaks, the wide spaces. */
const ws = fc.string({
  unit: fc.constantFrom(' ', '\t', '\n', '\r', ' ', ' ', '﻿'),
  maxLength: 4,
});

describe('lib/audit normalizeReason', () => {
  test.each(SEEDS)('changes outer whitespace and nothing else (seed %i)', (seed) => {
    console.log(`audit normalize seed ${seed}`);
    fc.assert(
      fc.property(ws, fc.string({ maxLength: 40 }), ws, (lead, core, trail) => {
        const given = lead + core + trail;
        const kept = normalizeReason(given);
        // What is kept is the text with its outer whitespace taken off — a slice of it, never an edit.
        const at = given.indexOf(kept);
        expect(at).toBeGreaterThanOrEqual(0);
        expect(given.slice(0, at).trim()).toBe('');
        expect(given.slice(at + kept.length).trim()).toBe('');
        expect(kept).toBe(kept.trim());
        // Text already trimmed is stored exactly as given.
        expect(normalizeReason(core.trim())).toBe(core.trim());
        // And the comparison every reader takes agrees with it, on old and new text alike.
        expect(sameReason(given, core)).toBe(given.trim() === core.trim());
      }),
      { seed, numRuns: 300 },
    );
  });

  test('checkedReason is the same normalizer, then the cap', () => {
    expect(checkedReason('  a reason \n')).toBe(normalizeReason('  a reason \n'));
    // Outer whitespace never counts toward the cap — the cap is the words.
    expect(checkedReason(`  ${'x'.repeat(AUDIT_REASON_MAX)}  `)).toHaveLength(AUDIT_REASON_MAX);
    expect(() => checkedReason('x'.repeat(AUDIT_REASON_MAX + 1))).toThrow(AUDIT_REASON_TOO_LONG);
    expect(sameReason(null, null)).toBe(true);
    expect(sameReason(null, '')).toBe(false);
    expect(sameReason('a ', null)).toBe(false);
  });
});

/** Write one row through the one writer and read back what it stored. */
async function stored(reason: Parameters<typeof writeAudit>[1]['reason']) {
  const t = convexTest(schema, modules);
  return t.run(async (ctx) => {
    const id = await writeAudit(ctx, {
      action: 'hide',
      targetType: 'report',
      targetId: 'r1',
      reason,
      createdAt: 1,
    });
    return (await ctx.db.get(id))?.reason;
  });
}

describe('lib/audit writeAudit stores every reason normalized', () => {
  test.each([
    ['a plain string', '  spam, again \n', 'spam, again'],
    ['a typed reason', typed('\tspam '), 'spam'],
    [
      'a composed reason whose value ends in whitespace',
      composed`Drew "${'Bay'}" on ${'Mascoma  '}`,
      'Drew "Bay" on Mascoma',
    ],
    [
      'a composed reason whose value leads it',
      composedOf(['', ' — kept'], [' Set the access']),
      'Set the access — kept',
    ],
    ['a reason already trimmed', 'Restored', 'Restored'],
  ])('%s', async (_, reason, want) => {
    expect(await stored(reason)).toBe(want);
  });

  test('a plain string is held to the cap after its outer whitespace goes, as a typed one is', async () => {
    expect(await stored(`${'x'.repeat(AUDIT_REASON_MAX)}   `)).toHaveLength(AUDIT_REASON_MAX);
    await expect(stored('x'.repeat(AUDIT_REASON_MAX + 1))).rejects.toThrow(AUDIT_REASON_TOO_LONG);
  });
});

// ── Rows written before: a reason kept with outer whitespace still matches its trimmed repeat ────

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

async function world() {
  const t = convexTest(schema, modules);
  const person = (subject: string, over: Partial<Doc<'profiles'>>) =>
    t.run(async (ctx) => {
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
        createdAt: Date.UTC(2026, 0, 1),
        ...over,
      });
      await refreshPersonRow(ctx, id);
      return id;
    });
  await t.run(async (ctx) => {
    for (const b of ['rows', 'flagSubjects', 'undoChains', 'verdicts'] as const) {
      await markReady(ctx, b);
    }
  });
  const adm = await person('adm', { role: 'admin' });
  return { t, adm, person, as: t.withIdentity({ subject: 'adm' }) };
}

describe('a reason kept untrimmed before this compares equal to its trimmed repeat', () => {
  test('a repeat ban whose reason differs only by outer whitespace changes nothing and writes nothing', async () => {
    const { t, person, as } = await world();
    // Kept with a trailing space, as a raw call could send one before the one normalizer.
    const them = await person('them', { status: 'banned', statusReason: 'spam  ' });
    const result = await as.mutation(api.moderation.banUser, { userId: them, reason: ' spam' });
    expect(result).toMatchObject({ changed: false });
    const rows = await t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_target', (q) => q.eq('targetType', 'user').eq('targetId', them))
        .collect(),
    );
    expect(rows).toHaveLength(0);
  });

  test('the undo of a row whose prior terms differ only by outer whitespace is never offered — as its write would refuse', async () => {
    const { t, adm, person, as } = await world();
    const them = await person('them', { status: 'banned', statusReason: 'spam' });
    // A row from before: it found the reason with a trailing space and kept it trimmed.
    const rowId: Id<'moderationActions'> = await t.run((ctx) =>
      ctx.db.insert('moderationActions', {
        actorId: adm,
        action: 'ban',
        targetType: 'user',
        targetId: them,
        reason: 'spam',
        metadata: {
          statusReason: 'spam',
          prev: { status: 'banned', statusReason: 'spam ', suspendedUntil: null },
        },
        createdAt: Date.now(),
      }),
    );
    const [view] = await as.query(api.moderation.listActions, {
      targetType: 'user',
      targetId: them,
    });
    expect(view?.id).toBe(rowId);
    expect(view?.undo).toEqual({
      state: 'unavailable',
      why: 'Nothing changed, so there is nothing to undo.',
    });
    await expect(as.mutation(api.undo.run, { actionId: rowId })).rejects.toThrow(/nothing to undo/);
  });
});

describe('composedOf takes a person’s words only checked (the type holds it)', () => {
  test('a literal or a checkedReason passes; a plain string does not compile', () => {
    const typedByPerson: string = '  too long to keep whole unchecked ';
    expect(fitComposedText(composedOf(['Hid it: ', checkedReason(typedByPerson)], ['']))).toBe(
      'Hid it: too long to keep whole unchecked',
    );
    // @ts-expect-error — a plain string as a fixed part: its words could be anyone's, unchecked.
    composedOf(['Hid it: ', typedByPerson], ['']);
    // @ts-expect-error — nor a literal joined to one at run time (`concat` returns a plain string).
    composedOf(['Hid it: '.concat(checkedReason(typedByPerson))], []);
    // @ts-expect-error — nor a template with a hole (inferred `Hid it: ${string}`, not a plain string).
    composedOf([`Hid it: ${typedByPerson}`], []);
  });
});
