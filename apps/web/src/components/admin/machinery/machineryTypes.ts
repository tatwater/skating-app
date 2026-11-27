import type { api } from '@skating/convex/api';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';

/**
 * **Machinery's reads, as the page holds them** — derived from the published functions
 * (`packages/convex/convex/machineryRuns.ts`, a contract), so the page can't drift from what the
 * server returns. Every Machinery file reads its server shapes from here.
 */

/** `machineryRuns.lanes`: the sidebar's tail, one entry per built page. */
export type MachineryLanesView = FunctionReturnType<typeof api.machineryRuns.lanes>;
/** One lane's tail. */
export type LaneTailView = MachineryLanesView['corpus'];

/** `machineryRuns.listPage`: one page of a lane's runs. */
export type RunListPage = FunctionReturnType<typeof api.machineryRuns.listPage>;
export type RunListArgs = FunctionArgs<typeof api.machineryRuns.listPage>;
/** One row of the run list: a campaign, or a pass listed on its own. */
export type RunRowView = RunListPage['page'][number];

/** `machineryRuns.campaign`: the campaign page, or `null` for none. */
export type CampaignRead = FunctionReturnType<typeof api.machineryRuns.campaign>;
export type CampaignPageView = NonNullable<CampaignRead>;

/** `machineryRuns.run`: one run, or `null` for none. */
export type RunRead = FunctionReturnType<typeof api.machineryRuns.run>;
export type RunPageView = NonNullable<RunRead>;

/** A run's liveness, core's union as the server returns it. */
export type LivenessView = RunRowView['liveness'];

/**
 * **Whether a campaign row was rebuilt from its runs** (the founder's ruling for campaigns from
 * before Machinery kept their own record: a server backfill stores a reconstructed row for each).
 * The one place the page reads it, so the flag's final name moves here alone: the stored
 * `reconstructed` when the view carries it, else the view's `recorded: false` (a campaign row with
 * no record of its own).
 */
export function isRebuilt(row: RunRowView): boolean {
  if (row.kind !== 'campaign' || row.line.kind !== 'campaign') return false;
  const flagged = row as RunRowView & { reconstructed?: unknown };
  const line = row.line as typeof row.line & { reconstructed?: unknown };
  if (flagged.reconstructed === true || line.reconstructed === true) return true;
  return !row.line.recorded;
}
