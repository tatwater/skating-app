/**
 * Which Convex deployment `convex run` will target.
 *
 * Lifted out of `scripts/etl/src/load.ts`, where it was written for the ETL's dev-first guard and
 * then copied by nobody — the other four loaders each grew their own partial version. It belongs
 * here for a second reason now: an `importRuns` row records the target verbatim, and a run history
 * that mislabels which deployment it wrote to is worse than no run history.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

export interface DeploymentTarget {
  /** Recorded verbatim on the run row. */
  label: string;
  isDev: boolean;
  isProd: boolean;
}

/**
 * Mirror the CLI's resolution order: a `CONVEX_DEPLOY_KEY` (points anywhere), then
 * `CONVEX_DEPLOYMENT` in the env, then the convex package's `.env.local`.
 *
 * **An unknown target is treated as non-dev**, so the dev-first guard fails closed: the cost of
 * being wrong in that direction is one extra `--prod` flag, and in the other direction it is an
 * OSM extract upserted into production.
 *
 * `convexPackageDir` is injectable so this is testable without a repo layout.
 */
export function resolveDeployment(convexPackageDir?: URL): DeploymentTarget {
  if (process.env.CONVEX_DEPLOY_KEY)
    return { label: 'CONVEX_DEPLOY_KEY (target unknown)', isDev: false, isProd: false };

  let deployment = process.env.CONVEX_DEPLOYMENT;
  if (!deployment) {
    try {
      // Default: `packages/convex/` relative to this file at `scripts/run-log/src/`.
      const dir = convexPackageDir ?? new URL('../../../packages/convex/', import.meta.url);
      const envLocal = readFileSync(new URL('.env.local', dir), 'utf8');
      // `convex dev` writes a trailing `# team: …, project: …` comment on this line. Strip it:
      // it is not part of the deployment name, and left in it becomes the label on every run row.
      deployment = envLocal
        .match(/^CONVEX_DEPLOYMENT=(.+)$/m)?.[1]
        ?.replace(/\s+#.*$/, '')
        .trim();
    } catch {
      // no .env.local reachable — fall through to unknown (treated as non-dev)
    }
  }
  if (!deployment) return { label: 'unknown', isDev: false, isProd: false };
  return {
    label: deployment,
    isDev: deployment.startsWith('dev:'),
    isProd: deployment.startsWith('prod:'),
  };
}
