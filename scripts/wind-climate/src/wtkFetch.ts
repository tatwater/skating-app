import { Cause, Duration, Effect, Schedule } from 'effect';
import { type WtkPoint, wtkUrl } from './wtk';

const DEFAULT_ATTEMPTS = 4;
// A07a-3: the short budget lost 18 cell-years in one burst of 429s.
const RATE_LIMIT_ATTEMPTS = 8;
const MAX_BACKOFF_MS = 240_000;
// Separate from normal request pacing: changing the daily pace must not change retry waits.
const BACKOFF_BASE_MS = 1_100;

/** RFC 9110 permits delta-seconds or an HTTP date. No usable header means use backoff. */
function retryAfterMs(header: string | null, now: number): number | null {
  const value = header?.trim();
  if (!value) return null;
  const delay = /^\d+$/.test(value) ? Number(value) * 1_000 : Date.parse(value) - now;
  return Number.isNaN(delay) ? null : Math.min(Math.max(0, delay), MAX_BACKOFF_MS);
}

type RequestFailure =
  | { kind: 'network' }
  | { kind: 'http'; status: number; retryAfter: string | null };

const retrySchedule = Schedule.fromStepWithMetadata(
  Effect.sync(() => {
    // Each cell-year starts with the short budget. Once it gets a 429, keep the longer budget even
    // if a subsequent attempt gets a network error or 5xx; a permanent refusal still stops at once.
    let rateLimited = false;
    return ({ input, attempt, now }: Schedule.InputMetadata<RequestFailure>) => {
      const status = input.kind === 'http' ? input.status : undefined;
      if (status !== undefined && status !== 429 && status < 500) return Cause.done(undefined);
      rateLimited ||= status === 429;
      if (attempt >= (rateLimited ? RATE_LIMIT_ATTEMPTS : DEFAULT_ATTEMPTS)) {
        return Cause.done(undefined);
      }
      const retryAfter =
        input.kind === 'http' && input.status === 429 ? retryAfterMs(input.retryAfter, now) : null;
      const delay = retryAfter ?? Math.min(BACKOFF_BASE_MS * 4 ** attempt, MAX_BACKOFF_MS);
      return Effect.succeed<[undefined, Duration.Duration]>([undefined, Duration.millis(delay)]);
    };
  }),
);

/** Fetch one cell-year; the snapshot CLI still owns pacing and archive writes. */
export function fetchCellYear(
  point: WtkPoint,
  year: number,
  apiKey: string,
  email: string,
  fetchImpl: typeof fetch = fetch,
) {
  const request = Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) => fetchImpl(wtkUrl(point, year, apiKey, email), { signal }),
      catch: (): RequestFailure => ({ kind: 'network' }),
    });
    if (response.ok) return response;
    return yield* Effect.fail<RequestFailure>({
      kind: 'http',
      status: response.status,
      retryAfter: response.headers.get('retry-after'),
    });
  });

  return request.pipe(
    Effect.retry(retrySchedule),
    // Never forward raw fetch errors or URLs: the WIND Toolkit URL contains a key and email.
    Effect.mapError(
      (error) =>
        new Error(
          error.kind === 'http'
            ? `WTK request failed: ${error.status}`
            : 'WTK request failed: network error',
        ),
    ),
    // As before, a failed body read is a cell-year failure, not another request.
    Effect.flatMap((response) =>
      Effect.tryPromise({
        try: () => response.text(),
        catch: () => new Error('WTK response body could not be read'),
      }),
    ),
  );
}
