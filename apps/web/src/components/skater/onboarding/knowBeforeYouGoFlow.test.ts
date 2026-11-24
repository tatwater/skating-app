import { KNOW_BEFORE_YOU_GO, knowBeforeYouGoAnswers } from '@skating/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  advance,
  type KnowBeforeYouGoPosition,
  openingPosition,
  pickAnswer,
} from './KnowBeforeYouGoFlow';

const QUESTIONS = KNOW_BEFORE_YOU_GO.questions;

/** The drawn place (0 = key 1) of a question's right or wrong answer. */
function place(index: number, right: boolean): 0 | 1 {
  const question = QUESTIONS[index];
  if (!question) throw new Error(`No question ${index}`);
  return knowBeforeYouGoAnswers(question).findIndex((a) => a.right === right) as 0 | 1;
}

const at = (index: number, state: KnowBeforeYouGoPosition['state'] = 'ask') =>
  ({ stage: 'question', index, state }) as const;

describe('where the questions open', () => {
  it('opens a first time straight on the first question, and a season on its card', () => {
    expect(openingPosition('never')).toEqual(at(0));
    expect(openingPosition('season')).toEqual({ stage: 'season', index: 0, state: 'ask' });
  });
});

describe('a pick', () => {
  it('settles the question on the right answer, wherever the data draws it', () => {
    QUESTIONS.forEach((_, i) => {
      expect(pickAnswer(at(i), place(i, true)).state).toBe('right');
    });
  });

  it('is a miss on the wrong one, and the right one still settles it after', () => {
    QUESTIONS.forEach((_, i) => {
      const missed = pickAnswer(at(i), place(i, false));
      expect(missed.state).toBe('miss');
      expect(pickAnswer(missed, place(i, false))).toBe(missed);
      expect(pickAnswer(missed, place(i, true)).state).toBe('right');
    });
  });

  it('changes nothing once settled', () => {
    const settled = at(2, 'right');
    expect(pickAnswer(settled, place(2, false))).toBe(settled);
  });
});

describe('going on', () => {
  it('waits for the right answer', () => {
    expect(advance(at(0))).toEqual(at(0));
    expect(advance(at(0, 'miss'))).toEqual(at(0, 'miss'));
    expect(advance(at(0, 'right'))).toEqual(at(1));
  });

  it('finishes on the seventh, into all seven', () => {
    expect(advance(at(QUESTIONS.length - 1, 'right')).stage).toBe('done');
  });

  /**
   * However the picks go — misses anywhere, in any number — the way to the end is the right answer
   * to each of the seven, in order, and nothing a pick does can skip one.
   */
  it('reaches all seven only through every right answer, in order', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom<0 | 1>(0, 1), { maxLength: 60 }), (keys) => {
        let position: KnowBeforeYouGoPosition = openingPosition('never');
        let rightsSeen = 0;
        for (const key of keys) {
          const before = position;
          position = pickAnswer(position, key);
          if (before.state !== 'right' && position.state === 'right') rightsSeen += 1;
          position = advance(position);
          if (position.stage === 'done') break;
        }
        if (position.stage === 'done') expect(rightsSeen).toBe(QUESTIONS.length);
        else expect(position.index).toBeLessThanOrEqual(rightsSeen);
      }),
    );
  });
});
