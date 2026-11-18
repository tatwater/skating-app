import { Effect, Exit, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it, vi } from 'vitest';
import { fetchCellYear } from './wtkFetch';

const point = { lat: 44.5, lng: -73.3 };
const NOW = Date.UTC(2026, 9, 21, 7, 26, 0);
const CSV = 'Year,Month,Day,Hour,Minute,dir,spd\n2012,1,1,0,0,180,4.2\n';
const tooMany = (retryAfter: string | null) =>
  new Response(null, {
    status: 429,
    headers: retryAfter === null ? {} : { 'Retry-After': retryAfter },
  });
const busy = () => new Response(null, { status: 503 });
const cellYear = (fetchImpl: typeof fetch) =>
  fetchCellYear(point, 2012, 'fixture-key', 'fixture@example.test', fetchImpl);

function runWithClock<A, E>(program: Effect.Effect<A, E>) {
  return Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())));
}

describe('fetchCellYear', () => {
  it('returns the CSV unchanged', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(CSV));
    await expect(Effect.runPromise(cellYear(fetchImpl))).resolves.toBe(CSV);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry a permanent refusal, even after a 429', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>(async () => new Response(null, { status: 403 }))
      .mockResolvedValueOnce(tooMany('0'));
    await expect(runWithClock(cellYear(fetchImpl))).rejects.toThrow('403');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives network and 5xx failures four attempts with the existing geometric backoff', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>(async () => busy())
      .mockRejectedValueOnce(new Error('connection reset'));
    await expect(
      runWithClock(
        Effect.gen(function* () {
          const job = yield* Effect.forkChild(cellYear(fetchImpl));
          for (const [index, delay] of [4_400, 17_600, 70_400].entries()) {
            yield* TestClock.adjust(delay - 1);
            expect(fetchImpl).toHaveBeenCalledTimes(index + 1);
            yield* TestClock.adjust(1);
          }
          return yield* Fiber.join(job);
        }),
      ),
    ).rejects.toThrow('503');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['120', 120_000],
    ['Wed, 21 Oct 2026 07:28:00 GMT', 120_000],
    ['Wed, 21 Oct 2026 07:00:00 GMT', 0],
    ['0', 0],
    [null, 4_400],
    ['', 4_400],
    ['soon please', 4_400],
    ['99999', 240_000],
    ['Fri, 21 Oct 2050 00:00:00 GMT', 240_000],
  ] as const)('uses the expected wait for Retry-After: %s', async (header, wait) => {
    const fetchImpl = vi
      .fn<typeof fetch>(async () => new Response(CSV))
      .mockResolvedValueOnce(tooMany(header));
    await expect(
      runWithClock(
        Effect.gen(function* () {
          yield* TestClock.setTime(NOW);
          const job = yield* Effect.forkChild(cellYear(fetchImpl));
          if (wait > 0) {
            yield* TestClock.adjust(wait - 1);
            expect(fetchImpl).toHaveBeenCalledTimes(1);
            yield* TestClock.adjust(1);
          }
          return yield* Fiber.join(job);
        }),
      ),
    ).resolves.toBe(CSV);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('stops after eight 429s, with no ninth request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => tooMany('0'));
    await expect(runWithClock(cellYear(fetchImpl))).rejects.toThrow('429');
    expect(fetchImpl).toHaveBeenCalledTimes(8);
  });

  it('keeps the longer budget after a 429, but not its Retry-After or its state on rerun', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => busy()).mockResolvedValueOnce(tooMany('2'));
    const program = cellYear(fetchImpl);
    const failure = Effect.gen(function* () {
      const job = yield* Effect.forkChild(program);
      const waits = [2_000, 17_600, 70_400, 240_000, 240_000, 240_000, 240_000];
      for (const [index, delay] of waits.entries()) {
        yield* TestClock.adjust(delay - 1);
        expect(fetchImpl).toHaveBeenCalledTimes(index + 1);
        yield* TestClock.adjust(1);
      }
      return yield* Fiber.await(job);
    });
    expect(Exit.isFailure(await runWithClock(failure))).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    fetchImpl.mockClear();
    await expect(
      runWithClock(
        Effect.gen(function* () {
          const job = yield* Effect.forkChild(program);
          yield* TestClock.adjust('2 minutes');
          return yield* Fiber.join(job);
        }),
      ),
    ).rejects.toThrow('503');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('does not retry a body read failure or expose its underlying error', async () => {
    const response = new Response(CSV);
    vi.spyOn(response, 'text').mockRejectedValue(new Error('fixture-key'));
    const fetchImpl = vi.fn<typeof fetch>(async () => response);
    await expect(Effect.runPromise(cellYear(fetchImpl))).rejects.toThrow(
      /^WTK response body could not be read$/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports an exhausted network error without the URL, key, or email', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      throw new Error(`Could not fetch ${url}`);
    });
    await expect(
      runWithClock(
        Effect.gen(function* () {
          const job = yield* Effect.forkChild(cellYear(fetchImpl));
          yield* TestClock.adjust('2 minutes');
          return yield* Fiber.join(job);
        }),
      ),
    ).rejects.toThrow(/^WTK request failed: network error$/);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('passes interruption to the in-flight request and does not retry it', async () => {
    const controller = new AbortController();
    const aborted = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted();
            reject(new Error('aborted'));
          });
          queueMicrotask(() => controller.abort());
        }),
    );
    const exit = await Effect.runPromiseExit(cellYear(fetchImpl), { signal: controller.signal });
    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
