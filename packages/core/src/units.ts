/**
 * Unit conversions + display formatters.
 *
 * Per D25 we store **metric internally** and **display imperial** (US audience).
 * Keep conversions pure and lossless; formatters own the rounding + unit suffix.
 */

const CM_PER_INCH = 2.54
const MM_PER_INCH = 25.4
const KM_PER_MILE = 1.609344
const M_PER_FOOT = 0.3048
const SQM_PER_ACRE = 4046.8564224
const SQFT_PER_SQM = 10.76391041671

// --- Conversions (metric → imperial and back) ---

export function cToF(celsius: number): number {
  return (celsius * 9) / 5 + 32
}

export function fToC(fahrenheit: number): number {
  return ((fahrenheit - 32) * 5) / 9
}

export function cmToInches(cm: number): number {
  return cm / CM_PER_INCH
}

export function inchesToCm(inches: number): number {
  return inches * CM_PER_INCH
}

export function mmToInches(mm: number): number {
  return mm / MM_PER_INCH
}

export function kphToMph(kph: number): number {
  return kph / KM_PER_MILE
}

export function mphToKph(mph: number): number {
  return mph * KM_PER_MILE
}

export function metersToFeet(meters: number): number {
  return meters / M_PER_FOOT
}

export function kmToMiles(km: number): number {
  return km / KM_PER_MILE
}

export function metersToMiles(meters: number): number {
  return meters / 1000 / KM_PER_MILE
}

export function sqMetersToAcres(sqm: number): number {
  return sqm / SQM_PER_ACRE
}

export function sqMetersToSqFeet(sqm: number): number {
  return sqm * SQFT_PER_SQM
}

// --- Helpers ---

/**
 * Round to a fixed number of decimals (default: whole number), half away from zero.
 *
 * Scales via exponent-string notation rather than `value * 10**decimals` so that
 * float artifacts don't swallow a digit: `1.005` is stored as `1.00499…`, so the
 * naive `Math.round(1.005 * 100)` yields `100` → `1` instead of `1.01`. Parsing
 * `"1.005e2"` lands on the true `100.5` first. Non-finite input passes through.
 */
export function roundTo(value: number, decimals = 0): number {
  if (!Number.isFinite(value)) return value
  const scaled = Number(`${value}e${decimals}`)
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled))
  return Number(`${rounded}e${-decimals}`)
}

// --- Imperial display formatters (D25) ---

export function formatTemperatureF(celsius: number, decimals = 0): string {
  return `${roundTo(cToF(celsius), decimals)}°F`
}

/** Ice thickness in inches (″), e.g. `formatThicknessInches(10)` → "3.9″". */
export function formatThicknessInches(cm: number, decimals = 1): string {
  return `${roundTo(cmToInches(cm), decimals)}″`
}

export function formatWindMph(kph: number, decimals = 0): string {
  return `${roundTo(kphToMph(kph), decimals)} mph`
}

export function formatPrecipInches(mm: number, decimals = 2): string {
  return `${roundTo(mmToInches(mm), decimals)} in`
}

export function formatDistanceMiles(meters: number, decimals = 1): string {
  return `${roundTo(metersToMiles(meters), decimals)} mi`
}

export function formatAreaAcres(sqm: number, decimals = 1): string {
  const acres = roundTo(sqMetersToAcres(sqm), decimals)
  return `${acres} ${acres === 1 ? 'acre' : 'acres'}`
}
