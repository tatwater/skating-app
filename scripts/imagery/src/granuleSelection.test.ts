import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_CLOUD_PCT,
  type GranuleCandidate,
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

  it('refuses a fully clouded frame, and says why rather than dropping it silently', () => {
    const result = selectGranules([at('S2B_18TXP_20260223_0_L2A', 100)]);
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

  it('is generous by default — 40% cloud is a keeper, not a reject', () => {
    expect(DEFAULT_MAX_CLOUD_PCT).toBe(60);
    // Clouds over the next county should not cost us this lake.
    expect(selectGranules([at('S2C_18TXP_20260215_0_L2A', 40)]).selected).toHaveLength(1);
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
    const result = selectGranules([
      at('S2C_18TXP_20260215_0_L2A', 7),
      at('S2B_18TXP_20260223_0_L2A', 100),
      at('S2B_18TXP_20260220_0_L2A', 5),
      at('S2B_18TXP_20260220_1_L2A', 5),
      at('garbage', 0),
    ]);
    const { considered, selected, cloud, superseded, unparseable } = result.counts;
    expect(considered).toBe(5);
    expect(selected + cloud + superseded + unparseable).toBe(considered);
  });
});
