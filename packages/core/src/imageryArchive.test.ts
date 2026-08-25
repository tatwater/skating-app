import { describe, expect, it } from 'vitest';
import {
  archiveSeasonAt,
  archiveSeasonLabel,
  type IndexedFrame,
  latestSeasonWithFrames,
  type SeasonIndex,
} from './imageryArchive';

const frame = (over: Partial<IndexedFrame> = {}): IndexedFrame => ({
  granuleId: 'S2C_18TXP_20260215_0_L2A',
  capturedAt: '2026-02-15T15:51:05Z',
  cloudCoverPct: 7.6,
  bodies: 9,
  band: 'visual',
  key: 'frames/winter-2025-26/S2C_18TXP_20260215_0_L2A.pmtiles',
  ...over,
});

const season = (name: string, frames: IndexedFrame[]): SeasonIndex => ({
  season: name,
  frames,
  firstCapturedAt: frames[0]?.capturedAt ?? null,
  lastCapturedAt: frames[frames.length - 1]?.capturedAt ?? null,
});

describe('latestSeasonWithFrames — D149 turnover', () => {
  it('picks the newest season that actually has frames', () => {
    expect(
      latestSeasonWithFrames([
        season('winter-2024-25', [frame()]),
        season('winter-2025-26', [frame()]),
      ]),
    ).toBe('winter-2025-26');
  });

  it('⚠ an empty new season does not blank out the one still being served', () => {
    // Ingest starts *looking* in September on the summit trigger (§C3), so an empty winter-2026-27
    // exists for weeks before its first frame lands. Turning over on the directory rather than on the
    // frames would take last winter's working scrubber away and replace it with nothing.
    expect(
      latestSeasonWithFrames([season('winter-2025-26', [frame()]), season('winter-2026-27', [])]),
    ).toBe('winter-2025-26');
  });

  it('flips the moment the new season has its first frame', () => {
    expect(
      latestSeasonWithFrames([
        season('winter-2025-26', [frame()]),
        season('winter-2026-27', [frame({ granuleId: 'first' })]),
      ]),
    ).toBe('winter-2026-27');
  });

  it('returns null when nothing has been cut at all', () => {
    expect(latestSeasonWithFrames([])).toBeNull();
    expect(latestSeasonWithFrames([season('winter-2026-27', [])])).toBeNull();
  });

  it('does not depend on the order the seasons were listed in', () => {
    expect(
      latestSeasonWithFrames([
        season('winter-2026-27', [frame()]),
        season('winter-2024-25', [frame()]),
        season('winter-2025-26', [frame()]),
      ]),
    ).toBe('winter-2026-27');
  });
});

describe('archiveSeasonLabel', () => {
  it('names the season for the July it started in, with a zero-padded following year', () => {
    expect(archiveSeasonLabel(2025)).toBe('winter-2025-26');
    expect(archiveSeasonLabel(2009)).toBe('winter-2009-10');
    // 2099 → 2100, whose last two digits are 00. Without the pad this reads `winter-2099-0`, which
    // sorts before every other season and would quietly become "latest" forever.
    expect(archiveSeasonLabel(2099)).toBe('winter-2099-00');
  });

  it('sorts as a string in season order, which latestSeasonWithFrames depends on', () => {
    const labels = [2027, 2025, 2026].map(archiveSeasonLabel);
    expect([...labels].sort()).toEqual(['winter-2025-26', 'winter-2026-27', 'winter-2027-28']);
  });

  it('⚠ puts a January frame in the winter that began the previous July (D63)', () => {
    expect(archiveSeasonAt(Date.UTC(2026, 0, 15))).toBe('winter-2025-26');
    expect(archiveSeasonAt(Date.UTC(2026, 6, 1))).toBe('winter-2026-27');
    // The boundary itself: 30 June is still last winter, 1 July is the new one.
    expect(archiveSeasonAt(Date.UTC(2026, 5, 30))).toBe('winter-2025-26');
  });
});
