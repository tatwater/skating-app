import { describe, expect, it } from 'vitest';
import { type IndexedFrame, latestSeasonWithFrames, type SeasonIndex } from './imageryArchive';

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
