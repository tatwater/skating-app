import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  applyConfirmation,
  DEFAULT_CONFIRM_THRESHOLD,
  DEFAULT_REMOVAL_THRESHOLD,
  type HazardLifecycleState,
  type HazardVerdict,
  initialLifecycleState,
  isProvisional,
  shouldArchive,
} from './hazardLifecycle'

const T0 = Date.UTC(2026, 0, 15, 12, 0, 0)
const HOUR = 3_600_000

const arbVerdict: fc.Arbitrary<HazardVerdict> = fc.constantFrom(
  'still_there',
  'healing_unsafe',
  'fully_healed',
)

const arbState: fc.Arbitrary<HazardLifecycleState> = fc.record({
  lastConfirmedAt: fc.integer({ min: T0 - 1000 * HOUR, max: T0 }),
  confirmCount: fc.integer({ min: 0, max: 10 }),
  goneCount: fc.integer({ min: 0, max: 10 }),
  healingState: fc.constantFrom('none' as const, 'healing_unsafe' as const),
  status: fc.constantFrom('active' as const, 'archived' as const),
})

describe('initialLifecycleState', () => {
  it('starts active, unconfirmed, not healing', () => {
    expect(initialLifecycleState(T0)).toEqual({
      lastConfirmedAt: T0,
      confirmCount: 0,
      goneCount: 0,
      healingState: 'none',
      status: 'active',
    })
  })

  it('is provisional at birth — a brand-new pin can never fire a hard warning', () => {
    expect(isProvisional(initialLifecycleState(T0).confirmCount)).toBe(true)
  })
})

describe('applyConfirmation — still_there', () => {
  it('resets the clock and counts toward confirmation', () => {
    const next = applyConfirmation(initialLifecycleState(T0), 'still_there', T0 + 5 * HOUR)
    expect(next.lastConfirmedAt).toBe(T0 + 5 * HOUR)
    expect(next.confirmCount).toBe(1)
    expect(next.goneCount).toBe(0)
    expect(next.status).toBe('active')
  })

  it('clears an earlier healing annotation — seeing it intact supersedes "healing"', () => {
    const healing = applyConfirmation(initialLifecycleState(T0), 'healing_unsafe', T0 + HOUR)
    expect(healing.healingState).toBe('healing_unsafe')
    expect(applyConfirmation(healing, 'still_there', T0 + 2 * HOUR).healingState).toBe('none')
  })
})

describe('applyConfirmation — healing_unsafe', () => {
  // The whole reason the middle verdict exists: a healing hazard is still a hazard, and saying so must
  // not nudge it toward removal.
  it('keeps the pin: moves neither counter and never archives', () => {
    fc.assert(
      fc.property(arbState, (state) => {
        const next = applyConfirmation(state, 'healing_unsafe', T0)
        expect(next.confirmCount).toBe(state.confirmCount)
        expect(next.goneCount).toBe(state.goneCount)
        expect(next.status).toBe(state.status)
        expect(next.healingState).toBe('healing_unsafe')
      }),
    )
  })

  it('still refreshes the clock — someone did look at it', () => {
    expect(
      applyConfirmation(initialLifecycleState(T0), 'healing_unsafe', T0 + 9 * HOUR).lastConfirmedAt,
    ).toBe(T0 + 9 * HOUR)
  })
})

describe('applyConfirmation — fully_healed', () => {
  it('is the only verdict that increments goneCount', () => {
    fc.assert(
      fc.property(arbState, arbVerdict, (state, verdict) => {
        const next = applyConfirmation(state, verdict, T0)
        if (verdict === 'fully_healed') {
          expect(next.goneCount).toBe(state.goneCount + 1)
        } else {
          expect(next.goneCount).toBe(state.goneCount)
        }
      }),
    )
  })

  it('archives only once the removal threshold is reached', () => {
    const one = applyConfirmation(initialLifecycleState(T0), 'fully_healed', T0 + HOUR)
    expect(one.goneCount).toBe(1)
    expect(one.status).toBe('active') // one vote is not enough — the asymmetry is deliberate

    const two = applyConfirmation(one, 'fully_healed', T0 + 2 * HOUR)
    expect(two.goneCount).toBe(2)
    expect(two.status).toBe('archived')
  })

  it('honors a tuned removal threshold', () => {
    let state = initialLifecycleState(T0)
    for (let i = 0; i < 3; i++) {
      state = applyConfirmation(state, 'fully_healed', T0 + i * HOUR, { removalThreshold: 4 })
      expect(state.status).toBe('active')
    }
    state = applyConfirmation(state, 'fully_healed', T0 + 4 * HOUR, { removalThreshold: 4 })
    expect(state.status).toBe('archived')
  })
})

describe('author self-confirmation (D54)', () => {
  // A reporter vouching for their own pin isn't independent evidence — otherwise one person could both
  // create a hazard and promote it to a hard warning for everyone else on that ice.
  it('never moves either counter', () => {
    fc.assert(
      fc.property(arbState, arbVerdict, (state, verdict) => {
        const next = applyConfirmation(state, verdict, T0, { isAuthor: true })
        expect(next.confirmCount).toBe(state.confirmCount)
        expect(next.goneCount).toBe(state.goneCount)
      }),
    )
  })

  it('cannot archive a hazard by itself, however many times it is repeated', () => {
    let state = initialLifecycleState(T0)
    for (let i = 0; i < 10; i++) {
      state = applyConfirmation(state, 'fully_healed', T0 + i * HOUR, { isAuthor: true })
    }
    expect(state.status).toBe('active')
  })

  it('still refreshes the decay clock — the author genuinely looked', () => {
    expect(
      applyConfirmation(initialLifecycleState(T0), 'still_there', T0 + 3 * HOUR, { isAuthor: true })
        .lastConfirmedAt,
    ).toBe(T0 + 3 * HOUR)
  })
})

describe('lifecycle invariants (property)', () => {
  it('counters never decrease and a hazard never un-archives', () => {
    fc.assert(
      fc.property(arbState, arbVerdict, fc.boolean(), (state, verdict, isAuthor) => {
        const next = applyConfirmation(state, verdict, T0, { isAuthor })
        expect(next.confirmCount).toBeGreaterThanOrEqual(state.confirmCount)
        expect(next.goneCount).toBeGreaterThanOrEqual(state.goneCount)
        if (state.status === 'archived') expect(next.status).toBe('archived')
      }),
    )
  })

  it('every confirmation refreshes the clock, whatever the verdict', () => {
    fc.assert(
      fc.property(arbState, arbVerdict, fc.boolean(), (state, verdict, isAuthor) => {
        expect(applyConfirmation(state, verdict, T0, { isAuthor }).lastConfirmedAt).toBe(T0)
      }),
    )
  })

  it('archiving requires goneCount to have reached the threshold', () => {
    fc.assert(
      fc.property(arbState, arbVerdict, (state, verdict) => {
        const next = applyConfirmation(state, verdict, T0)
        if (next.status === 'archived' && state.status !== 'archived') {
          expect(next.goneCount).toBeGreaterThanOrEqual(DEFAULT_REMOVAL_THRESHOLD)
          expect(verdict).toBe('fully_healed')
        }
      }),
    )
  })

  it('is pure — the input state is never mutated', () => {
    const state = initialLifecycleState(T0)
    const snapshot = { ...state }
    applyConfirmation(state, 'fully_healed', T0 + HOUR)
    expect(state).toEqual(snapshot)
  })
})

describe('shouldArchive / isProvisional', () => {
  it('archives at or above the threshold', () => {
    expect(shouldArchive(0)).toBe(false)
    expect(shouldArchive(1)).toBe(false)
    expect(shouldArchive(2)).toBe(true)
    expect(shouldArchive(99)).toBe(true)
  })

  it('promotes out of provisional at the confirm threshold', () => {
    expect(isProvisional(0)).toBe(true)
    expect(isProvisional(DEFAULT_CONFIRM_THRESHOLD)).toBe(false)
    expect(isProvisional(1, 3)).toBe(true)
    expect(isProvisional(3, 3)).toBe(false)
  })

  // Removal is deliberately harder than confirmation: a wrong "still here" costs a detour, a wrong
  // "all clear" can kill someone (D3).
  it('keeps removal strictly harder than confirmation', () => {
    expect(DEFAULT_REMOVAL_THRESHOLD).toBeGreaterThan(DEFAULT_CONFIRM_THRESHOLD)
  })
})
