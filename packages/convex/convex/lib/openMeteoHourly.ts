/**
 * Open-Meteo hourly temperatures for many sites, a few at a time (A06i) — what the season watch's
 * daily tick and its history fill both read, since #82 cut days from hours rather than trusting
 * Open-Meteo's fixed-offset daily lows.
 *
 * ⚠ **Small answers, each with a deadline and one retry.** Hourly readings are ~24× the daily form,
 * and from Convex a 12-site, 92-day answer (430 KB; ~1 s from a laptop) took 65 s, and another
 * arrived cut off mid-array after 32 s (2026-10-11, re-filling the lows on dev). So a request carries
 * at most {@link SITE_DAYS_PER_FETCH} site-days — three sites of the tick's 93 days, one site of an
 * archive season — a few run at once, each attempt times out, and an answer that did not arrive
 * whole, a timeout or a 5xx is asked again once. A 4xx is not: a refusal or the quota is no blip.
 * The whole fetch has a deadline ({@link FETCH_BUDGET_MS}) the caller can finish inside.
 *
 * A request that still fails leaves its sites' rows `undefined` rather than throwing, so each caller
 * decides what part of an answer is worth: the fill stores what came, the tick decides on nothing
 * less than its whole sample.
 */

import type { OpenMeteoHourlyRow } from '@skating/core';
import { Clock, Effect } from 'effect';

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import { openMeteoCallWeight } from './apiMeter';

/** Site-days per request: ~110 KB of hourly JSON. */
const SITE_DAYS_PER_FETCH = 300;

/** Requests in flight at once — well inside Open-Meteo's 600 weighted calls a minute. */
const FETCHES_AT_ONCE = 3;

/** One attempt's deadline: a stalled answer is retried, not waited on to the action limit. */
const FETCH_TIMEOUT_MS = 60_000;

/**
 * The whole fetch's deadline. ⚠ **Well inside Convex's 10-minute action limit**, so the caller still
 * has time to store what came and — for the daily tick — send its email in `finally`: at 80 sites
 * (ten sentinels, ten pinned, a sample of sixty) a stalled API could otherwise spend nine waves of
 * a timeout and a retry, ~18 minutes, and the action would be killed mid-loop (Greptile, PR #85).
 * Past it, no attempt starts, and the requests left count as failed.
 */
const FETCH_BUDGET_MS = 5 * 60_000;

export interface HourlyFetch {
  /** One row per site, in order; `undefined` where its request failed twice. */
  rows: (OpenMeteoHourlyRow | undefined)[];
  /** Requests that failed both attempts, and the last error among them. */
  failed: number;
  requests: number;
  lastError: string | null;
}

/** Records each attempt on the call meter (`externalApiCalls`) — told the sites it asked for. */
export type Meter = (siteCount: number) => Promise<void>;

/**
 * The meter both callers use: weighted by days, and never in the way — a metering failure is
 * logged, and the fetch goes on (D158: a meter, not a limiter).
 */
export function openMeteoMeter(ctx: ActionCtx, days: number): Meter {
  return async (siteCount) => {
    try {
      await ctx.runMutation(internal.weather.recordOpenMeteoCallMutation, {
        weightedCalls: openMeteoCallWeight(1, days) * siteCount,
        nowMs: Date.now(),
      });
    } catch (err) {
      console.warn('externalApiCalls metering failed (fetch continues)', err);
    }
  };
}

class FetchFailure extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

async function requestRows(
  url: string,
  siteCount: number,
  signal: AbortSignal,
): Promise<OpenMeteoHourlyRow[]> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (error) {
    throw new FetchFailure(`Open-Meteo did not answer: ${String(error)}`, true);
  }
  if (!res.ok) {
    throw new FetchFailure(`Open-Meteo ${res.status} ${res.statusText}`, res.status >= 500);
  }
  let json: OpenMeteoHourlyRow | OpenMeteoHourlyRow[];
  try {
    json = (await res.json()) as typeof json;
  } catch (error) {
    throw new FetchFailure(`Open-Meteo's answer did not arrive whole: ${String(error)}`, true);
  }
  // One coordinate answers with an object. A short answer would otherwise silently remove lakes
  // from the tick's sample, so reject the whole chunk before keeping any of its rows.
  const answered = (Array.isArray(json) ? json : [json]).slice(0, siteCount);
  const whole = answered.filter((row) => Array.isArray(row?.hourly?.time)).length;
  if (whole < siteCount) {
    throw new FetchFailure(`Open-Meteo answered for ${whole} of ${siteCount} sites`, true);
  }
  return answered;
}

/** Each site's Open-Meteo hourly row for `days` days of `params`, a few sites a request. */
export function fetchHourlyRows(
  ...args: Parameters<typeof hourlyRowsEffect>
): Promise<HourlyFetch> {
  return Effect.runPromise(hourlyRowsEffect(...args));
}

/** Testable with a virtual clock; only actions should run this program. */
export function hourlyRowsEffect(
  url: string,
  params: URLSearchParams,
  sites: readonly { lat: number; lng: number }[],
  days: number,
  meter: Meter,
  budgetMs: number = FETCH_BUDGET_MS,
): Effect.Effect<HourlyFetch> {
  return Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + budgetMs;
    const outOfTime = new FetchFailure(
      `Open-Meteo: out of time after ${Math.round(budgetMs / 1000)} s`,
      false,
    );
    const size = Math.max(1, Math.floor(SITE_DAYS_PER_FETCH / days));
    const chunks: { start: number; sites: (typeof sites)[number][] }[] = [];
    for (let i = 0; i < sites.length; i += size) {
      chunks.push({ start: i, sites: sites.slice(i, i + size) });
    }
    const rows: HourlyFetch['rows'] = new Array(sites.length).fill(undefined);
    let failed = 0;
    let lastError: string | null = null;

    const one = ({ start, sites }: (typeof chunks)[number]) => {
      const query = new URLSearchParams(params);
      query.set('latitude', sites.map((s) => s.lat.toFixed(4)).join(','));
      query.set('longitude', sites.map((s) => s.lng.toFixed(4)).join(','));
      const attempt = Effect.gen(function* () {
        if ((yield* Clock.currentTimeMillis) >= deadline) return yield* Effect.fail(outOfTime);
        yield* Effect.promise(() => meter(sites.length));
        // The meter cannot be canceled safely, and a slow write must not start a late fetch.
        const left = deadline - (yield* Clock.currentTimeMillis);
        if (left <= 0) return yield* Effect.fail(outOfTime);
        return yield* Effect.tryPromise({
          try: (signal) => requestRows(`${url}?${query.toString()}`, sites.length, signal),
          catch: (error) =>
            error instanceof FetchFailure ? error : new FetchFailure(String(error), false),
        }).pipe(
          Effect.timeoutOrElse({
            duration: Math.min(FETCH_TIMEOUT_MS, left),
            orElse: () => Effect.fail(new FetchFailure('Open-Meteo did not answer in time', true)),
          }),
        );
      });

      return attempt.pipe(
        Effect.retry({ times: 1, while: (error) => error.retryable }),
        Effect.match({
          onSuccess: (answer) => {
            answer.forEach((row, j) => {
              rows[start + j] = row;
            });
          },
          onFailure: (error) => {
            failed++;
            lastError = error.message;
          },
        }),
      );
    };

    // Keep the existing waves: retrying requests continue to occupy their slot.
    for (let i = 0; i < chunks.length; i += FETCHES_AT_ONCE) {
      yield* Effect.forEach(chunks.slice(i, i + FETCHES_AT_ONCE), one, {
        concurrency: FETCHES_AT_ONCE,
        discard: true,
      });
    }
    return { rows, failed, requests: chunks.length, lastError };
  });
}
