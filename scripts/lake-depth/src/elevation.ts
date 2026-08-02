/**
 * Elevation lookup against the **Open-Meteo Elevation API** (N6c A1) — the tested half.
 *
 * Rides the depth pass rather than getting its own (N6a's ordering gate, founder call): both write
 * to the same 116,070 rows, and doing them separately costs a second full pass over the corpus for
 * a field that could have been free.
 *
 * `https://api.open-meteo.com/v1/elevation?latitude=…&longitude=…` — no API key, no account, and
 * it serves Copernicus GLO-90. See `@skating/core`'s `elevation.ts` for what the numbers are
 * actually worth and why there is one source rather than a ladder.
 */

import { isPlausibleElevationM } from '@skating/core';

/**
 * Coordinates per request. **Verified against the live endpoint at build time**, not taken from
 * the docs: 100 returns 200, and **101 returns a 400** reading *"Parameter 'latitude' and
 * 'longitude' must not exceed 100 coordinates."* (A much larger batch fails earlier still, with a
 * 414 from their nginx, so there is no URL-length headroom to exploit either.)
 *
 * At 100 per request the 116,070-body corpus is ~1,161 requests.
 */
export const ELEVATION_BATCH_SIZE = 100;

/**
 * Pause between requests, in milliseconds.
 *
 * Open-Meteo's free tier publishes a per-minute ceiling, and ~1,161 requests is small enough that
 * there is nothing to gain by going fast — the pass is minutes either way. 250 ms puts us at ~4/s,
 * comfortably inside any published limit and polite to an endpoint we are not paying for. The whole
 * corpus costs about five minutes of wall clock at this rate.
 */
export const ELEVATION_REQUEST_DELAY_MS = 250;

/** How many times to retry one batch before giving up on the run. */
export const ELEVATION_MAX_RETRIES = 4;

export const ELEVATION_URL = 'https://api.open-meteo.com/v1/elevation';

/** One body awaiting a lookup, as `waterBodies.listNeedingElevation` returns it. */
export interface ElevationTarget {
  waterBodyId: string;
  lat: number;
  lng: number;
}

/** A resolved elevation, shaped for `waterBodies.importElevations`. */
export interface ElevationRecord {
  waterBodyId: string;
  elevationM: number;
}

/** Split targets into request-sized batches. */
export function batchTargets(
  targets: readonly ElevationTarget[],
  size: number = ELEVATION_BATCH_SIZE,
): ElevationTarget[][] {
  const batches: ElevationTarget[][] = [];
  for (let i = 0; i < targets.length; i += size) batches.push([...targets.slice(i, i + size)]);
  return batches;
}

/** The request URL for one batch — coordinates in the order the response will echo them. */
export function elevationUrl(batch: readonly ElevationTarget[]): string {
  const params = new URLSearchParams({
    latitude: batch.map((t) => t.lat).join(','),
    longitude: batch.map((t) => t.lng).join(','),
  });
  return `${ELEVATION_URL}?${params.toString()}`;
}

/**
 * Zip a response's `elevation` array back onto the batch that produced it.
 *
 * **Refuses a length mismatch outright** rather than zipping what it can. The response is positional
 * — there is no id in it — so a short or long array means every pairing after the discrepancy is
 * suspect, and the failure would be invisible: every body would get *an* elevation, just not its
 * own. That is the worst available outcome for a field rendered as a fact, and it is exactly the
 * kind of thing that survives review because the data looks populated.
 *
 * Implausible values are dropped per body (the mutation re-checks, but there is no reason to spend
 * a write on a sentinel).
 */
export function zipElevations(
  batch: readonly ElevationTarget[],
  elevations: unknown,
): { records: ElevationRecord[]; implausible: number } {
  if (!Array.isArray(elevations)) {
    throw new Error('elevation response carried no `elevation` array');
  }
  if (elevations.length !== batch.length) {
    throw new Error(
      `elevation response length ${elevations.length} does not match the ${batch.length} coordinates sent — ` +
        'the response is positional, so a mismatch means every pairing is suspect',
    );
  }
  const records: ElevationRecord[] = [];
  let implausible = 0;
  for (const [i, target] of batch.entries()) {
    const value = elevations[i];
    if (!isPlausibleElevationM(value)) {
      implausible++;
      continue;
    }
    records.push({ waterBodyId: target.waterBodyId, elevationM: value });
  }
  return { records, implausible };
}

/** Sleep, for the inter-request pause and the retry backoff. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch one batch, retrying on a transient failure with exponential backoff.
 *
 * A 4xx that is not 429 is **not** retried: a malformed request will be malformed on the fourth
 * attempt too, and retrying it just spends someone else's quota.
 */
export async function fetchElevationBatch(
  batch: readonly ElevationTarget[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ records: ElevationRecord[]; implausible: number }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ELEVATION_MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(ELEVATION_REQUEST_DELAY_MS * 4 ** attempt);

    // Each failure mode is handled where it happens rather than in one `catch`. The first version
    // of this wrapped the whole body in a try and re-`throw`ew the non-retryable case from inside
    // it — which its own `catch` then swallowed, so a 400 retried four times. Caught by the test
    // asserting exactly one call.
    let res: Response;
    try {
      res = await fetchImpl(elevationUrl(batch));
    } catch (err) {
      lastError = err; // network / DNS — worth another go
      continue;
    }

    if (!res.ok) {
      const err = new Error(`elevation request failed: ${res.status}`);
      // A malformed request will be malformed on the fourth attempt too, and retrying it just
      // spends someone else's quota.
      if (res.status !== 429 && res.status < 500) throw err;
      lastError = err;
      continue;
    }

    let json: { elevation?: unknown };
    try {
      json = (await res.json()) as { elevation?: unknown };
    } catch (err) {
      lastError = err; // truncated body — retryable
      continue;
    }

    // Deliberately outside any `try`: a length mismatch is a data problem, not a transient one,
    // and it must reach the caller on the first occurrence.
    return zipElevations(batch, json.elevation);
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`elevation request failed after ${ELEVATION_MAX_RETRIES} attempts`);
}
