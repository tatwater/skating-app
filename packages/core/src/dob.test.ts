import { describe, expect, it } from 'vitest';
import { parseDateOfBirth } from './dob';

describe('parseDateOfBirth', () => {
  it('parses a valid YYYY-MM-DD to UTC ms', () => {
    expect(parseDateOfBirth('2000-01-15')).toBe(Date.UTC(2000, 0, 15));
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseDateOfBirth('  1990-12-31  ')).toBe(Date.UTC(1990, 11, 31));
  });

  it('rejects malformed strings', () => {
    for (const bad of ['', '2000', '2000-1-1', '01-15-2000', '2000/01/15', 'not-a-date']) {
      expect(parseDateOfBirth(bad)).toBeNull();
    }
  });

  it('rejects impossible calendar dates (overflow)', () => {
    expect(parseDateOfBirth('2021-02-31')).toBeNull();
    expect(parseDateOfBirth('2021-13-01')).toBeNull();
    expect(parseDateOfBirth('2021-00-10')).toBeNull();
  });

  it('rejects implausibly ancient years that would sail past the age gate', () => {
    expect(parseDateOfBirth('0100-01-01')).toBeNull();
    expect(parseDateOfBirth('1899-12-31')).toBeNull();
    // Boundary: 1900 is the earliest accepted year.
    expect(parseDateOfBirth('1900-01-01')).toBe(Date.UTC(1900, 0, 1));
  });
});
