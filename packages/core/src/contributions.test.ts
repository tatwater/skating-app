import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CONTRIBUTING_REQUEST_KINDS, contributionStands } from './contributions';

describe('what a contribution is (the founder, 2026-11-13)', () => {
  it('counts a report or a hazard while it stands', () => {
    expect(contributionStands.report({ moderationStatus: 'visible' })).toBe(true);
    expect(contributionStands.report({ moderationStatus: 'visible', authorDeletedAt: 1 })).toBe(
      false,
    );
    expect(contributionStands.report({ moderationStatus: 'hidden' })).toBe(false);
    expect(contributionStands.hazard({ moderationStatus: 'removed' })).toBe(false);
    expect(contributionStands.hazard({ moderationStatus: 'visible' })).toBe(true);
  });

  it('counts an access alert that was up, but not one retracted', () => {
    for (const status of ['active', 'official', 'expired', 'resolved']) {
      expect(contributionStands.accessAlert({ status })).toBe(true);
    }
    expect(contributionStands.accessAlert({ status: 'retracted' })).toBe(false);
  });

  it('counts a "not publicly accessible" report on a body — never a flag on someone’s content', () => {
    const flag = { reason: 'no_public_access', targetType: 'waterbody', status: 'open' };
    expect(contributionStands.noPublicAccess(flag)).toBe(true);
    expect(contributionStands.noPublicAccess({ ...flag, status: 'actioned' })).toBe(true);
    expect(contributionStands.noPublicAccess({ ...flag, status: 'dismissed' })).toBe(false);
    expect(contributionStands.noPublicAccess({ ...flag, reason: 'spam' })).toBe(false);
    expect(contributionStands.noPublicAccess({ ...flag, targetType: 'report' })).toBe(false);
  });

  it('counts a put-in a person placed, not one the machine derived', () => {
    expect(
      contributionStands.putIn({ source: 'official', status: 'visible', createdByUserId: 'u' }),
    ).toBe(true);
    expect(
      contributionStands.putIn({ source: 'official', status: 'hidden', createdByUserId: 'u' }),
    ).toBe(false);
    expect(
      contributionStands.putIn({ source: 'derived', status: 'visible', createdByUserId: 'u' }),
    ).toBe(false);
    expect(contributionStands.putIn({ source: 'official', status: 'visible' })).toBe(false);
  });

  it('counts a request to add or activate a body, or a proposed name, until declined', () => {
    for (const kind of CONTRIBUTING_REQUEST_KINDS) {
      expect(contributionStands.corpusRequest({ kind, status: 'open' })).toBe(true);
      expect(contributionStands.corpusRequest({ kind, status: 'approved' })).toBe(true);
      expect(contributionStands.corpusRequest({ kind, status: 'declined' })).toBe(false);
    }
    for (const kind of ['restore', 'takedown', 'contest_access']) {
      expect(contributionStands.corpusRequest({ kind, status: 'open' })).toBe(false);
    }
  });

  it('never counts anything withdrawn, retracted, removed, hidden, declined or dismissed', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('hidden', 'removed'),
        fc.option(fc.nat(), { nil: undefined }),
        (m, d) => {
          expect(contributionStands.report({ moderationStatus: m, authorDeletedAt: d })).toBe(
            false,
          );
          expect(contributionStands.hazard({ moderationStatus: m })).toBe(false);
        },
      ),
    );
    fc.assert(
      fc.property(fc.string(), fc.string(), (reason, kind) => {
        expect(contributionStands.accessAlert({ status: 'retracted' })).toBe(false);
        expect(
          contributionStands.noPublicAccess({
            reason,
            targetType: 'waterbody',
            status: 'dismissed',
          }),
        ).toBe(false);
        expect(contributionStands.corpusRequest({ kind, status: 'declined' })).toBe(false);
      }),
    );
  });
});
