import { describe, expect, it } from 'vitest';
import { buildSeasonIndex, type FrameManifest } from './frameIndex';

const manifest = (over: Partial<FrameManifest> = {}): FrameManifest => ({
  granuleId: 'S2C_18TXP_20260215_0_L2A',
  capturedAt: '2026-02-15T15:51:05Z',
  cloudCoverPct: 7.6,
  season: 'winter-2025-26',
  bodies: 9,
  band: 'visual',
  ...over,
});

describe('buildSeasonIndex', () => {
  it('indexes a frame with the key a client composes its URL from', () => {
    const index = buildSeasonIndex('winter-2025-26', [manifest()]);
    expect(index.frames).toHaveLength(1);
    expect(index.frames[0]?.key).toBe('frames/winter-2025-26/S2C_18TXP_20260215_0_L2A.pmtiles');
  });

  it('sorts by capture time, the axis the scrubber moves along', () => {
    const index = buildSeasonIndex('winter-2025-26', [
      manifest({ granuleId: 'c', capturedAt: '2026-03-10T15:00:00Z' }),
      manifest({ granuleId: 'a', capturedAt: '2026-01-11T15:00:00Z' }),
      manifest({ granuleId: 'b', capturedAt: '2026-02-15T15:00:00Z' }),
    ]);
    expect(index.frames.map((f) => f.granuleId)).toEqual(['a', 'b', 'c']);
    expect(index.firstCapturedAt).toBe('2026-01-11T15:00:00Z');
    expect(index.lastCapturedAt).toBe('2026-03-10T15:00:00Z');
  });

  it('drops a granule that had nothing under it', () => {
    // The cutter exits 0 on "nothing to cut" — plenty of granules over five states are all land or
    // ocean. A frame with no bodies is an empty picture, and a date in the scrubber that shows a
    // skater nothing, with no explanation, is worse than a gap.
    const index = buildSeasonIndex('winter-2025-26', [
      manifest({ granuleId: 'empty', bodies: 0 }),
      manifest({ granuleId: 'real', bodies: 4 }),
    ]);
    expect(index.frames.map((f) => f.granuleId)).toEqual(['real']);
  });

  it('ignores manifests belonging to another season', () => {
    const index = buildSeasonIndex('winter-2025-26', [
      manifest({ granuleId: 'mine' }),
      manifest({ granuleId: 'theirs', season: 'winter-2024-25' }),
    ]);
    expect(index.frames.map((f) => f.granuleId)).toEqual(['mine']);
  });

  it('keeps one entry per granule id', () => {
    // Two identical dates in a scrubber is the same correctness problem the superseded-reprocessing
    // rule exists to prevent: C4 makes the date the content.
    const index = buildSeasonIndex('winter-2025-26', [manifest(), manifest()]);
    expect(index.frames).toHaveLength(1);
  });

  it('carries a missing cloud figure through as null rather than inventing one', () => {
    const index = buildSeasonIndex('winter-2025-26', [manifest({ cloudCoverPct: undefined })]);
    expect(index.frames[0]?.cloudCoverPct).toBeNull();
  });

  it('an empty season is an index with no frames, not a failure', () => {
    const index = buildSeasonIndex('winter-2026-27', []);
    expect(index).toEqual({
      season: 'winter-2026-27',
      frames: [],
      firstCapturedAt: null,
      lastCapturedAt: null,
    });
  });

  it('carries the granule footprint through to the index', () => {
    const footprint = {
      type: 'Polygon' as const,
      coordinates: [
        [
          [-73.7, 43.2],
          [-72.4, 43.2],
          [-72.4, 44.2],
          [-73.7, 44.2],
          [-73.7, 43.2],
        ],
      ],
    };
    const index = buildSeasonIndex('winter-2025-26', [manifest({ footprint })]);
    expect(index.frames[0]?.footprint).toEqual(footprint);
  });

  it('⚠ omits footprint entirely when absent, so "unknown" cannot read as "covers nothing"', () => {
    // A scrubber uses this to say "that lake was not photographed that day". A frame with no footprint
    // is one we cannot make that claim about — frames cut before 2026-08-24 predate the field — and a
    // reader must treat it as unknown. Writing `null` would invite a truthy check that silently
    // classifies every old frame as covering nowhere.
    const index = buildSeasonIndex('winter-2025-26', [manifest()]);
    expect('footprint' in (index.frames[0] as object)).toBe(false);
  });
});
