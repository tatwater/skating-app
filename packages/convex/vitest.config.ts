import { defineConfig, type Plugin } from 'vitest/config';

/**
 * **The harness enforces Convex's one-paginated-query rule for mutations too** (PR #170). The real
 * backend refuses a second `.paginate()` in one function execution, queries and mutations alike —
 * `crates/isolate/src/environment/udf/async_syscall.rs`, the `queryPage` syscall:
 * `MultiplePaginatedDatabaseQueries`, "This query or mutation function ran multiple paginated
 * queries. Convex only supports a single paginated query in each function." `convex-test` (0.0.72)
 * counts it for queries only (its mutation context carries no counter), so a mutation paginating
 * twice passed here and would throw on deploy. This gives every mutation execution a counter of its
 * own — nested ones too: the backend builds each execution its own `DatabaseUdfEnvironment` with a
 * fresh `next_journal` (`environment/udf/mod.rs`; a nested call runs at `reactor_depth > 0`) — and
 * names the function in the error. Test-only: it rewrites the inlined `convex-test` bundle, never
 * production code. Its own test: `harnessLimits.test.ts`.
 */
function singlePaginatePerMutation(): Plugin {
  const MUTATION_CTX = `udfType: "mutation",
            depth: (parentCtx?.depth ?? 0) + 1,
        };`;
  const THROW = `throw new Error("Only a single paginated query (\`.paginate()\`) is allowed per " +`;
  return {
    name: 'convex-single-paginate-per-mutation',
    enforce: 'pre',
    transform(code, id) {
      if (!/convex-test[\\/]dist[\\/]index\.js$/.test(id)) return null;
      if (!code.includes(MUTATION_CTX) || !code.includes(THROW)) {
        throw new Error(
          'convex-test changed: the one-paginated-query harness rule no longer applies; update it',
        );
      }
      return code
        .replace(
          MUTATION_CTX,
          `udfType: "mutation",
            depth: (parentCtx?.depth ?? 0) + 1,
            pagination: { calls: 0 },
        };`,
        )
        .replace(
          THROW,
          `throw new Error("[" + (executionContextStorage.getStore()?.udfPath ?? "?") + "] " + "Only a single paginated query (\`.paginate()\`) is allowed per " +`,
        );
    },
  };
}

export default defineConfig({
  plugins: [singlePaginatePerMutation()],
  test: {
    /**
     * 20s, not vitest's 5s default.
     *
     * **The flaking set is load-dependent, which is why per-test bounds could not fix it.** Three
     * different tests timed out across three consecutive full-suite runs — a 60-bay convex-test
     * import, a 140,000-point density probe, a union-find chain sized to the call stack — and none
     * of them is slow in isolation (0.3-0.5s). They lose the race only when turbo runs 11 packages
     * at once on a machine already doing something else, and CI is measured at ~8x slower than
     * local. Bounding whichever test happened to lose is chasing the symptom.
     *
     * This does not hide a hang: a hang is unbounded and still fails, 15 seconds later. What it
     * stops is a green suite reporting red for reasons that have nothing to do with the code.
     */
    testTimeout: 20_000,
    // convex-test runs functions in a simulated Convex backend; the edge-runtime
    // environment matches Convex's V8 isolate more closely than jsdom/node.
    environment: 'edge-runtime',
    server: { deps: { inline: ['convex-test'] } },
    // A benign default `fetch` stub so scheduled weather actions never hit the real network in tests.
    setupFiles: ['./test.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['convex/**/*.ts'],
      // Generated code and tests aren't our logic; schema/enums/validators are pure
      // data exercised on import.
      exclude: [
        'convex/_generated/**',
        'convex/**/*.test.ts',
        'convex/**/*.d.ts',
        'convex/**/*.config.ts', // deployment config (auth.config.ts), not testable logic
      ],
      // Matches @skating/core's baseline; functions are at 100% now. Ratchet upward
      // as more functions land (D40).
      //
      // Branches re-baselined 85 → 81.8 at Vitest 5 (2026-09-28): v8 coverage now remaps through
      // the AST, which counts every `?.`, `??` and default parameter as a branch. The same code
      // and the same 1,792 tests measured 86.36% before and 81.88% after. Set at the measurement,
      // not below it — a ratchet (D40) leaves no slack for a real loss to hide in. The climb back
      // to 85 is a register row in `07-roadmap.md`.
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 81.8,
        statements: 90,
      },
    },
  },
});
