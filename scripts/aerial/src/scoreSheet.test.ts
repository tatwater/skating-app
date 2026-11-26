import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type NaipCandidate, selectNaipPicks } from '@skating/core';
import { afterEach, describe, expect, test } from 'vitest';
import type { ThumbnailScore } from './score';
import { cloudCandidates, readPrescreen, writeContactSheet } from './scoreSheet';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'aerial-sheet-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const f = (key: string, acquired: string, gsd = 0.6): NaipCandidate => ({
  itemId: `ny_m_${key.slice(0, 7)}_${key.slice(7)}_18_060_${acquired.replaceAll('-', '')}`,
  key,
  state: 'NY',
  acquired,
  gsd,
  year: Number(acquired.slice(0, 4)),
  bbox: [0, 0, 0, 0],
});

// Long Island: a glare pick over a clean 2022 fallback; a beach pick with no fallback; a clean
// partial pick over a cloudy fallback; a clean cell.
const glare = f('4007326nw', '2024-07-02');
const clean22 = f('4007326nw', '2022-09-15');
const beach = f('4007438ne', '2024-09-13');
const partialPick = f('4007330nw', '2024-07-02');
const cloudyFallback = f('4007330nw', '2022-07-30');
const plain = f('4007331nw', '2024-07-02');
const picks = selectNaipPicks(
  [glare, clean22, beach, partialPick, cloudyFallback, plain],
  [],
  [],
).picks;
const scores = new Map<string, ThumbnailScore | null>([
  [glare.itemId, { white: 0.39, valid: 1 }],
  [clean22.itemId, { white: 0.01, valid: 1 }],
  [beach.itemId, { white: 0.08, valid: 1 }],
  [partialPick.itemId, { white: 0.0, valid: 0.5 }],
  [cloudyFallback.itemId, { white: 0.2, valid: 1 }],
  [plain.itemId, { white: 0.02, valid: 1 }],
]);

describe('cloudCandidates', () => {
  const c = cloudCandidates(picks, scores);

  test('picks over the threshold, highest first, each beside what would replace it', () => {
    expect(c.picks).toEqual([
      {
        key: '4007326nw',
        pick: { itemId: glare.itemId, acquired: '2024-07-02', gsd: 0.6, state: 'NY', white: 0.39 },
        replacement: {
          itemId: clean22.itemId,
          acquired: '2022-09-15',
          gsd: 0.6,
          state: 'NY',
          white: 0.01,
        },
      },
      expect.objectContaining({ key: '4007438ne', replacement: null }),
    ]);
  });

  test('a fallback over the threshold counts only where it shows', () => {
    expect(c.fallbacks).toEqual([
      {
        key: '4007330nw',
        depth: 0,
        frame: expect.objectContaining({ itemId: cloudyFallback.itemId, white: 0.2 }),
      },
    ]);
    // Under a full pick the same fallback shows nowhere.
    const full = new Map(scores).set(partialPick.itemId, { white: 0, valid: 1 });
    expect(cloudCandidates(picks, full).fallbacks).toEqual([]);
  });

  test('fallbacks sort by score, then by key', () => {
    const p2 = f('4007330ne', '2024-07-02');
    const fb2 = f('4007330ne', '2022-07-30');
    const p3 = f('4007329nw', '2024-07-02');
    const fb3 = f('4007329nw', '2022-07-30');
    const more = selectNaipPicks([partialPick, cloudyFallback, p2, fb2, p3, fb3], [], []).picks;
    const s = new Map(scores)
      .set(p2.itemId, { white: 0, valid: 0.5 })
      .set(fb2.itemId, { white: 0.5, valid: 1 })
      .set(p3.itemId, { white: 0, valid: 0.5 })
      .set(fb3.itemId, { white: 0.2, valid: 1 });
    expect(cloudCandidates(more, s).fallbacks.map((c) => c.key)).toEqual([
      '4007330ne',
      '4007329nw',
      '4007330nw',
    ]);
  });

  test('the threshold is a parameter; equal scores sort by key', () => {
    const tied = new Map(scores).set(beach.itemId, { white: 0.39, valid: 1 });
    expect(cloudCandidates(picks, tied).picks.map((p) => p.key)).toEqual([
      '4007326nw',
      '4007438ne',
    ]);
    expect(cloudCandidates(picks, scores, 0.5).picks).toEqual([]);
    expect(cloudCandidates(picks, new Map()).picks).toEqual([]);
  });
});

describe('writeContactSheet', () => {
  test('groups by the pre-screen, copies the thumbnails it shows, and writes the list as JSON', () => {
    const dir = tmp();
    const thumbs = join(dir, 'thumbs');
    const sheet = join(dir, 'sheet');
    const c = cloudCandidates(picks, scores);
    // Only some thumbnails are kept: the sheet copies what exists.
    mkdirSync(thumbs, { recursive: true });
    writeFileSync(join(thumbs, `${glare.itemId}.jpg`), 'jpg');
    const path = writeContactSheet(sheet, thumbs, c, {
      campaign: 'naip-20261125',
      prescreen: {
        [glare.itemId]: { verdict: 'likely', note: 'Sun glare over Great South Bay <bright>' },
        [beach.itemId]: { verdict: 'falsePositive', note: 'Beach and dunes' },
      },
    });
    const html = readFileSync(path, 'utf8');
    expect(html).toContain('Likely cloud or glare: confirm to strike (1)');
    expect(html).toContain('Set aside as false positives (1)');
    expect(html).not.toContain('Not yet pre-screened');
    expect(html).toContain('Sun glare over Great South Bay &lt;bright&gt;');
    expect(html).toContain('striking the pick leaves the cell without a summer frame');
    expect(html).toContain('white 39.0%');
    expect(html).toContain('Fallbacks that show, over the threshold (1)');
    expect(existsSync(join(sheet, 'thumbs', `${glare.itemId}.jpg`))).toBe(true);
    expect(existsSync(join(sheet, 'thumbs', `${beach.itemId}.jpg`))).toBe(false);
    expect(JSON.parse(readFileSync(join(sheet, 'candidates.json'), 'utf8'))).toEqual(c);
  });

  test('without a pre-screen everything is not yet looked at; an unscored replacement says so', () => {
    const dir = tmp();
    const c = cloudCandidates(picks, new Map(scores).set(clean22.itemId, null));
    const html = readFileSync(
      writeContactSheet(dir, join(dir, 'none'), c, { campaign: 'naip-20261125' }),
      'utf8',
    );
    expect(html).toContain('Not yet pre-screened (2)');
    expect(html).toContain('white unscored');
    expect(html).not.toContain('Likely cloud or glare');
  });
});

describe('readPrescreen', () => {
  test('reads the file beside the sheet, or nothing', () => {
    const dir = tmp();
    expect(readPrescreen(dir)).toEqual({});
    writeFileSync(
      join(dir, 'prescreen.json'),
      JSON.stringify({ a: { verdict: 'likely', note: 'n' } }),
    );
    expect(readPrescreen(dir)).toEqual({ a: { verdict: 'likely', note: 'n' } });
  });
});
