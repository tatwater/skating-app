import { afterEach, beforeEach, vi } from 'vitest';

/**
 * Default every test to a benign, **offline** Open-Meteo response. `reports.create` now schedules weather
 * actions (conditions auto-fill §7a, contradiction eval §7b), and convex-test flushes pending scheduled
 * functions during later `t.*` calls — so without this a report created in an unrelated test would fire a
 * real network fetch (flaky, rate-limited). An empty `hourly.time` makes those actions fail open
 * harmlessly. Tests that exercise weather override this with their own `vi.stubGlobal('fetch', …)`.
 */
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ hourly: { time: [] } }), { status: 200 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});
