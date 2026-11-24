import { KNOW_BEFORE_YOU_GO, knowBeforeYouGoAnswers } from '@skating/core';
import { describe, expect, it } from 'vitest';
import {
  answerLook,
  canAdvance,
  initialQuiz,
  isLastQuestion,
  type QuizEvent,
  type QuizState,
  quizCells,
  quizReducer,
} from './knowBeforeYouGoQuiz';

const QS = KNOW_BEFORE_YOU_GO.questions;
const step = (s: QuizState, e: QuizEvent) => quizReducer(QS, s, e);
/** The drawn position of the question's right (or wrong) answer. */
const slot = (index: number, right: boolean): 0 | 1 => {
  const q = QS[index];
  if (!q) throw new Error(`no question ${index}`);
  return knowBeforeYouGoAnswers(q)[0].right === right ? 0 : 1;
};

describe('initialQuiz', () => {
  it('opens a first time on the first question', () => {
    expect(initialQuiz('never', false)).toEqual({
      phase: 'question',
      index: 0,
      picked: null,
      outcome: 'none',
    });
  });

  it('opens a season check on its card, unless the receipt just led here', () => {
    expect(initialQuiz('season', false).phase).toBe('season');
    expect(initialQuiz('season', true).phase).toBe('question');
    expect(initialQuiz(null, false).phase).toBe('question');
  });
});

describe('quizReducer', () => {
  it('goes through all seven to the list, only ever on the right pick', () => {
    let s = initialQuiz('never', false);
    for (let i = 0; i < QS.length; i++) {
      expect(s.index).toBe(i);
      expect(canAdvance(s)).toBe(false);
      // Next does nothing before the right pick.
      expect(step(s, { type: 'next' })).toBe(s);
      s = step(s, { type: 'pick', answer: slot(i, true) });
      expect(s.outcome).toBe('right');
      expect(canAdvance(s)).toBe(true);
      expect(isLastQuestion(QS, s)).toBe(i === QS.length - 1);
      s = step(s, { type: 'next' });
    }
    expect(s.phase).toBe('done');
    expect(canAdvance(s)).toBe(false);
    expect(quizCells(QS.length, s).every((c) => c === 'done')).toBe(true);
  });

  it('explains a miss and holds the button until the right pick (board 11.8)', () => {
    let s = initialQuiz('never', false);
    s = step(s, { type: 'pick', answer: slot(0, false) });
    expect(s.outcome).toBe('miss');
    expect(answerLook(s, slot(0, false))).toBe('miss');
    expect(answerLook(s, slot(0, true))).toBe('plain');
    expect(canAdvance(s)).toBe(false);
    // Picking the miss again changes nothing that matters.
    s = step(s, { type: 'pick', answer: slot(0, false) });
    expect(s.outcome).toBe('miss');
    s = step(s, { type: 'pick', answer: slot(0, true) });
    expect(s.outcome).toBe('right');
    expect(answerLook(s, slot(0, true))).toBe('right');
    expect(answerLook(s, slot(0, false))).toBe('plain');
  });

  it('locks the answers once the right one is picked', () => {
    const right = step(initialQuiz('never', false), { type: 'pick', answer: slot(0, true) });
    expect(step(right, { type: 'pick', answer: slot(0, false) })).toBe(right);
  });

  it('forgets a miss on the next question: nothing about it is kept', () => {
    let s = step(initialQuiz('never', false), { type: 'pick', answer: slot(0, false) });
    s = step(s, { type: 'pick', answer: slot(0, true) });
    s = step(s, { type: 'next' });
    expect(s).toEqual({ phase: 'question', index: 1, picked: null, outcome: 'none' });
  });

  it('starts from the season card, and ignores picks while on it', () => {
    let s = initialQuiz('season', false);
    expect(step(s, { type: 'pick', answer: 0 })).toBe(s);
    expect(quizCells(QS.length, s).every((c) => c === 'ahead')).toBe(true);
    s = step(s, { type: 'start' });
    expect(s.phase).toBe('question');
    expect(step(s, { type: 'start' })).toBe(s);
  });

  it('ignores a pick past the end of the data', () => {
    const lost: QuizState = { phase: 'question', index: 99, picked: null, outcome: 'none' };
    expect(step(lost, { type: 'pick', answer: 0 })).toBe(lost);
  });
});

describe('quizCells', () => {
  it('fills the answered cells and lights the current one', () => {
    const s: QuizState = { phase: 'question', index: 2, picked: null, outcome: 'none' };
    expect(quizCells(7, s)).toEqual([
      'done',
      'done',
      'current',
      'ahead',
      'ahead',
      'ahead',
      'ahead',
    ]);
  });
});
