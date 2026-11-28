/**
 * **The headroom re-runs' harness** (B01-8b, D347; test-only — its name has two dots, so Convex never
 * deploys it). Each `cronHeadroom.<suite>.test.ts` imports one at-the-edge suite of a job that
 * budgets its reads, so that suite's tests run again there, and calls {@link rerunThroughDispatcher}:
 * every `t.mutation(<a cron mutation's function>, args)` its tests make becomes `t.run` of what
 * `cronRuns.tickMutation` does — a nested transaction under `nestedLimits` (what is left less the
 * recorder's reserve) after the dispatcher's own start cost. Every test must still pass: the
 * backbone must not make a job that works today fail. Every call is routed whatever its arguments,
 * a stricter test than the cron's own empty ones.
 *
 * One suite a file: a suite's top-level hooks (its clock, its stubs) apply to every test in the file
 * that imports it, so two suites in one file would run under each other's hooks. Nothing here
 * imports an app module statically, so a suite's own `vi.mock` applies before anything loads it.
 * An inline `t.run` is not charged the harness's start cost (`vitest.config.ts`, `START_RANGES`),
 * which `tickMutation` pays as a registered function, so the route reads that many ranges first.
 */

import { getFunctionName } from 'convex/server';
import * as convexTestModule from 'convex-test';
import { afterAll, beforeEach, expect, vi } from 'vitest';

/** `vitest.config.ts`' `START_RANGES`: what `tickMutation` is charged before its handler runs. */
const START_RANGES = 96;

const realConvexTest = convexTestModule.convexTest;
const routed = new Set<string>();

type Harness = ReturnType<typeof realConvexTest>;

/** `t`, with each call to a cron mutation's function run as the dispatcher runs it. */
function throughDispatcher(t: Harness): Harness {
  return new Proxy(t, {
    get(target, prop, receiver) {
      if (prop !== 'mutation') return Reflect.get(target, prop, receiver);
      return async (ref: never, args?: Record<string, unknown>, ...rest: never[]) => {
        const name = getFunctionName(ref);
        const { CRON_JOBS } = await import('./cronJobs');
        const isCron = CRON_JOBS.some(
          (e) => e.kind === 'mutation' && getFunctionName(e.fn) === name,
        );
        if (!isCron) return target.mutation(ref, args as never, ...rest);
        routed.add(name);
        const { nestedLimits } = await import('./cronRuns');
        return target.run(async (ctx) => {
          for (let i = 0; i < START_RANGES; i++) {
            await ctx.db
              .query('cronHeartbeats')
              .withIndex('by_job', (q) => q.eq('job', `start ${i}`))
              .first();
          }
          return await ctx.runMutation(ref, (args ?? {}) as never, {
            transactionLimits: await nestedLimits(ctx),
          });
        });
      };
    },
  });
}

/**
 * Install the re-run in the calling test file (which imports one at-the-edge suite): every harness
 * its tests make routes its cron mutations through the dispatcher's path, and the file fails unless
 * the suite reached each of `expected` (a rename would otherwise make the re-run vacuous).
 */
export function rerunThroughDispatcher(expected: string[]): void {
  beforeEach(() => {
    vi.spyOn(convexTestModule, 'convexTest').mockImplementation(((...a: never[]) =>
      throughDispatcher((realConvexTest as (...x: never[]) => Harness)(...a))) as never);
  });
  afterAll(() => {
    expect([...routed].sort()).toEqual(expect.arrayContaining(expected));
  });
}
