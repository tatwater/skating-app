/**
 * The Inbox's one rule per verb (B01-5, `lib/inboxRules`): every verb's refusal for a viewer without
 * its capability, on their own content (D269), on an item they filed (D289), on a decided item (D283);
 * the read's answer equals the write's, and where a write exists today, its own words.
 */

import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { InboxVerb } from './inbox';
import { DELETION_PENDING_MESSAGE } from './lib/auth';
import {
  assertInboxVerb,
  capabilitiesFor,
  DECIDED_REFUSAL,
  inboxCan,
  OWN_FILING_REFUSAL,
  preconditionCode,
  preconditionRefusal,
  verbsOf,
  whoRefusal,
} from './lib/inboxRules';
import { OWN_CONTENT_REFUSAL } from './lib/ownContent';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);

const VERBS: InboxVerb[] = [
  'dismiss',
  'hide',
  'remove',
  'restore',
  'unpin',
  'retract',
  'ruleClosed',
  'ruleAccessible',
  'clearRuling',
  'approve',
  'decline',
  'sameAs',
  'lookUpAgain',
  'approveDrawn',
  'rejectDrawn',
  'mergeDrawn',
  'reply',
  'note',
  'resolve',
  'reopen',
];

const viewer = (role: 'member' | 'moderator' | 'admin', extra: Partial<Doc<'profiles'>> = {}) =>
  ({ _id: `p_${role}` as Id<'profiles'>, role, ...extra }) as Doc<'profiles'>;
const item = (over: Partial<Doc<'inboxItems'>> = {}) =>
  ({
    _id: 'i1' as Id<'inboxItems'>,
    kind: 'flag',
    status: 'open',
    ...over,
  }) as Doc<'inboxItems'>;

describe('who may act (rules 1–4)', () => {
  test('a member is refused every verb in requireCapability’s words', () => {
    for (const verb of VERBS) {
      const role = ['reply', 'note', 'resolve', 'reopen'].includes(verb) ? 'admin' : 'moderator';
      expect(whoRefusal(viewer('member'), item(), verb, false)).toBe(`Requires ${role} role`);
    }
  });

  test('a moderator is refused the admin verbs: support, and a restore or takedown approval', () => {
    const mod = viewer('moderator');
    for (const verb of ['reply', 'note', 'resolve'] as const) {
      expect(whoRefusal(mod, item({ kind: 'ticket' }), verb, false)).toBe('Requires admin role');
    }
    for (const requestKind of ['restore', 'takedown'] as const) {
      expect(whoRefusal(mod, item({ kind: 'request' }), 'approve', false, { requestKind })).toBe(
        'Requires admin role',
      );
    }
    expect(
      whoRefusal(mod, item({ kind: 'request' }), 'approve', false, { requestKind: 'activate' }),
    ).toBeNull();
    expect(capabilitiesFor('mergeDrawn')).toEqual(['inbox.drawnBody', 'corpus.duplicates']);
  });

  test('a staffer on their way out is refused every write, in requireContributor’s words', () => {
    const leaving = viewer('admin', { deletionRequestedAt: 1 });
    expect(whoRefusal(leaving, item(), 'dismiss', false)).toBe(DELETION_PENDING_MESSAGE);
  });

  test('a decided item refuses every verb but a ticket’s reopen (D283)', () => {
    const admin = viewer('admin');
    for (const verb of VERBS.filter((v) => v !== 'reopen')) {
      expect(whoRefusal(admin, item({ status: 'decided' }), verb, false)).toBe(DECIDED_REFUSAL);
    }
    expect(
      whoRefusal(admin, item({ kind: 'ticket', status: 'decided' }), 'reopen', false),
    ).toBeNull();
    expect(whoRefusal(admin, item({ kind: 'ticket' }), 'reopen', false)).toBe(
      'This ticket is still open.',
    );
  });

  test('an item the viewer filed refuses every verb (D289); admins are bound too', () => {
    for (const verb of VERBS.filter((v) => v !== 'reopen')) {
      expect(whoRefusal(viewer('admin'), item(), verb, true)).toBe(OWN_FILING_REFUSAL);
    }
  });

  test('a flag about the viewer or their content refuses every verb (D269)', () => {
    const admin = viewer('admin');
    for (const kind of ['flag', 'access'] as const) {
      for (const verb of ['dismiss', 'hide', 'remove', 'ruleClosed'] as const) {
        expect(whoRefusal(admin, item({ kind, subjectUserId: admin._id }), verb, false)).toBe(
          OWN_CONTENT_REFUSAL,
        );
      }
    }
    // An ask is the asker's filing (D289), not their content.
    expect(
      whoRefusal(admin, item({ kind: 'request', subjectUserId: admin._id }), 'decline', false),
    ).toBeNull();
  });
});

describe('the verbs a handler draws, and their preconditions (rule 5)', () => {
  test('each kind draws its board’s verbs', () => {
    expect(verbsOf(item(), { targetType: 'report', targetStatus: 'visible' })).toEqual([
      'dismiss',
      'hide',
      'remove',
    ]);
    expect(verbsOf(item(), { targetType: 'report', targetStatus: 'hidden' })).toEqual([
      'dismiss',
      'restore',
    ]);
    expect(verbsOf(item(), { targetType: 'user' })).toEqual(['dismiss']);
    expect(verbsOf(item(), { targetType: 'accessAlert' })).toEqual([
      'dismiss',
      'pin',
      'unpin',
      'retract',
    ]);
    expect(verbsOf(item({ kind: 'access' }), { hasRuling: true })).toContain('clearRuling');
    expect(verbsOf(item({ kind: 'request' }), { requestKind: 'admit' })).toEqual([
      'lookUpAgain',
      'decline',
    ]);
    expect(verbsOf(item({ kind: 'place' }), { hasLookalike: true })).toContain('sameAs');
    expect(verbsOf(item({ kind: 'drawn' }), { hasOverlap: true })).toContain('mergeDrawn');
    expect(verbsOf(item({ kind: 'ticket' }), {})).toEqual(['reply', 'note', 'resolve']);
    expect(verbsOf(item({ kind: 'ticket', status: 'decided' }), {})).toEqual(['reopen']);
  });

  test('each precondition refuses in its own words, and allows what it should', () => {
    // A photo has its axis (B01-5e): without record facts it defers to the write, as content does.
    expect(preconditionRefusal('hide', { targetType: 'photo' })).toBeNull();
    // Without the record facts (a write that didn't read them) the content verbs defer to
    // `setContentStatus`, which refuses by the same function the read answers from.
    expect(preconditionRefusal('hide', { targetStatus: 'visible' })).toBeNull();
    expect(preconditionRefusal('restore', { targetStatus: 'visible' })).toBeNull();
    expect(preconditionRefusal('unpin', { alert: null })).toMatch(/gone/);
    expect(preconditionRefusal('unpin', { alert: { status: 'active', pinned: false } })).toMatch(
      /pinned/,
    );
    expect(preconditionRefusal('unpin', { alert: { status: 'active', pinned: true } })).toBeNull();
    expect(preconditionRefusal('retract', { alert: null })).toMatch(/gone/);
    expect(
      preconditionRefusal('retract', { alert: { status: 'retracted', pinned: false } }),
    ).toMatch(/author/);
    expect(
      preconditionRefusal('retract', { alert: { status: 'active', pinned: false } }),
    ).toBeNull();
    expect(preconditionRefusal('clearRuling', {})).toMatch(/no ruling/);
    expect(preconditionRefusal('approve', { requestKind: 'admit' })).toMatch(/catalog/);
    expect(preconditionRefusal('approve', { requestKind: 'name_bay', bayMissing: 'draw it' })).toBe(
      'draw it',
    );
    expect(
      preconditionRefusal('approve', { requestKind: 'name_landmark', landmarkMissing: 'add it' }),
    ).toBe('add it');
    expect(preconditionRefusal('approve', { requestKind: 'activate' })).toBeNull();
    expect(preconditionRefusal('sameAs', { requestKind: 'name_landmark' })).toMatch(/same place/);
    expect(preconditionRefusal('lookUpAgain', { requestKind: 'activate' })).toMatch(/admit/);
    expect(preconditionRefusal('lookUpAgain', { requestKind: 'admit' })).toBeNull();
    expect(preconditionRefusal('mergeDrawn', {})).toMatch(/overlaps/);
    expect(preconditionRefusal('decline', {})).toBeNull();
  });
});

describe('the read’s answer is the write’s', () => {
  async function seed() {
    const t = harness();
    const person = (subject: string, role: 'member' | 'moderator' | 'admin') =>
      t.run((ctx) =>
        ctx.db.insert('profiles', {
          clerkUserId: subject,
          displayName: subject,
          username: subject,
          driveTimePrefMinutes: 60,
          profileVisibility: 'public' as const,
          notificationPrefs: {
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
          },
          dateOfBirth: Date.UTC(1990, 0, 1),
          reputationPoints: 0,
          role,
          status: 'active' as const,
          createdAt: Date.now(),
        }),
      );
    const mod = await person('user_mod', 'moderator');
    const other = await person('user_other', 'moderator');
    const member = await person('user_member', 'member');
    return { t, mod, other, member };
  }

  test('can and assertInboxVerb agree verb by verb, the filer probe included (D289)', async () => {
    const { t, mod, other } = await seed();
    await t.withIdentity({ subject: 'user_mod' }).mutation(api.contentFlags.flag, {
      targetType: 'user',
      targetId: other,
      reason: 'spam',
    });
    await t.run(async (ctx) => {
      const it = (await ctx.db.query('inboxItems').first()) as Doc<'inboxItems'>;
      for (const who of [mod, other]) {
        const viewerDoc = (await ctx.db.get(who)) as Doc<'profiles'>;
        const facts = { targetType: 'user' as const };
        const can = await inboxCan(ctx, viewerDoc, it, facts);
        expect(Object.keys(can)).toEqual(['dismiss']);
        let thrown: string | null = null;
        try {
          await assertInboxVerb(ctx, viewerDoc, it, 'dismiss', facts);
        } catch (err) {
          thrown = (err as { data: string }).data;
        }
        expect(thrown).toBe(can.dismiss);
      }
      // The filer is refused (they filed it); the flagged colleague is refused (it is about them).
      expect((await inboxCan(ctx, (await ctx.db.get(mod)) as Doc<'profiles'>, it)).dismiss).toBe(
        OWN_FILING_REFUSAL,
      );
      expect((await inboxCan(ctx, (await ctx.db.get(other)) as Doc<'profiles'>, it)).dismiss).toBe(
        OWN_CONTENT_REFUSAL,
      );
    });
  });

  test('a capability refusal is word for word what today’s writes throw', async () => {
    const { t, member, mod } = await seed();
    const asMember = t.withIdentity({ subject: 'user_member' });
    const requestId = await t.run((ctx) =>
      ctx.db.insert('waterBodyRequests', {
        kind: 'admit',
        status: 'open',
        requesterId: member,
        coord: { lat: 1, lng: 1 },
        createdAt: Date.now(),
      }),
    );
    await expect(
      asMember.mutation(api.corpusRequests.decline, { requestId, note: 'no' }),
    ).rejects.toThrow(whoRefusal(viewer('member'), item(), 'decline', false) as string);
    const ticketId = await t.run((ctx) =>
      ctx.db.insert('supportTickets', {
        category: 'bug',
        body: 'x',
        status: 'open',
        createdAt: Date.now(),
      }),
    );
    await expect(
      t.withIdentity({ subject: 'user_mod' }).mutation(api.support.resolve, { ticketId }),
    ).rejects.toThrow(
      whoRefusal(viewer('moderator'), item({ kind: 'ticket' }), 'resolve', false) as string,
    );
    void mod;
  });
});

describe('preconditionCode (B01-5d): awaitsDrawing only for an Approve waiting on a drawing', () => {
  test('a bay or a landmark not drawn yet, on Approve; nothing else, on no other verb', () => {
    const bay = { requestKind: 'name_bay' as const, bayMissing: 'No sub-area yet' };
    const landmark = { requestKind: 'name_landmark' as const, landmarkMissing: 'No landmark yet' };
    expect(preconditionCode('approve', bay)).toBe('awaitsDrawing');
    expect(preconditionCode('approve', landmark)).toBe('awaitsDrawing');
    expect(preconditionCode('sameAs', bay)).toBeUndefined();
    expect(preconditionCode('decline', landmark)).toBeUndefined();
    expect(
      preconditionCode('approve', { requestKind: 'name_bay', bayMissing: null }),
    ).toBeUndefined();
    expect(
      preconditionCode('approve', { requestKind: 'admit', hasCandidate: false, resolveError: 'x' }),
    ).toBeUndefined();
  });
});
