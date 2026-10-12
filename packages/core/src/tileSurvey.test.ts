import { describe, expect, it } from 'vitest';
import {
  emptyTilesFromCollection,
  TILE_SURVEY_VERSION,
  type TileSurveyEntry,
  tileSurveyKey,
  toTileSurveyCollection,
} from './tileSurvey';

const entry = (over: Partial<TileSurveyEntry> = {}): TileSurveyEntry => ({
  tile: '18TXP',
  bodies: 899,
  kept: true,
  bbox: [-73.77, 43.24, -72.42, 44.25],
  ...over,
});

describe('tileSurveyKey', () => {
  it('changes when the corpus changes, which is what invalidates the cache', () => {
    // A lake added, merged or taken down moves the body count — so a stale survey cannot outlive the
    // corpus it described. That is the reason the mask sidecar carries a body count at all.
    expect(tileSurveyKey('winter-2026-27', 24831)).not.toBe(tileSurveyKey('winter-2026-27', 24839));
  });

  it('changes when the season changes', () => {
    expect(tileSurveyKey('winter-2026-27', 24831)).not.toBe(tileSurveyKey('winter-2025-26', 24831));
  });

  it('carries the version, so bumping it forces a resurvey with nothing else changed', () => {
    expect(tileSurveyKey('winter-2026-27', 24831)).toContain(`v${TILE_SURVEY_VERSION}`);
  });
});

describe('toTileSurveyCollection', () => {
  it('renders each tile as a closed rectangle a map can draw', () => {
    const collection = toTileSurveyCollection([entry()], 'k');
    const ring = collection.features[0]?.geometry.coordinates[0];
    expect(ring).toHaveLength(5);
    expect(ring?.[0]).toEqual(ring?.[4]);
  });

  it('marks kept and skipped tiles, which is the whole point of looking at it', () => {
    const collection = toTileSurveyCollection(
      [entry(), entry({ tile: '19TDF', bodies: 0, kept: false })],
      'k',
    );
    expect(collection.features.map((f) => f.properties?.kept)).toEqual([true, false]);
  });

  it('sorts by tile, so two surveys of the same corpus diff cleanly', () => {
    const collection = toTileSurveyCollection(
      [entry({ tile: '19TDF' }), entry({ tile: '17TNG' }), entry({ tile: '18TXP' })],
      'k',
    );
    expect(collection.features.map((f) => f.properties?.tile)).toEqual(['17TNG', '18TXP', '19TDF']);
  });

  it('is a valid FeatureCollection, so geojson.io and QGIS open it directly', () => {
    const collection = toTileSurveyCollection([entry()], 'k');
    expect(collection.type).toBe('FeatureCollection');
    expect(collection.features[0]?.type).toBe('Feature');
    // The cache key rides as a GeoJSON foreign member — readers that do not know it ignore it.
    expect(collection.surveyKey).toBe('k');
  });
});

describe('emptyTilesFromCollection', () => {
  it('returns the skipped tiles when the key matches', () => {
    const collection = toTileSurveyCollection(
      [entry(), entry({ tile: '19TDF', bodies: 0, kept: false })],
      'k',
    );
    expect(emptyTilesFromCollection(collection, 'k')).toEqual(new Set(['19TDF']));
  });

  it('⚠ refuses a survey taken against a different corpus', () => {
    // Returning the stale set would skip tiles that have since gained a lake — a body that silently
    // never receives a photograph, which is the failure nobody notices. `null` means "resurvey".
    const collection = toTileSurveyCollection([entry({ kept: false })], 'old-key');
    expect(emptyTilesFromCollection(collection, 'new-key')).toBeNull();
  });

  it('returns null when there is no cache at all', () => {
    expect(emptyTilesFromCollection(null, 'k')).toBeNull();
  });

  it('distinguishes "no tiles are empty" from "no cache"', () => {
    // An empty Set means every tile is kept and was checked; null means we do not know. Conflating
    // them would either skip the survey or discard a valid one.
    const collection = toTileSurveyCollection([entry()], 'k');
    expect(emptyTilesFromCollection(collection, 'k')).toEqual(new Set());
  });
});
