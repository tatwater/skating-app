/**
 * The Corpus tasks' rule (B01-6a), on its own: each verb's answer in the rule's order — capability,
 * the lock, the body merged or removed, a task that left, the verb's precondition — and the name a
 * pick names. The write's side (the same sentences thrown) is `corpusDecisions.test.ts`.
 */

import { describe, expect, test } from 'vitest';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { DELETION_PENDING_MESSAGE } from './auth';
import {
  ALREADY_SHOWN,
  CORPUS_LANE_VERBS,
  CORPUS_VERB_CAPABILITY,
  type CorpusVerb,
  corpusCan,
  corpusVerbRefusal,
  NO_OTHER_NAME,
  NOT_A_CATALOG_NAME,
  NOT_THIS_LANE,
  namePickRefusal,
} from './corpusRules';
import { TASK_DECIDED, TASK_LEFT } from './corpusTasks';

// The rule reads one row: a decided task's decider, for the lock's sentence. Nothing else.
const DECIDER = 'p9' as Id<'profiles'>;
const ctx = {
  db: { get: async (id: string) => (id === DECIDER ? { displayName: 'Casey Example' } : null) },
} as unknown as QueryCtx;
const LOCK = 'Decided by Casey Example · renamed';
const decided = (lane: Doc<'corpusTasks'>['lane']) =>
  task(lane, { status: 'decided', decidedByUserId: DECIDER, decision: 'renamed' });

const viewer = (
  role: Doc<'profiles'>['role'],
  over: Partial<Doc<'profiles'>> = {},
): Doc<'profiles'> => ({ _id: 'p1' as Id<'profiles'>, role, ...over }) as Doc<'profiles'>;

const body = (over: Partial<Doc<'waterBodies'>> = {}): Doc<'waterBodies'> =>
  ({
    _id: 'b1' as Id<'waterBodies'>,
    name: 'The Basin',
    type: 'lakePond',
    dedupStatus: 'clean',
    nameClaims: [
      { source: 'nhd', value: 'The Basin' },
      { source: 'osm', value: 'Lake Auburn' },
    ],
    ...over,
  }) as Doc<'waterBodies'>;

const task = (
  lane: Doc<'corpusTasks'>['lane'],
  over: Partial<Doc<'corpusTasks'>> = {},
): Doc<'corpusTasks'> =>
  ({
    _id: 't1' as Id<'corpusTasks'>,
    key: `reason:${lane === 'nameConflicts' ? 'name-conflict' : 'class-conflict'}:b1`,
    kind: 'reason',
    lane,
    facet: lane === 'nameConflicts' ? 'different' : 'notRecorded',
    status: 'open',
    waterBodyId: 'b1' as Id<'waterBodies'>,
    ...over,
  }) as Doc<'corpusTasks'>;

describe('corpusCan: each lane draws its own verbs', () => {
  test('a name conflict draws Pick and Keep; a class conflict draws Set and Keep', async () => {
    const mod = viewer('moderator');
    expect(await corpusCan(ctx, mod, task('nameConflicts'), body())).toEqual({
      pickName: null,
      keepName: null,
    });
    expect(await corpusCan(ctx, mod, task('classConflicts'), body())).toEqual({
      setClass: null,
      keepClass: null,
    });
  });

  test('every verb is one lane’s, and its capability is the change it makes', () => {
    const verbs = Object.values(CORPUS_LANE_VERBS).flat();
    expect([...verbs].sort()).toEqual(['keepClass', 'keepName', 'pickName', 'setClass']);
    // A Keep changes nothing but the queue; a pick or a set changes the body's identity (D217).
    expect(CORPUS_VERB_CAPABILITY).toEqual({
      pickName: 'body.identity',
      keepName: 'corpus.intake',
      setClass: 'body.identity',
      keepClass: 'corpus.intake',
    });
  });
});

describe('the rule’s order: the first that refuses answers', () => {
  const every = async (
    v: Doc<'profiles'>,
    t: Doc<'corpusTasks'>,
    b: Doc<'waterBodies'> | null,
  ): Promise<Partial<Record<CorpusVerb, string | null>>> => corpusCan(ctx, v, t, b);

  test('1. the capability, in requireCapability’s words — before the lock and the body', async () => {
    const member = viewer('member');
    expect(await every(member, decided('nameConflicts'), null)).toEqual({
      pickName: 'Requires moderator role',
      keepName: 'Requires moderator role',
    });
    // A staffer on their way out writes nothing (D62).
    const leaving = viewer('moderator', { deletionRequestedAt: 1 });
    expect(await every(leaving, task('classConflicts'), body())).toEqual({
      setClass: DELETION_PENDING_MESSAGE,
      keepClass: DELETION_PENDING_MESSAGE,
    });
  });

  test('2. a decided task: the lock’s own sentence, who and what, before the body’s state', async () => {
    expect(await every(viewer('admin'), decided('classConflicts'), body({ removedAt: 1 }))).toEqual(
      {
        setClass: LOCK,
        keepClass: LOCK,
      },
    );
    // A decider since erased: the lock still holds, in its plain words.
    const orphan = task('classConflicts', {
      status: 'decided',
      decidedByUserId: 'p0' as Id<'profiles'>,
      decision: 'kept',
    });
    expect((await every(viewer('admin'), orphan, body())).keepClass).toBe(TASK_DECIDED);
  });

  test('2. a task that left: why its question went away, whatever the body is now', async () => {
    const mod = viewer('moderator');
    const left = (leftBecause: Doc<'corpusTasks'>['leftBecause']) =>
      task('classConflicts', { status: 'left', leftBecause });
    for (const why of ['notAsserted', 'merged', 'removed', 'deleted'] as const) {
      expect((await every(mod, left(why), body())).setClass).toBe(TASK_LEFT[why]);
    }
  });

  test('3. an open task whose body is gone, merged away or removed — merged before removed', async () => {
    const mod = viewer('moderator');
    const t = task('nameConflicts');
    expect((await every(mod, t, null)).keepName).toBe(TASK_LEFT.deleted);
    expect((await every(mod, t, body({ dedupStatus: 'merged' }))).keepName).toBe(TASK_LEFT.merged);
    expect(
      (await every(mod, t, body({ mergedIntoId: 'b2' as Id<'waterBodies'>, removedAt: 1 })))
        .keepName,
    ).toBe(TASK_LEFT.merged);
    expect((await every(mod, t, body({ removedAt: 1 }))).pickName).toBe(TASK_LEFT.removed);
  });

  test('4. Pick needs a catalog name that isn’t the one shown; Keep needs nothing', async () => {
    const mod = viewer('moderator');
    const t = task('nameConflicts');
    // Only the shown name, in another case; and a moderator's own claim is never a catalog's.
    const lone = body({
      nameClaims: [
        { source: 'nhd', value: 'THE BASIN ' },
        { source: 'user', value: 'Lake Auburn' },
      ],
    });
    expect(await every(mod, t, lone)).toEqual({ pickName: NO_OTHER_NAME, keepName: null });
    expect(await every(mod, t, body({ nameClaims: undefined }))).toEqual({
      pickName: NO_OTHER_NAME,
      keepName: null,
    });
  });
});

describe('corpusVerbRefusal: the write’s question', () => {
  test('a verb of another lane is refused first, whoever asks', async () => {
    expect(
      await corpusVerbRefusal(ctx, viewer('member'), task('classConflicts'), body(), 'pickName'),
    ).toBe(NOT_THIS_LANE.nameConflicts);
    expect(
      await corpusVerbRefusal(ctx, viewer('admin'), task('nameConflicts'), null, 'keepClass'),
    ).toBe(NOT_THIS_LANE.classConflicts);
  });

  test('a verb of the lane answers exactly what corpusCan says of it', async () => {
    const cases: [Doc<'profiles'>, Doc<'corpusTasks'>, Doc<'waterBodies'> | null][] = [
      [viewer('member'), task('nameConflicts'), body()],
      [viewer('moderator'), decided('nameConflicts'), body()],
      [
        viewer('moderator'),
        task('classConflicts', { status: 'left', leftBecause: 'merged' }),
        body(),
      ],
      [viewer('moderator'), task('classConflicts'), null],
      [viewer('admin'), task('classConflicts'), body({ removedAt: 1 })],
      [viewer('admin'), task('nameConflicts'), body({ nameClaims: [] })],
      [viewer('admin'), task('nameConflicts'), body()],
    ];
    for (const [v, t, b] of cases) {
      const can = await corpusCan(ctx, v, t, b);
      for (const verb of CORPUS_LANE_VERBS[t.lane]) {
        expect(await corpusVerbRefusal(ctx, v, t, b, verb)).toBe(can[verb]);
      }
    }
  });
});

describe('namePickRefusal: what a pick names', () => {
  test('a catalog’s name, matched case- and space-insensitively, is the claim picked', () => {
    expect(namePickRefusal(body(), '  lake auburn ')).toEqual({
      claim: { source: 'osm', value: 'Lake Auburn' },
    });
  });

  test('the name shown is Keep, not a pick', () => {
    expect(namePickRefusal(body(), 'the basin')).toEqual({ refused: ALREADY_SHOWN });
  });

  test('free text, or a moderator’s own claim, is not a catalog’s name', () => {
    expect(namePickRefusal(body(), 'Auburn Reservoir')).toEqual({ refused: NOT_A_CATALOG_NAME });
    const userOnly = body({
      nameClaims: [
        { source: 'nhd', value: 'The Basin' },
        { source: 'user', value: 'Our Pond' },
      ],
    });
    expect(namePickRefusal(userOnly, 'Our Pond')).toEqual({ refused: NOT_A_CATALOG_NAME });
  });
});
