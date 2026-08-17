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

import {
  normalizeRose,
  STRONG_WIND_MIN_MPS,
  WIND_ROSE_MONTHS,
  WIND_ROSE_SECTORS,
} from '@skating/core';

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

/**
 * Pause between requests. The documented 1/second ceiling on CSV downloads is what set this to
 * 1100 ms, but it is not the limit that binds: the same endpoint caps CSV at **10,000 requests a
 * day**, and that one is never mentioned next to the per-second one.
 *
 * At 1100 ms plus the ~4 s measured latency the run paced ~700/hr — 16,800/day, or 1.7× the cap.
 * So it spent a full day's quota in ~14 hours and the rest of the day collecting 429s, each of
 * which costs the whole `WTK_RATE_LIMIT_RETRIES` budget (~17 min) before it counts as failed. The
 * N7-3 campaign ran clean to 84% and then crawled at ~40/hr; `x-ratelimit-remaining: 0` with a
 * `retry-after` of an hour is what it looks like from the outside.
 *
 * 5000 ms plus latency is ~400/hr (~9,600/day), which lands under the cap rather than into it.
 */
export const WTK_REQUEST_DELAY_MS = 5000;

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
 * Everything one cell's winters accumulate into — **direction and speed, not just direction**.
 *
 * `counts` was the whole accumulator until N7-3, and `cells[6]` was fetched on every request and
 * never read. That is what turned "could we also derive strong-wind hours?" into a 7.7-hour
 * re-fetch, and it is the reason this package now archives responses. See `archive.ts`.
 */
export interface WindAccumulator {
  /** Winter hours per sector, whatever the speed — the rose. */
  counts: SectorCounts;
  /** Winter hours per sector **at or above the strong threshold** — the wind-hole signal. */
  strongHours: SectorCounts;
  /**
   * Summed m/s per sector, for a **mean** speed — how hard it blows from a direction, as opposed to
   * `strongHours`, which is how often it blows hard. A rose says which way; these say what it is
   * like when it does.
   */
  speedSum: SectorCounts;
  /**
   * Hours with a **readable** speed, per sector — `speedSum`'s denominator, and deliberately not
   * `counts`.
   *
   * `accumulateCsv` keeps an hour whose direction parses but whose speed does not, because dropping
   * it would bias the rose toward whatever conditions produce a clean speed field. That same rule
   * makes `counts` the wrong divisor here: it would average a sector's speed sum over hours that
   * contributed nothing to it and quietly report a light wind.
   */
  speedHours: SectorCounts;
  /** Every winter hour accepted, the honest denominator for both. */
  sampledHours: number;
  /** The m/s bar `strongHours` was taken at, carried so a stored row is self-describing. */
  strongMinMps: number;
}

export function emptyAccumulator(strongMinMps: number = STRONG_WIND_MIN_MPS): WindAccumulator {
  return {
    counts: emptyCounts(),
    strongHours: emptyCounts(),
    speedSum: emptyCounts(),
    speedHours: emptyCounts(),
    sampledHours: 0,
    strongMinMps,
  };
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
export function accumulateCsv(csv: string, into: WindAccumulator): number {
  let accepted = 0;
  const lines = csv.split('\n');
  for (let i = 2; i < lines.length; i++) {
    const row = lines[i];
    if (!row) continue;
    const cells = row.split(',');
    if (cells.length < 7) continue;
    const month = Number(cells[1]);
    const direction = Number(cells[5]);
    // **`cells[6]`, which every previous run fetched and ignored.**
    const speed = Number(cells[6]);
    if (!Number.isFinite(month) || !Number.isFinite(direction)) continue;
    if (!(WIND_ROSE_MONTHS as readonly number[]).includes(month)) continue;
    const sector = Math.round((((direction % 360) + 360) % 360) / (360 / WIND_ROSE_SECTORS));
    const index = sector % WIND_ROSE_SECTORS;
    into.counts[index] = (into.counts[index] ?? 0) + 1;
    // A row with a readable direction and an unreadable speed still counts toward the rose — the
    // two are separate claims, and dropping the hour entirely would silently bias the rose toward
    // whatever conditions happen to produce a clean speed field. Everything speed-derived below is
    // therefore guarded on the speed parsing, and carries its own denominator.
    if (Number.isFinite(speed)) {
      into.speedSum[index] = (into.speedSum[index] ?? 0) + speed;
      into.speedHours[index] = (into.speedHours[index] ?? 0) + 1;
      if (speed >= into.strongMinMps) {
        into.strongHours[index] = (into.strongHours[index] ?? 0) + 1;
      }
    }
    into.sampledHours++;
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

/** What one cell contributes to every body in it. `null` where the sample is too thin for a rose. */
export interface CellClimate {
  rose: number[] | null;
  strongWindHours: number[];
  /** Mean m/s per sector, `null` per sector where no hour there had a readable speed. */
  meanWindMps: (number | null)[];
  sampledWindHours: number;
  strongWindMinMps: number;
}

/**
 * Mean m/s per sector — **`null`, never `0`, where a sector has no readable speed at all.**
 *
 * Zero is a real wind speed, and a rose glyph sized on it would draw "dead calm from the north"
 * identically to "we have no reading from the north". They are different claims and only one of
 * them is a measurement, so the absent case is absent rather than small.
 */
export function meanSpeedFromAccumulator(acc: WindAccumulator): (number | null)[] {
  return acc.speedSum.map((sum, k) => {
    const hours = acc.speedHours[k] ?? 0;
    return hours > 0 ? sum / hours : null;
  });
}

/**
 * An accumulator → what gets stored.
 *
 * **The rose can be `null` while the strong-hour counts are still real**, and that asymmetry is
 * deliberate. A rose is rendered as a percentage, so a thin sample is actively misleading —
 * `MIN_ROSE_HOURS` exists for that. Strong-hour counts are absolute and carry their own denominator,
 * so a thin sample is merely a small number honestly reported. Suppressing both on one threshold
 * would discard usable data to protect against a failure mode only one of them has.
 */
export function climateFromAccumulator(acc: WindAccumulator): CellClimate {
  return {
    rose: roseFromCounts(acc.counts, acc.sampledHours),
    strongWindHours: [...acc.strongHours],
    meanWindMps: meanSpeedFromAccumulator(acc),
    sampledWindHours: acc.sampledHours,
    strongWindMinMps: acc.strongMinMps,
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Attempts for a **429 specifically**, which is a different failure from a 500 (N7-3).
 *
 * A 5xx is the service being broken and retrying hard is rude; a 429 is the service telling us to
 * slow down, and the correct response is to wait longer and try again. Four attempts spanning ~92
 * seconds was not enough: the 250 m fetch lost **18 cell-years to 429 in one burst** at 13% through,
 * every one of them recoverable by simply having waited.
 *
 * The handoff asked for this check — *"`fetchCellYear` already has 429 backoff; check it is as
 * patient"* as the elevation lane's — and it was never done before the fetch started.
 */
export const WTK_RATE_LIMIT_RETRIES = 8;

/** Longest single wait, so a pathological `Retry-After` cannot park the run for an hour. */
export const WTK_MAX_BACKOFF_MS = 240_000;

/**
 * Base of the geometric retry schedule — deliberately NOT `WTK_REQUEST_DELAY_MS`.
 *
 * The two were the same constant until the daily cap forced the pacing delay up, which silently
 * scaled every backoff with it (4.4 s → 20 s on the first retry) and made each failure *more*
 * expensive at exactly the moment failures got common. Pacing answers "how fast may we go when
 * things are fine"; this answers "how long do we wait when they are not". They move for unrelated
 * reasons, so they are separate constants and the schedule below stays pinned by test.
 */
export const WTK_BACKOFF_BASE_MS = 1100;

/**
 * How long the server asked us to wait, in ms, or `null` when it did not say.
 *
 * **RFC 9110 allows two forms** and services use both: delta-seconds (`120`) and an HTTP-date
 * (`Wed, 21 Oct 2026 07:28:00 GMT`). Reading only the first silently returns `NaN` for the second,
 * which is worse than not reading it at all — a `NaN` wait becomes an immediate retry into the same
 * limit. `now` is injected so the date branch is testable without freezing the clock.
 */
export function retryAfterMs(header: string | null | undefined, now: number): number | null {
  if (header === null || header === undefined) return null;
  const trimmed = header.trim();
  if (trimmed.length === 0) return null;
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, WTK_MAX_BACKOFF_MS);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  // A date already in the past means "go now", not "go back in time".
  return Math.min(Math.max(0, at - now), WTK_MAX_BACKOFF_MS);
}

/**
 * Fetch one cell-year's CSV, retrying transient failures.
 *
 * A 429 is expected in normal operation — the daily and per-second limits are real — so it backs
 * off rather than failing the run. A 4xx that is not 429 is not retried: it will not become valid.
 *
 * **A 429 gets its own, longer budget** (`WTK_RATE_LIMIT_RETRIES`) and honours `Retry-After` when the
 * server sends one, because being told exactly how long to wait and then guessing is how a run loses
 * requests it could have kept. Everything else keeps the short budget: a broken service should fail
 * fast and be reported, not retried for four minutes.
 */
export async function fetchCellYear(
  point: WtkPoint,
  year: number,
  apiKey: string,
  email: string,
  fetchImpl: typeof fetch = fetch,
  maxRetries = 4,
  now: () => number = Date.now,
  /** Injected so the backoff SCHEDULE is assertable without a test that waits 92 seconds. */
  sleepImpl: (ms: number) => Promise<void> = sleep,
): Promise<string> {
  let lastError: unknown;
  let lastRetryAfter: number | null = null;
  // The budget is the larger of the two, and a non-429 failure stops consuming it at `maxRetries`.
  const attempts = Math.max(maxRetries, WTK_RATE_LIMIT_RETRIES);
  let rateLimited = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0 && !rateLimited && attempt >= maxRetries) break;
    if (attempt > 0) {
      const backoff = Math.min(WTK_BACKOFF_BASE_MS * 4 ** attempt, WTK_MAX_BACKOFF_MS);
      await sleepImpl(lastRetryAfter ?? backoff);
    }
    lastRetryAfter = null;
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
      if (res.status === 429) {
        rateLimited = true;
        lastRetryAfter = retryAfterMs(res.headers?.get?.('retry-after'), now());
      }
      lastError = err;
      continue;
    }
    return await res.text();
  }
  throw lastError instanceof Error ? lastError : new Error('WTK request failed');
}
