import { describe, expect, it } from 'vitest';
import { cronJobAt, cronJobState, JOB_STATES } from './cronJobState';
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
