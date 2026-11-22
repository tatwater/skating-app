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

/**
 * **The harness counts what the real backend counts** (B01-5d, measured on a real backend): the
 * transaction limits `convex-test` enforces are only as true as what it counts, and it undercounted
 * the two that fail real merges. Measured per operation on a local backend (100 of each, one
 * transaction; `getTransactionMetrics`):
 *
 * | Operation | Index ranges | Documents read | Documents written |
 * |---|---|---|---|
 * | `get` | 1 | 1 | 0 |
 * | `patch` / `replace` / `delete` | 1 (it reads the row) | 1 | 1 (0 when a patch changes nothing) |
 * | `insert` | 0 | 0 | 1 |
 * | the same row read again (`get` then `patch`, two patches) | 0 more | 1 more each | 1 each |
 * | a query (`first`, `take`, `collect`) | 1 a distinct range; the same range again, 0 | each row scanned | 0 |
 * | a `.filter` query | 1 | **every row scanned**, kept or not | 0 |
 *
 * `convex-test` charged a range for a `get` and every query, but none for a `patch`, `replace` or
 * `delete`, charged the same range again each time it was read, and counted only the rows a filter
 * kept. So a merge that patched 3,900 rows passed here and failed there ("Too many reads ... 4096").
 * Now: a write's read takes its row's range; a range is charged once a transaction (a row by its id,
 * a query by its index and bounds — not its order, limit or filter), through nested calls; a filter's
 * rejected rows are read; and a patch or replace that changes nothing writes nothing.
 *
 * Calibrated against the real backend's own counts: a merge of 3,900 put-ins used 4,043 ranges and
 * of 1,800 favorites 3,743 (`harnessLimits.test.ts` holds the per-operation table and those two
 * merges' counts). **Not modeled:** the 1 s execution limit (no honest harness proxy), and a
 * backend's coalescing of adjacent new ids' ranges (a patch of a row inserted in the same transaction
 * measured 0.93 of a range; charged as 1 here, so the harness errs a hair conservative).
 */
/**
 * Ranges a registered function is charged before its handler runs (measured on a local backend: the
 * backend reads its module's code — 8 for a module importing nothing, 60 for one importing
 * `waterBodies`, 61 `unmerge`, 64 `corpusRequests`, 88 `moderation`, 89 `inboxWrites`, 93 `undo`,
 * 95 `inbox`). The harness can't see a bundle, so it charges the most measured, rounded up: never
 * more than 88 ranges (2% of the cap) earlier than the backend would fail.
 */
const START_RANGES = 96;

function realBackendCounts(): Plugin {
  const exact = (code: string, from: string, to: string, file: string) => {
    const n = code.split(from).length - 1;
    if (n !== 1) {
      throw new Error(
        `convex-test changed (${file}): the harness's real-backend counts no longer apply; update them`,
      );
    }
    return code.replace(from, to);
  };
  // **Read intervals, as the backend charges them** (measured): every read covers an interval of one
  // index — a `get` (or a write's read) the point of its row's id; a query its bounds up to the last key
  // it read, or its whole bounds once it runs out. A read is charged one range only where it reaches
  // outside the union of the intervals this transaction has already read on that index — so the same
  // row twice, a query repeated, or a narrower query inside a wider one costs nothing more.
  const rangeKey = `const __START_RANGES = ${START_RANGES};
function __chargeStart(tm) {
  const t = tm.getMetricsTracker();
  for (let i = 0; i < __START_RANGES; i++) t?.trackIndexRange();
}
const __QUERY_READS = new Map();
function __cmpKey(a, b) {
  const n = Math.max(a.vals.length, b.vals.length);
  for (let i = 0; i < n; i++) {
    const ai = i < a.vals.length, bi = i < b.vals.length;
    if (ai && bi) { const c = compareValues(a.vals[i], b.vals[i]); if (c !== 0) return c; continue; }
    if (!ai && !bi) break;
    if (!ai) return a.tail === 0 ? -1 : a.tail;
    return b.tail === 0 ? 1 : -b.tail;
  }
  return Math.sign(a.tail - b.tail);
}
function __indexFields(db, table, indexName) {
  if (indexName === "by_creation_time") return ["_creationTime", "_id"];
  if (indexName === "by_id") return ["_id"];
  const index = db._schema?.tables.get(table)?.indexes?.find((i) => i.indexDescriptor === indexName);
  return (index?.fields ?? []).concat(["_creationTime", "_id"]);
}
function __plan(db, query) {
  const s = query?.source ?? {};
  let table, indexName, range;
  if (s.type === "IndexRange") { [table, indexName] = s.indexName.split("."); range = s.range ?? []; }
  else { table = s.tableName ?? (s.indexName ?? "?").split(".")[0]; indexName = s.type === "Search" ? s.indexName : "by_creation_time"; range = []; }
  const fields = __indexFields(db, table, indexName);
  const eq = [];
  let lo = null, hi = null;
  for (const f of range) {
    const v = evaluateQueryValue(f.value);
    if (f.type === "Eq") eq.push(v);
    else if (f.type === "Gt") lo = { v, tail: 1 };
    else if (f.type === "Gte") lo = { v, tail: -1 };
    else if (f.type === "Lt") hi = { v, tail: -1 };
    else if (f.type === "Lte") hi = { v, tail: 1 };
  }
  return {
    index: table + "." + indexName,
    fields,
    desc: (s.order ?? "asc") === "desc",
    lower: lo ? { vals: [...eq, lo.v], tail: lo.tail } : { vals: eq, tail: -1 },
    upper: hi ? { vals: [...eq, hi.v], tail: hi.tail } : { vals: eq, tail: 1 },
  };
}
function __docKey(plan, doc) {
  return { vals: plan.fields.map((f) => evaluateFieldPath(f, doc)), tail: 0 };
}
function __reads(tracker) {
  const layer = tracker?._current?.();
  if (!layer) return null;
  layer.reads ??= new Map();
  return layer.reads;
}
// Each index's read intervals, sorted and disjoint (binary-searched: a read costs O(log n), not a
// scan of every interval read before), and the rows read by id as a set of points.
function __entry(reads, index) {
  let e = reads.get(index);
  if (!e) { e = { ivs: [], points: new Set() }; reads.set(index, e); }
  return e;
}
// The last interval starting at or before key, or -1.
function __floor(ivs, key) {
  let lo = 0, hi = ivs.length - 1, at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (__cmpKey(ivs[mid][0], key) <= 0) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return at;
}
function __covered(reads, index, key) {
  const e = reads.get(index);
  if (!e) return false;
  if (key.tail === 0 && key.vals.length === 1 && e.points.has(key.vals[0])) return true;
  const i = __floor(e.ivs, key);
  return i >= 0 && __cmpKey(key, e.ivs[i][1]) <= 0;
}
function __addInterval(reads, index, lo, hi) {
  if (__cmpKey(lo, hi) > 0) return;
  const ivs = __entry(reads, index).ivs;
  // Merge with every interval it touches: from the one at or before lo, through those starting by hi.
  let start = __floor(ivs, lo);
  if (start < 0 || __cmpKey(ivs[start][1], lo) < 0) start += 1;
  let end = start;
  let nlo = lo, nhi = hi;
  while (end < ivs.length && __cmpKey(ivs[end][0], hi) <= 0) {
    if (__cmpKey(ivs[end][0], nlo) < 0) nlo = ivs[end][0];
    if (__cmpKey(ivs[end][1], nhi) > 0) nhi = ivs[end][1];
    end++;
  }
  ivs.splice(start, end - start, [nlo, nhi]);
}
// A row read by id (a get, or a write's read): the point of its id on its table's by_id.
function __readPoint(tracker, table, id) {
  const reads = __reads(tracker);
  if (!reads) return tracker?.trackIndexRange();
  const index = table + ".by_id";
  const key = { vals: [id], tail: 0 };
  if (!__covered(reads, index, key)) tracker.trackIndexRange();
  __entry(reads, index).points.add(id);
}
// Whether a write changed the row: only the fields it set are compared (a patch), never the whole
// document serialized twice — the backend writes nothing for a write that changes nothing.
function __changed(before, after, keys) {
  if (!before || !after) return true;
  for (const k of keys) if (compareValues(before[k], after[k]) !== 0) return true;
  return false;
}
function __queryStart(tracker, db, queryId, query) {
  const reads = __reads(tracker);
  const plan = __plan(db, query);
  const start = plan.desc ? plan.upper : plan.lower;
  const st = { plan, charged: false, last: null };
  if (!reads || !__covered(reads, plan.index, start)) { tracker.trackIndexRange(); st.charged = true; }
  __QUERY_READS.set(queryId, st);
}
function __queryNext(tracker, queryId, doc) {
  const st = __QUERY_READS.get(queryId);
  const reads = __reads(tracker);
  if (!st || !reads) return;
  const { plan } = st;
  const reached = doc ? __docKey(plan, doc) : plan.desc ? plan.lower : plan.upper;
  if (!st.charged && !__covered(reads, plan.index, reached)) { tracker.trackIndexRange(); st.charged = true; }
  const start = plan.desc ? plan.upper : plan.lower;
  if (plan.desc) __addInterval(reads, plan.index, reached, start);
  else __addInterval(reads, plan.index, start, reached);
  if (!doc) __QUERY_READS.delete(queryId);
}`;
  return {
    name: 'convex-real-backend-counts',
    enforce: 'pre',
    transform(code, id) {
      if (/convex-test[\\/]dist[\\/]transactionMetrics\.js$/.test(id)) {
        let out = code;
        // A nested call reads through its caller's intervals (the backend charges a nested call's re-read
        // of a range its caller read nothing more): the child layer shares the parent's read set.
        out = exact(
          out,
          `    trackIndexRange() {
        const layer = this._current();
        if (layer === undefined) {
            return;
        }
        layer.metrics.databaseQueries += 1;`,
          `    trackIndexRange(key) {
        const layer = this._current();
        if (layer === undefined) {
            return;
        }
        if (key !== undefined) {
            layer.ranges ??= new Map();
            if (layer.ranges.has(key)) return;
            layer.ranges.set(key, true);
        }
        layer.metrics.databaseQueries += 1;`,
          'transactionMetrics.js',
        );
        out = exact(
          out,
          `            metrics: { ...parent.metrics },
            limits,`,
          `            metrics: { ...parent.metrics },
            reads: (parent.reads ??= new Map()),
            limits,`,
          'transactionMetrics.js',
        );
        out = exact(
          out,
          `            parent.metrics = { ...child.metrics };`,
          `            parent.metrics = { ...child.metrics };`,
          'transactionMetrics.js',
        );
        out = exact(
          out,
          `            for (const key of READ_METRIC_KEYS) {
                parent.metrics[key] = child.metrics[key];
            }`,
          `            for (const key of READ_METRIC_KEYS) {
                parent.metrics[key] = child.metrics[key];
            }
`,
          'transactionMetrics.js',
        );
        return out;
      }
      if (!/convex-test[\\/]dist[\\/]index\.js$/.test(id)) return null;
      let out = code;
      out = exact(
        out,
        `const MAX_SEARCH_CANDIDATE_REVISIONS = 1024;`,
        `const MAX_SEARCH_CANDIDATE_REVISIONS = 1024;
${rangeKey}`,
        'index.js',
      );
      // A registered function's start: the backend loads its module's code before the handler runs,
      // charging ranges for it (inline \`t.run\` handlers are fixtures, not functions).
      {
        const begin = `        await transactionManager.begin(isNested, transactionLimits);`;
        if (out.split(begin).length - 1 !== 2) {
          throw new Error(
            "convex-test changed (index.js): the harness's start cost no longer applies; update it",
          );
        }
        out = out.replaceAll(
          begin,
          `${begin}
        if (!isNested && functionPath.udfPath !== "inline") __chargeStart(transactionManager);`,
        );
      }
      // A filter's rejected rows are scanned, so read.
      out = exact(
        out,
        `        const filterFn = (doc) => filters.every((f) => evaluateFilter(doc, f));`,
        `        const filterFn = (doc) => {
            const kept = filters.every((f) => evaluateFilter(doc, f));
            if (!kept) getTransactionManager().getMetricsTracker()?.trackRead(getDocumentSize(doc));
            return kept;
        };`,
        'index.js',
      );
      // A query's range, once a transaction.
      out = exact(
        out,
        `                tracker?.trackIndexRange();
                const queryId = db.startQuery(query);
                return JSON.stringify({ queryId });`,
        `                const queryId = db.startQuery(query);
                if (tracker) __queryStart(tracker, db, queryId, query);
                return JSON.stringify({ queryId });`,
        'index.js',
      );
      out = exact(
        out,
        `                    tracker.trackIndexRange();
                    for (const doc of page) {`,
        `                    tracker.trackIndexRange();
                    for (const doc of page) {`,
        'index.js',
      );
      out = exact(
        out,
        `                const { value, done } = db.queryNext(args.queryId);`,
        `                const { value, done } = db.queryNext(args.queryId);
                if (tracker) __queryNext(tracker, args.queryId, done ? null : value);`,
        'index.js',
      );
      // A row's range, once a transaction — by a read or by a write's read.
      out = exact(
        out,
        `                tracker?.trackIndexRange();
                const doc = getAndTrack(table, id);`,
        `                if (tracker) __readPoint(tracker, table, id);
                const doc = getAndTrack(table, id);`,
        'index.js',
      );
      out = exact(
        out,
        `                const { table, id, value } = args;
                getAndTrack(table, id);
                db.patch(table, id, value);
                tracker?.trackWrite(getConvexSize(db.get(table, id)));`,
        `                const { table, id, value } = args;
                if (tracker) __readPoint(tracker, table, id);
                const __before = getAndTrack(table, id);
                db.patch(table, id, value);
                const __after = db.get(table, id);
                if (__changed(__before, __after, Object.keys(value))) tracker?.trackWrite(getConvexSize(__after));`,
        'index.js',
      );
      out = exact(
        out,
        `                const { table, id, value } = args;
                getAndTrack(table, id);
                db.replace(table, id, value);
                tracker?.trackWrite(getConvexSize(db.get(table, id)));`,
        `                const { table, id, value } = args;
                if (tracker) __readPoint(tracker, table, id);
                const __before = getAndTrack(table, id);
                db.replace(table, id, value);
                const __after = db.get(table, id);
                if (__changed(__before, __after, new Set([...Object.keys(__before ?? {}), ...Object.keys(__after ?? {})]))) tracker?.trackWrite(getConvexSize(__after));`,
        'index.js',
      );
      out = exact(
        out,
        `                const { table, id } = args;
                getAndTrack(table, id);
                db.delete(table, id);`,
        `                const { table, id } = args;
                if (tracker) __readPoint(tracker, table, id);
                getAndTrack(table, id);
                db.delete(table, id);`,
        'index.js',
      );
      return out;
    },
  };
}

export default defineConfig({
  plugins: [singlePaginatePerMutation(), realBackendCounts()],
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
     *
     * 60 s since the harness counts index ranges and documents read as the real backend does
     * (B01-5d). Its bookkeeping is cheap now — intervals binary-searched, a patch compared on the
     * fields it set: two workers with the web unit tests beside them, the suite took 112 s without
     * it, 136 s with the first cut, 122 s now. The limit stays for the heavy approvals the counting
     * made testable: 4–7 s each on that constrained run, so the slowest stays under a fifth of 60 s.
     */
    testTimeout: 60_000,
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
