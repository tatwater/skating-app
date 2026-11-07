import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { NOTES_EXCERPT_MAX, notesExcerpt, thicknessSummaryOf } from './feed';
import { THICKNESS_METHODS } from './types';

describe('thicknessSummaryOf (B03 §11)', () => {
  it('nothing measured is nothing to summarize', () => {
    expect(thicknessSummaryOf(undefined)).toBeUndefined();
    expect(thicknessSummaryOf({ readings: [] })).toBeUndefined();
  });

  it('spans values, ranges and lower bounds, and marks an open top', () => {
    expect(
      thicknessSummaryOf({
        readings: [
          { valueCm: 12, method: 'measured' },
          { minCm: 8, maxCm: 10, method: 'estimated' },
          { minCm: 15, method: 'estimated' },
        ],
      }),
    ).toEqual({
      readingCount: 3,
      minCm: 8,
      maxCm: 15,
      openEnded: true,
      methods: ['measured', 'estimated'],
    });
  });

  it('a poke-only report has a count and a method, and no figures', () => {
    expect(thicknessSummaryOf({ readings: [{ method: 'poke' }, { method: 'poke' }] })).toEqual({
      readingCount: 2,
      methods: ['poke'],
    });
  });

  it('the thinnest figure anyone gave is never hidden by the span', () => {
    // A range is ordered, as `validateReport` insists (`minCm must be ≤ maxCm`): no stored reading
    // has its top below its bottom.
    const reading = fc
      .record(
        {
          valueCm: fc.integer({ min: 0, max: 100 }),
          minCm: fc.integer({ min: 0, max: 100 }),
          maxCm: fc.integer({ min: 0, max: 100 }),
          method: fc.constantFrom(...THICKNESS_METHODS),
        },
        { requiredKeys: ['method'] },
      )
      .map((r) =>
        r.minCm !== undefined && r.maxCm !== undefined && r.minCm > r.maxCm
          ? { ...r, minCm: r.maxCm, maxCm: r.minCm }
          : r,
      );
    fc.assert(
      fc.property(fc.array(reading, { minLength: 1, maxLength: 8 }), (readings) => {
        const summary = thicknessSummaryOf({ readings });
        expect(summary?.readingCount).toBe(readings.length);
        const lows = readings
          .map((r) => r.valueCm ?? r.minCm)
          .filter((n): n is number => n !== undefined);
        if (lows.length === 0) {
          expect(summary?.minCm).toBeUndefined();
          return;
        }
        expect(summary?.minCm).toBe(Math.min(...lows));
        expect(summary?.maxCm).toBeGreaterThanOrEqual(summary?.minCm ?? 0);
      }),
    );
  });
});

describe('notesExcerpt (B03 §11)', () => {
  it('absent or blank notes draw nothing', () => {
    expect(notesExcerpt(undefined)).toBeUndefined();
    expect(notesExcerpt('  \n\t ')).toBeUndefined();
  });

  it('short notes come back whole, with whitespace collapsed', () => {
    expect(notesExcerpt('  Glass  from the\nramp out. ')).toBe('Glass from the ramp out.');
  });

  it('long notes are cut at a word, trailing punctuation dropped, with an ellipsis', () => {
    expect(notesExcerpt('Black ice to the island, then snow, then slush.', 30)).toBe(
      'Black ice to the island, then…',
    );
    expect(notesExcerpt('x'.repeat(50), 10)).toBe(`${'x'.repeat(10)}…`);
  });

  it('never runs past the cap plus its ellipsis', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (notes) => {
        const out = notesExcerpt(notes);
        if (out !== undefined) expect(out.length).toBeLessThanOrEqual(NOTES_EXCERPT_MAX + 1);
      }),
    );
  });
});
