import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  LENGTH_BANDS,
  lengthBand,
  sumTallies,
  TEXT_LENGTH_CAPS,
  TEXT_LENGTH_KINDS,
  tallyLengths,
  tallyRecorded,
} from './textLengths';

describe('lengthBand — where a length sits against its cap', () => {
  it('reads the bands at their edges', () => {
    const cap = 1_000;
    expect(lengthBand(0, cap)).toBe('empty');
    expect(lengthBand(1, cap)).toBe('to25');
    expect(lengthBand(250, cap)).toBe('to25');
    expect(lengthBand(251, cap)).toBe('to50');
    expect(lengthBand(500, cap)).toBe('to50');
    expect(lengthBand(750, cap)).toBe('to75');
    expect(lengthBand(900, cap)).toBe('to90');
    expect(lengthBand(901, cap)).toBe('to99');
    expect(lengthBand(999, cap)).toBe('to99');
    expect(lengthBand(1_000, cap)).toBe('atCap');
    // A cap since lowered: an old length past it reads as at the cap.
    expect(lengthBand(1_200, cap)).toBe('atCap');
  });

  it('never goes down as the length goes up', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 0, max: 12_000 }),
        fc.integer({ min: 0, max: 12_000 }),
        (cap, a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          expect(LENGTH_BANDS.indexOf(lengthBand(lo, cap))).toBeLessThanOrEqual(
            LENGTH_BANDS.indexOf(lengthBand(hi, cap)),
          );
        },
      ),
    );
  });

  it('uses the caps the writers enforce', () => {
    expect(TEXT_LENGTH_KINDS.map((k) => TEXT_LENGTH_CAPS[k])).toEqual([5_000, 500, 1_000]);
  });
});

describe('tallyLengths and sumTallies', () => {
  it('counts each band, the longest and the writes', () => {
    const tally = tallyLengths([0, 10, 990, 1_000], 1_000);
    expect(tally).toEqual({
      bands: { empty: 1, to25: 1, to50: 0, to75: 0, to90: 0, to99: 1, atCap: 1 },
      longest: 1_000,
      writes: 4,
    });
  });

  it('adds recorded days and skips the unrecorded; nothing recorded is null, never zero', () => {
    const a = tallyLengths([100], 1_000);
    const b = tallyLengths([950, 0], 1_000);
    expect(sumTallies([a, null, b])).toEqual({
      bands: { empty: 1, to25: 1, to50: 0, to75: 0, to90: 0, to99: 1, atCap: 0 },
      longest: 950,
      writes: 3,
    });
    expect(sumTallies([null, null])).toBeNull();
    expect(sumTallies([])).toBeNull();
    // Adding never changes the days it read.
    expect(a.writes).toBe(1);
  });

  it('counts a recorded write in the band its own cap gave it', () => {
    // 600 was at the cap when the cap was 600; today's cap of 1,000 would call it 50–75%.
    expect(tallyRecorded([{ length: 600, band: 'atCap' }]).bands.atCap).toBe(1);
  });
});
