import { describe, expect, it } from 'vitest';
import {
  cronCardState,
  cronJobAt,
  cronJobState,
  foldCardState,
  JOB_STATES,
  worstCronJob,
} from './cronJobState';
import type { CronLiveness } from './cronLiveness';

const T = 1_764_201_600_000;
const tick = (state: 'ok' | 'failed' | 'late' | 'stalled'): CronLiveness => ({
  state,
  lastTickAt: T,
  quietMs: 0,
  expectedMs: 1,
  nextAt: null,
});
const run = (outcome: string) => ({ startedAt: T - 5, outcome });

describe('cronJobState (the Overview card’s mapping, shared)', () => {
  it('folds a killed tick into failed, and keeps a failed or killed last run failed', () => {
    expect(cronJobState({ state: 'killed', since: T }, null)).toBe('failed');
    expect(cronJobState({ state: 'running', since: T }, run('failed'))).toBe('failed');
    expect(cronJobState({ state: 'running', since: T }, run('killed'))).toBe('failed');
    expect(cronJobState({ state: 'running', since: T }, run('ok'))).toBe('running');
    expect(cronJobState(tick('ok'), run('killed'))).toBe('failed');
    expect(cronJobState(tick('ok'), run('refused'))).toBe('retried');
    expect(cronJobState(tick('ok'), null)).toBe('ok');
  });

  it('passes the rest through', () => {
    expect(cronJobState({ state: 'never' }, null)).toBe('never');
    for (const s of ['failed', 'late', 'stalled'] as const) {
      expect(cronJobState(tick(s), run('failed'))).toBe(s);
    }
  });

  it('dates the row by the run it is about, else the tick', () => {
    expect(cronJobAt(tick('ok'), run('failed'), 'failed')).toBe(T - 5);
    expect(cronJobAt({ state: 'running', since: T }, run('refused'), 'retried')).toBe(T - 5);
    expect(cronJobAt({ state: 'running', since: T }, null, 'running')).toBe(T);
    expect(cronJobAt({ state: 'killed', since: T }, null, 'failed')).toBe(T);
    expect(cronJobAt({ state: 'never' }, null, 'never')).toBeNull();
    expect(cronJobAt(tick('late'), run('failed'), 'late')).toBe(T);
  });

  it('orders worst first', () => {
    expect(JOB_STATES[0]).toBe('stalled');
    expect(JOB_STATES.at(-1)).toBe('never');
  });
});

describe('cronCardState (Machinery’s card: killed is its own state)', () => {
  it('draws a killed tick, and a killed last run not yet superseded, as killed', () => {
    expect(cronCardState({ state: 'killed', since: T }, null)).toBe('killed');
    expect(cronCardState(tick('ok'), run('killed'))).toBe('killed');
    expect(cronCardState({ state: 'running', since: T }, run('killed'))).toBe('killed');
  });

  it('agrees with the Overview everywhere else, and folds back to it', () => {
    const livenesses: CronLiveness[] = [
      { state: 'never' },
      { state: 'running', since: T },
      { state: 'killed', since: T },
      tick('ok'),
      tick('late'),
      tick('stalled'),
      tick('failed'),
    ];
    for (const l of livenesses) {
      for (const r of [null, run('ok'), run('failed'), run('killed'), run('refused')]) {
        expect(foldCardState(cronCardState(l, r))).toBe(cronJobState(l, r));
      }
    }
    // A stalled or late cron says so, whatever its last run.
    expect(cronCardState(tick('stalled'), run('killed'))).toBe('stalled');
  });
});

describe('worstCronJob (the lane’s tail)', () => {
  it('is never with no crons, and never ranks below ok', () => {
    expect(worstCronJob([])).toEqual({ state: 'never', at: null });
    expect(
      worstCronJob([
        { liveness: { state: 'never' }, lastRun: null },
        { liveness: tick('ok'), lastRun: null },
      ]),
    ).toEqual({ state: 'ok', at: T });
  });

  it('takes the worst, dated by its own run, and the newest among equals', () => {
    expect(
      worstCronJob([
        { liveness: tick('ok'), lastRun: null },
        { liveness: tick('ok'), lastRun: run('failed') },
        { liveness: { state: 'running', since: T + 9 }, lastRun: null },
      ]),
    ).toEqual({ state: 'failed', at: T - 5 });
    expect(
      worstCronJob([
        { liveness: { ...tick('ok'), lastTickAt: T - 100 }, lastRun: null },
        { liveness: tick('ok'), lastRun: null },
      ]),
    ).toEqual({ state: 'ok', at: T });
  });
});
