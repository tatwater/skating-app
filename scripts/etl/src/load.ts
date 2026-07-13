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
 *   pnpm --filter @skating/etl load <bodies.ndjson> [--prod]
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import process from 'node:process'

/**
 * Batches are bounded by two Convex/OS limits:
 *
 *  1. **Reads per mutation (the binding one): Convex caps a single mutation at 4096 document
 *     reads.** Each body's geospatial `.insert()` in `importCanonical` reads several S2-cell
 *     docs, and that cost *grows with the index size* — so a batch that's fine against an empty
 *     index blows the limit once tens of thousands of bodies are indexed. `MAX_BATCH_COUNT`
 *     keeps a batch's total reads well under 4096 even at full-corpus index size (~15–20
 *     reads/body × 150 ≈ a few thousand, with headroom).
 *  2. **ARG_MAX:** `convex run` takes its args only as an inline JSON string (macOS ARG_MAX
 *     ≈ 1 MiB for the whole argv+env). `MAX_BATCH_BYTES` keeps a batch's serialized args well
 *     under that; Lake Champlain (~0.3 MiB simplified) is the only body that ever nears a solo
 *     batch, and the oversized-single-line guard admits it regardless.
 */
const MAX_BATCH_COUNT = 150
const MAX_BATCH_BYTES = 512 * 1024

/** Group NDJSON lines into batches under both the count and byte budgets. */
function chunk(lines: string[]): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let size = 0
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line) + 1
    const full = current.length >= MAX_BATCH_COUNT || size + lineBytes > MAX_BATCH_BYTES
    if (current.length > 0 && full) {
      batches.push(current)
      current = []
      size = 0
    }
    current.push(line)
    size += lineBytes
  }
  if (current.length > 0) batches.push(current)
  return batches
}

function runImport(bodies: unknown[]): { inserted: number; updated: number } {
  const args = JSON.stringify({ bodies })
  const stdout = execFileSync(
    'pnpm',
    ['--filter', '@skating/convex', 'exec', 'convex', 'run', 'waterBodies:importCanonical', args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 },
  )
  // convex run pretty-prints the function's return value as a multi-line JSON object on stdout
  // (function logs go to the inherited stderr). Parse it; fall back to the last {...} block if
  // anything else slipped onto stdout. Anything we can't read as {inserted, updated} is a hard
  // error — the mutation may well have committed, so reporting zeroes would mislead the operator.
  const trimmed = stdout.trim()
  const candidate = trimmed.startsWith('{') ? trimmed : trimmed.match(/\{[\s\S]*\}/)?.[0]
  const parsed: unknown = candidate ? JSON.parse(candidate) : undefined
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { inserted?: unknown }).inserted !== 'number' ||
    typeof (parsed as { updated?: unknown }).updated !== 'number'
  ) {
    throw new Error(`convex run returned an unexpected response: ${trimmed || '(empty)'}`)
  }
  return parsed as { inserted: number; updated: number }
}

/**
 * Best-effort read of the Convex deployment `convex run` will target, mirroring the CLI's
 * resolution order: a `CONVEX_DEPLOY_KEY` (points anywhere — treated as non-dev so it needs
 * opt-in), then `CONVEX_DEPLOYMENT` in the env, then the convex package's `.env.local`.
 */
function resolveDeployment(): { label: string; isDev: boolean } {
  if (process.env.CONVEX_DEPLOY_KEY)
    return { label: 'CONVEX_DEPLOY_KEY (target unknown)', isDev: false }
  let deployment = process.env.CONVEX_DEPLOYMENT
  if (!deployment) {
    try {
      const envLocal = readFileSync(
        new URL('../../../packages/convex/.env.local', import.meta.url),
        'utf8',
      )
      deployment = envLocal.match(/^CONVEX_DEPLOYMENT=(.+)$/m)?.[1]?.trim()
    } catch {
      // no .env.local reachable — fall through to unknown (treated as non-dev)
    }
  }
  if (!deployment) return { label: 'unknown', isDev: false }
  return { label: deployment, isDev: deployment.startsWith('dev:') }
}

function main(): void {
  const args = process.argv.slice(2)
  const allowNonDev = args.includes('--prod')
  const inputPath = args.find((arg) => !arg.startsWith('--'))
  if (!inputPath) {
    process.stderr.write('usage: pnpm --filter @skating/etl load <bodies.ndjson> [--prod]\n')
    process.exit(1)
  }

  // Dev-first (settled note): refuse a non-dev target unless the operator explicitly opts in,
  // so the normal command can never upsert the extract into production by accident.
  const target = resolveDeployment()
  process.stderr.write(`[etl] target deployment: ${target.label}\n`)
  if (!target.isDev && !allowNonDev) {
    process.stderr.write(
      '[etl] refusing: target is not a dev deployment. Confirm, then re-run with --prod to override.\n',
    )
    process.exit(1)
  }

  const lines = readFileSync(inputPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const batches = chunk(lines)
  process.stderr.write(`[etl] loading ${lines.length} bodies in ${batches.length} batch(es)…\n`)

  let inserted = 0
  let updated = 0
  let applied = 0
  try {
    for (const [index, batch] of batches.entries()) {
      const result = runImport(batch.map((line) => JSON.parse(line)))
      inserted += result.inserted
      updated += result.updated
      applied++
      process.stderr.write(`[etl] batch ${index + 1}/${batches.length} done\n`)
    }
  } catch (err) {
    // A batch threw; earlier batches are already committed. Report progress so the operator
    // can recover (a re-run is safe — importCanonical upserts idempotently) before rethrowing.
    process.stderr.write(
      `[etl] FAILED on batch ${applied + 1}/${batches.length}; ${applied} batch(es) applied ` +
        `(${inserted} inserted · ${updated} updated). Re-running is safe (idempotent upsert).\n`,
    )
    throw err
  }
  process.stderr.write(`[etl] load complete: ${inserted} inserted · ${updated} updated\n`)
}

main()
