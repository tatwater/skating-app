import type { FeedFilters } from '@skating/core';
import { describe, expect, it } from 'vitest';
import { activeFilterCount, parseFilters, reconcileFilters } from './feedFilters';

describe('parseFilters', () => {
  it('sanitizes a stored blob', () => {
    expect(parseFilters(JSON.stringify({ radiusMinutes: 60, bogus: 1 }))).toEqual({
      radiusMinutes: 60,
    });
  });

  it('returns {} for nullish or corrupt input', () => {
    expect(parseFilters(null)).toEqual({});
    expect(parseFilters(undefined)).toEqual({});
    expect(parseFilters('not json')).toEqual({});
  });
});

describe('reconcileFilters (LWW)', () => {
  it('prefers a non-empty local copy', () => {
    expect(reconcileFilters({ radiusMinutes: 30 }, { radiusMinutes: 90 })).toEqual({
      radiusMinutes: 30,
    });
  });

  it('adopts the sanitized server copy when local is empty', () => {
    expect(reconcileFilters({}, { qualityFloor: 'great', junk: true })).toEqual({
      qualityFloor: 'great',
    });
  });
});

describe('activeFilterCount', () => {
  it('counts each active gate once', () => {
    const filters: FeedFilters = {
      radiusMinutes: 60,
      qualityFloor: 'good',
      thicknessFloorCm: 10,
      noSnow: true,
      iceTypes: ['black_ice'],
      surfaceTags: ['glass'],
      recencyHours: 48,
    };
    expect(activeFilterCount(filters)).toBe(7);
    expect(activeFilterCount({})).toBe(0);
  });

  it('ignores empty arrays and a false noSnow', () => {
    expect(activeFilterCount({ iceTypes: [], noSnow: false })).toBe(0);
  });
});
