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
 *
 * A request that still fails leaves its sites' rows `undefined` rather than throwing, so each caller
 * decides what part of an answer is worth: the fill stores what came, the tick decides on nothing
 * less than its whole sample.
 */

import type { OpenMeteoHourlyRow } from '@skating/core';

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import { openMeteoCallWeight } from './apiMeter';

/** Site-days per request: ~110 KB of hourly JSON. */
const SITE_DAYS_PER_FETCH = 300;

/** Requests in flight at once — well inside Open-Meteo's 600 weighted calls a minute. */
const FETCHES_AT_ONCE = 3;

/** One attempt's deadline: a stalled answer is retried, not waited on to the action limit. */
const FETCH_TIMEOUT_MS = 60_000;

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

async function attempt(url: string): Promise<OpenMeteoHourlyRow | OpenMeteoHourlyRow[]> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    throw new FetchFailure(`Open-Meteo did not answer: ${String(error)}`, true);
  }
  if (!res.ok) {
    throw new FetchFailure(`Open-Meteo ${res.status} ${res.statusText}`, res.status >= 500);
  }
  try {
    return (await res.json()) as OpenMeteoHourlyRow | OpenMeteoHourlyRow[];
  } catch (error) {
    throw new FetchFailure(`Open-Meteo's answer did not arrive whole: ${String(error)}`, true);
  }
}

/** Each site's Open-Meteo hourly row for `days` days of `params`, a few sites a request. */
export async function fetchHourlyRows(
  url: string,
  params: URLSearchParams,
  sites: readonly { lat: number; lng: number }[],
  days: number,
  meter: Meter,
): Promise<HourlyFetch> {
  const size = Math.max(1, Math.floor(SITE_DAYS_PER_FETCH / days));
  const chunks: { start: number; sites: (typeof sites)[number][] }[] = [];
  for (let i = 0; i < sites.length; i += size) {
    chunks.push({ start: i, sites: sites.slice(i, i + size) });
  }
  const rows: (OpenMeteoHourlyRow | undefined)[] = new Array(sites.length).fill(undefined);
  let failed = 0;
  let lastError: string | null = null;

  const one = async (chunk: (typeof chunks)[number]) => {
    const query = new URLSearchParams(params);
    query.set('latitude', chunk.sites.map((s) => s.lat.toFixed(4)).join(','));
    query.set('longitude', chunk.sites.map((s) => s.lng.toFixed(4)).join(','));
    for (let n = 1; ; n++) {
      await meter(chunk.sites.length);
      try {
        const json = await attempt(`${url}?${query.toString()}`);
        // One coordinate answers with an object, several with an array.
        const answered = Array.isArray(json) ? json : [json];
        chunk.sites.forEach((_, j) => {
          rows[chunk.start + j] = answered[j];
        });
        return;
      } catch (error) {
        const failure =
          error instanceof FetchFailure ? error : new FetchFailure(String(error), false);
        if (failure.retryable && n < 2) continue;
        failed++;
        lastError = failure.message;
        return;
      }
    }
  };

  for (let i = 0; i < chunks.length; i += FETCHES_AT_ONCE) {
    await Promise.all(chunks.slice(i, i + FETCHES_AT_ONCE).map(one));
  }
  return { rows, failed, requests: chunks.length, lastError };
}
