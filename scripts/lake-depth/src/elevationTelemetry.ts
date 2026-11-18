import { Effect, Exit, Layer, Tracer } from 'effect';
import { fetchElevationPoints } from './fetchElevation';

/** One opt-in span per fetch batch; no automatic instrumentation or error-event export. */
export async function runElevationFetch(
  points: Parameters<typeof fetchElevationPoints>[0],
  concurrency: number,
  onPoint: Parameters<typeof fetchElevationPoints>[2],
  signal: AbortSignal,
  dsn: string | undefined,
): Promise<void> {
  if (!dsn)
    return Effect.runPromise(fetchElevationPoints(points, concurrency, onPoint), { signal });

  const Sentry = await import('@sentry/effect');
  const sentry = Layer.merge(
    Sentry.effectLayer({
      dsn,
      environment: 'manual-scripts',
      tracesSampleRate: 1,
      tracePropagationTargets: [],
      defaultIntegrations: false,
      dataCollection: { userInfo: false },
      sendClientReports: false,
      beforeSend: () => null,
    }),
    Layer.succeed(Tracer.Tracer, Sentry.SentryEffectTracer),
  );
  let fetched = 0;
  let refused = 0;
  let retries = 0;
  const batch = fetchElevationPoints(
    points,
    concurrency,
    (result) => {
      if (result.ok) fetched++;
      else refused++;
      onPoint(result);
    },
    fetch,
    () => retries++,
  ).pipe(
    Effect.onExit((exit) =>
      Effect.annotateCurrentSpan({
        'snapshot.outcome': Exit.isSuccess(exit)
          ? 'completed'
          : Exit.hasInterrupts(exit)
            ? 'interrupted'
            : 'failed',
        'snapshot.fetched': fetched,
        'snapshot.refused': refused,
        'snapshot.retries': retries,
      }),
    ),
    Effect.withSpan(
      '3dep.snapshot.fetch',
      { attributes: { 'snapshot.points': points.length, 'snapshot.concurrency': concurrency } },
      { captureStackTrace: false },
    ),
    Effect.provide(sentry),
  );
  return Effect.runPromise(batch, { signal });
}

/** Flush after the CLI has saved its archive and closed the operator log. */
export async function flushElevationTelemetry(): Promise<boolean> {
  const Sentry = await import('@sentry/effect');
  return Sentry.flush(2_000);
}
