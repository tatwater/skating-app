import {
  type ApproachLeg,
  type LatLng,
  ORS_FOOT_HIKING_URL,
  type OrsRouteResponse,
  orsFootHikingBody,
  parseOrsFootHikingRoute,
  straightLineApproach,
} from '@skating/core';
import { Effect, Schedule } from 'effect';

const MAX_RETRIES = 3;
const BACKOFF_MS = 20_000;
// Three 403s trip the run-level quota breaker. A later run can try the uncached legs.
const QUOTA_STRIKES = 3;

function requestApproach(from: LatLng, to: LatLng, apiKey: string, fetchImpl: typeof fetch) {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetchImpl(ORS_FOOT_HIKING_URL, {
          method: 'POST',
          headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(orsFootHikingBody(from, to)),
          signal,
        }),
      catch: () => 'transport' as const,
    });
    if (response.status === 429) return yield* Effect.fail('rate-limited' as const);
    if (!response.ok) return { kind: 'refused', status: response.status } as const;

    // An OK HTTP response resets the 403 streak even if we cannot read its body.
    const leg = yield* Effect.tryPromise({
      try: async () => parseOrsFootHikingRoute((await response.json()) as OrsRouteResponse),
      catch: () => 'body' as const,
    }).pipe(Effect.result);
    return { kind: 'answered', leg } as const;
  });
}

interface RoutedLeg {
  leg: ApproachLeg;
  cacheable: boolean;
}

/** One router per serial access run; retries and waits are clock-driven, quota is run-local. */
export function createApproachRouter(
  apiKey: string | undefined,
  log: (message: string) => void,
  fetchImpl: typeof fetch = fetch,
) {
  let forbidden = 0;
  const retryDelay = Schedule.spaced(BACKOFF_MS).pipe(
    Schedule.tap(({ attempt, input }) =>
      Effect.sync(() => {
        // Effect steps the schedule on the last failure even when it won't retry.
        if (input === 'rate-limited' && attempt <= MAX_RETRIES) {
          log(`ORS 429 — backing off ${BACKOFF_MS / 1000}s (attempt ${attempt})`);
        }
      }),
    ),
  );

  const quotaExhausted = () => forbidden >= QUOTA_STRIKES;
  const route = (from: LatLng, to: LatLng, key: string): Effect.Effect<RoutedLeg> =>
    Effect.gen(function* () {
      const fallback = () => straightLineApproach(from, to);
      if (!apiKey || quotaExhausted()) return { leg: fallback(), cacheable: false };

      const result = yield* requestApproach(from, to, apiKey, fetchImpl).pipe(
        Effect.retry({
          times: MAX_RETRIES,
          while: (error) => error === 'rate-limited',
          schedule: retryDelay,
        }),
        Effect.result,
      );
      if (result._tag === 'Failure') {
        log(
          result.failure === 'rate-limited'
            ? `ORS 429 after ${MAX_RETRIES} retries for ${key} — flying straight`
            : `ORS request failed for ${key} — falling back`,
        );
        return { leg: fallback(), cacheable: false };
      }

      const response = result.success;
      if (response.kind === 'refused' && response.status === 403) {
        if (++forbidden === QUOTA_STRIKES) {
          log(
            `ORS refused ${QUOTA_STRIKES} in a row with 403 — treating the daily quota as exhausted. Flying the rest straight; re-run tomorrow and the cache resumes.`,
          );
        }
        return { leg: fallback(), cacheable: false };
      }
      forbidden = 0;
      if (response.kind === 'refused') {
        // A 404 is an answer about the pair, not the provider's current availability.
        if (response.status !== 404) log(`ORS ${response.status} for ${key} — falling back`);
        return { leg: fallback(), cacheable: response.status === 404 };
      }
      if (response.leg._tag === 'Failure') {
        log(`ORS response could not be read for ${key} — falling back`);
        return { leg: fallback(), cacheable: false };
      }
      return { leg: response.leg.success ?? fallback(), cacheable: true };
    });
  return { route, quotaExhausted };
}
