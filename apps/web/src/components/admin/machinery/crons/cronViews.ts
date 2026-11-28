import type { api } from '@skating/convex/api';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';

/**
 * **The crons' reads, as the cron pieces hold them** — derived from the published functions
 * (`packages/convex/convex/machineryCrons.ts`, a contract), so the card, the strip and the drawer
 * can't drift from what the server returns.
 */

/** `machineryCrons.jobs`: one cron's card — its schedule, its verdict and the verdict's inputs. */
export type CronJobView = FunctionReturnType<typeof api.machineryCrons.jobs>[number];

/** A cron's last run, as its card reads it. */
export type CronLastRun = CronJobView['lastRun'];

/** `machineryCrons.strip`: a cron's ticks over a range, oldest first. */
export type CronStripView = FunctionReturnType<typeof api.machineryCrons.strip>;
/** One tick: when, its outcome's code (core's `CRON_TICK_CODES`), and how long (`null`: a mutation job). */
export type CronTickView = CronStripView['ticks'][number];

/** `machineryCrons.runsPage`: a page of a cron's runs, newest first. */
export type CronRunsPage = FunctionReturnType<typeof api.machineryCrons.runsPage>;
export type CronRunsArgs = FunctionArgs<typeof api.machineryCrons.runsPage>;
/** One run: a tick that did work or failed. */
export type CronRunView = CronRunsPage['page'][number];
/** The runs list's read filter: every run, or the failed ones. */
export type CronRunsFilter = CronRunsArgs['filter'];

/** `machineryCrons.runLog`: a page of one run's lines, newest first. */
export type CronRunLogPage = FunctionReturnType<typeof api.machineryCrons.runLog>;
/** One line of a run's log. */
export type CronLogLineView = CronRunLogPage['page'][number];

/** The runs list's page (the read's bound): 25. */
export const CRON_RUNS_PAGE = 25;
/** A run log's page (the read's bound): 200. */
export const CRON_LOG_PAGE = 200;
