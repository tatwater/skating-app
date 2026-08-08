/**
 * Prune driver (glue) — brings a stored corpus into agreement with the D91 surface-area floor.
 *
 * The floor in `./transform` governs what a *future* import writes. It cannot reach rows already in
 * the database, because `importCanonical` upserts and never deletes — so a deployment loaded before
 * 2026-08-02 still holds the ~100,000 unnamed sub-five-acre bodies the transform would now skip.
 * This walks the table through `waterBodies:pruneBelowAreaFloor` and deletes exactly those.
 *
 *   pnpm --filter @skating/etl prune-floor              # DRY RUN — counts, writes nothing
 *   pnpm --filter @skating/etl prune-floor --apply      # actually delete (resumes if interrupted)
 *   pnpm --filter @skating/etl prune-floor --apply --restart   # ignore the checkpoint, start over
 *   pnpm --filter @skating/etl prune-floor --apply --prod
 *
 * **Dry by default and dev-only unless `--prod`**, the same two guards the loader has, for a
 * stronger reason: this is the one script in the ETL that destroys rows. An `--apply` run
 * checkpoints its cursor after every committed page, so a kill costs seconds rather than the whole
 * pass — see `CHECKPOINT`. The mutation decides what
 * is deletable (and refuses anything curated, delisted, merged, user-drawn or attached to a report,
 * hazard, bounty, favourite, put-in or track) — this only drives the cursor and reports.
 *
 * Thin subprocess + loop; excluded from coverage. The rule it enforces is tested in
 * `@skating/core`'s `meetsAreaFloor` and `waterBodies.pruneBelowAreaFloor`.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { MIN_SURFACE_AREA_ACRES } from '@skating/core';
import { convexRun, resolveDeployment } from '@skating/run-log';

/**
 * Where the cursor is checkpointed between pages.
 *
 * **Because this pass has already been killed once mid-run.** A forty-minute job holding its only
 * position in a local variable loses everything to a SIGTERM, and the restart is not free: the rows
 * it already deleted are gone, but re-reaching page 800 means re-reading the ~20,000 survivors ahead
 * of it at full row cost (polygons included). Deleting is idempotent, so resuming is purely an
 * optimisation — which is exactly why it should be automatic rather than something you remember.
 */
const CHECKPOINT = fileURLToPath(new URL('../.scratch/prune-cursor.json', import.meta.url));

interface Checkpoint {
  deployment: string;
  cursor: string;
  scanned: number;
  deleted: number;
  pages: number;
  kept: Record<string, number>;
  attachedBy: Record<string, number>;
}

function readCheckpoint(deployment: string): Checkpoint | undefined {
  if (!existsSync(CHECKPOINT)) return undefined;
  try {
    const saved = JSON.parse(readFileSync(CHECKPOINT, 'utf8')) as Checkpoint;
    // A cursor is meaningless against a different deployment — resuming across one would skip an
    // arbitrary prefix of a table it never scanned.
    if (saved.deployment !== deployment) {
      process.stderr.write(
        `[prune] ignoring checkpoint from a different deployment (${saved.deployment})\n`,
      );
      return undefined;
    }
    return saved;
  } catch {
    return undefined;
  }
}

/** One page's return from `waterBodies:pruneBelowAreaFloor`. */
interface PrunedPage {
  applied: boolean;
  scanned: number;
  deleted: number;
  kept: Record<string, number>;
  attachedBy: Record<string, number>;
  cursor: string;
  isDone: boolean;
}

/**
 * Bodies per mutation call. Each page reads whole rows *including polygons*, so the transaction's
 * byte budget binds long before its document count; 100 leaves room for a page that happens to hold
 * several large lakes.
 */
const BATCH_SIZE = 100;

/**
 * Pages between progress lines. A five-state corpus is ~1,200 pages, and a run that prints nothing
 * for twenty minutes is indistinguishable from a hung one.
 */
const PROGRESS_EVERY = 25;

function addInto(total: Record<string, number>, page: Record<string, number>): void {
  for (const [key, value] of Object.entries(page)) total[key] = (total[key] ?? 0) + value;
}

function summarize(counts: Record<string, number>): string {
  const entries = Object.entries(counts).filter(([, value]) => value > 0);
  if (entries.length === 0) return 'none';
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => `${key} ${value.toLocaleString()}`)
    .join(' · ');
}

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const allowNonDev = args.includes('--prod');

  const target = resolveDeployment();
  process.stderr.write(`[prune] target deployment: ${target.label}\n`);
  if (!target.isDev && !allowNonDev) {
    process.stderr.write(
      '[prune] refusing: target is not a dev deployment. Confirm, then re-run with --prod.\n',
    );
    process.exit(1);
  }
  process.stderr.write(
    apply
      ? `[prune] APPLYING the ${MIN_SURFACE_AREA_ACRES}-acre floor — unnamed bodies under it will be DELETED.\n`
      : `[prune] dry run (pass --apply to delete). Floor: named, or >= ${MIN_SURFACE_AREA_ACRES} acres.\n`,
  );

  // Resume where a killed run left off, unless told to start over. Only `--apply` runs checkpoint:
  // a dry run writes nothing, so resuming one would report a partial corpus as if it were the whole.
  const restart = args.includes('--restart');
  const saved = apply && !restart ? readCheckpoint(target.label) : undefined;
  if (saved) {
    process.stderr.write(
      `[prune] resuming from checkpoint: ${saved.scanned.toLocaleString()} scanned · ` +
        `${saved.deleted.toLocaleString()} deleted so far (--restart to start over)\n`,
    );
  }

  let cursor: string | undefined = saved?.cursor;
  let done = false;
  let pages = saved?.pages ?? 0;
  let scanned = saved?.scanned ?? 0;
  let deleted = saved?.deleted ?? 0;
  const kept: Record<string, number> = { ...(saved?.kept ?? {}) };
  const attachedBy: Record<string, number> = { ...(saved?.attachedBy ?? {}) };

  while (!done) {
    const page = convexRun<PrunedPage>('waterBodies:pruneBelowAreaFloor', {
      cursor,
      batchSize: BATCH_SIZE,
      apply,
    });
    cursor = page.cursor;
    done = page.isDone;
    pages++;
    scanned += page.scanned;
    deleted += page.deleted;
    addInto(kept, page.kept);
    addInto(attachedBy, page.attachedBy);

    // After the page commits, never before: a cursor written first would skip a page whose
    // transaction then failed. Cheap enough to do every page — the alternative is losing up to
    // `PROGRESS_EVERY` pages of position to save one small write per page.
    if (apply && !done) {
      mkdirSync(dirname(CHECKPOINT), { recursive: true });
      writeFileSync(
        CHECKPOINT,
        JSON.stringify(
          {
            deployment: target.label,
            cursor: page.cursor,
            scanned,
            deleted,
            pages,
            kept,
            attachedBy,
          } satisfies Checkpoint,
          null,
          2,
        ),
      );
    }

    if (pages % PROGRESS_EVERY === 0 || done) {
      process.stderr.write(
        `[prune] ${scanned.toLocaleString()} scanned · ` +
          `${deleted.toLocaleString()} ${apply ? 'deleted' : 'deletable'}\n`,
      );
    }
  }

  process.stderr.write(
    `\n[prune] ${apply ? 'DONE' : 'DRY RUN'} — ${scanned.toLocaleString()} bodies scanned in ` +
      `${pages.toLocaleString()} pages\n` +
      `[prune] ${deleted.toLocaleString()} ${apply ? 'deleted' : 'would be deleted'}\n` +
      `[prune] kept: ${summarize(kept)}\n`,
  );
  // Named separately because it is the interesting one: a sub-floor body someone has *used* is the
  // case the floor cannot see, and the count is what tells you whether the rule is too blunt.
  if (Object.keys(attachedBy).length > 0) {
    process.stderr.write(`[prune] kept-because-attached, by table: ${summarize(attachedBy)}\n`);
  }
  // The pass completed, so the checkpoint is now a lie waiting to be resumed from. Clear it.
  if (apply && existsSync(CHECKPOINT)) rmSync(CHECKPOINT);
  if (!apply && deleted > 0) {
    process.stderr.write('[prune] nothing was written. Re-run with --apply to delete.\n');
  }
}

main();
