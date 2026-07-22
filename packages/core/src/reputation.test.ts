import { describe, expect, it } from 'vitest';
import {
  type AgreeableReport,
  deriveTrustClass,
  hasMeasuredThickness,
  hazardsAgree,
  reportsAgree,
} from './reputation';
import { NEW_ACCOUNT_WINDOW_MS, TRUST_CLASS_THRESHOLDS } from './reputationConfig';

const DAY = 24 * 60 * 60 * 1000;

describe('deriveTrustClass', () => {
  it('classifies by point floor, top-down', () => {
    const old = NEW_ACCOUNT_WINDOW_MS + DAY; // past the New window, so age never rescues
    expect(deriveTrustClass(TRUST_CLASS_THRESHOLDS.leader, old)).toBe('leader');
    expect(deriveTrustClass(TRUST_CLASS_THRESHOLDS.leader + 1000, old)).toBe('leader');
    expect(deriveTrustClass(TRUST_CLASS_THRESHOLDS.expert, old)).toBe('expert');
    expect(deriveTrustClass(TRUST_CLASS_THRESHOLDS.leader - 1, old)).toBe('expert');
    expect(deriveTrustClass(TRUST_CLASS_THRESHOLDS.trusted, old)).toBe('trusted');
    expect(deriveTrustClass(TRUST_CLASS_THRESHOLDS.expert - 1, old)).toBe('trusted');
  });

  it('shows the New chip below trusted only inside the New window', () => {
    expect(deriveTrustClass(0, 0)).toBe('new');
    expect(deriveTrustClass(0, NEW_ACCOUNT_WINDOW_MS - 1)).toBe('new');
    expect(deriveTrustClass(TRUST_CLASS_THRESHOLDS.trusted - 1, DAY)).toBe('new');
  });

  it('shows no chip below trusted once past the New window (never "Not trusted")', () => {
    expect(deriveTrustClass(0, NEW_ACCOUNT_WINDOW_MS)).toBeNull();
    expect(
      deriveTrustClass(TRUST_CLASS_THRESHOLDS.trusted - 1, NEW_ACCOUNT_WINDOW_MS + DAY),
    ).toBeNull();
  });

  it('lets points win over the New window (a fast earner inside the window is still classed)', () => {
    expect(deriveTrustClass(TRUST_CLASS_THRESHOLDS.expert, DAY)).toBe('expert');
  });
});

const rep = (overrides: Partial<AgreeableReport> = {}): AgreeableReport => ({ ...overrides });

describe('reportsAgree', () => {
  it('agrees when skateQuality is within one ordinal step', () => {
    expect(reportsAgree(rep({ skateQuality: 'great' }), rep({ skateQuality: 'good' }))).toBe(true);
    expect(reportsAgree(rep({ skateQuality: 'good' }), rep({ skateQuality: 'good' }))).toBe(true);
    expect(reportsAgree(rep({ skateQuality: 'fair' }), rep({ skateQuality: 'poor' }))).toBe(true);
  });

  it('does not agree on quality more than one step apart', () => {
    expect(reportsAgree(rep({ skateQuality: 'great' }), rep({ skateQuality: 'fair' }))).toBe(false);
    expect(reportsAgree(rep({ skateQuality: 'great' }), rep({ skateQuality: 'poor' }))).toBe(false);
  });

  it('agrees on a shared ice type regardless of quality', () => {
    expect(
      reportsAgree(
        rep({ skateQuality: 'great', iceTypes: ['black_ice', 'white_ice'] }),
        rep({ skateQuality: 'poor', iceTypes: ['white_ice'] }),
      ),
    ).toBe(true);
  });

  it('does not agree with no shared ice type and no comparable quality', () => {
    expect(reportsAgree(rep({ iceTypes: ['black_ice'] }), rep({ iceTypes: ['snow_ice'] }))).toBe(
      false,
    );
    expect(reportsAgree(rep({ skateQuality: 'great' }), rep({ iceTypes: ['black_ice'] }))).toBe(
      false,
    );
    expect(reportsAgree(rep(), rep())).toBe(false);
  });
});

describe('hazardsAgree', () => {
  it('agrees only on the same type', () => {
    expect(hazardsAgree({ type: 'open_water' }, { type: 'open_water' })).toBe(true);
    expect(hazardsAgree({ type: 'open_water' }, { type: 'pressure_ridge' })).toBe(false);
  });
});

describe('hasMeasuredThickness', () => {
  it('is true with at least one measured reading', () => {
    expect(
      hasMeasuredThickness({
        iceThickness: { readings: [{ method: 'estimated' }, { method: 'measured' }] },
      }),
    ).toBe(true);
  });

  it('is false with only estimated readings, no readings, or no thickness block', () => {
    expect(hasMeasuredThickness({ iceThickness: { readings: [{ method: 'estimated' }] } })).toBe(
      false,
    );
    expect(hasMeasuredThickness({ iceThickness: { readings: [] } })).toBe(false);
    expect(hasMeasuredThickness({})).toBe(false);
  });
});
