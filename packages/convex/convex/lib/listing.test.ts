import { isActive } from '@skating/core';
import { describe, expect, it } from 'vitest';
import { isListed } from './listing';

describe('isListed (D48, re-scoped by N7b — reachable, not pushed)', () => {
  it('lists canonical bodies (no reviewStatus) and auto-visible/approved user bodies', () => {
    // Canonical OSM/NHD import — no reviewStatus at all.
    expect(isListed({ dedupStatus: 'clean' })).toBe(true);
    // Auto-visible user body awaiting after-the-fact review (D37).
    expect(isListed({ dedupStatus: 'clean', reviewStatus: 'pending' })).toBe(true);
    expect(isListed({ dedupStatus: 'clean', reviewStatus: 'approved' })).toBe(true);
  });

  it('unlists a rejected or merged body', () => {
    expect(isListed({ dedupStatus: 'clean', reviewStatus: 'rejected' })).toBe(false);
    expect(isListed({ dedupStatus: 'merged' })).toBe(false);
  });

  it('treats suspected_duplicate as still listed (only a confirmed merge unlists)', () => {
    expect(isListed({ dedupStatus: 'suspected_duplicate' })).toBe(true);
  });

  /**
   * The N7b change. A removed body keeps its cell rows so a track over it resolves to *it* — the
   * landowner skating their own taken-down pond must not mint a fresh public body. What removal
   * takes away is standing: it is on no push surface and not in search.
   */
  it('a removed body is still listed (reachable) but not active (pushed)', () => {
    const removed = { dedupStatus: 'clean' as const, removedAt: 1_700_000_000_000 };
    expect(isListed(removed)).toBe(true);
    expect(isActive(removed)).toBe(false);
  });

  it('rejected wins even if removed — an unlisted row has no standing to lose', () => {
    expect(
      isListed({ dedupStatus: 'clean', reviewStatus: 'rejected', removedAt: 1_700_000_000_000 }),
    ).toBe(false);
  });
});
