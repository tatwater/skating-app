import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyConfirmation,
  confirmThresholdFor,
  DEFAULT_CONFIRM_THRESHOLD,
  DEFAULT_REMOVAL_THRESHOLD,
  deriveHazardLifecycle,
  type HazardLifecycleState,
  type HazardVerdict,
  type HazardVoteRecord,
  initialLifecycleState,
  isProvisional,
  PASSAGE_CONFIRM_THRESHOLD,
  shouldArchive,
} from './hazardLifecycle';

const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);
const HOUR = 3_600_000;

const arbVerdict: fc.Arbitrary<HazardVerdict> = fc.constantFrom(
  'still_there',
  'healing_unsafe',
  'fully_healed',
  'never_existed',
);

const arbState: fc.Arbitrary<HazardLifecycleState> = fc.record({
  lastConfirmedAt: fc.integer({ min: T0 - 1000 * HOUR, max: T0 }),
  confirmCount: fc.integer({ min: 0, max: 10 }),
  goneCount: fc.integer({ min: 0, max: 10 }),
  healingState: fc.constantFrom('none' as const, 'healing_unsafe' as const, 'disputed' as const),
  status: fc.constantFrom('active' as const, 'archived' as const),
});

describe('initialLifecycleState', () => {
  it('starts active, unconfirmed, not healing', () => {
    expect(initialLifecycleState(T0)).toEqual({
      lastConfirmedAt: T0,
      confirmCount: 0,
      goneCount: 0,
      healingState: 'none',
      status: 'active',
    });
  });

  it('is provisional at birth — a brand-new pin can never fire a hard warning', () => {
    expect(isProvisional(initialLifecycleState(T0).confirmCount)).toBe(true);
  });
});

describe('applyConfirmation — still_there', () => {
  it('resets the clock and counts toward confirmation', () => {
    const next = applyConfirmation(initialLifecycleState(T0), 'still_there', T0 + 5 * HOUR);
    expect(next.lastConfirmedAt).toBe(T0 + 5 * HOUR);
    expect(next.confirmCount).toBe(1);
    expect(next.goneCount).toBe(0);
    expect(next.status).toBe('active');
  });

  it('clears an earlier healing annotation — seeing it intact supersedes "healing"', () => {
    const healing = applyConfirmation(initialLifecycleState(T0), 'healing_unsafe', T0 + HOUR);
    expect(healing.healingState).toBe('healing_unsafe');
    expect(applyConfirmation(healing, 'still_there', T0 + 2 * HOUR).healingState).toBe('none');
  });
});

describe('applyConfirmation — healing_unsafe', () => {
  // The whole reason the middle verdict exists: a healing hazard is still a hazard, and saying so must
  // not nudge it toward removal.
  it('keeps the pin: moves neither counter and never archives', () => {
    fc.assert(
      fc.property(arbState, (state) => {
        const next = applyConfirmation(state, 'healing_unsafe', T0);
        expect(next.confirmCount).toBe(state.confirmCount);
        expect(next.goneCount).toBe(state.goneCount);
        expect(next.status).toBe(state.status);
        expect(next.healingState).toBe('healing_unsafe');
      }),
    );
  });

  it('still refreshes the clock — someone did look at it', () => {
    expect(
      applyConfirmation(initialLifecycleState(T0), 'healing_unsafe', T0 + 9 * HOUR).lastConfirmedAt,
    ).toBe(T0 + 9 * HOUR);
  });
});

describe('applyConfirmation — fully_healed', () => {
  // D65 made this two verdicts rather than one. The invariant it was protecting is unchanged: nothing
  // *except* a "there is nothing there" verdict can move a hazard toward removal.
  it('is one of only two verdicts that increment goneCount', () => {
    fc.assert(
      fc.property(arbState, arbVerdict, (state, verdict) => {
        const next = applyConfirmation(state, verdict, T0);
        if (verdict === 'fully_healed' || verdict === 'never_existed') {
          expect(next.goneCount).toBe(state.goneCount + 1);
        } else {
          expect(next.goneCount).toBe(state.goneCount);
        }
      }),
    );
  });

  it('archives only once the removal threshold is reached', () => {
    const one = applyConfirmation(initialLifecycleState(T0), 'fully_healed', T0 + HOUR);
    expect(one.goneCount).toBe(1);
    expect(one.status).toBe('active'); // one vote is not enough — the asymmetry is deliberate

    const two = applyConfirmation(one, 'fully_healed', T0 + 2 * HOUR);
    expect(two.goneCount).toBe(2);
    expect(two.status).toBe('archived');
  });

  it('honors a tuned removal threshold', () => {
    let state = initialLifecycleState(T0);
    for (let i = 0; i < 3; i++) {
      state = applyConfirmation(state, 'fully_healed', T0 + i * HOUR, { removalThreshold: 4 });
      expect(state.status).toBe('active');
    }
    state = applyConfirmation(state, 'fully_healed', T0 + 4 * HOUR, { removalThreshold: 4 });
    expect(state.status).toBe('archived');
  });
});

describe('author self-confirmation (D54)', () => {
  // A reporter vouching for their own pin isn't independent evidence — otherwise one person could both
  // create a hazard and promote it to a hard warning for everyone else on that ice.
  it('never moves either counter', () => {
    fc.assert(
      fc.property(arbState, arbVerdict, (state, verdict) => {
        const next = applyConfirmation(state, verdict, T0, { isAuthor: true });
        expect(next.confirmCount).toBe(state.confirmCount);
        expect(next.goneCount).toBe(state.goneCount);
      }),
    );
  });

  it('cannot archive a hazard by itself, however many times it is repeated', () => {
    let state = initialLifecycleState(T0);
    for (let i = 0; i < 10; i++) {
      state = applyConfirmation(state, 'fully_healed', T0 + i * HOUR, { isAuthor: true });
    }
    expect(state.status).toBe('active');
  });

  it('still refreshes the decay clock — the author genuinely looked', () => {
    expect(
      applyConfirmation(initialLifecycleState(T0), 'still_there', T0 + 3 * HOUR, { isAuthor: true })
        .lastConfirmedAt,
    ).toBe(T0 + 3 * HOUR);
  });
});

describe('lifecycle invariants (property)', () => {
  it('counters never decrease and a hazard never un-archives', () => {
    fc.assert(
      fc.property(arbState, arbVerdict, fc.boolean(), (state, verdict, isAuthor) => {
        const next = applyConfirmation(state, verdict, T0, { isAuthor });
        expect(next.confirmCount).toBeGreaterThanOrEqual(state.confirmCount);
        expect(next.goneCount).toBeGreaterThanOrEqual(state.goneCount);
        if (state.status === 'archived') expect(next.status).toBe('archived');
      }),
    );
  });

  // The clock is monotonic: a confirmation moves it to `max(existing, at)`, never backward. A late
  // offline "still here" observed hours before an online vote already refreshed it must not age a pin
  // that was verified minutes ago — adding an observation can never make a hazard look *less* observed.
  it('advances the clock to max(existing, at) and never backward', () => {
    fc.assert(
      fc.property(
        arbState,
        arbVerdict,
        fc.boolean(),
        fc.integer({ min: T0 - 2000 * HOUR, max: T0 + 2000 * HOUR }),
        (state, verdict, isAuthor, at) => {
          const next = applyConfirmation(state, verdict, at, { isAuthor });
          expect(next.lastConfirmedAt).toBe(Math.max(state.lastConfirmedAt, at));
          expect(next.lastConfirmedAt).toBeGreaterThanOrEqual(state.lastConfirmedAt);
        },
      ),
    );
  });

  it('archiving requires goneCount to have reached the threshold', () => {
    fc.assert(
      fc.property(arbState, arbVerdict, (state, verdict) => {
        const next = applyConfirmation(state, verdict, T0);
        if (next.status === 'archived' && state.status !== 'archived') {
          expect(next.goneCount).toBeGreaterThanOrEqual(DEFAULT_REMOVAL_THRESHOLD);
          // "It healed" or "it was never here" — pooled (D65), and still nothing else.
          expect(['fully_healed', 'never_existed']).toContain(verdict);
        }
      }),
    );
  });

  it('is pure — the input state is never mutated', () => {
    const state = initialLifecycleState(T0);
    const snapshot = { ...state };
    applyConfirmation(state, 'fully_healed', T0 + HOUR);
    expect(state).toEqual(snapshot);
  });
});

describe('deriveHazardLifecycle', () => {
  const AUTHOR = 'author';
  const CREATED = T0 - 100 * HOUR;
  const opts = { authorId: AUTHOR, createdAt: CREATED, priorStatus: 'active' as const };
  const vote = (userId: string, verdict: HazardVerdict, at: number): HazardVoteRecord => ({
    userId,
    verdict,
    at,
  });

  it('counts distinct non-author users, not vote rows', () => {
    // Same user, two fully_healed rows (an offline replay, or a re-vote past the window): still ONE
    // gone verdict, so it must not reach the removal threshold. This is the D3 abuse the whole
    // derive-from-votes design exists to prevent.
    const state = deriveHazardLifecycle(
      [vote('troll', 'fully_healed', T0 - HOUR), vote('troll', 'fully_healed', T0)],
      opts,
    );
    expect(state.goneCount).toBe(1);
    expect(state.status).toBe('active');
  });

  it('archives only once two distinct users say fully_healed', () => {
    const state = deriveHazardLifecycle(
      [vote('a', 'fully_healed', T0), vote('b', 'fully_healed', T0)],
      opts,
    );
    expect(state.goneCount).toBe(2);
    expect(state.status).toBe('archived');
  });

  it("uses each user's latest verdict only", () => {
    // A user who said fully_healed then changed to still_there counts as a still_there, not both.
    const state = deriveHazardLifecycle(
      [vote('a', 'fully_healed', T0 - HOUR), vote('a', 'still_there', T0)],
      opts,
    );
    expect(state.goneCount).toBe(0);
    expect(state.confirmCount).toBe(1);
  });

  it("excludes the author's own vote from both thresholds", () => {
    const state = deriveHazardLifecycle(
      [vote(AUTHOR, 'still_there', T0), vote(AUTHOR, 'fully_healed', T0 + HOUR)],
      opts,
    );
    expect(state.confirmCount).toBe(0);
    expect(state.goneCount).toBe(0);
    // ...but the author's observation still refreshes the clock.
    expect(state.lastConfirmedAt).toBe(T0 + HOUR);
  });

  it('takes lastConfirmedAt as the max over all votes and creation, never backward', () => {
    const state = deriveHazardLifecycle(
      [vote('a', 'still_there', T0 - 50 * HOUR), vote('b', 'still_there', T0 - 10 * HOUR)],
      opts,
    );
    expect(state.lastConfirmedAt).toBe(T0 - 10 * HOUR);
    // With no votes at all, it floors at creation time.
    expect(deriveHazardLifecycle([], opts).lastConfirmedAt).toBe(CREATED);
  });

  it('reflects the single most recent vote in healingState (author included)', () => {
    const healing = deriveHazardLifecycle(
      [vote('a', 'fully_healed', T0 - HOUR), vote('b', 'healing_unsafe', T0)],
      opts,
    );
    expect(healing.healingState).toBe('healing_unsafe');
    const superseded = deriveHazardLifecycle(
      [vote('a', 'healing_unsafe', T0 - HOUR), vote('b', 'still_there', T0)],
      opts,
    );
    expect(superseded.healingState).toBe('none');
  });

  it('never un-archives: an already-archived hazard stays archived even if a verdict changes', () => {
    // b recanting drops goneCount below threshold, but archival is a ratchet (D15).
    const state = deriveHazardLifecycle(
      [vote('a', 'fully_healed', T0), vote('b', 'still_there', T0)],
      {
        ...opts,
        priorStatus: 'archived',
      },
    );
    expect(state.goneCount).toBe(1);
    expect(state.status).toBe('archived');
  });

  it('is idempotent — re-deriving the same votes yields the same state', () => {
    const votes = [vote('a', 'still_there', T0), vote('b', 'fully_healed', T0 - HOUR)];
    expect(deriveHazardLifecycle(votes, opts)).toEqual(deriveHazardLifecycle([...votes], opts));
  });
});

describe('shouldArchive / isProvisional', () => {
  it('archives at or above the threshold', () => {
    expect(shouldArchive(0)).toBe(false);
    expect(shouldArchive(1)).toBe(false);
    expect(shouldArchive(2)).toBe(true);
    expect(shouldArchive(99)).toBe(true);
  });

  it('promotes out of provisional at the confirm threshold', () => {
    expect(isProvisional(0)).toBe(true);
    expect(isProvisional(DEFAULT_CONFIRM_THRESHOLD)).toBe(false);
    expect(isProvisional(1, 3)).toBe(true);
    expect(isProvisional(3, 3)).toBe(false);
  });

  // Removal is deliberately harder than confirmation: a wrong "still here" costs a detour, a wrong
  // "all clear" can kill someone (D3).
  it('keeps removal strictly harder than confirmation', () => {
    expect(DEFAULT_REMOVAL_THRESHOLD).toBeGreaterThan(DEFAULT_CONFIRM_THRESHOLD);
  });
});

/**
 * D64 — a suggested crossing decays in the opposite direction from a hazard, and D65's fourth verdict.
 * Both land in this reducer, and both are about the *removal* side of the asymmetry, which is the side
 * that costs someone something when it's wrong.
 */
describe('never_existed (D65) pools with fully_healed', () => {
  const vote = (userId: string, verdict: HazardVerdict, at: number): HazardVoteRecord => ({
    userId,
    verdict,
    at,
  });
  const opts = { authorId: 'author', createdAt: T0, priorStatus: 'active' as const };

  it('counts toward the same threshold — two people saying "nothing there" is two votes', () => {
    const state = deriveHazardLifecycle(
      [vote('a', 'fully_healed', T0 + HOUR), vote('b', 'never_existed', T0 + 2 * HOUR)],
      opts,
    );
    // They disagree about history and agree about now. The map shows now.
    expect(state.goneCount).toBe(2);
    expect(state.status).toBe('archived');
  });

  it('does not make removal cheaper — one vote still leaves the pin up', () => {
    const state = deriveHazardLifecycle([vote('a', 'never_existed', T0 + HOUR)], opts);
    expect(state.goneCount).toBe(1);
    expect(state.status).toBe('active');
  });

  it('still ignores the author, who cannot clear their own pin alone', () => {
    const state = deriveHazardLifecycle(
      [vote('author', 'never_existed', T0 + HOUR), vote('author', 'fully_healed', T0 + 2 * HOUR)],
      opts,
    );
    expect(state.goneCount).toBe(0);
    expect(state.status).toBe('active');
  });
});

describe('disputed (D64) — passage markers only', () => {
  const vote = (userId: string, verdict: HazardVerdict, at: number): HazardVoteRecord => ({
    userId,
    verdict,
    at,
  });
  const base = { authorId: 'author', createdAt: T0, priorStatus: 'active' as const };

  it('one "gone" vote on a crossing is visible instead of silent', () => {
    const state = deriveHazardLifecycle([vote('a', 'fully_healed', T0 + HOUR)], {
      ...base,
      isPassage: true,
    });
    expect(state.healingState).toBe('disputed');
    expect(state.status).toBe('active'); // closing still takes two
  });

  it('the same vote on a hazard changes nothing on screen — the unsafe direction', () => {
    const state = deriveHazardLifecycle([vote('a', 'fully_healed', T0 + HOUR)], base);
    expect(state.healingState).toBe('none');
  });

  it('outranks healing_unsafe when both apply', () => {
    const state = deriveHazardLifecycle(
      [vote('a', 'fully_healed', T0 + HOUR), vote('b', 'healing_unsafe', T0 + 2 * HOUR)],
      { ...base, isPassage: true },
    );
    // "The ridge is closed here" is a stronger claim than "the crossing is dicey".
    expect(state.healingState).toBe('disputed');
  });

  it('stops being disputed once the second vote closes it', () => {
    const state = deriveHazardLifecycle(
      [vote('a', 'fully_healed', T0 + HOUR), vote('b', 'never_existed', T0 + 2 * HOUR)],
      { ...base, isPassage: true },
    );
    expect(state.status).toBe('archived');
    expect(state.healingState).not.toBe('disputed');
  });

  it('a crossing nobody has disputed reads normally', () => {
    const state = deriveHazardLifecycle([vote('a', 'still_there', T0 + HOUR)], {
      ...base,
      isPassage: true,
    });
    expect(state.healingState).toBe('none');
    expect(state.confirmCount).toBe(1);
  });
});

describe('confirmThresholdFor (D64)', () => {
  it('asks twice as much of a pin that says you can go this way', () => {
    expect(confirmThresholdFor(true)).toBe(PASSAGE_CONFIRM_THRESHOLD);
    expect(confirmThresholdFor(false)).toBe(DEFAULT_CONFIRM_THRESHOLD);
    expect(PASSAGE_CONFIRM_THRESHOLD).toBeGreaterThan(DEFAULT_CONFIRM_THRESHOLD);
  });

  it('leaves a one-confirm crossing provisional, where a hazard would be confirmed', () => {
    expect(isProvisional(1, confirmThresholdFor(true))).toBe(true);
    expect(isProvisional(1, confirmThresholdFor(false))).toBe(false);
    expect(isProvisional(2, confirmThresholdFor(true))).toBe(false);
  });
});
