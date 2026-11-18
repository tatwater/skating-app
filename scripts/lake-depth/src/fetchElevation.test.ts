import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, test, vi } from 'vitest';
import { fetchElevationPoints } from './fetchElevation';

const points = [44, 45, 46, 47].map((lat) => ({ lat, lng: -72 }));
const reading = () => Response.json({ value: '171.25', resolution: 1 });
const latitude = (url: Parameters<typeof fetch>[0]) =>
  Number(new URL(String(url)).searchParams.get('y'));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('fetchElevationPoints', () => {
  test('retries network, HTTP, and malformed responses at 1.5, 3, and 6 seconds', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('<html>bad gateway</html>'))
      .mockImplementation(async () => reading());
    const onPoint = vi.fn();

    await Effect.runPromise(
      Effect.gen(function* () {
        const batch = yield* Effect.forkChild(
          fetchElevationPoints(points.slice(0, 1), 1, onPoint, fetchImpl),
        );
        for (const [index, delay] of [1_500, 3_000, 6_000].entries()) {
          yield* TestClock.adjust(delay - 1);
          expect(fetchImpl).toHaveBeenCalledTimes(index + 1);
          yield* TestClock.adjust(1);
        }
        yield* Fiber.join(batch);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(onPoint).toHaveBeenCalledExactlyOnceWith({
      ok: true,
      entry: expect.objectContaining({ lat: 44, lng: -72, elevationM: 171.25, resolutionM: 1 }),
    });
  });

  test('exhaustion counts one refusal; no data is not retried and other points still finish', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      switch (latitude(url)) {
        case 44:
          return Response.json({ unexpectedShape: true });
        case 45:
          return Response.json({ value: '-1000000' });
        default:
          return reading();
      }
    });
    const onPoint = vi.fn();

    await Effect.runPromise(
      Effect.gen(function* () {
        const batch = yield* Effect.forkChild(
          fetchElevationPoints(points.slice(0, 3), 2, onPoint, fetchImpl),
        );
        yield* TestClock.adjust(10_500);
        yield* Fiber.join(batch);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    const requests = fetchImpl.mock.calls.map(([url]) => latitude(url));
    expect(requests.filter((lat) => lat === 44)).toHaveLength(4);
    expect(requests.filter((lat) => lat === 45)).toHaveLength(1);
    expect(onPoint).toHaveBeenCalledTimes(3);
    expect(onPoint).toHaveBeenCalledWith({ ok: false, reason: 'unparseable' });
    expect(onPoint).toHaveBeenCalledWith({ ok: false, reason: 'implausible' });
    expect(onPoint).toHaveBeenCalledWith({ ok: true, entry: expect.objectContaining({ lat: 46 }) });
  });

  test('the per-attempt deadline aborts even a stalled response body, then retries', async () => {
    const aborted = vi.fn();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (_url, init) => {
        const signal = init?.signal;
        return new Response(
          new ReadableStream({
            start(controller) {
              signal?.addEventListener('abort', () => {
                controller.error(signal.reason);
                aborted();
              });
            },
          }),
        );
      })
      .mockImplementation(async () => reading());
    const onPoint = vi.fn();

    await Effect.runPromise(
      Effect.gen(function* () {
        const batch = yield* Effect.forkChild(
          fetchElevationPoints(points.slice(0, 1), 1, onPoint, fetchImpl),
        );
        yield* TestClock.adjust(44_999);
        expect(aborted).not.toHaveBeenCalled();
        yield* TestClock.adjust(1);
        expect(aborted).toHaveBeenCalledTimes(1);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        yield* TestClock.adjust(1_500);
        yield* Fiber.join(batch);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onPoint).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ok: true }));
  });

  test('publishes progress before the batch ends and stops active and queued work on abort', async () => {
    const responses = points.map(() => deferred<Response>());
    const firstTwoStarted = deferred<void>();
    const thirdStarted = deferred<void>();
    const active = new Map<number, AbortSignal>();
    const aborted = vi.fn();
    const onPoint = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>((url, init) => {
      const lat = latitude(url);
      const response = responses[lat - 44];
      const signal = init?.signal;
      if (!response || !signal) throw new Error('bad fake request');
      active.set(lat, signal);
      if (active.size === 2) firstTwoStarted.resolve();
      if (lat === 46) thirdStarted.resolve();
      signal.addEventListener('abort', () => {
        aborted(lat);
        response.reject(signal.reason);
      });
      return response.promise;
    });
    const controller = new AbortController();
    const result = Effect.runPromiseExit(fetchElevationPoints(points, 2, onPoint, fetchImpl), {
      signal: controller.signal,
    });
    try {
      await firstTwoStarted.promise;
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      responses[0]?.resolve(reading());
      await thirdStarted.promise;
      expect(onPoint).toHaveBeenCalledExactlyOnceWith({
        ok: true,
        entry: expect.objectContaining({ lat: 44 }),
      });
    } finally {
      controller.abort();
    }
    expect((await result)._tag).toBe('Failure');
    expect(aborted.mock.calls.flat().sort()).toEqual([45, 46]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(onPoint).toHaveBeenCalledTimes(1);
  });
});
