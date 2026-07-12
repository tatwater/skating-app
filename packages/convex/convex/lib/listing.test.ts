import { describe, expect, it } from 'vitest'
import { isListed, type ListableBody } from './listing'

describe('isListed (D48)', () => {
  it('lists canonical bodies (no reviewStatus) and auto-visible/approved user bodies', () => {
    // Canonical OSM/NHD import — no reviewStatus at all.
    expect(isListed({ dedupStatus: 'clean' })).toBe(true)
    // Auto-visible user body awaiting after-the-fact review (D37).
    expect(isListed({ dedupStatus: 'clean', reviewStatus: 'pending' })).toBe(true)
    expect(isListed({ dedupStatus: 'clean', reviewStatus: 'approved' })).toBe(true)
  })

  it('unlists a rejected, merged, or removed body', () => {
    expect(isListed({ dedupStatus: 'clean', reviewStatus: 'rejected' })).toBe(false)
    expect(isListed({ dedupStatus: 'merged' })).toBe(false)
    expect(isListed({ dedupStatus: 'clean', removedAt: 1_700_000_000_000 })).toBe(false)
  })

  it('treats suspected_duplicate as still listed (only a confirmed merge unlists)', () => {
    expect(isListed({ dedupStatus: 'suspected_duplicate' })).toBe(true)
  })

  it('any single suppression reason is sufficient (removed wins even if approved)', () => {
    const removedButApproved: ListableBody = {
      dedupStatus: 'clean',
      reviewStatus: 'approved',
      removedAt: 1_700_000_000_000,
    }
    expect(isListed(removedButApproved)).toBe(false)
  })
})
