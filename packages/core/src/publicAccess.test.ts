import { describe, expect, test } from 'vitest';
import { displayScore, MIN_VISIBLE_ZOOM_FLOOR, minVisibleZoomFor } from './display';
import {
  accessReportGateMessage,
  describePendingAccessReports,
  describePublicAccess,
  disputesReview,
  isNoPublicAccess,
  NO_PUBLIC_ACCESS_OPACITY_SCALE,
  type PublicAccess,
  withAccessDim,
} from './publicAccess';
import { DORMANT_MIN_VISIBLE_ZOOM, standingOf } from './standing';

const UTC = 'UTC';
const RULED_AT = Date.parse('2026-03-04T15:00:00Z');

const NONE: PublicAccess = { verdict: 'none', decidedAt: RULED_AT, decidedByUserId: 'u1' };
const OPEN: PublicAccess = { verdict: 'open', decidedAt: RULED_AT, decidedByUserId: 'u1' };

describe('the zoom rung (N7b — a `none` body is dormant, not demoted)', () => {
  test('a `none` body draws at the dormant rung, past the D49 floor', () => {
    const area = 5_000_000;
    const plain = minVisibleZoomFor(displayScore({ surfaceAreaSqM: area }), true);
    const shut = minVisibleZoomFor(displayScore({ surfaceAreaSqM: area }), false);
    expect(plain).toBeLessThanOrEqual(MIN_VISIBLE_ZOOM_FLOOR);
    expect(shut).toBe(DORMANT_MIN_VISIBLE_ZOOM);
    expect(shut).toBeGreaterThan(MIN_VISIBLE_ZOOM_FLOOR);
  });

  test('an enormous private lake lands on the same rung as a tiny one — standing, not size', () => {
    const champlain = minVisibleZoomFor(displayScore({ surfaceAreaSqM: 1.1e9 }), false);
    const puddle = minVisibleZoomFor(displayScore({ surfaceAreaSqM: 1 }), false);
    expect(champlain).toBe(puddle);
  });

  test('the score itself is untouched — every term is still a boost', () => {
    const base = { surfaceAreaSqM: 5_000_000, curatedBoost: 0.3 };
    expect(displayScore(base)).toBeGreaterThan(displayScore({ surfaceAreaSqM: 5_000_000 }));
    expect(displayScore({ surfaceAreaSqM: 1 })).toBeGreaterThanOrEqual(0);
  });

  test('standingOf reads the verdict as dormancy', () => {
    const body = { dedupStatus: 'clean' as const, publicAccess: NONE };
    expect(standingOf(body)).toEqual({
      standing: 'dormant',
      since: RULED_AT,
      reason: 'no_public_access',
    });
    expect(standingOf({ dedupStatus: 'clean', publicAccess: OPEN }).standing).toBe('active');
  });
});

describe('the map dim expression', () => {
  test('wraps a constant and a nested expression alike', () => {
    expect(withAccessDim(0.35)[0]).toBe('*');
    expect(withAccessDim(0.35)[1]).toBe(0.35);
    const nested = ['case', ['boolean', ['feature-state', 'selected'], false], 0.6, 0.35];
    expect(withAccessDim(nested)[1]).toBe(nested);
  });

  test('is a multiplier, so a dimmed lake still brightens when selected', () => {
    // The property the plan turns on: 0.6 * 0.5 > 0.35 * 0.5, i.e. the selection survives the dim.
    expect(0.6 * NO_PUBLIC_ACCESS_OPACITY_SCALE).toBeGreaterThan(
      0.35 * NO_PUBLIC_ACCESS_OPACITY_SCALE,
    );
  });

  test('either signal dims — a moderator ruling or the viewer’s own report', () => {
    const [, , caseExpr] = withAccessDim(1) as [unknown, unknown, unknown[]];
    const [, condition, dimmed, plain] = caseExpr;
    expect((condition as unknown[])[0]).toBe('any');
    expect(dimmed).toBe(NO_PUBLIC_ACCESS_OPACITY_SCALE);
    expect(plain).toBe(1);
  });

  /**
   * A bare `['get', 'x']` on a feature missing the property evaluates to `null`, and `any` over a null
   * throws in MapLibre's evaluator rather than reading as false — which would break the layer for
   * every body, not just the flagged ones.
   */
  test('compares against true rather than reading the property as a boolean', () => {
    const json = JSON.stringify(withAccessDim(1));
    expect(json).toContain('["==",["get","inactive"],true]');
    expect(json).toContain('["==",["get","selfFlagged"],true]');
  });
});

describe('copy', () => {
  test('“none” names the review, and states the claim about the approach, not about ownership', () => {
    expect(describePublicAccess(NONE, UTC)).toBe(
      'A moderator reviewed this on March 4, 2026 and found no public access — every approach crosses private land.',
    );
  });

  test('“open” is a plain fact — no date, no moderator (founder call, 2026-09-16)', () => {
    expect(describePublicAccess(OPEN, UTC)).toBe('Accessible to the public.');
  });

  test('nothing ruled renders nothing', () => {
    expect(describePublicAccess(undefined)).toBeNull();
  });

  test('the pending line counts people, and stays quiet at zero', () => {
    expect(describePendingAccessReports(0)).toBeNull();
    expect(describePendingAccessReports(1)).toBe(
      '1 person has reported no public access here — under review.',
    );
    expect(describePendingAccessReports(3)).toBe(
      '3 people have reported no public access here — under review.',
    );
  });

  test('the gate message names the date so the refusal is contestable', () => {
    expect(accessReportGateMessage(OPEN, UTC)).toContain('March 4, 2026');
    expect(accessReportGateMessage(OPEN, UTC)).toContain('say what changed');
  });
});

describe('isNoPublicAccess', () => {
  test('only “none” dims', () => {
    expect(isNoPublicAccess({ publicAccess: NONE })).toBe(true);
    expect(isNoPublicAccess({ publicAccess: OPEN })).toBe(false);
    expect(isNoPublicAccess({})).toBe(false);
    expect(isNoPublicAccess(undefined)).toBe(false);
  });
});

describe('disputesReview', () => {
  test('a report after an “open” ruling disputes it', () => {
    expect(disputesReview(OPEN, RULED_AT + 86_400_000)).toBe(OPEN);
  });

  /**
   * `>=` rather than `>`: a report filed in the same millisecond was still checked against a verdict
   * that already existed, so it cannot be anything but a dispute. Anything genuinely older was
   * resolved by the ruling and is no longer open, so this boundary is only reachable from one side.
   */
  test('the same millisecond counts', () => {
    expect(disputesReview(OPEN, RULED_AT)).toBe(OPEN);
  });

  test('a “none” ruling is never disputed this way — the body already says so', () => {
    expect(disputesReview(NONE, RULED_AT + 1)).toBeNull();
  });

  test('an unruled body has nothing to dispute', () => {
    expect(disputesReview(undefined, Date.now())).toBeNull();
  });
});
