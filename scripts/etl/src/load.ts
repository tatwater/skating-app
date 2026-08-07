/**
 * ETL loader (glue). Chunks canonical-body NDJSON into the internal
 * `waterBodies.importCanonical` mutation via the Convex CLI (`pnpm exec convex run`).
 *
 * `importCanonical` is an `internalMutation` (never client-callable); the CLI invokes it with
 * the deployment's admin credentials from `packages/convex/.env.local`. Loads the **dev**
 * deployment (settled: dev first, confirm it renders, only then prod) — it refuses a non-dev
 * target unless `--prod` is passed. Thin subprocess + file I/O — excluded from coverage; all
 * real work is in the tested transform.
 *
 *   pnpm --filter @skating/etl load <bodies.ndjson> [--state=XX] [--prod]
 *     [--campaign=<id>] [--label=<text>] [--manifest=<manifest.json>]
 *     [--transform-summary=<run.json>] [--filter-command=<text>] [--no-run-log]
 *
 * The second row of flags is the run history (N6c F2): the loader writes one `importRuns` row
 * carrying the **whole path** — the archived extract's URL/checksum/build date, the `osmium`
 * filter, the transform's own summary and itemized skips, and its own batch outcomes — so an
 * admin can answer "how did the last import go" and "which features did it decline" without
 * re-running it. `--no-run-log` opts out; nothing else about the load changes.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

import { isKnownStateCode, KNOWN_STATE_CODES } from '@skating/core';
import {
  convexRun,
  type ExtractManifest,
  extractStage,
  RunLogger,
  type RunStage,
  resolveDeployment,
} from '@skating/run-log';

/**
 * Batches are bounded by two Convex/OS limits:
 *
 *  1. **Reads per mutation: Convex caps a single mutation at 4096 document reads.** This used to
 *     be the binding constraint — each body's geospatial `.insert()` read ~15–20 S2-cell docs,
 *     a cost that *grew with the index size*, so a batch fine against an empty index blew the
 *     limit once tens of thousands of bodies were indexed. Since N1 a body costs one `by_body`
 *     lookup plus ≤ 4 cell writes, flat regardless of corpus size, so `MAX_BATCH_COUNT` now has
 *     enormous headroom here; ARG_MAX below is what actually binds.
 *  2. **ARG_MAX:** `convex run` takes its args only as an inline JSON string (macOS ARG_MAX
 *     ≈ 1 MiB for the whole argv+env). `MAX_BATCH_BYTES` keeps a batch's serialized args well
 *     under that; Lake Champlain (~0.3 MiB simplified) is the only body that ever nears a solo
 *     batch, and the oversized-single-line guard admits it regardless.
 */
const MAX_BATCH_COUNT = 150;
const MAX_BATCH_BYTES = 512 * 1024;

/** Group NDJSON lines into batches under both the count and byte budgets. */
function chunk(lines: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line) + 1;
    const full = current.length >= MAX_BATCH_COUNT || size + lineBytes > MAX_BATCH_BYTES;
    if (current.length > 0 && full) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += lineBytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * How many batches may fail back-to-back before the load gives up.
 *
 * A single bad batch is worth surviving: at ~150 bodies a batch, a five-state run is hundreds of
 * `convex run` calls and thirty-odd minutes, and dying at batch 700 over one malformed body throws
 * away everything after it for nothing (the upsert is idempotent, so the work is not *lost* — but
 * the wall clock is). A *streak* of failures is different: that is a schema mismatch or a dead
 * deployment, and grinding through 600 more doomed batches would turn a clear error into a slow
 * one. Isolated failures are recorded on the run row and the load continues; a streak aborts.
 */
const MAX_CONSECUTIVE_BATCH_FAILURES = 5;

interface ImportResult {
  inserted: number;
  updated: number;
  /** Ambiguous identity, flagged for the D36 queue rather than merged (N7 / D93). */
  queuedForMerge: number;
  /** One id resolving to two rows, or a record carrying no id at all. */
  conflicts: number;
  unresolved: { externalId: string; action: string; reason: string }[];
}

function runImport(
  bodies: unknown[],
  state: string | undefined,
  campaignId: string | undefined,
): ImportResult {
  // Anything we can't read as the expected shape is a hard error — the mutation may well have
  // committed, so reporting zeroes would mislead the operator.
  //
  // `campaignId` rides along because step 6's prune keys on it: a row this load did not touch is a
  // row the master list did not contain, and that is the only question that can find a stored body
  // the new rules refuse. Passing it here rather than deriving it server-side keeps "which campaign
  // was this?" a statement the operator makes once, on the command line, for every pass at once.
  const parsed = convexRun<unknown>('waterBodies:importCanonical', {
    bodies,
    ...(state ? { state } : {}),
    ...(campaignId ? { campaignId } : {}),
  });
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { inserted?: unknown }).inserted !== 'number' ||
    typeof (parsed as { updated?: unknown }).updated !== 'number'
  ) {
    throw new Error(`convex run returned an unexpected response: ${JSON.stringify(parsed)}`);
  }
  const r = parsed as Partial<ImportResult> & { inserted: number; updated: number };
  return {
    inserted: r.inserted,
    updated: r.updated,
    queuedForMerge: r.queuedForMerge ?? 0,
    conflicts: r.conflicts ?? 0,
    unresolved: r.unresolved ?? [],
  };
}

/** Read a JSON sidecar (an extract manifest, a transform summary), or `undefined` if unreadable. */
function readJson<T>(path: string | undefined, what: string): T | undefined {
  if (!path) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    // A missing sidecar costs provenance, never the import — warn and carry on with a hole in the
    // path, which is more honest than refusing to load because the bookkeeping was incomplete.
    process.stderr.write(
      `[etl] could not read ${what} at ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return undefined;
  }
}

/**
 * The first body's `externalId` in a batch, for naming a failed batch on the run row.
 *
 * Defensive to the point of paranoia because it runs **inside a catch block**: a throw here would
 * replace the batch's real error with a parse error about the bookkeeping, losing the diagnosis.
 */
function firstExternalId(batch: string[]): string | undefined {
  const first = batch[0];
  if (first === undefined) return undefined;
  try {
    return (JSON.parse(first) as { externalId?: string }).externalId;
  } catch {
    return undefined;
  }
}

/** The transform's `--summary=` sidecar (see `cli.ts`). */
interface TransformSummaryFile {
  input?: string;
  output?: string;
  total?: number;
  imported?: number;
  droppedByType?: number;
  droppedByAreaFloor?: number;
  skipped?: number;
  depthsTagged?: number;
  densestRing?: { externalId: string; name?: string; vertices: number; cap: number };
  errors?: { externalId?: string; message: string }[];
}

function main(): void {
  const args = process.argv.slice(2);
  const allowNonDev = args.includes('--prod');
  // `--state=XX` (2-letter code) tags the batch's bodies with their source region; unioned into each
  // body's `states` so a border-spanning body imported from several state extracts accumulates them
  // all (Phase 2.5). Equals-form so it doesn't look like the positional input path.
  const state = args
    .find((arg) => arg.startsWith('--state='))
    ?.slice('--state='.length)
    .toUpperCase();
  const flag = (name: string) =>
    args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const campaignId = flag('campaign');
  const label = flag('label');
  const manifestPath = flag('manifest');
  const transformSummaryPath = flag('transform-summary');
  const filterCommand = flag('filter-command');
  const runLogEnabled = !args.includes('--no-run-log');

  const inputPath = args.find((arg) => !arg.startsWith('--'));
  if (!inputPath) {
    process.stderr.write(
      'usage: pnpm --filter @skating/etl load <bodies.ndjson> [--state=XX] [--prod]\n' +
        '       [--campaign=<id>] [--label=<text>] [--manifest=<manifest.json>]\n' +
        '       [--transform-summary=<run.json>] [--filter-command=<text>] [--no-run-log]\n',
    );
    process.exit(1);
  }

  // Guard the region tag: a typo (`--state=VE`, `--state=VERMONT`) would silently union a bad code
  // into every body's `states`, corrupting the state label + boost-seed disambiguation for the run.
  // Fail before any write rather than let it reach importCanonical (Phase 2.5 review).
  if (state !== undefined && !isKnownStateCode(state)) {
    process.stderr.write(
      `[etl] refusing: unknown --state=${state}. Expected one of: ${KNOWN_STATE_CODES.join(', ')}.\n`,
    );
    process.exit(1);
  }

  // Dev-first (settled note): refuse a non-dev target unless the operator explicitly opts in,
  // so the normal command can never upsert the extract into production by accident.
  const target = resolveDeployment();
  process.stderr.write(`[etl] target deployment: ${target.label}\n`);
  if (!target.isDev && !allowNonDev) {
    process.stderr.write(
      '[etl] refusing: target is not a dev deployment. Confirm, then re-run with --prod to override.\n',
    );
    process.exit(1);
  }

  const lines = readFileSync(inputPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const batches = chunk(lines);
  process.stderr.write(
    `[etl] loading ${lines.length} bodies in ${batches.length} batch(es)` +
      `${state ? ` (state: ${state})` : ''}…\n`,
  );

  // ---- Run history (N6c F2) -------------------------------------------------------------------
  // Assembled before the first batch so a killed process still leaves a row naming what it was
  // doing. Everything here is best-effort: `RunLogger` swallows its own failures by design.
  const manifest = readJson<ExtractManifest>(manifestPath, 'extract manifest');
  const transform = readJson<TransformSummaryFile>(transformSummaryPath, 'transform summary');

  const stages: RunStage[] = [];
  if (manifest) stages.push(extractStage(manifest));
  if (filterCommand) {
    stages.push({
      name: 'filter',
      detail:
        'osmium tags-filter + export — a superset of what we import; the transform classifies',
      command: filterCommand,
      output: transform?.input,
      counts:
        transform?.total === undefined
          ? undefined
          : [{ name: 'polygonFeatures', value: transform.total }],
    });
  }
  if (transform) {
    stages.push({
      name: 'transform',
      detail:
        'classify, apply the surface-area floor, simplify to ~5 m (D48), measure shoreline/axes/' +
        'fetch on the source geometry (D85)',
      input: transform.input,
      output: transform.output ?? inputPath,
      counts: [
        { name: 'features', value: transform.total ?? 0 },
        { name: 'imported', value: transform.imported ?? 0 },
        { name: 'droppedByType', value: transform.droppedByType ?? 0 },
        // Named even when the sidecar predates the floor (⇒ 0): a run row that doesn't say how many
        // bodies the floor removed can't be told apart from one where the floor wasn't applied.
        { name: 'droppedByAreaFloor', value: transform.droppedByAreaFloor ?? 0 },
        { name: 'skipped', value: transform.skipped ?? 0 },
        { name: 'osmDepthTagged', value: transform.depthsTagged ?? 0 },
        ...(transform.densestRing
          ? [{ name: 'densestRingVertices', value: transform.densestRing.vertices }]
          : []),
      ],
    });
  }

  const logger = new RunLogger({
    kind: 'canonical_water',
    label: label ?? `${state ?? 'unscoped'} canonical water`,
    campaignId,
    target,
    stages,
    call: convexRun,
    notes: transform?.densestRing
      ? [
          `densest ring: ${transform.densestRing.externalId} "${transform.densestRing.name ?? ''}" — ` +
            `${transform.densestRing.vertices} vertices (cap ${transform.densestRing.cap})`,
        ]
      : undefined,
  });
  if (runLogEnabled) logger.start();

  // The transform's own skips are failures of this run, itemized — they are the features that
  // silently never became lakes, and until now they scrolled past in a terminal.
  for (const err of transform?.errors ?? []) {
    logger.fail({ stage: 'transform', key: err.externalId, reason: err.message });
  }

  let inserted = 0;
  let updated = 0;
  let queuedForMerge = 0;
  let conflicts = 0;
  let applied = 0;
  let failedBatches = 0;
  let bodiesInFailedBatches = 0;
  let consecutiveFailures = 0;
  let aborted: Error | undefined;

  for (const [index, batch] of batches.entries()) {
    try {
      const result = runImport(
        batch.map((line) => JSON.parse(line)),
        state,
        campaignId,
      );
      inserted += result.inserted;
      updated += result.updated;
      queuedForMerge += result.queuedForMerge;
      conflicts += result.conflicts;
      // **An ambiguous identity is a failure of this run, itemized.** It is not a batch error — the
      // other 149 bodies loaded — but it is a body that did not land, and the whole point of the
      // ledger is that those stop scrolling past in a terminal.
      for (const u of result.unresolved) {
        logger.fail({
          stage: 'load',
          key: u.externalId,
          reason: `${u.action}: ${u.reason}`,
        });
      }
      applied++;
      consecutiveFailures = 0;
      process.stderr.write(`[etl] batch ${index + 1}/${batches.length} done\n`);
    } catch (err) {
      failedBatches++;
      bodiesInFailedBatches += batch.length;
      consecutiveFailures++;
      const message = err instanceof Error ? err.message : String(err);
      // Name the batch by its first body, so "which lakes did it decline" has an answer that
      // survives the run — a bare batch index is meaningless once the scratch files are gone.
      const firstId = firstExternalId(batch);
      logger.fail({
        stage: 'load',
        key: `batch ${index + 1}/${batches.length} (from ${firstId ?? 'unknown'}, ${batch.length} bodies)`,
        reason: message,
      });
      process.stderr.write(
        `[etl] batch ${index + 1}/${batches.length} FAILED (${consecutiveFailures} in a row): ${message}\n`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_BATCH_FAILURES) {
        aborted = err instanceof Error ? err : new Error(message);
        break;
      }
    }

    if ((index + 1) % 25 === 0) {
      logger.count('inserted', inserted);
      logger.count('updated', updated);
      logger.count('batchesApplied', applied);
      logger.count('batchesFailed', failedBatches);
      logger.flush();
    }
  }

  logger.count('bodiesRead', lines.length);
  logger.count('batchesTotal', batches.length);
  logger.count('batchesApplied', applied);
  logger.count('batchesFailed', failedBatches);
  logger.count('inserted', inserted);
  logger.count('updated', updated);
  logger.count('queuedForMerge', queuedForMerge);
  logger.count('conflicts', conflicts);
  // The denominator is the *polygon features the filter emitted*, not the bodies the transform
  // kept — otherwise "dropped as a river" disappears from the ledger and the pass looks perfect.
  const featuresIn = transform?.total ?? lines.length;
  logger.coverage({
    unit: 'polygon features',
    eligible: featuresIn,
    covered: inserted + updated,
    omissions: [
      {
        reason: 'not still water (river, stream, generic wetland) — dropped by the classifier',
        count: transform?.droppedByType ?? 0,
      },
      { reason: 'threw during transform (see failures)', count: transform?.skipped ?? 0 },
      { reason: 'in a batch that failed and was skipped', count: bodiesInFailedBatches },
      {
        reason: 'ambiguous identity — two ids resolved to two rows, queued for the dedup review',
        count: queuedForMerge,
      },
      {
        reason: 'identity conflict — an id resolves to two rows, or no id at all',
        count: conflicts,
      },
    ].filter((o) => o.count > 0),
  });
  logger.stage({
    name: 'load',
    detail:
      'waterBodies:importCanonical — idempotent upsert keyed on the catalogue ids (D93), ' +
      'cell-indexed (N1); merge/conflict verdicts are queued, never performed',
    input: inputPath,
    output: target.label,
    counts: [
      { name: 'batchesApplied', value: applied },
      { name: 'batchesFailed', value: failedBatches },
      { name: 'inserted', value: inserted },
      { name: 'updated', value: updated },
      { name: 'queuedForMerge', value: queuedForMerge },
      { name: 'conflicts', value: conflicts },
    ],
  });

  if (aborted) {
    process.stderr.write(
      `[etl] ABORTED after ${MAX_CONSECUTIVE_BATCH_FAILURES} consecutive batch failures; ` +
        `${applied}/${batches.length} batch(es) applied (${inserted} inserted · ${updated} updated). ` +
        'Re-running is safe (idempotent upsert).\n',
    );
    logger.failed(aborted);
    throw aborted;
  }

  const declined = logger.totalFailures;
  process.stderr.write(
    `[etl] load complete: ${inserted} inserted · ${updated} updated` +
      `${queuedForMerge > 0 ? ` · ${queuedForMerge} queued for dedup review` : ''}` +
      `${conflicts > 0 ? ` · ${conflicts} identity conflict(s)` : ''}` +
      `${failedBatches > 0 ? ` · ${failedBatches} batch(es) failed and were skipped` : ''}` +
      `${declined > 0 ? ` · ${declined} itemized failure(s) recorded` : ''}\n`,
  );
  // A run with skipped batches did not succeed, even though it got to the end — saying otherwise on
  // the admin page is the exact dishonesty this table was built to remove.
  if (failedBatches > 0) {
    logger.failed(
      new Error(`${failedBatches} of ${batches.length} batches failed and were skipped`),
    );
    // **The one consequence that is not obvious from "some batches failed"** (N7 second audit).
    // Every body in a skipped batch is missing its `lastCampaignId` stamp, and step 6 deletes
    // precisely the rows that lack it — so a partial load followed by a prune deletes real lakes
    // that were never refused by any rule. `pruneNotInCampaign` has a blast-radius guard for the
    // gross case; this is the specific warning, at the moment the operator can still act on it.
    process.stderr.write(
      `[etl] ⚠ DO NOT RUN waterBodies:pruneNotInCampaign after this load. ` +
        `${bodiesInFailedBatches} bodies in ${failedBatches} skipped batch(es) carry no ` +
        `lastCampaignId, and the prune would delete them as "not in the master list". ` +
        `Re-run this load (the upsert is idempotent) until it reports zero failed batches.\n`,
    );
    process.exitCode = 1;
  } else {
    logger.succeed();
  }
}

main();
