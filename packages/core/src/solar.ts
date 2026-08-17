/**
 * Sunrise and sunset, for rendering a posted "daylight hours only" rule (N6e).
 *
 * ## This is display-only, and that boundary is deliberate
 *
 * Sunset-timed *notifications* were considered and dropped twice — the digest flushes at a fixed 20:00
 * ET because a fixed hour needs no astronomy and no per-body fetch
 * (`plans/phase-N8-notification-pipeline.md:508`). **That decision stands and this module does not
 * reopen it.** Nothing here is imported by the scheduler; `schedule.ts` still knows only about wall
 * clocks. What changed is not the cost of the calculation but the question being asked: a digest picks
 * one hour for thousands of users, while a lake drawer answers "may I be out there right now" for one
 * lake, on the client, with no network and no cron.
 *
 * ## Why hand-rolled rather than a dependency
 *
 * This is the NOAA solar-position algorithm — closed-form, ~40 lines of trigonometry, and measured at
 * **within ~20 seconds of the US Naval Observatory** across the ice season at this latitude (see
 * `solar.test.ts`). Pulling an astronomy package in would put the repo's first such dependency into
 * both the Vite bundle and the Expo bundle to compute two numbers.
 *
 * The accuracy is worth stating plainly: this is a *civil* sunrise/sunset (the 90.833° zenith that
 * accounts for refraction and the sun's disc), it ignores elevation and terrain, and a lake in a
 * valley goes dark before this says it does. That is fine for reading a posted rule and would not be
 * fine for anything that had to be right to the second.
 */

import { zonedInstantOnDayOf } from './zonedTime';

/** The zenith angle the sun's *upper limb* crosses at civil sunrise: 90° + refraction + semidiameter. */
const SUNRISE_ZENITH_DEG = 90.833;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** Julian Day at the Unix epoch (1970-01-01T00:00:00Z). */
const JULIAN_EPOCH = 2_440_587.5;
/** Days per Julian century, the unit the NOAA polynomials are expressed in. */
const JULIAN_CENTURY_DAYS = 36_525;
/** Julian Day at J2000.0, the epoch those polynomials are anchored to. */
const J2000 = 2_451_545.0;

const rad = (deg: number): number => (deg * Math.PI) / 180;
const deg = (r: number): number => (r * 180) / Math.PI;
/** `%` keeps the sign of the dividend in JS, which is wrong for an angle. */
const mod360 = (x: number): number => ((x % 360) + 360) % 360;

/** The two instants, or `null` for a day on which the sun does not cross the horizon at all. */
export interface SunTimes {
  sunriseMs: number;
  sunsetMs: number;
}

/**
 * The sun's declination and the equation of time for a Julian century `t`.
 *
 * Straight from the NOAA Solar Calculator's published spreadsheet. The magic numbers are that
 * document's, not ours, and are deliberately left as literals: rewriting them as named constants
 * would make the source harder to diff against NOAA's, which is the only way anyone will ever check
 * this function.
 */
function solarPosition(t: number): { declinationDeg: number; eqTimeMinutes: number } {
  const meanLongDeg = mod360(280.46646 + t * (36000.76983 + t * 0.0003032));
  const meanAnomDeg = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

  const centerDeg =
    Math.sin(rad(meanAnomDeg)) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(rad(2 * meanAnomDeg)) * (0.019993 - 0.000101 * t) +
    Math.sin(rad(3 * meanAnomDeg)) * 0.000289;

  const trueLongDeg = meanLongDeg + centerDeg;
  const omegaDeg = 125.04 - 1934.136 * t;
  const appLongDeg = trueLongDeg - 0.00569 - 0.00478 * Math.sin(rad(omegaDeg));

  const meanObliqDeg = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliqCorrDeg = meanObliqDeg + 0.00256 * Math.cos(rad(omegaDeg));

  const declinationDeg = deg(Math.asin(Math.sin(rad(obliqCorrDeg)) * Math.sin(rad(appLongDeg))));

  const varY = Math.tan(rad(obliqCorrDeg / 2)) ** 2;
  const eqTimeMinutes =
    4 *
    deg(
      varY * Math.sin(2 * rad(meanLongDeg)) -
        2 * eccentricity * Math.sin(rad(meanAnomDeg)) +
        4 * eccentricity * varY * Math.sin(rad(meanAnomDeg)) * Math.cos(2 * rad(meanLongDeg)) -
        0.5 * varY * varY * Math.sin(4 * rad(meanLongDeg)) -
        1.25 * eccentricity * eccentricity * Math.sin(2 * rad(meanAnomDeg)),
    );

  return { declinationDeg, eqTimeMinutes };
}

/**
 * Sunrise and sunset for the local calendar day containing `atMs`, at `lat`/`lon` (degrees, east
 * positive), with the day boundary taken in `timeZone`.
 *
 * **Returns `null` when the sun neither rises nor sets** — a polar day or night, where the hour-angle
 * cosine leaves [-1, 1]. That case cannot arise in this corpus, and it is handled anyway because the
 * alternative is not an error but an `acos` of an out-of-range value, which is `NaN`: it would flow
 * silently into a comparison, and every comparison against `NaN` is `false`, so a posted window would
 * quietly report *closed* forever rather than reporting that it does not know.
 *
 * The day is anchored on **local noon**, not local midnight, because the declination used has to be
 * the one at the middle of the daylight span rather than 12 hours before it.
 */
export function sunTimes(
  atMs: number,
  lat: number,
  lon: number,
  timeZone: string,
): SunTimes | null {
  const localNoonMs = localNoonInstant(atMs, timeZone);
  const julianDay = localNoonMs / DAY_MS + JULIAN_EPOCH;
  const t = (julianDay - J2000) / JULIAN_CENTURY_DAYS;

  const { declinationDeg, eqTimeMinutes } = solarPosition(t);

  // cos(H) for the moment the sun's upper limb touches the horizon.
  const cosHourAngle =
    Math.cos(rad(SUNRISE_ZENITH_DEG)) / (Math.cos(rad(lat)) * Math.cos(rad(declinationDeg))) -
    Math.tan(rad(lat)) * Math.tan(rad(declinationDeg));
  if (cosHourAngle > 1 || cosHourAngle < -1) return null;

  const hourAngleDeg = deg(Math.acos(cosHourAngle));

  // Minutes from 00:00 UTC of the UTC day containing local noon. 720 = noon; the earth turns one
  // degree every four minutes, which is where both `4 *` factors come from.
  const utcMidnightMs = Math.floor(localNoonMs / DAY_MS) * DAY_MS;
  const solarNoonMinutes = 720 - 4 * lon - eqTimeMinutes;

  return {
    sunriseMs: utcMidnightMs + (solarNoonMinutes - 4 * hourAngleDeg) * MINUTE_MS,
    sunsetMs: utcMidnightMs + (solarNoonMinutes + 4 * hourAngleDeg) * MINUTE_MS,
  };
}

/**
 * The instant of 12:00 local wall-clock on the calendar day that `atMs` falls in, in `timeZone`.
 *
 * Noon rather than midnight because the declination this feeds has to be the one from the middle of
 * the daylight span, not twelve hours before it.
 */
function localNoonInstant(atMs: number, timeZone: string): number {
  return zonedInstantOnDayOf(atMs, 12 * 60, timeZone);
}
