import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_POINTER_KEY,
  archiveSeasonAt,
  archiveSeasonLabel,
  archiveUrl,
  bandsIn,
  bodyStatsIn,
  copernicusCredit,
  type FrameBodyStats,
  type IndexedFrame,
  latestSeasonWithFrames,
  manifestKeyFor,
  type SeasonIndex,
  seasonIndexKeyFor,
  snowIceFractionOf,
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

describe('manifestKeyFor', () => {
  it('keys on the granule, so every band of a pass shares one manifest', () => {
    expect(manifestKeyFor('winter-2025-26', 'S2C_18TXP_20260215_0_L2A')).toBe(
      'frames/winter-2025-26/S2C_18TXP_20260215_0_L2A.json',
    );
  });

  it('⚠ is not derivable by rewriting a frame key, which is why it exists', () => {
    // A granule now publishes several frames — `-visual.pmtiles`, `-scl.pmtiles` — that all share a
    // single `<granuleId>.json`. String-replacing the extension on a frame's own key yields
    // `…-visual.json`, which is a 404 that reads like a missing manifest rather than a bad path.
    const frameKey = 'frames/winter-2025-26/S2C_18TXP_20260215_0_L2A-visual.pmtiles';
    const naive = frameKey.replace('.pmtiles', '.json');
    expect(naive).not.toBe(manifestKeyFor('winter-2025-26', 'S2C_18TXP_20260215_0_L2A'));
  });
});

describe('snowIceFractionOf — the rename that spans the archive', () => {
  const stats = (over: Partial<FrameBodyStats>): FrameBodyStats => ({
    waterBodyId: 'body',
    coveragePct: 1,
    pixels: 4107,
    ...over,
  });

  it('prefers the current key', () => {
    expect(snowIceFractionOf(stats({ snowIcePct: 0.45, icePct: 0.11 }))).toBe(0.45);
  });

  it('⚠ falls back to the deprecated key, which 4,381 published frames still carry', () => {
    // Forgetting this reads `undefined` across an entire winter and reports no snow anywhere — a
    // silent wrong answer rather than a crash, which is why the fallback is a function and not a
    // convention.
    expect(snowIceFractionOf(stats({ icePct: 0.45 }))).toBe(0.45);
  });

  it('distinguishes "unmeasured" from zero', () => {
    expect(snowIceFractionOf(stats({}))).toBeNull();
    expect(snowIceFractionOf(stats({ snowIcePct: null }))).toBeNull();
    // Zero is a real reading — a clear look at a lake with no snow on it.
    expect(snowIceFractionOf(stats({ snowIcePct: 0 }))).toBe(0);
  });

  it('does not treat a radar row as snow-free', () => {
    // Radar carries no scene classification at all, so both keys are absent and the honest answer is
    // "not measured" rather than 0.
    expect(snowIceFractionOf(stats({ vhDb: -21.4, vvDb: -14.8 }))).toBeNull();
  });
});

describe('bodyStatsIn', () => {
  const frame = {
    bodies: [
      { waterBodyId: 'champlain', coveragePct: 0.4, pixels: 900, clearPct: 0.9 },
      { waterBodyId: 'morey', coveragePct: 1, pixels: 120, clearPct: 0.85 },
    ],
  };

  it('finds a lake this pass reached', () => {
    expect(bodyStatsIn(frame, 'morey')?.coveragePct).toBe(1);
  });

  it('returns undefined for a lake the pass never covered', () => {
    expect(bodyStatsIn(frame, 'mascoma')).toBeUndefined();
  });

  it('⚠ tolerates a frame with no statistics at all', () => {
    // Frames cut before the per-body pass predate `bodies` entirely, and a reader must not crash on
    // the archive's own history.
    expect(bodyStatsIn({}, 'morey')).toBeUndefined();
  });
});

describe('archiveUrl — composing an address from a key', () => {
  it('joins a base and a key', () => {
    expect(archiveUrl('https://cdn.example/imagery', ARCHIVE_POINTER_KEY)).toBe(
      'https://cdn.example/imagery/index/latest.json',
    );
  });

  it('⚠ tolerates a trailing slash, because a doubled one is a 404 on most object stores', () => {
    // Half the ways of setting an environment variable add one, and the failure is remote and silent.
    expect(archiveUrl('https://cdn.example/imagery/', 'index/latest.json')).toBe(
      'https://cdn.example/imagery/index/latest.json',
    );
    expect(archiveUrl('https://cdn.example/imagery///', '/index/latest.json')).toBe(
      'https://cdn.example/imagery/index/latest.json',
    );
  });

  it('names a season index the way build-index writes it', () => {
    expect(seasonIndexKeyFor('winter-2025-26')).toBe('index/winter-2025-26.json');
  });
});

describe('bandsIn — what a band selector should be built from', () => {
  it('lists each band once, with true color first', () => {
    expect(
      bandsIn(
        season('winter-2025-26', [
          frame({ band: 'vh' }),
          frame({ band: 'visual' }),
          frame({ band: 'scl' }),
          frame({ band: 'visual' }),
        ]),
      ),
    ).toEqual(['visual', 'scl', 'vh']);
  });

  it('⚠ reports only what this season actually published', () => {
    // The archive's bands have changed twice: `scl` was statistics-only until 2026-08-25 and `vh` did
    // not exist until Sentinel-1 was wired. A hardcoded list would offer a tab leading to an empty
    // scrubber for every season cut under an older policy.
    expect(bandsIn(season('winter-2025-26', [frame({ band: 'visual' })]))).toEqual(['visual']);
  });

  it('does not invent true color for a season that has none', () => {
    expect(bandsIn(season('winter-2025-26', [frame({ band: 'vh' })]))).toEqual(['vh']);
  });

  it('is empty for an empty season', () => {
    expect(bandsIn(season('winter-2026-27', []))).toEqual([]);
  });
});

describe('copernicusCredit — a winter spans two calendar years', () => {
  it('names both, because the frames come from both', () => {
    expect(copernicusCredit('winter-2025-26')).toBe('Copernicus Sentinel data 2025–2026');
    expect(copernicusCredit('winter-2099-00')).toBe('Copernicus Sentinel data 2099–2100');
  });

  it('⚠ degrades to the bare required form rather than inventing a year', () => {
    // A wrong year is worse than none, and an unparseable season is not a reason to omit a credit a
    // licence compels — unlike NAIP's, which is courtesy only.
    expect(copernicusCredit('not-a-season')).toBe('Copernicus Sentinel data');
  });
});
