import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_REASON_MAX,
  AUDIT_REASON_TOO_LONG,
  AUDIT_VIA_MAX_LENGTH,
  isAuditVia,
} from './auditVia';

describe('isAuditVia — what an audit row records it was done through', () => {
  it('takes a script name in hyphen-joined lowercase words', () => {
    for (const name of ['seed-destinations', 'agent', 'b01-backfill-2']) {
      expect(isAuditVia(name)).toBe(true);
    }
  });

  it('refuses anything else: case, spaces, punctuation, empty words, non-strings', () => {
    for (const bad of [
      '',
      'Seed-Destinations',
      'seed destinations',
      'seed_destinations',
      '-seed',
      'seed-',
      'seed--destinations',
      'seed/destinations',
      'séed',
      undefined,
      null,
      42,
      ['seed'],
    ]) {
      expect(isAuditVia(bad)).toBe(false);
    }
  });

  it('is bounded: the longest name passes, one character more does not', () => {
    expect(isAuditVia('a'.repeat(AUDIT_VIA_MAX_LENGTH))).toBe(true);
    expect(isAuditVia('a'.repeat(AUDIT_VIA_MAX_LENGTH + 1))).toBe(false);
  });

  it('never passes a string with anything but lowercase letters, digits and inner hyphens', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (s) => {
        if (isAuditVia(s)) {
          expect(s.length).toBeGreaterThan(0);
          expect(s.length).toBeLessThanOrEqual(AUDIT_VIA_MAX_LENGTH);
          expect(s).toMatch(/^[a-z0-9-]+$/);
          expect(s.startsWith('-') || s.endsWith('-') || s.includes('--')).toBe(false);
        }
      }),
    );
  });
});

describe('the audit reason cap (D261)', () => {
  it('is 2,000 characters, and its refusal says so plainly', () => {
    expect(AUDIT_REASON_MAX).toBe(2_000);
    expect(AUDIT_REASON_TOO_LONG).toBe('A reason can be at most 2,000 characters.');
  });
});
