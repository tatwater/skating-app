import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_REPORTED_MAX_LENGTH,
  CONSENT_RETENTION_YEARS,
  capClientReported,
  consentPurgeAt,
  termsAcceptanceContext,
} from './consentRecord';

describe('consentPurgeAt', () => {
  it('is six calendar years on, at the same time of day, in UTC', () => {
    expect(CONSENT_RETENTION_YEARS).toBe(6);
    expect(consentPurgeAt(Date.UTC(2026, 10, 24, 15, 30, 5, 250))).toBe(
      Date.UTC(2032, 10, 24, 15, 30, 5, 250),
    );
  });

  it('lands a 29 February on 1 March', () => {
    expect(consentPurgeAt(Date.UTC(2028, 1, 29, 9))).toBe(Date.UTC(2034, 2, 1, 9));
  });

  it('is always later, by at least six years of 365 days', () => {
    // Six calendar years hold at least one leap day, except across 2100, which has none.
    const SIX_YEARS_MIN = 6 * 365 * 24 * 60 * 60 * 1000;
    fc.assert(
      fc.property(fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2100, 0, 1) }), (t) => {
        return consentPurgeAt(t) - t >= SIX_YEARS_MIN;
      }),
    );
  });
});

describe('termsAcceptanceContext', () => {
  it('names the four ways an acceptance happens', () => {
    expect(termsAcceptanceContext({ profile: 'none' })).toBe('first_run');
    expect(termsAcceptanceContext({ profile: 'emptied', termsVersion: '2026-11-24' })).toBe(
      'reintroduced',
    );
    expect(termsAcceptanceContext({ profile: 'live' })).toBe('returning');
    expect(termsAcceptanceContext({ profile: 'live', termsVersion: '2026-11-24' })).toBe(
      'version_change',
    );
  });
});

describe('capClientReported', () => {
  it('trims and cuts to the cap', () => {
    expect(capClientReported('  Mozilla/5.0  ')).toBe('Mozilla/5.0');
    expect(capClientReported('x'.repeat(600))).toHaveLength(CLIENT_REPORTED_MAX_LENGTH);
  });
});
