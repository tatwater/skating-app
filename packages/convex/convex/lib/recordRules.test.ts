/**
 * The record's one rule, as a pure function (B01-4d): over every state an item can be in and every
 * viewer, an item offers at most one lever; an erased item none; a lever's answer is the refusal its
 * write gives (or the choice a Post needs); and no state offers a give-back a reason or a takeaway
 * none. Pinned seeds, plus one random seed, logged.
 */
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { Id } from '../_generated/dataModel';
import { AUTHOR_DELETED_RESTORE } from './authorDeletion';
import { OWN_CONTENT_REFUSAL } from './ownContent';
import {
  ERASED_ALREADY,
  KEEP_ALREADY_HELD,
  KEEP_NOT_DELETED,
  OVERTURN_NOT_DELETED,
  OVERTURN_NOTHING_STANDING,
  POST_RESTORE_NEEDS_A_CHOICE,
  POST_UNRESTORABLE,
  RECORD_CHECK_ON_ITEM,
  RECORD_LEAVING,
  RECORD_NEEDS_REASON,
  RECORD_NOT_STAFF,
  RESTORE_ALREADY_UP,
  type RecordAction,
  type RecordFacts,
  type RecordViewer,
  recordCan,
  recordFactsOf,
  recordLevers,
  recordRefusal,
} from './recordRules';

const KINDS = ['report', 'post', 'comment', 'hazard', 'accessAlert'] as const;
const ME = 'me' as Id<'profiles'>;
const OTHER = 'other' as Id<'profiles'>;
const ACTIONS: RecordAction[] = ['restore', 'hideAgain', 'overturn', 'keep'];

const factsArb: fc.Arbitrary<RecordFacts> = fc
  .record({
    targetType: fc.constantFrom(...KINDS),
    erased: fc.boolean(),
    gone: fc.boolean(),
    authorDeleted: fc.boolean(),
    membersWithdrawn: fc.constantFrom<boolean | 'unknown'>(true, false, 'unknown'),
    status: fc.constantFrom('visible' as const, 'hidden' as const, 'removed' as const),
    standing: fc.boolean(),
    post: fc.option(
      fc.record({ visibleAfter: fc.nat({ max: 3 }), choosable: fc.nat({ max: 3 }) }),
      { nil: undefined },
    ),
    // Theirs, someone else's, or no one's (gone): a moderator never decides their own (D269).
    authorId: fc.constantFrom<Id<'profiles'> | null>(ME, OTHER, null),
  })
  .map(({ membersWithdrawn, post, gone, ...f }) => ({
    ...f,
    // Gone is erased too; an erased shell (a comment's placeholder) is not gone.
    ...(gone && f.erased ? { gone: true } : {}),
    status: f.targetType === 'accessAlert' ? null : f.status,
    withdrawn: f.authorDeleted ? true : f.targetType === 'post' ? membersWithdrawn : false,
    ...(f.targetType === 'post' && post !== undefined ? { post } : {}),
  }));

const viewerArb: fc.Arbitrary<RecordViewer> = fc.record({
  _id: fc.constant(ME),
  role: fc.constantFrom('member' as const, 'moderator' as const, 'admin' as const),
  canEditLedger: fc.boolean(),
  deletionRequestedAt: fc.option(fc.constant(Date.UTC(2026, 10, 1)), { nil: undefined }),
});

const SEEDS = [1, 7, 20261115, Math.floor(Math.random() * 2 ** 31)];

describe('lib/recordRules', () => {
  test.each(SEEDS)(
    'one lever at most, and each answer is its write’s refusal (seed %i)',
    (seed) => {
      console.log(`recordRules seed ${seed}`);
      fc.assert(
        fc.property(factsArb, viewerArb, (facts, viewer) => {
          const levers = recordLevers(viewer, facts);
          const keys = Object.keys(levers) as RecordAction[];
          expect(keys.length).toBeLessThanOrEqual(1);
          // Gone offers nothing; an erased shell, only the overturn of a decision standing on it.
          if (facts.gone) expect(keys).toEqual([]);
          else if (facts.erased) expect(keys).toEqual(facts.standing ? ['overturn'] : []);
          const staff = viewer.role !== 'member' && viewer.deletionRequestedAt === undefined;
          for (const action of ACTIONS) {
            const can = recordCan(viewer, facts, action);
            const why = recordRefusal(facts, action);
            if (!staff) {
              expect(can).toEqual({
                ok: false,
                why: viewer.deletionRequestedAt !== undefined ? RECORD_LEAVING : RECORD_NOT_STAFF,
              });
              continue;
            }
            // Their own content: no lever, whatever its state (D269; no role exempt by default).
            if (facts.authorId === viewer._id) {
              expect(can).toEqual({ ok: false, why: OWN_CONTENT_REFUSAL });
              continue;
            }
            if (why === null || why === POST_RESTORE_NEEDS_A_CHOICE) {
              expect(can).toMatchObject({ ok: true, needsReason: RECORD_NEEDS_REASON[action] });
              if (why === POST_RESTORE_NEEDS_A_CHOICE)
                expect(can).toMatchObject({ needsChoice: true });
            } else {
              expect(can).toEqual({ ok: false, why });
            }
          }
          for (const action of keys)
            expect(levers[action]).toEqual(recordCan(viewer, facts, action));
        }),
        { seed, numRuns: 300 },
      );
    },
  );

  test('the refusals, case by case', () => {
    const base: RecordFacts = {
      targetType: 'report',
      erased: false,
      authorDeleted: false,
      withdrawn: false,
      status: 'hidden',
      standing: true,
      authorId: OTHER,
    };
    expect(recordRefusal({ ...base, erased: true }, 'restore')).toBe(ERASED_ALREADY);
    expect(recordRefusal({ ...base, authorDeleted: true, withdrawn: true }, 'restore')).toBe(
      AUTHOR_DELETED_RESTORE,
    );
    expect(recordRefusal({ ...base, status: 'visible', standing: false }, 'restore')).toBe(
      RESTORE_ALREADY_UP,
    );
    // Up, but a decision still stands on it (a history rebuilt from before the record): the restore
    // ends it.
    expect(recordRefusal({ ...base, status: 'visible' }, 'restore')).toBe(null);
    // An erased shell keeps its record: an overturn still takes a standing decision off it.
    const shell = { ...base, erased: true, authorDeleted: true, withdrawn: true } as RecordFacts;
    expect(recordRefusal(shell, 'overturn')).toBe(null);
    expect(recordRefusal(shell, 'restore')).toBe(ERASED_ALREADY);
    expect(recordRefusal({ ...shell, gone: true }, 'overturn')).toBe(ERASED_ALREADY);
    expect(recordRefusal(base, 'overturn')).toBe(OVERTURN_NOT_DELETED);
    expect(recordRefusal({ ...base, withdrawn: true, standing: false }, 'overturn')).toBe(
      OVERTURN_NOTHING_STANDING,
    );
    expect(recordRefusal(base, 'keep')).toBe(KEEP_NOT_DELETED);
    expect(recordRefusal({ ...base, authorDeleted: true, withdrawn: true }, 'keep')).toBe(
      KEEP_ALREADY_HELD,
    );
    const post: RecordFacts = { ...base, targetType: 'post', withdrawn: 'unknown' };
    expect(recordRefusal(post, 'restore')).toBe(RECORD_CHECK_ON_ITEM);
    expect(recordRefusal(post, 'overturn')).toBe(RECORD_CHECK_ON_ITEM);
    expect(recordRefusal({ ...post, post: { visibleAfter: 0, choosable: 0 } }, 'restore')).toBe(
      POST_UNRESTORABLE,
    );
    expect(recordRefusal({ ...post, post: { visibleAfter: 0, choosable: 2 } }, 'restore')).toBe(
      POST_RESTORE_NEEDS_A_CHOICE,
    );
    expect(recordRefusal({ ...post, post: { visibleAfter: 1, choosable: 0 } }, 'restore')).toBe(
      null,
    );
  });

  test('a standing Post that is up: Restore ends its decision — checked on the item, exact in the pane', () => {
    const viewer: RecordViewer = { _id: ME, role: 'moderator', canEditLedger: false };
    const up: RecordFacts = {
      targetType: 'post',
      erased: false,
      authorDeleted: false,
      withdrawn: 'unknown',
      status: 'visible',
      standing: true,
      authorId: OTHER,
    };
    // A list row, its members unread, sends the moderator to the item (as for a Post that is down).
    expect(recordLevers(viewer, up)).toEqual({ restore: { ok: false, why: RECORD_CHECK_ON_ITEM } });
    // The pane read them: a member is up, so the restore brings the Post back and ends the decision.
    expect(
      recordLevers(viewer, { ...up, withdrawn: false, post: { visibleAfter: 1, choosable: 0 } }),
    ).toEqual({ restore: { ok: true, needsReason: false, needsChoice: false } });
  });

  test('a standing alert its author didn’t retract offers nothing — no write restores an alert', () => {
    const viewer: RecordViewer = { _id: ME, role: 'moderator', canEditLedger: false };
    const alert: RecordFacts = {
      targetType: 'accessAlert',
      erased: false,
      authorDeleted: false,
      withdrawn: false,
      status: null,
      standing: true,
      authorId: OTHER,
    };
    expect(recordLevers(viewer, alert)).toEqual({});
    // Retracted by its author, the verdict on it is overturned.
    expect(
      Object.keys(recordLevers(viewer, { ...alert, authorDeleted: true, withdrawn: true })),
    ).toEqual(['overturn']);
  });

  test('the facts of a document: gone is erased; a Post its author didn’t delete waits on its members', () => {
    expect(recordFactsOf('report', null, true)).toMatchObject({ erased: true, standing: true });
    const post = {
      _id: 'p',
      _creationTime: 0,
      authorId: 'a',
      reportIds: [],
      photoIds: [],
      latestSkateEndTime: 0,
      moderationStatus: 'hidden',
      createdAt: 0,
      updatedAt: 0,
    } as never;
    expect(recordFactsOf('post', post, true)).toMatchObject({ withdrawn: 'unknown' });
    expect(
      recordFactsOf('post', post, true, {
        everyWithdrawn: true,
        plan: { visibleAfter: 0, choosable: 0 },
      }),
    ).toMatchObject({ withdrawn: true, authorDeleted: false, post: { visibleAfter: 0 } });
    const alert = {
      _id: 'x',
      createdByUserId: 'a',
      retractedByUserId: 'a',
      status: 'retracted',
    } as never;
    expect(recordFactsOf('accessAlert', alert, false)).toMatchObject({
      authorDeleted: true,
      withdrawn: true,
      status: null,
    });
    const comment = {
      _id: 'c',
      authorDeletedAt: 1,
      erasedAt: 2,
      moderationStatus: 'removed',
    } as never;
    expect(recordFactsOf('comment', comment, false)).toMatchObject({ erased: true });
  });
});
