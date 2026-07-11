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

/** Round to a fixed number of decimals (default: whole number). */
export function roundTo(value: number, decimals = 0): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
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
  return `${roundTo(sqMetersToAcres(sqm), decimals)} acres`
}
