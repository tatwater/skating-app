import { cronJobState, cronLiveness, foldCardState, worstCronJob } from '@skating/core';
import { describe, expect, test } from 'vitest';

import { IMAGERY_JOBS, NOW, STATE_JOBS } from '../crons/cronFixtures';
import { cronReading } from '../crons/cronModel';
import { cronStateAt, worstCron } from './imageryModel';
import { imageryRunHeadline } from './imageryWords';

/**
 * **One rule, every place a cron is drawn** (B01-8b-2): at the same `now`, the Overview's row (core's
 * `cronJobState`), the Imagery lane and head (`cronStateAt`, `worstCron`) and Machinery's own cron
 * card (`cronReading`) agree — the card alone drawing a cut-off run as its own state, which folds
 * back to the Overview's *failed*.
 */
describe('the card, the lane and the Overview agree', () => {
  const jobs = [...STATE_JOBS.map((s) => s.job), ...IMAGERY_JOBS];
  const moments = [NOW, NOW + 4 * 60_000, NOW + 40 * 60_000, NOW + 8 * 3_600_000];

  test.each(moments)('each cron at %i', (now) => {
    for (const job of jobs) {
      const overview = cronJobState(cronLiveness(job.inputs, job.schedule, now), job.lastRun);
      const card = cronReading(job, now).state;
      const lane = cronStateAt(job, now).state;
      expect(lane).toBe(overview);
      expect(foldCardState(card)).toBe(overview);
    }
  });

  test.each(moments)('the lane’s worst is the server’s rule at %i', (now) => {
    const expected = worstCronJob(
      IMAGERY_JOBS.map((j) => ({ liveness: cronReading(j, now).liveness, lastRun: j.lastRun })),
    );
    expect(worstCron(IMAGERY_JOBS, now)).toEqual(expected);
  });

  test('a cut-off run is the card’s own word, the Overview’s failed', () => {
    const killed = STATE_JOBS.find((s) => s.name === 'killed');
    expect(killed).toBeDefined();
    const job = (killed as (typeof STATE_JOBS)[number]).job;
    expect(cronReading(job, NOW).state).toBe('killed');
    expect(cronStateAt(job, NOW).state).toBe('failed');
  });
});

describe('what a run did, in the page’s words', () => {
  const run = (
    outcome: string,
    counts: Record<string, number> | null,
    detail: string | null = null,
  ) => ({
    outcome,
    counts,
    detail,
  });
  test('the poll, the pump and the index', () => {
    expect(imageryRunHeadline('poll', run('ok', { selected: 10, queued: 6 }))).toBe('6 new');
    expect(imageryRunHeadline('poll', run('ok', { selected: 3, queued: 0 }))).toBe('nothing new');
    expect(imageryRunHeadline('poll', run('capped', { queued: 200 }))).toBe(
      '200 new · stopped at its limit',
    );
    expect(imageryRunHeadline('pump', run('ok', { spawned: 1, landed: 2, empty: 1 }))).toBe(
      '1 starting · 2 landed · 1 nothing to cut',
    );
    expect(imageryRunHeadline('index', run('ok', { added: 1, frames: 9 }))).toBe('1 new frame');
    expect(imageryRunHeadline('index', run('ok', null))).toBe('nothing new');
  });
  test('a failed or cut-off run leaves its own error to speak; a turned-down one its sentence', () => {
    expect(imageryRunHeadline('pump', run('failed', { spawned: 1 }))).toBeNull();
    expect(imageryRunHeadline('pump', run('killed', null))).toBeNull();
    expect(imageryRunHeadline('pump', run('refused', null, 'Fly said no'))).toBe('Fly said no');
  });
});
