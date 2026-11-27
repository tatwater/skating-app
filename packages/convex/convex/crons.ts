/**
 * Scheduled jobs (Convex crons), registered from the cron registry (D343, D347, B01-8b).
 *
 * Every job is an entry of `CRON_JOBS` in `cronJobs.ts` — its name, schedule, function, arguments
 * and the comment saying why it runs when it does. This file only registers each one against its
 * dispatcher (`cronRuns.tickMutation` for a mutation job, `cronRuns.tickAction` for an action job),
 * with `{ job: <name> }` as the argument, so every tick is recorded by one recorder and no job can
 * forget to. Add a cron by adding an entry there, never a `crons.interval` here: `cronJobs.test.ts`
 * fails on a registration that isn't an entry.
 */

import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';
import { CRON_JOBS, type CronJobEntry } from './cronJobs';

const crons = cronJobs();

/** Registers one entry against its dispatcher, on its schedule. */
function register(entry: CronJobEntry): void {
  const args = { job: entry.name };
  const dispatcher =
    entry.kind === 'mutation' ? internal.cronRuns.tickMutation : internal.cronRuns.tickAction;
  const { schedule } = entry;
  if ('every' in schedule) crons.interval(entry.name, schedule.every, dispatcher, args);
  else if ('daily' in schedule) crons.daily(entry.name, schedule.daily, dispatcher, args);
  else crons.weekly(entry.name, schedule.weekly, dispatcher, args);
}

for (const entry of CRON_JOBS) register(entry);

export default crons;
