import { describe, expect, it } from 'vitest';
import { destinationPoint, type LatLng } from './geometry';
import {
  AUTOMERGE_MIN_FOOTPRINT_IOU,
  type MergeCandidate,
  mergeSurvivorOf,
  shouldAutoMerge,
} from './hazardMerge';
import type { HazardType } from './types';

const ORIGIN: LatLng = { lat: 44.5, lng: -72.5 };

function pin(
  id: string,
  overrides: Partial<MergeCandidate> & { metersEast?: number; radiusMeters?: number } = {},
): MergeCandidate {
  const { metersEast = 0, radiusMeters = 40, ...rest } = overrides;
  const at = destinationPoint(ORIGIN, 90, metersEast);
  return {
    id,
    type: 'thin_ice' as HazardType,
    geometryKind: 'point_radius',
    geometry: { type: 'Point', coordinates: [at.lng, at.lat] },
    radiusMeters,
    firstReportedAt: 1_000,
    season: 2026,
    moderationStatus: 'visible',
    ...rest,
  };
}

/** The refusal reason, or `'merged'` when it went through — reads better in a table of cases. */
function verdict(a: MergeCandidate, b: MergeCandidate): string {
  const result = shouldAutoMerge(a, b);
  return result.merge ? 'merged' : result.reason;
}

describe('shouldAutoMerge', () => {
  it('merges two pins of the same thing drawn nearly on top of each other', () => {
    expect(verdict(pin('a'), pin('b', { metersEast: 5 }))).toBe('merged');
  });

  it('refuses a near miss — 25 m apart is "probably", overlapping is "yes"', () => {
    // Inside the *clustering* tolerance (so they pool and draw as one outline) but nowhere near the
    // automatic-merge bar, which is a claim strong enough to collapse a row without asking anyone.
    expect(verdict(pin('a'), pin('b', { metersEast: 95 }))).toBe('no_overlap');
  });

  it('refuses a big polygon that merely contains a small distinct pin', () => {
    // A 300 m thaw-rotten zone contains a 5 m drilled hole completely, and "contains" is not "is the
    // same as". This is what the IoU bar exists for; overlap alone would swallow it.
    expect(verdict(pin('big', { radiusMeters: 300 }), pin('small', { radiusMeters: 5 }))).toBe(
      'insufficient_overlap',
    );
  });

  it('never merges across families', () => {
    expect(verdict(pin('a'), pin('b', { type: 'spring_current' }))).toBe('different_family');
  });

  it('never merges passage markers', () => {
    expect(
      verdict(pin('a', { type: 'ridge_crossing' }), pin('b', { type: 'ridge_crossing' })),
    ).toBe(
      'different_family', // a crossing has no family at all — it never clusters, so it never merges
    );
  });

  it('never merges across a season boundary — that is recurrence’s question', () => {
    expect(verdict(pin('a'), pin('b', { season: 2025 }))).toBe('different_season');
  });

  it('has no time-window condition inside a season', () => {
    // December and February, overlapping: the same ridge, and the February reporter is exactly the
    // corroboration the pin had been missing.
    const december = pin('dec', { firstReportedAt: 1_000 });
    const february = pin('feb', { metersEast: 5, firstReportedAt: 5_000_000_000 });
    expect(verdict(december, february)).toBe('merged');
  });

  it('never re-decides something a human decided', () => {
    expect(verdict(pin('a'), pin('b', { metersEast: 5, promotedToFeatureId: 'f1' }))).toBe(
      'promoted',
    );
    expect(verdict(pin('a'), pin('b', { metersEast: 5, moderationStatus: 'hidden' }))).toBe(
      'moderator_hidden',
    );
    expect(verdict(pin('a'), pin('b', { metersEast: 5, mergedIntoHazardId: 'x' }))).toBe(
      'already_merged',
    );
  });

  it('honours a moderator who separated the pair', () => {
    // Otherwise Unmerge is a button that undoes nothing: the next create on the same spot re-merges
    // them by the same rule that merged them the first time.
    expect(verdict(pin('a', { noMergeWith: ['b'] }), pin('b', { metersEast: 5 }))).toBe(
      'previously_unmerged',
    );
    expect(verdict(pin('a'), pin('b', { metersEast: 5, noMergeWith: ['a'] }))).toBe(
      'previously_unmerged',
    );
  });

  it('honours a skater who was shown the pin and said theirs was different', () => {
    // The nudge promised not to argue. Merging anyway is the same argument, held quietly.
    expect(verdict(pin('a'), pin('b', { metersEast: 5, dismissedDuplicateOf: 'a' }))).toBe(
      'skater_said_different',
    );
  });

  it('refuses a row whose geometry cannot be buffered rather than throwing', () => {
    const broken = pin('broken', {
      geometryKind: 'line',
      geometry: { type: 'LineString', coordinates: [] },
      bufferMeters: 10,
    });
    expect(verdict(pin('a'), broken)).toBe('unusable_geometry');
  });

  it('is symmetric', () => {
    const cases: [MergeCandidate, MergeCandidate][] = [
      [pin('a'), pin('b', { metersEast: 5 })],
      [pin('a'), pin('b', { metersEast: 95 })],
      [pin('a'), pin('b', { type: 'spring_current' })],
      [pin('a'), pin('b', { season: 2025 })],
      [pin('big', { radiusMeters: 300 }), pin('small', { radiusMeters: 5 })],
    ];
    for (const [a, b] of cases) {
      expect(shouldAutoMerge(a, b).merge).toBe(shouldAutoMerge(b, a).merge);
    }
  });

  it('never merges a row with itself', () => {
    expect(verdict(pin('a'), pin('a'))).toBe('same_row');
  });

  it('sits the bar above half the combined area', () => {
    expect(AUTOMERGE_MIN_FOOTPRINT_IOU).toBe(0.5);
  });
});

describe('mergeSurvivorOf', () => {
  it('keeps the earliest sighting', () => {
    // The honest first-seen date, and the one recurrence keys a season off (D63). Keeping the newer
    // row would walk a hazard's first-seen date forward every time somebody re-marked it.
    const early = { id: 'early', firstReportedAt: 100 };
    const late = { id: 'late', firstReportedAt: 900 };
    expect(mergeSurvivorOf(early, late).id).toBe('early');
    expect(mergeSurvivorOf(late, early).id).toBe('early');
  });

  it('breaks a tie deterministically, so two clients agree', () => {
    const a = { id: 'aaa', firstReportedAt: 100 };
    const b = { id: 'bbb', firstReportedAt: 100 };
    expect(mergeSurvivorOf(a, b).id).toBe('aaa');
    expect(mergeSurvivorOf(b, a).id).toBe('aaa');
  });
});
