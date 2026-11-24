import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { meetsMinimumAge } from './age';
import { parseDateOfBirth } from './dob';
import { composeDateOfBirth, DOB_MONTHS, dateOfBirthFields, dateOfBirthProblem } from './dobFields';

// Pinned (D243): noon UTC, 24 November 2026.
const NOW = Date.UTC(2026, 10, 24, 12);

describe('DOB_MONTHS', () => {
  it('is the twelve months by name, January first', () => {
    expect(DOB_MONTHS).toHaveLength(12);
    expect(DOB_MONTHS[0]).toBe('January');
    expect(DOB_MONTHS[10]).toBe('November');
  });
});

describe('composeDateOfBirth', () => {
  it('makes the stored UTC-midnight value from a month, a day and a year', () => {
    expect(composeDateOfBirth({ month: 11, day: '2', year: '1988' })).toBe(Date.UTC(1988, 10, 2));
    expect(composeDateOfBirth({ month: 3, day: ' 14 ', year: ' 2010 ' })).toBe(
      Date.UTC(2010, 2, 14),
    );
  });

  it('refuses anything that is not a real date', () => {
    for (const fields of [
      { month: null, day: '2', year: '1988' },
      { month: 0, day: '2', year: '1988' },
      { month: 13, day: '2', year: '1988' },
      { month: 1.5, day: '2', year: '1988' },
      { month: 2, day: '30', year: '1988' },
      { month: 2, day: '', year: '1988' },
      { month: 2, day: '123', year: '1988' },
      { month: 2, day: 'x', year: '1988' },
      { month: 2, day: '2', year: '88' },
      { month: 2, day: '2', year: '1899' },
    ]) {
      expect(composeDateOfBirth(fields)).toBeNull();
    }
  });

  it('agrees with parseDateOfBirth on every padded date', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 31 }),
        fc.integer({ min: 1890, max: 2100 }),
        (month, day, year) => {
          const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          return (
            composeDateOfBirth({ month, day: String(day), year: String(year) }) ===
            parseDateOfBirth(iso)
          );
        },
      ),
    );
  });

  it('round-trips through dateOfBirthFields', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date(Date.UTC(1900, 0, 1)), max: new Date(NOW), noInvalidDate: true }),
        (d) => {
          const ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
          return composeDateOfBirth(dateOfBirthFields(ms)) === ms;
        },
      ),
    );
  });
});

describe('dateOfBirthProblem', () => {
  it('says nothing while the fields are still being filled', () => {
    expect(dateOfBirthProblem({ month: null, day: '2', year: '1988' }, NOW)).toBe('incomplete');
    expect(dateOfBirthProblem({ month: 11, day: ' ', year: '1988' }, NOW)).toBe('incomplete');
    expect(dateOfBirthProblem({ month: 11, day: '2', year: '198' }, NOW)).toBe('incomplete');
  });

  it('flags a complete date that does not exist', () => {
    expect(dateOfBirthProblem({ month: 2, day: '31', year: '1988' }, NOW)).toBe('invalid');
    expect(dateOfBirthProblem({ month: 2, day: '3', year: '19x8' }, NOW)).toBe('invalid');
  });

  it('applies the 18+ gate (D294), future dates included', () => {
    expect(dateOfBirthProblem({ month: 11, day: '2', year: '1988' }, NOW)).toBeNull();
    expect(dateOfBirthProblem({ month: 3, day: '14', year: '2010' }, NOW)).toBe('underage');
    expect(dateOfBirthProblem({ month: 1, day: '1', year: '2030' }, NOW)).toBe('underage');
  });

  it('admits exactly whom meetsMinimumAge admits', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40 * 366 }), (daysBack) => {
        const ms = Date.UTC(2026, 10, 24) - daysBack * 24 * 60 * 60 * 1000;
        const fields = dateOfBirthFields(ms);
        const problem = dateOfBirthProblem(fields, NOW);
        return (problem === null) === meetsMinimumAge(ms, NOW);
      }),
    );
  });
});
