import type { convexTest as ConvexTest } from 'convex-test';
import { afterEach, beforeEach, vi } from 'vitest';

/**
 * Default every test to a benign, **offline** Open-Meteo response. `reports.create` now schedules weather
 * actions (conditions auto-fill §7a, contradiction eval §7b), and convex-test flushes pending scheduled
 * functions during later `t.*` calls — so without this a report created in an unrelated test would fire a
 * real network fetch (flaky, rate-limited). An empty `hourly.time` makes those actions fail open
 * harmlessly. Tests that exercise weather override this with their own `vi.stubGlobal('fetch', …)`.
 */
function stubOfflineFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ hourly: { time: [] } }), { status: 200 })),
  );
}

/**
 * Every harness a test created, so its scheduled work can be drained before the test is torn down.
 * A mutation that schedules (`waterBodies.merge` → `recurrence.enqueueBody` → …) in a test that stops
 * at its assertions leaves that chain running in the background, past the end of the test and
 * sometimes the file. Vitest 5 fails the run when such a straggler logs after the worker has closed
 * (`EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`), and one that
 * outlives the offline stub above could reach the real network.
 */
const harnesses = vi.hoisted(() => new Set<ReturnType<typeof ConvexTest>>());

vi.mock('convex-test', async (importOriginal) => {
  const actual = await importOriginal<typeof import('convex-test')>();
  return {
    ...actual,
    convexTest: (...args: Parameters<typeof actual.convexTest>) => {
      const t = actual.convexTest(...args);
      harnesses.add(t);
      return t;
    },
  };
});

beforeEach(() => {
  stubOfflineFetch();
});

/**
 * The drain finishes the test's own scheduled work — a decline's sibling pages, their deliveries —
 * so it runs on the test's own budget, not vitest's 10 s hook default: a heavy test given minutes
 * gives its continuations minutes too (one timed out at 10 s on CI while the test had 450 s). The
 * hook's own timeout is off (`0`) and the drain races the test's timeout instead, so a runaway
 * still fails, at the bound its test declared.
 */
afterEach(async (ctx) => {
  // Offline again first: a test's own teardown may have unstubbed its fetch.
  stubOfflineFetch();
  // A test file's own afterEach (which restores real timers) runs before this setup hook, so there
  // is no fake clock to advance: the drain yields real event-loop turns until the zero-delay chains
  // settle, and anything scheduled further out lapses with the test, as it always has.
  // A drain that throws (a runaway chain past convex-test's iteration cap, or past the test's
  // timeout) fails this test, but must not leave its harness behind to fail every later test in the
  // file the same way.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const budget = ctx.task.timeout;
    const drain = (async () => {
      for (const t of harnesses) await t.finishAllScheduledFunctions(() => {});
    })();
    // A test with no timeout (`0`) gives its drain none either.
    if (!(budget > 0 && Number.isFinite(budget))) await drain;
    else
      await Promise.race([
        drain,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error(`Draining this test's scheduled work passed its own ${budget} ms.`)),
            budget,
          );
        }),
      ]);
  } finally {
    clearTimeout(timer);
    harnesses.clear();
    vi.unstubAllGlobals();
  }
}, 0);
