/**
 * **Where a stage's run rows may go** (B05 §2.6, §3.1) — the one rule every stage CLI and
 * `run-aerial.sh` apply before they write anything:
 *
 * - **a pilot** (`--pilot`) writes its rows to a throwaway local backend only — a `local:` or
 *   `anonymous:` deployment (`convex dev --local`) — never dev, never prod, never a deploy key whose
 *   target can't be known (G-8 a);
 * - **a build** writes them to dev only (the founder, F-4 a: dev only; prod has never been
 *   initialized), and an unknown target is refused rather than guessed, as `resolveDeployment`'s
 *   dev-first guard does.
 *
 * A dry run writes no row and needs no target; the callers skip this check for one.
 */

import type { resolveDeployment } from '@skating/run-log';

/** Where `convex run` will write (run-log exports the resolver, not its type). */
export type DeploymentTarget = ReturnType<typeof resolveDeployment>;

/** A refusal of the run rows' target: nothing has been written. */
export class RunTargetRefusal extends Error {
  override name = 'RunTargetRefusal';
}

/** Is this a throwaway local backend (`convex dev --local`, or an anonymous one)? */
export function isLocalTarget(target: Pick<DeploymentTarget, 'label'>): boolean {
  return /^(local|anonymous):/.test(target.label);
}

const describe = (target: DeploymentTarget): string =>
  target.isProd ? 'prod' : target.isDev ? 'dev' : JSON.stringify(target.label);

/** Refuse a target this run's rows may not reach (see the file's comment). */
export function checkRunTarget(pilot: string | null, target: DeploymentTarget): void {
  if (pilot !== null) {
    if (!isLocalTarget(target)) {
      throw new RunTargetRefusal(
        `a pilot writes its run rows to a local deployment only; this one targets ${describe(target)}`,
      );
    }
    return;
  }
  if (target.isProd) {
    throw new RunTargetRefusal('the summer aerial is built for dev only; this one targets prod');
  }
  if (!target.isDev) {
    throw new RunTargetRefusal(
      `a build writes its run rows to dev only; this one targets ${describe(target)}`,
    );
  }
}
