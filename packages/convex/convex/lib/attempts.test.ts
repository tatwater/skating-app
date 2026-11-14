/**
 * The parking rule as a state machine (D248): over any sequence of outcomes, work is parked exactly
 * when it has failed three times with no progress between (held passes don't count either way), a
 * progress clears every trace, held never writes, and a daily retry's failure keeps it parked.
 */
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { type AttemptOutcome, type AttemptState, MAX_ATTEMPTS, nextAttemptState } from './attempts';

const outcome: fc.Arbitrary<AttemptOutcome> = fc.oneof(
  fc.constant<AttemptOutcome>({ kind: 'failed', errorClass: 'Error' }),
  fc.constant<AttemptOutcome>({ kind: 'progress' }),
  fc.constant<AttemptOutcome>({ kind: 'held' }),
);

describe('the parking rule', () => {
  test('parked if and only if three failures in a row with no progress between them', () => {
    fc.assert(
      fc.property(fc.array(outcome, { maxLength: 30 }), (outcomes) => {
        let state: AttemptState = {};
        let run = 0;
        let parkedModel = false;
        for (const [now, o] of outcomes.entries()) {
          const next = nextAttemptState(state, o, now);
          if (o.kind === 'held') expect(next).toBeNull();
          if (next) state = { ...state, ...next };
          if (o.kind === 'progress') {
            run = 0;
            parkedModel = false;
          } else if (o.kind === 'failed') {
            run++;
            if (run >= MAX_ATTEMPTS) parkedModel = true;
          }
          expect(state.parkedAt !== undefined).toBe(parkedModel);
          expect(state.attempts ?? 0).toBe(run);
          if (o.kind === 'progress') expect(state.errorClass).toBeUndefined();
        }
      }),
    );
  });

  test('the common path writes nothing: progress on clean work, and any held pass', () => {
    expect(nextAttemptState({}, { kind: 'progress' }, 1)).toBeNull();
    expect(nextAttemptState({ attempts: 2 }, { kind: 'held' }, 1)).toBeNull();
    expect(nextAttemptState({ attempts: 1 }, { kind: 'progress' }, 1)).toEqual({
      attempts: undefined,
      errorClass: undefined,
      parkedAt: undefined,
      retriedAt: undefined,
    });
  });

  test("the daily retry's failure keeps it parked, re-stamped; its success clears it", () => {
    const parked = { attempts: 3, errorClass: 'Error', parkedAt: 10 };
    expect(
      nextAttemptState(parked, { kind: 'failed', errorClass: 'TypeError', byDailyRetry: true }, 99),
    ).toEqual({ attempts: 4, errorClass: 'TypeError', parkedAt: 99, retriedAt: 99 });
    expect(nextAttemptState({ ...parked, retriedAt: 99 }, { kind: 'progress' }, 100)).toEqual({
      attempts: undefined,
      errorClass: undefined,
      parkedAt: undefined,
      retriedAt: undefined,
    });
  });
});
