import type { FeedFilters } from '@skating/core'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  activeFilterCount,
  FEED_FILTERS_STORAGE_KEY,
  readStoredFilters,
  reconcileFilters,
  writeStoredFilters,
} from './feedFilters'

/** A minimal in-memory Storage double. */
function fakeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size
    },
  }
}

describe('read/writeStoredFilters', () => {
  let storage: Storage
  beforeEach(() => {
    storage = fakeStorage()
  })

  it('round-trips a sanitized filter set', () => {
    const filters: FeedFilters = { radiusMinutes: 60, qualityFloor: 'good' }
    writeStoredFilters(storage, filters)
    expect(readStoredFilters(storage)).toEqual(filters)
  })

  it('returns {} for absent or corrupt storage', () => {
    expect(readStoredFilters(storage)).toEqual({})
    storage.setItem(FEED_FILTERS_STORAGE_KEY, 'not json')
    expect(readStoredFilters(storage)).toEqual({})
  })

  it('drops out-of-domain fields on read (sanitize)', () => {
    storage.setItem(FEED_FILTERS_STORAGE_KEY, JSON.stringify({ radiusMinutes: 45, bogus: 1 }))
    expect(readStoredFilters(storage)).toEqual({})
  })
})

describe('reconcileFilters (LWW)', () => {
  it('prefers a non-empty local copy', () => {
    expect(reconcileFilters({ radiusMinutes: 30 }, { radiusMinutes: 90 })).toEqual({
      radiusMinutes: 30,
    })
  })

  it('adopts the sanitized server copy when local is empty', () => {
    expect(reconcileFilters({}, { qualityFloor: 'great', junk: true })).toEqual({
      qualityFloor: 'great',
    })
  })

  it('is empty when both are empty', () => {
    expect(reconcileFilters({}, undefined)).toEqual({})
  })
})

describe('activeFilterCount', () => {
  it('counts each active gate once', () => {
    expect(activeFilterCount({})).toBe(0)
    expect(
      activeFilterCount({
        radiusMinutes: 60,
        qualityFloor: 'good',
        thicknessFloorCm: 10,
        noSnow: true,
        iceTypes: ['black_ice'],
        surfaceTags: ['glass'],
        recencyHours: 48,
      }),
    ).toBe(7)
  })

  it('ignores empty arrays and a false noSnow', () => {
    expect(activeFilterCount({ iceTypes: [], surfaceTags: [], noSnow: false })).toBe(0)
  })
})
