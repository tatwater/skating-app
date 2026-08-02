/**
 * NREL WIND Toolkit client + rose accumulation (N6c A4b) — the tested half.
 *
 * The WIND Toolkit is WRF run on a **2 km grid** over the contiguous US, hourly, with wind speed
 * and direction at 10 m. Free with an API key; see `.env.example` for where to get one and why the
 * variable is named after the dataset rather than the provider.
 *
 * ## Why not the Global Wind Atlas
 *
 * GWA resolves 250 m and would see more terrain, but it publishes **no documented public API** — its
 * site is a JS application and data comes out through interactive downloads, so a pipeline on it
 * would depend on an undocumented endpoint with no stability promise. The question here is
 * *"which way does wind come down this valley"*, which is valley-scale; Willoughby's measured rose
 * (see `windRose.ts`) shows 2 km WRF answers it.
 *
 * ## The two limits that shape this file
 *
 * 1. **One point and one year per CSV request.** Not a batching choice — the API documents it.
 * 2. **10,000 CSV requests/day, one per second.** So the scarce resource is *requests*, which is
 *    why the loader dedupes to the native grid before spending any: many lakes share a 2 km cell,
 *    and a rose is a property of the cell, not of the lake.
 */

import { normalizeRose, WIND_ROSE_MONTHS, WIND_ROSE_SECTORS } from '@skating/core';

/** Where the API lives. The host moved from `developer.nrel.gov`, which no longer resolves at all. */
export const WTK_BASE = 'https://developer.nlr.gov/api/wind-toolkit/v2/wind/wtk-download.csv';

/**
 * The WIND Toolkit's native grid spacing, in degrees of latitude (~2 km).
 *
 * Used to **dedupe lakes onto cells before fetching**. The API snaps a requested point to its own
 * grid anyway — asking for `44.75, -72.06` returns `44.7501, -72.0525` — so two lakes in the same
 * cell would otherwise cost two requests for byte-identical data.
 */
export const WTK_GRID_DEG = 0.018;

/** Winters averaged into one rose. Five is enough to wash out an anomalous year (founder call). */
export const WTK_YEARS = [2010, 2011, 2012, 2013, 2014] as const;

/** Pause between requests: the API documents a 1/second ceiling on CSV downloads. */
export const WTK_REQUEST_DELAY_MS = 1100;

export interface WtkPoint {
  lat: number;
  lng: number;
}

/** The grid cell a point falls in, as a stable string key. */
export function gridKey({ lat, lng }: WtkPoint): string {
  const round = (v: number) => Math.round(v / WTK_GRID_DEG) * WTK_GRID_DEG;
  return `${round(lat).toFixed(4)},${round(lng).toFixed(4)}`;
}

/** The representative point for a grid key — the cell centre we actually request. */
export function pointForGridKey(key: string): WtkPoint {
  const [lat, lng] = key.split(',').map(Number) as [number, number];
  return { lat, lng };
}

/** The request URL for one cell-year. */
export function wtkUrl(point: WtkPoint, year: number, apiKey: string, email: string): string {
  const params = new URLSearchParams({
    api_key: apiKey,
    // WKT is `POINT(lng lat)` — longitude first, which is the opposite of every other parameter
    // pair in this repo and the easiest thing here to get backwards.
    wkt: `POINT(${point.lng} ${point.lat})`,
    attributes: 'winddirection_10m,windspeed_10m',
    names: String(year),
    email,
    interval: '60',
  });
  return `${WTK_BASE}?${params.toString()}`;
}

/** Per-sector hour counts, the accumulator a rose is built from. */
export type SectorCounts = number[];

export function emptyCounts(): SectorCounts {
  return Array.from({ length: WIND_ROSE_SECTORS }, () => 0);
}

/**
 * Accumulate one year's CSV into per-sector winter-hour counts.
 *
 * The WTK CSV carries **two header lines** — a site-metadata row then the column names — before
 * data. Rows are `Year,Month,Day,Hour,Minute,direction,speed`.
 *
 * **Only `WIND_ROSE_MONTHS` are counted.** An annual rose averages in summer patterns that have
 * nothing to do with ice.
 *
 * Returns the number of hours accepted so a caller can tell "no winter data" from "parsed nothing",
 * which otherwise look identical downstream.
 */
export function accumulateCsv(csv: string, into: SectorCounts): number {
  let accepted = 0;
  const lines = csv.split('\n');
  for (let i = 2; i < lines.length; i++) {
    const row = lines[i];
    if (!row) continue;
    const cells = row.split(',');
    if (cells.length < 7) continue;
    const month = Number(cells[1]);
    const direction = Number(cells[5]);
    if (!Number.isFinite(month) || !Number.isFinite(direction)) continue;
    if (!(WIND_ROSE_MONTHS as readonly number[]).includes(month)) continue;
    const sector = Math.round((((direction % 360) + 360) % 360) / (360 / WIND_ROSE_SECTORS));
    const index = sector % WIND_ROSE_SECTORS;
    into[index] = (into[index] ?? 0) + 1;
    accepted++;
  }
  return accepted;
}

/**
 * The minimum winter hours a rose may be built from.
 *
 * One winter is ~2,900 hours, so this is roughly a season and a half — enough that a single
 * anomalous month cannot define a lake's rose. Below it we store **nothing**, because a rose is
 * rendered as a percentage and a percentage of a small sample is the failure mode D78 and D86 both
 * exist to prevent: it looks identical whether it summarises 300 hours or 14,000.
 */
export const MIN_ROSE_HOURS = 4000;

/** Turn accumulated counts into a stored rose, or `null` if the sample is too thin. */
export function roseFromCounts(counts: SectorCounts, hours: number): number[] | null {
  if (hours < MIN_ROSE_HOURS) return null;
  return normalizeRose(counts);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch one cell-year's CSV, retrying transient failures.
 *
 * A 429 is expected in normal operation — the daily and per-second limits are real — so it backs
 * off rather than failing the run. A 4xx that is not 429 is not retried: it will not become valid.
 */
export async function fetchCellYear(
  point: WtkPoint,
  year: number,
  apiKey: string,
  email: string,
  fetchImpl: typeof fetch = fetch,
  maxRetries = 4,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) await sleep(WTK_REQUEST_DELAY_MS * 4 ** attempt);
    let res: Response;
    try {
      res = await fetchImpl(wtkUrl(point, year, apiKey, email));
    } catch (err) {
      lastError = err;
      continue;
    }
    if (!res.ok) {
      const err = new Error(`WTK request failed: ${res.status}`);
      if (res.status !== 429 && res.status < 500) throw err;
      lastError = err;
      continue;
    }
    return await res.text();
  }
  throw lastError instanceof Error ? lastError : new Error('WTK request failed');
}
