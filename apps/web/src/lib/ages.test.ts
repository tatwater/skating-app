import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { assertSeeded } from '@/test/seeded';
import { ageInWords, shortAge, timeLeftInWords } from './ages';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 9, 14, 12, 0).getTime();

describe('shortAge — a row’s', () => {
  it('reads minutes, hours, a day and a half, then whole days rounded down', () => {
    expect(shortAge(0)).toBe('0 min');
    expect(shortAge(41 * MIN)).toBe('41 min');
    expect(shortAge(5 * HOUR + 59 * MIN)).toBe('5 h');
    expect(shortAge(1.5 * DAY)).toBe('1.5 d');
    expect(shortAge(1.99 * DAY)).toBe('1.9 d');
    expect(shortAge(2 * DAY + 3 * HOUR)).toBe('2 d');
    expect(shortAge(4 * DAY + 23 * HOUR)).toBe('4 d');
  });

  it('never reads negative or NaN, whatever the clock skew', () => {
    expect(shortAge(-5 * MIN)).toBe('0 min');
    expect(shortAge(Number.NaN)).toBe('0 min');
    expect(shortAge(Number.POSITIVE_INFINITY)).toBe('0 min');
    assertSeeded(
      fc.property(fc.double({ min: -100 * 365 * DAY, max: 100 * 365 * DAY }), (ms) => {
        expect(shortAge(ms)).toMatch(/^\d+(\.\d)? (min|h|d)$/u);
      }),
    );
  });
});

describe('the written-out pair — a head’s, a note’s', () => {
  it('writes the time left out, never abbreviated', () => {
    expect(timeLeftInWords(NOW + 31 * HOUR, NOW)).toBe('1 day left');
    expect(timeLeftInWords(NOW + 4 * DAY + HOUR, NOW)).toBe('4 days left');
    expect(timeLeftInWords(NOW + 5 * HOUR, NOW)).toBe('5 hours left');
    expect(timeLeftInWords(NOW + HOUR, NOW)).toBe('1 hour left');
    expect(timeLeftInWords(NOW + 10 * MIN, NOW)).toBe('Less than an hour left');
  });

  it('writes ages with "ago", and a clock ahead of ours as just now', () => {
    expect(ageInWords(NOW - 2 * DAY, NOW)).toBe('2 days ago');
    expect(ageInWords(NOW - 5 * HOUR, NOW)).toBe('5 hours ago');
    expect(ageInWords(NOW - 3 * MIN, NOW)).toBe('3 minutes ago');
    expect(ageInWords(NOW - MIN, NOW)).toBe('1 minute ago');
    expect(ageInWords(NOW + 1000, NOW)).toBe('Just now');
  });
});
