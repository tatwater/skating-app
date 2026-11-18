import { ORS_FOOT_HIKING_URL } from '@skating/core';
import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, test, vi } from 'vitest';
import { createApproachRouter } from './orsApproach';

const from = { lat: 44, lng: -72 };
const to = { lat: 44.001, lng: -72.001 };
const fallback = { leg: expect.objectContaining({ routed: false }) };
const log = () => {};
const refused = (status: number) => new Response(null, { status });

describe('ORS approach routing', () => {
  test('requests foot hiking and returns a cacheable route', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ features: [{ properties: { summary: { distance: 150 } } }] }),
    );
    const { route } = createApproachRouter('fixture', log, fetchImpl);
    expect(await Effect.runPromise(route(from, to, 'pair'))).toEqual({
      leg: { meters: 150, routed: true },
      cacheable: true,
    });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      ORS_FOOT_HIKING_URL,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          coordinates: [
            [-72, 44],
            [-72.001, 44.001],
          ],
          elevation: true,
        }),
      }),
    );
  });

  test.each([
    [404, true],
    [500, false],
  ])('classifies HTTP %i without a retry', async (status, cacheable) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => refused(status));
    const { route } = createApproachRouter('fixture', log, fetchImpl);
    expect(await Effect.runPromise(route(from, to, 'pair'))).toMatchObject({
      ...fallback,
      cacheable,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('backs off only for 429 and never caches an exhausted retry', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => refused(429));
    const reports = vi.fn();
    const { route } = createApproachRouter('fixture', reports, fetchImpl);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const leg = yield* Effect.forkChild(route(from, to, 'pair'));
        for (let i = 1; i <= 3; i++) {
          yield* TestClock.adjust(19_999);
          expect(fetchImpl).toHaveBeenCalledTimes(i);
          yield* TestClock.adjust(1);
        }
        return yield* Fiber.join(leg);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(result).toMatchObject({ ...fallback, cacheable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(reports.mock.calls.flat()).toEqual([
      'ORS 429 — backing off 20s (attempt 1)',
      'ORS 429 — backing off 20s (attempt 2)',
      'ORS 429 — backing off 20s (attempt 3)',
      'ORS 429 after 3 retries for pair — flying straight',
    ]);
  });

  test('backs off and uses a later definitive answer', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>(async () => refused(404))
      .mockResolvedValueOnce(refused(429));
    const { route } = createApproachRouter('fixture', log, fetchImpl);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const leg = yield* Effect.forkChild(route(from, to, 'pair'));
        yield* TestClock.adjust(20_000);
        return yield* Fiber.join(leg);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(result).toMatchObject({ ...fallback, cacheable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('turns off requests after three 403s until the next access run', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => refused(403));
    const reports = vi.fn();
    const { route, quotaExhausted } = createApproachRouter('fixture', reports, fetchImpl);
    expect(quotaExhausted()).toBe(false);
    for (let i = 0; i < 4; i++) {
      expect(await Effect.runPromise(route(from, to, `pair ${i}`))).toMatchObject({
        ...fallback,
        cacheable: false,
      });
    }
    expect(quotaExhausted()).toBe(true);
    expect(reports).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const next = createApproachRouter('fixture', log, fetchImpl);
    expect(next.quotaExhausted()).toBe(false);
    await Effect.runPromise(next.route(from, to, 'new run'));
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  test('an OK HTTP response resets the quota streak even if its body is unreadable', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>(async () => refused(403))
      .mockResolvedValueOnce(refused(403))
      .mockResolvedValueOnce(refused(403))
      .mockResolvedValueOnce(new Response('not JSON'));
    const { route } = createApproachRouter('fixture', log, fetchImpl);
    for (let i = 0; i < 6; i++) {
      expect(await Effect.runPromise(route(from, to, 'pair'))).toMatchObject({
        ...fallback,
        cacheable: false,
      });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  test('keeps a parseable no-route answer, but never caches missing credentials or network failure', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>(async () => Response.json({ features: [] }))
      .mockRejectedValueOnce(new Error('fixture credential'));
    const reports = vi.fn();
    const { route: withoutKey } = createApproachRouter(undefined, reports, fetchImpl);
    expect(await Effect.runPromise(withoutKey(from, to, 'pair'))).toMatchObject({
      ...fallback,
      cacheable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    const { route } = createApproachRouter('fixture', reports, fetchImpl);
    expect(await Effect.runPromise(route(from, to, 'pair'))).toMatchObject({
      ...fallback,
      cacheable: false,
    });
    expect(reports).toHaveBeenCalledExactlyOnceWith('ORS request failed for pair — falling back');
    expect(await Effect.runPromise(route(from, to, 'pair'))).toMatchObject({
      ...fallback,
      cacheable: true,
    });
  });
});
