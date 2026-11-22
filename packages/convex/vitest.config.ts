import { defineConfig, type Plugin } from 'vitest/config';

/**
 * **The harness enforces the real backend's limits** (PR #170). Two rewrites of the inlined
 * `convex-test` bundle, test-only:
 *
 * - every `convexTest(...)` runs under Convex's default per-transaction limits (`transactionLimits:
 *   true` — documents and bytes read and written, index ranges, functions scheduled and their
 *   argument bytes, files), which `convex-test` leaves off unless a test asks; a function or fixture
 *   past one throws as the backend would;
 * - Convex's one-paginated-query rule, for mutations too. The real
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
 * - Convex's **8,192-item array cap** (B01-5d). The backend refuses any Convex value holding an array
 *   longer than 8,192 items — a document written (inserted, patched or replaced), a scheduled
 *   function's arguments, a function's arguments and its return value — "Array length is too long".
 *   `convex-test` checks none of them, so a fixture or a writer past it passed here and could never
 *   exist on a deployment (B01-5c's real-backend proof found heavy rings and tracks that couldn't).
 *   Every value is walked where `convex-test` writes a document (`_validate`, run before its schema
 *   check, so the system tables — `_scheduled_functions`' stored arguments — are walked too) and
 *   where it checks a registered function's arguments and its return value (a test's call and a
 *   nested `runQuery`/`runMutation` alike; `t.run`'s inline handler is neither, so it isn't walked).
 */
/** Convex's largest array, in items (`@skating/core`'s `CONVEX_ARRAY_LIMIT` says the same). */
const CONVEX_ARRAY_MAX = 8_192;

/**
 * The array-cap walker the transform puts in the bundle: every array in a Convex value, at any depth,
 * at most {@link CONVEX_ARRAY_MAX} items, else it throws the backend's words. Returns the value, so a
 * call site wraps an expression. A `Uint8Array`/`ArrayBuffer` is bytes, not a Convex array.
 */
const ARRAY_CAP_WALKER = `function __convexArrayCap(value, where) {
  const stack = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (v === null || typeof v !== "object" || v instanceof ArrayBuffer || ArrayBuffer.isView(v)) continue;
    if (Array.isArray(v)) {
      if (v.length > ${CONVEX_ARRAY_MAX}) {
        throw new Error("Array length is too long (" + v.length + " > maximum length ${CONVEX_ARRAY_MAX}), in " + where + " (the harness's array cap, vitest.config.ts)");
      }
      for (const x of v) stack.push(x);
    } else {
      for (const k in v) stack.push(v[k]);
    }
  }
  return value;
}`;

function singlePaginatePerMutation(): Plugin {
  const MUTATION_CTX = `udfType: "mutation",
            depth: (parentCtx?.depth ?? 0) + 1,
        };`;
  const THROW = `throw new Error("Only a single paginated query (\`.paginate()\`) is allowed per " +`;
  const LIMITS_OFF = `export function convexTest(schemaOrOptions, modules) {
    let schema = undefined;
    let limitsConfig = false;`;
  const LIMITS_ON = `export function convexTest(schemaOrOptions, modules) {
    let schema = undefined;
    let limitsConfig = true;`;
  // The array cap: a walker defined once beside the bundle's imports, called where a document is
  // validated and where a test's function call crosses the boundary (arguments in, result out).
  const IMPORTS_END = `import { TransactionMetricsTracker, } from "./transactionMetrics.js";`;
  const VALIDATE = `    _validate(tableName, doc) {
        if (this._schema === null || !this._schema.schemaValidation) {`;
  const ARGS =
    'function validateFunctionArgs(argsValidator, args, functionPath, allowPendingValues) {';
  const RESULT =
    'function validateReturnValue(returnsValidator, result, functionType, functionPath) {';
  return {
    name: 'convex-single-paginate-per-mutation',
    enforce: 'pre',
    transform(code, id) {
      if (!/convex-test[\\/]dist[\\/]index\.js$/.test(id)) return null;
      if (
        !code.includes(MUTATION_CTX) ||
        !code.includes(THROW) ||
        !code.includes(LIMITS_OFF) ||
        !code.includes(IMPORTS_END) ||
        !code.includes(VALIDATE) ||
        !code.includes(ARGS) ||
        !code.includes(RESULT)
      ) {
        throw new Error(
          'convex-test changed: the harness rules (one paginated query, the limits, the array cap) no longer apply; update them',
        );
      }
      return code
        .replace(
          IMPORTS_END,
          `${IMPORTS_END}
${ARRAY_CAP_WALKER}`,
        )
        .replace(
          VALIDATE,
          `    _validate(tableName, doc) {
        __convexArrayCap(doc, "a document in " + tableName);
        if (this._schema === null || !this._schema.schemaValidation) {`,
        )
        .replace(
          ARGS,
          `${ARGS}
    __convexArrayCap(args, "the arguments of " + functionPath.udfPath);`,
        )
        .replace(
          RESULT,
          `${RESULT}
    __convexArrayCap(result, "the return value of " + functionPath.udfPath);`,
        )
        .replace(LIMITS_OFF, LIMITS_ON)
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
