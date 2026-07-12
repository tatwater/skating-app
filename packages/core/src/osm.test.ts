import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { isWaterBodyType, type OsmTags, waterBodyTypeFromOsmTags } from './osm'
import { WATER_BODY_TYPES } from './types'

describe('waterBodyTypeFromOsmTags', () => {
  it('maps the recognized still-water types', () => {
    expect(waterBodyTypeFromOsmTags({ natural: 'water', water: 'lake' })).toBe('lake')
    expect(waterBodyTypeFromOsmTags({ natural: 'water', water: 'pond' })).toBe('pond')
    expect(waterBodyTypeFromOsmTags({ natural: 'water', water: 'reservoir' })).toBe('reservoir')
    // A bare `water=*` subtag (no `natural=water`) is still a water area.
    expect(waterBodyTypeFromOsmTags({ water: 'pond' })).toBe('pond')
  })

  it('maps reservoirs and bays tagged without a `water` subtag', () => {
    expect(waterBodyTypeFromOsmTags({ landuse: 'reservoir' })).toBe('reservoir')
    expect(waterBodyTypeFromOsmTags({ natural: 'bay' })).toBe('bay')
  })

  it('maps a marsh but skips other wetlands', () => {
    expect(waterBodyTypeFromOsmTags({ natural: 'wetland', wetland: 'marsh' })).toBe('marsh')
    expect(waterBodyTypeFromOsmTags({ wetland: 'marsh' })).toBe('marsh')
    expect(waterBodyTypeFromOsmTags({ natural: 'wetland', wetland: 'swamp' })).toBeNull()
    expect(waterBodyTypeFromOsmTags({ natural: 'wetland', wetland: 'bog' })).toBeNull()
    expect(waterBodyTypeFromOsmTags({ natural: 'wetland' })).toBeNull()
  })

  it('falls back to `other` for a water area of unrecognized/unspecified kind', () => {
    expect(waterBodyTypeFromOsmTags({ natural: 'water' })).toBe('other')
    expect(waterBodyTypeFromOsmTags({ natural: 'water', water: 'lagoon' })).toBe('other')
    expect(waterBodyTypeFromOsmTags({ natural: 'water', water: 'oxbow' })).toBe('other')
    expect(waterBodyTypeFromOsmTags({ natural: 'water', water: 'basin' })).toBe('other')
  })

  it('defers rivers and skips flowing/linear water (Phase 1 imports still water only)', () => {
    expect(waterBodyTypeFromOsmTags({ natural: 'water', water: 'river' })).toBeNull()
    expect(waterBodyTypeFromOsmTags({ natural: 'water', water: 'stream' })).toBeNull()
    expect(waterBodyTypeFromOsmTags({ natural: 'water', water: 'canal' })).toBeNull()
    expect(waterBodyTypeFromOsmTags({ waterway: 'river' })).toBeNull()
    expect(waterBodyTypeFromOsmTags({ waterway: 'stream' })).toBeNull()
    expect(waterBodyTypeFromOsmTags({ waterway: 'riverbank' })).toBeNull()
    // A `waterway` tag wins even alongside `natural=water` — it's flowing water, deferred.
    expect(waterBodyTypeFromOsmTags({ natural: 'water', waterway: 'canal' })).toBeNull()
  })

  it('returns null for non-water features and empty tags', () => {
    expect(waterBodyTypeFromOsmTags({ natural: 'wood' })).toBeNull()
    expect(waterBodyTypeFromOsmTags({ building: 'yes' })).toBeNull()
    expect(waterBodyTypeFromOsmTags({ landuse: 'residential' })).toBeNull()
    expect(waterBodyTypeFromOsmTags({})).toBeNull()
  })

  it('always returns a valid type or null, and never lets flowing water through (property)', () => {
    const arbTags: fc.Arbitrary<OsmTags> = fc.record(
      {
        natural: fc.constantFrom('water', 'bay', 'wetland', 'wood', 'scrub'),
        water: fc.constantFrom('lake', 'pond', 'reservoir', 'river', 'stream', 'canal', 'lagoon'),
        waterway: fc.constantFrom('river', 'stream', 'canal', 'riverbank'),
        landuse: fc.constantFrom('reservoir', 'residential', 'basin'),
        wetland: fc.constantFrom('marsh', 'swamp', 'bog'),
      },
      { requiredKeys: [] },
    )
    fc.assert(
      fc.property(arbTags, (tags) => {
        const result = waterBodyTypeFromOsmTags(tags)
        // Result is always null or a member of our enum.
        expect(result === null || isWaterBodyType(result)).toBe(true)
        // Flowing/linear water never leaks through as an importable body.
        if (tags.waterway !== undefined) expect(result).toBeNull()
        // We never emit a deferred river/stream from a `water=river|stream|canal` subtag.
        if (
          tags.waterway === undefined &&
          ['river', 'stream', 'canal'].includes(tags.water ?? '')
        ) {
          expect(result).toBeNull()
        }
      }),
    )
  })
})

describe('isWaterBodyType', () => {
  it('accepts every enum member and rejects non-members', () => {
    for (const t of WATER_BODY_TYPES) expect(isWaterBodyType(t)).toBe(true)
    expect(isWaterBodyType('river')).toBe(true)
    expect(isWaterBodyType('ocean')).toBe(false)
    expect(isWaterBodyType('')).toBe(false)
  })
})
