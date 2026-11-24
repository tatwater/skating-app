/**
 * The Account step's date of birth as three fields (D298): the month picked by name, the day and the
 * year typed as numbers. This turns them into the stored value — UTC-midnight epoch ms, through
 * `parseDateOfBirth`'s rules — and says what, if anything, is wrong with them, through the same 18+
 * gate the server applies (`meetsMinimumAge`, D294). Both apps draw the fields; neither re-derives
 * the rule.
 */

import { meetsMinimumAge } from './age';
import { parseDateOfBirth } from './dob';

/** The month names, January first: a `Select`'s options, and `month` is the 1-based index. */
export const DOB_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export interface DateOfBirthFields {
  /** 1–12, or `null` until a month is picked. */
  month: number | null;
  /** As typed. */
  day: string;
  /** As typed. */
  year: string;
}

/** The fields as the stored date of birth (UTC-midnight epoch ms), or `null` if they aren't a date. */
export function composeDateOfBirth(fields: DateOfBirthFields): number | null {
  const day = fields.day.trim();
  const year = fields.year.trim();
  const { month } = fields;
  if (month === null || !Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!/^\d{1,2}$/.test(day) || !/^\d{4}$/.test(year)) return null;
  return parseDateOfBirth(`${year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}`);
}

/** A stored date of birth back as fields, for a form that starts filled in. */
export function dateOfBirthFields(dateOfBirthMs: number): DateOfBirthFields {
  const d = new Date(dateOfBirthMs);
  return {
    month: d.getUTCMonth() + 1,
    day: String(d.getUTCDate()),
    year: String(d.getUTCFullYear()),
  };
}

/**
 * What's wrong with the fields, or `null` when they make a date of someone old enough:
 * - `incomplete` — a field is empty, or the year isn't four characters yet: still being typed, so
 *   say nothing and keep *Continue* off;
 * - `invalid` — complete, but not a real date (31 February, a year before 1900, letters);
 * - `underage` — a real date of someone not yet 18 on every calendar (a future date included).
 */
export type DateOfBirthProblem = 'incomplete' | 'invalid' | 'underage';

export function dateOfBirthProblem(
  fields: DateOfBirthFields,
  nowMs: number,
): DateOfBirthProblem | null {
  if (fields.month === null || fields.day.trim() === '' || fields.year.trim().length < 4) {
    return 'incomplete';
  }
  const ms = composeDateOfBirth(fields);
  if (ms === null) return 'invalid';
  return meetsMinimumAge(ms, nowMs) ? null : 'underage';
}
