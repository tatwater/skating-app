/**
 * Know Before You Go on the phone (D296; B03 §9.6 boards 11.6–11.9, 11.13), as a state machine: one
 * question at a time, two answers in the data's order, a miss explained and the button held until
 * the right pick, then the "All seven" list whose *Continue* writes the completion.
 *
 * **Wrong picks are never stored** — not here past the question they were made on, not on the
 * server, not anywhere. The completion says only that all seven were answered.
 */

import {
  type KnowBeforeYouGoDue,
  type KnowBeforeYouGoQuestion,
  knowBeforeYouGoAnswers,
} from '@skating/core';

/**
 * - `season` — the "A new season on the ice" card (board 11.13);
 * - `question` — a question on screen, `index` 0–6;
 * - `done` — the "All seven" list (board 11.9).
 */
export type QuizPhase = 'season' | 'question' | 'done';

/** The feedback line under the answers: nothing yet (its room kept), right, or a miss. */
export type QuizOutcome = 'none' | 'right' | 'miss';

export interface QuizState {
  phase: QuizPhase;
  index: number;
  /** Which of the two drawn answers is picked (0 = top), on this question only. */
  picked: 0 | 1 | null;
  outcome: QuizOutcome;
}

export type QuizEvent = { type: 'start' } | { type: 'pick'; answer: 0 | 1 } | { type: 'next' };

/**
 * Where the screen opens. A season check opens on its card, unless the skater has just come from
 * the receipt's *Start the questions* (it already said what the card says); a first time opens on
 * the first question.
 */
export function initialQuiz(flavor: KnowBeforeYouGoDue | null, fromReceipt: boolean): QuizState {
  const first: QuizState = { phase: 'question', index: 0, picked: null, outcome: 'none' };
  return flavor === 'season' && !fromReceipt ? { ...first, phase: 'season' } : first;
}

export function quizReducer(
  questions: readonly KnowBeforeYouGoQuestion[],
  state: QuizState,
  event: QuizEvent,
): QuizState {
  switch (event.type) {
    case 'start':
      return state.phase === 'season' ? { ...state, phase: 'question' } : state;
    case 'pick': {
      if (state.phase !== 'question' || state.outcome === 'right') return state;
      const question = questions[state.index];
      if (question === undefined) return state;
      const right = knowBeforeYouGoAnswers(question)[event.answer].right;
      return { ...state, picked: event.answer, outcome: right ? 'right' : 'miss' };
    }
    case 'next': {
      if (state.phase !== 'question' || state.outcome !== 'right') return state;
      if (state.index + 1 >= questions.length) {
        return { phase: 'done', index: state.index, picked: null, outcome: 'none' };
      }
      return { phase: 'question', index: state.index + 1, picked: null, outcome: 'none' };
    }
  }
}

/** The seven progress cells: answered, the one on screen, or still ahead. */
export type QuizCell = 'done' | 'current' | 'ahead';

export function quizCells(count: number, state: QuizState): QuizCell[] {
  return Array.from({ length: count }, (_, i) => {
    if (state.phase === 'done') return 'done';
    if (state.phase === 'season') return 'ahead';
    if (i < state.index) return 'done';
    return i === state.index ? 'current' : 'ahead';
  });
}

/** How an answer is drawn: plain, the outlined right pick, or the amber miss with its cross. */
export type AnswerLook = 'plain' | 'right' | 'miss';

export function answerLook(state: QuizState, answer: 0 | 1): AnswerLook {
  if (state.picked !== answer) return 'plain';
  return state.outcome === 'right' ? 'right' : 'miss';
}

/** Whether the question's button (*Next question*, *Finish* on the last) is on. */
export function canAdvance(state: QuizState): boolean {
  return state.phase === 'question' && state.outcome === 'right';
}

/** The question's button: *Finish* on the last one. */
export function isLastQuestion(questions: readonly unknown[], state: QuizState): boolean {
  return state.index === questions.length - 1;
}
