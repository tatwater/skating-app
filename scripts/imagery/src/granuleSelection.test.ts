import { describe, expect, it } from 'vitest';
import {
  assertTileSurveyUsable,
  type GranuleCandidate,
  MAX_UNREADABLE_TILE_FRACTION,
  parseGranuleId,
  selectGranules,
} from './granuleSelection';

const at = (id: string, cloud?: number): GranuleCandidate => ({
  id,
  datetime: '2026-02-15T15:51:05Z',
  ...(cloud === undefined ? {} : { cloudCoverPct: cloud }),
});

describe('parseGranuleId', () => {
  it('decomposes a real Sentinel-2 id', () => {
    expect(parseGranuleId('S2C_18TXP_20260215_0_L2A')).toEqual({
      platform: 'S2C',
      tile: '18TXP',
      date: '20260215',
      version: 0,
    });
  });

  it('accepts every platform letter, since ESA keeps launching them', () => {
    for (const p of ['S2A', 'S2B', 'S2C', 'S2D']) {
      expect(parseGranuleId(`${p}_18TXP_20260215_0_L2A`)?.platform).toBe(p);
    }
  });

  it('returns null for something that is not a granule id', () => {
    expect(parseGranuleId('LC08_L2SP_013030_20260215')).toBeNull();
    expect(parseGranuleId('')).toBeNull();
  });
});

describe('selectGranules', () => {
  it('keeps a clear frame', () => {
    const result = selectGranules([at('S2C_18TXP_20260215_0_L2A', 7.6)]);
    expect(result.selected).toEqual(['S2C_18TXP_20260215_0_L2A']);
    expect(result.counts.selected).toBe(1);
  });

  it('⚠ keeps a fully clouded frame by default — we cut and store everything', () => {
    // Founder override, 2026-08-24: hit Copernicus once and own the pixels, so every later
    // re-derivation is free. A 100%-cloud frame is still a frame we chose to have.
    const result = selectGranules([at('S2B_18TXP_20260223_0_L2A', 100)]);
    expect(result.selected).toEqual(['S2B_18TXP_20260223_0_L2A']);
    expect(result.counts.cloud).toBe(0);
  });

  it('still gates when a threshold is passed, and says why rather than dropping silently', () => {
    const result = selectGranules([at('S2B_18TXP_20260223_0_L2A', 100)], { maxCloudPct: 60 });
    expect(result.selected).toEqual([]);
    expect(result.rejected[0]).toMatchObject({ reason: 'cloud' });
    // The count is the point — a gate that cannot report what it refused reads as "nothing was there".
    expect(result.counts.cloud).toBe(1);
    expect(result.rejected[0]?.detail).toContain('100.0%');
  });

  it('keeps a frame with no cloud figure at all', () => {
    // Absent metadata is not a cloudy scene. The expensive failure is a missed freeze-up (§C3), so
    // the unknown case resolves generously and the manifest records whatever was actually found.
    const result = selectGranules([at('S2C_18TXP_20260310_0_L2A')]);
    expect(result.selected).toHaveLength(1);
  });

  it('skips a granule whose tile holds no corpus body', () => {
    // The lever that replaced the cloud gate, and a strictly better one: this frame contains nothing,
    // so skipping it discards no data. Measured at 44.3% of a season.
    const result = selectGranules([at('S2C_19TDF_20251101_0_L2A', 5)], {
      emptyTiles: new Set(['19TDF']),
    });
    expect(result.selected).toEqual([]);
    expect(result.counts.emptyTile).toBe(1);
    expect(result.rejected[0]).toMatchObject({ reason: 'empty-tile', detail: '19TDF' });
  });

  it('keeps a granule whose tile does hold bodies', () => {
    const result = selectGranules([at('S2C_18TXP_20260215_0_L2A', 5)], {
      emptyTiles: new Set(['19TDF']),
    });
    expect(result.selected).toHaveLength(1);
  });

  it('honours an explicit threshold', () => {
    const strict = selectGranules([at('S2C_18TXP_20260215_0_L2A', 40)], { maxCloudPct: 15 });
    expect(strict.selected).toEqual([]);
    expect(strict.counts.cloud).toBe(1);
  });

  it('keeps only the newest reprocessing of a tile-day', () => {
    // ESA reprocesses; the higher version is the newer baseline. Cutting both would put two different
    // pictures on the same date in the scrubber, and C4 makes the date the content.
    const result = selectGranules([
      at('S2B_18TXP_20260220_0_L2A', 10),
      at('S2B_18TXP_20260220_1_L2A', 10),
    ]);
    expect(result.selected).toEqual(['S2B_18TXP_20260220_1_L2A']);
    expect(result.counts.superseded).toBe(1);
    expect(result.rejected[0]).toMatchObject({
      id: 'S2B_18TXP_20260220_0_L2A',
      reason: 'superseded',
      detail: 'by S2B_18TXP_20260220_1_L2A',
    });
  });

  it('supersedes regardless of the order they arrive in', () => {
    const result = selectGranules([
      at('S2B_18TXP_20260220_1_L2A', 10),
      at('S2B_18TXP_20260220_0_L2A', 10),
    ]);
    expect(result.selected).toEqual(['S2B_18TXP_20260220_1_L2A']);
  });

  it('does not confuse two tiles on the same day', () => {
    const result = selectGranules([
      at('S2C_18TXP_20260225_0_L2A', 10),
      at('S2C_18TXQ_20260225_0_L2A', 10),
    ]);
    // Adjacent tiles are different ground; both are wanted.
    expect(result.selected).toHaveLength(2);
    expect(result.counts.superseded).toBe(0);
  });

  it('does not confuse the same tile on two days', () => {
    const result = selectGranules([
      at('S2C_18TXP_20260215_0_L2A', 10),
      at('S2C_18TXP_20260310_0_L2A', 10),
    ]);
    expect(result.selected).toHaveLength(2);
  });

  it('orders by date then tile, so a partial backfill is legible', () => {
    const result = selectGranules([
      at('S2C_18TXQ_20260310_0_L2A', 1),
      at('S2C_18TXP_20260215_0_L2A', 1),
      at('S2C_18TXP_20260310_0_L2A', 1),
    ]);
    expect(result.selected).toEqual([
      'S2C_18TXP_20260215_0_L2A',
      'S2C_18TXP_20260310_0_L2A',
      'S2C_18TXQ_20260310_0_L2A',
    ]);
  });

  it('reports an unparseable id rather than passing it to a Machine', () => {
    const result = selectGranules([at('not-a-granule', 1)]);
    expect(result.selected).toEqual([]);
    expect(result.counts.unparseable).toBe(1);
  });

  it('counts everything it considered, so the arithmetic is checkable', () => {
    const result = selectGranules(
      [
        at('S2C_18TXP_20260215_0_L2A', 7),
        at('S2B_18TXP_20260223_0_L2A', 100),
        at('S2B_18TXP_20260220_0_L2A', 5),
        at('S2B_18TXP_20260220_1_L2A', 5),
        at('garbage', 0),
      ],
      { maxCloudPct: 60 },
    );
    const { considered, selected, cloud, superseded, unparseable, emptyTile } = result.counts;
    expect(considered).toBe(5);
    expect(selected + cloud + superseded + unparseable + emptyTile).toBe(considered);
  });
});

describe('assertTileSurveyUsable', () => {
  it('accepts an ordinary survey', () => {
    expect(() => assertTileSurveyUsable({ surveyed: 100, unreadable: 0, empty: 50 })).not.toThrow();
  });

  it('tolerates a few transient read failures', () => {
    // One flaky read should not stop a nine-season backfill; a kept tile costs one Machine that
    // exits 0.
    expect(() => assertTileSurveyUsable({ surveyed: 100, unreadable: 5, empty: 45 })).not.toThrow();
  });

  it('⚠ refuses a survey where everything failed to read', () => {
    // The real bug this exists for: the first implementation called `ogrinfo -clipsrc`, an ogr2ogr
    // flag ogrinfo does not have. All 100 tiles came back unreadable, the season stayed correct, and
    // the only symptom was `empty tile 0` — a report nobody would think to question, on a run that
    // silently cost twice as much.
    expect(() => assertTileSurveyUsable({ surveyed: 100, unreadable: 100, empty: 0 })).toThrow(
      /tile survey is broken/,
    );
  });

  it('refuses just past the threshold, not at it', () => {
    const n = 100;
    const atLimit = Math.round(MAX_UNREADABLE_TILE_FRACTION * n);
    expect(() =>
      assertTileSurveyUsable({ surveyed: n, unreadable: atLimit, empty: 40 }),
    ).not.toThrow();
    expect(() =>
      assertTileSurveyUsable({ surveyed: n, unreadable: atLimit + 1, empty: 40 }),
    ).toThrow(/unreadable/);
  });

  it('⚠ refuses a survey where every tile read as empty', () => {
    // The mirror image: five states do not genuinely contain no water, so this means the mask file is
    // wrong, empty, or for another region.
    expect(() => assertTileSurveyUsable({ surveyed: 100, unreadable: 0, empty: 100 })).toThrow(
      /NO bodies in any/,
    );
  });

  it('says nothing about an empty survey', () => {
    expect(() => assertTileSurveyUsable({ surveyed: 0, unreadable: 0, empty: 0 })).not.toThrow();
  });
});
