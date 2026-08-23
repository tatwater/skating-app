import { describe, expect, it } from 'vitest';
import { buildSeasonIndex, type FrameManifest, latestSeasonWithFrames } from './frameIndex';

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
});

describe('latestSeasonWithFrames — D149 turnover', () => {
  it('picks the newest season that actually has frames', () => {
    const seasons = [
      buildSeasonIndex('winter-2024-25', [manifest({ season: 'winter-2024-25' })]),
      buildSeasonIndex('winter-2025-26', [manifest({ season: 'winter-2025-26' })]),
    ];
    expect(latestSeasonWithFrames(seasons)).toBe('winter-2025-26');
  });

  it('⚠ an empty new season does not blank out the one still being served', () => {
    // Ingest starts *looking* in September (the summit trigger), so an empty winter-2026-27 exists
    // for weeks before its first frame lands. Turning over on the directory rather than on the frames
    // would take last winter's working scrubber away and replace it with nothing.
    const seasons = [
      buildSeasonIndex('winter-2025-26', [manifest({ season: 'winter-2025-26' })]),
      buildSeasonIndex('winter-2026-27', []),
    ];
    expect(latestSeasonWithFrames(seasons)).toBe('winter-2025-26');
  });

  it('flips the moment the new season has its first frame', () => {
    const seasons = [
      buildSeasonIndex('winter-2025-26', [manifest({ season: 'winter-2025-26' })]),
      buildSeasonIndex('winter-2026-27', [
        manifest({ season: 'winter-2026-27', granuleId: 'first' }),
      ]),
    ];
    expect(latestSeasonWithFrames(seasons)).toBe('winter-2026-27');
  });

  it('returns null when nothing has been cut at all', () => {
    expect(latestSeasonWithFrames([])).toBeNull();
    expect(latestSeasonWithFrames([buildSeasonIndex('winter-2026-27', [])])).toBeNull();
  });

  it('does not depend on the order the seasons were listed in', () => {
    const seasons = [
      buildSeasonIndex('winter-2026-27', [manifest({ season: 'winter-2026-27' })]),
      buildSeasonIndex('winter-2024-25', [manifest({ season: 'winter-2024-25' })]),
      buildSeasonIndex('winter-2025-26', [manifest({ season: 'winter-2025-26' })]),
    ];
    expect(latestSeasonWithFrames(seasons)).toBe('winter-2026-27');
  });
});
