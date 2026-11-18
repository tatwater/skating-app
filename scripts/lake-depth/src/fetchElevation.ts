import { Effect, Schedule } from 'effect';
import type { ElevationArchiveEntry } from './elevationArchive';
import { coordinateKey, type EpqsRefusal, epqsUrl, parseEpqsResponse } from './epqs';

export interface ElevationPoint {
  lat: number;
  lng: number;
}

type PointResult = { ok: true; entry: ElevationArchiveEntry } | { ok: false; reason: EpqsRefusal };

const ATTEMPT_TIMEOUT_MS = 45_000;
const RETRIES = 3;
const BACKOFF_MS = 1_500;

function fetchPoint({ lat, lng }: ElevationPoint, fetchImpl: typeof fetch) {
  const attempt = Effect.gen(function* () {
    // Keep the fetch and the body read in one deadline, and pass through the signal so
    // a timeout (or stopping the batch) actually aborts the request.
    const body = yield* Effect.tryPromise({
      try: async (signal): Promise<unknown> => {
        const response = await fetchImpl(epqsUrl(lat, lng), { signal });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`EPQS HTTP ${response.status}`);
        }
        return response.json();
      },
      catch: () => 'unparseable' as const,
    }).pipe(Effect.timeout(ATTEMPT_TIMEOUT_MS));

    const outcome = parseEpqsResponse(body, lat);
    if (!outcome.ok) {
      // No data is an answer, not a retryable failure.
      if (outcome.reason === 'implausible') return { ok: false, reason: outcome.reason } as const;
      return yield* Effect.fail(outcome.reason);
    }
    return {
      ok: true,
      entry: {
        key: coordinateKey(lat, lng),
        lat,
        lng,
        fetchedAt: new Date().toISOString(),
        ...outcome.reading,
      },
    } as const;
  });

  return attempt.pipe(
    // As before: retry transport failures, non-OK HTTP, and malformed responses.
    Effect.retry({ times: RETRIES, schedule: Schedule.exponential(BACKOFF_MS) }),
    Effect.catch(() => Effect.succeed({ ok: false, reason: 'unparseable' } as const)),
  );
}

/** Report each settled point immediately so the caller can checkpoint a partial run. */
export function fetchElevationPoints(
  points: readonly ElevationPoint[],
  concurrency: number,
  onPoint: (result: PointResult) => void,
  fetchImpl: typeof fetch = fetch,
) {
  return Effect.forEach(
    points,
    (point) =>
      fetchPoint(point, fetchImpl).pipe(Effect.tap((result) => Effect.sync(() => onPoint(result)))),
    { concurrency, discard: true },
  );
}
