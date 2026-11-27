import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  campaignLiveness,
  expectedQuietMs,
  RUN_LATE_FACTOR,
  RUN_QUIET_MS,
  RUN_STALLED_FACTOR,
  RUN_WAIT_MS,
  type RunLiveness,
  type RunLivenessInput,
  runLiveness,
} from './runLiveness';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 10, 27, 14, 0);
const E = RUN_QUIET_MS.canonical_water as number;

const live = (over: Partial<RunLivenessInput> = {}): RunLivenessInput => ({
  kind: 'canonical_water',
  status: 'running',
  progressAt: NOW,
  ...over,
});

/** The ladder, best first; `waiting` is a stall held, so it sits with `stalled`. */
const LADDER: Record<RunLiveness['state'], number> = {
  finished: -1,
  running: 0,
  notRecorded: 0,
  late: 1,
  waiting: 2,
  stalled: 2,
};

const KINDS = Object.keys(RUN_QUIET_MS);
const kind = fc.constantFrom(...KINDS);
const quiet = fc.integer({ min: 0, max: 40 * 60 * MINUTE });

describe('runLiveness', () => {
  it('reads the thresholds at exactly 2× and 10× the expected gap', () => {
    const at = (q: number) => runLiveness(live({ progressAt: NOW - q }), NOW).state;
    expect(at(0)).toBe('running');
    expect(at(RUN_LATE_FACTOR * E)).toBe('running');
    expect(at(RUN_LATE_FACTOR * E + 1)).toBe('late');
    expect(at(RUN_STALLED_FACTOR * E)).toBe('late');
    expect(at(RUN_STALLED_FACTOR * E + 1)).toBe('stalled');
    // The board's numbers: a 3-minute gap goes late past 6 minutes, stalled past 30.
    expect(RUN_LATE_FACTOR).toBe(2);
    expect(RUN_STALLED_FACTOR).toBe(10);
    expect(E).toBe(3 * MINUTE);
  });

  it('carries the quiet, the expected gap and no wait on a live verdict', () => {
    expect(runLiveness(live({ progressAt: NOW - 7 * MINUTE }), NOW)).toEqual({
      state: 'late',
      quietMs: 7 * MINUTE,
      expectedMs: E,
      waitUntil: null,
    });
  });

  it('is finished for a closed or marked row, and notRecorded without a heartbeat', () => {
    expect(runLiveness(live({ status: 'succeeded' }), NOW)).toEqual({ state: 'finished' });
    expect(runLiveness(live({ status: 'failed' }), NOW)).toEqual({ state: 'finished' });
    expect(runLiveness(live({ markedFailed: { at: 1 } }), NOW)).toEqual({ state: 'finished' });
    expect(runLiveness(live({ markedFailed: null }), NOW).state).toBe('running');
    expect(runLiveness(live({ progressAt: undefined }), NOW)).toEqual({ state: 'notRecorded' });
    expect(runLiveness(live({ progressAt: Number.NaN }), NOW)).toEqual({ state: 'notRecorded' });
  });

  it('gives no verdict for a kind with no expected gap — prototype keys included', () => {
    for (const k of ['lake_depth', 'toString', 'constructor', '__proto__']) {
      expect(expectedQuietMs(k)).toBeNull();
      expect(runLiveness(live({ kind: k, progressAt: NOW - 50 * 60 * MINUTE }), NOW)).toEqual({
        state: 'running',
        quietMs: 50 * 60 * MINUTE,
        expectedMs: null,
        waitUntil: null,
      });
    }
  });

  it('holds a stall as waiting only until the wait ends', () => {
    const stalled = live({ progressAt: NOW - 40 * MINUTE });
    const until = NOW + RUN_WAIT_MS;
    expect(runLiveness({ ...stalled, stallWaitUntil: until }, NOW)).toEqual({
      state: 'waiting',
      quietMs: 40 * MINUTE,
      expectedMs: E,
      waitUntil: until,
    });
    expect(runLiveness({ ...stalled, stallWaitUntil: until }, until - 1).state).toBe('waiting');
    expect(runLiveness({ ...stalled, stallWaitUntil: until }, until).state).toBe('stalled');
    expect(runLiveness({ ...stalled, stallWaitUntil: NOW }, NOW).state).toBe('stalled');
    // A wait never touches running or late.
    const late = live({ progressAt: NOW - 7 * MINUTE, stallWaitUntil: until });
    expect(runLiveness(late, NOW).state).toBe('late');
  });

  it('reads a heartbeat ahead of the clock as running with a quiet of 0', () => {
    expect(runLiveness(live({ progressAt: NOW + 5 * MINUTE }), NOW)).toEqual({
      state: 'running',
      quietMs: 0,
      expectedMs: E,
      waitUntil: null,
    });
  });
});

describe('runLiveness, as properties', () => {
  it('never moves back down the ladder as time passes, with the heartbeat and wait fixed', () => {
    fc.assert(
      fc.property(
        kind,
        fc.integer({ min: -60 * MINUTE, max: 60 * MINUTE }),
        quiet,
        quiet,
        (k, skew, a, b) => {
          const run = live({ kind: k, progressAt: NOW + skew });
          const [t1, t2] = a <= b ? [NOW + a, NOW + b] : [NOW + b, NOW + a];
          expect(LADDER[runLiveness(run, t2).state]).toBeGreaterThanOrEqual(
            LADDER[runLiveness(run, t1).state],
          );
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it('is never late inside 2E and never stalled inside 10E, waited or not', () => {
    fc.assert(
      fc.property(kind, quiet, fc.option(quiet), (k, q, w) => {
        const e = RUN_QUIET_MS[k] as number;
        const run = live({
          kind: k,
          progressAt: NOW - q,
          ...(w === null ? {} : { stallWaitUntil: NOW + w - 20 * 60 * MINUTE }),
        });
        const { state } = runLiveness(run, NOW);
        if (q <= RUN_LATE_FACTOR * e) expect(state).toBe('running');
        else if (q <= RUN_STALLED_FACTOR * e) expect(state).toBe('late');
        else expect(['stalled', 'waiting']).toContain(state);
      }),
      { numRuns: 3_000 },
    );
  });

  it('a finished or marked row is finished whatever its clock', () => {
    fc.assert(
      fc.property(
        kind,
        fc.constantFrom('running', 'succeeded', 'failed') as fc.Arbitrary<
          RunLivenessInput['status']
        >,
        fc.boolean(),
        fc.option(fc.integer({ min: 0, max: 2 * NOW })),
        fc.option(fc.integer({ min: 0, max: 2 * NOW })),
        (k, status, marked, progressAt, wait) => {
          fc.pre(status !== 'running' || marked);
          const run: RunLivenessInput = {
            kind: k,
            status,
            ...(progressAt === null ? {} : { progressAt }),
            ...(wait === null ? {} : { stallWaitUntil: wait }),
            ...(marked ? { markedFailed: { reason: 'x' } } : {}),
          };
          expect(runLiveness(run, NOW)).toEqual({ state: 'finished' });
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it('a wait only turns stalled into waiting, and after it ends the answer is the unwaited one', () => {
    fc.assert(
      fc.property(kind, quiet, fc.integer({ min: -RUN_WAIT_MS, max: RUN_WAIT_MS }), (k, q, w) => {
        const base = live({ kind: k, progressAt: NOW - q });
        const unwaited = runLiveness(base, NOW);
        const waited = runLiveness({ ...base, stallWaitUntil: NOW + w }, NOW);
        if (w > 0 && unwaited.state === 'stalled') {
          expect(waited).toEqual({ ...unwaited, state: 'waiting', waitUntil: NOW + w });
        } else {
          expect(waited).toEqual(unwaited);
        }
      }),
      { numRuns: 3_000 },
    );
  });

  it('a heartbeat after now reads running with a quiet of 0', () => {
    fc.assert(
      fc.property(kind, fc.integer({ min: 1, max: 365 * 24 * 60 * MINUTE }), (k, ahead) => {
        const r = runLiveness(live({ kind: k, progressAt: NOW + ahead }), NOW);
        expect(r.state).toBe('running');
        expect('quietMs' in r && r.quietMs).toBe(0);
      }),
    );
  });

  it('a beat clears a stall on its own', () => {
    fc.assert(
      fc.property(kind, quiet, (k, q) => {
        const e = RUN_QUIET_MS[k] as number;
        expect(runLiveness(live({ kind: k, progressAt: NOW - q }), NOW + 0).state).toBe(
          q > RUN_STALLED_FACTOR * e ? 'stalled' : q > RUN_LATE_FACTOR * e ? 'late' : 'running',
        );
        // The same run, beaten just now.
        expect(runLiveness(live({ kind: k, progressAt: NOW }), NOW).state).toBe('running');
      }),
    );
  });
});

describe('campaignLiveness', () => {
  const campaign = (over: Partial<RunLivenessInput> = {}) =>
    live({ kind: 'corpus_campaign', progressAt: NOW - 60 * MINUTE, ...over });
  const C = RUN_QUIET_MS.corpus_campaign as number;

  it('is finished when the campaign is, whatever its passes say', () => {
    const stalledPass = live({ progressAt: NOW - 60 * MINUTE });
    expect(campaignLiveness(campaign({ status: 'failed' }), [stalledPass], NOW)).toEqual({
      state: 'finished',
    });
    expect(campaignLiveness(campaign({ markedFailed: {} }), [stalledPass], NOW)).toEqual({
      state: 'finished',
    });
  });

  it('reads its running pass, not its own stale beat, while a pass runs', () => {
    const merge = live({ kind: 'corpus_merge', progressAt: NOW - MINUTE });
    const done = live({ kind: 'region_masks', status: 'succeeded', progressAt: NOW - 50 * MINUTE });
    expect(campaignLiveness(campaign(), [done, merge], NOW)).toEqual(runLiveness(merge, NOW));
  });

  it('takes the worst of two running passes', () => {
    const fresh = live({ progressAt: NOW });
    const dead = live({ kind: 'corpus_merge', progressAt: NOW - 90 * MINUTE });
    expect(campaignLiveness(campaign(), [fresh, dead], NOW).state).toBe('stalled');
    expect(campaignLiveness(campaign(), [dead, fresh], NOW).state).toBe('stalled');
    const later = live({ progressAt: NOW - 8 * MINUTE });
    const early = live({ progressAt: NOW - 7 * MINUTE });
    expect(campaignLiveness(campaign(), [early, later], NOW)).toEqual(runLiveness(later, NOW));
    expect(campaignLiveness(campaign(), [later, early], NOW)).toEqual(runLiveness(later, NOW));
    const unbeaten = live({ progressAt: undefined });
    expect(campaignLiveness(campaign(), [fresh, unbeaten], NOW).state).toBe('notRecorded');
    expect(campaignLiveness(campaign(), [unbeaten, unbeaten], NOW)).toEqual({
      state: 'notRecorded',
    });
  });

  it('between passes, is quiet since the last pass reported, on the campaign’s own gap', () => {
    const merge = live({ kind: 'corpus_merge', status: 'succeeded', progressAt: NOW - MINUTE });
    expect(campaignLiveness(campaign(), [merge], NOW)).toEqual({
      state: 'running',
      quietMs: MINUTE,
      expectedMs: C,
      waitUntil: null,
    });
    // Nothing since the merge closed 20 minutes ago: stalled, on the campaign's 3-minute gap.
    const old = { ...merge, progressAt: NOW - 20 * MINUTE };
    expect(campaignLiveness(campaign({ progressAt: NOW - 50 * MINUTE }), [old], NOW).state).toBe(
      'late',
    );
    expect(
      campaignLiveness(campaign(), [{ ...merge, progressAt: NOW - 31 * MINUTE }], NOW).state,
    ).toBe('stalled');
    // A campaign beat newer than any pass wins; a pass with no heartbeat is passed over.
    const unbeaten = live({ status: 'succeeded', progressAt: undefined });
    expect(campaignLiveness(campaign({ progressAt: NOW }), [old, unbeaten], NOW).state).toBe(
      'running',
    );
    expect(campaignLiveness(campaign({ progressAt: undefined }), [], NOW).state).toBe(
      'notRecorded',
    );
    expect(campaignLiveness(campaign({ progressAt: undefined }), [merge], NOW).state).toBe(
      'running',
    );
  });

  it('is never better than its running pass’s (property)', () => {
    const pass = fc.record({
      kind,
      status: fc.constantFrom('running', 'succeeded', 'failed') as fc.Arbitrary<
        RunLivenessInput['status']
      >,
      progressAt: fc.integer({ min: NOW - 20 * 60 * MINUTE, max: NOW + MINUTE }),
    });
    fc.assert(
      fc.property(fc.array(pass, { maxLength: 8 }), quiet, (passes, q) => {
        const c = campaign({ progressAt: NOW - q });
        const out = campaignLiveness(c, passes, NOW);
        for (const p of passes) {
          const own = runLiveness(p, NOW);
          if (own.state !== 'finished') {
            expect(LADDER[out.state]).toBeGreaterThanOrEqual(LADDER[own.state]);
          }
        }
        if (
          passes.every((p) => runLiveness(p, NOW).state === 'finished') &&
          out.state !== 'finished'
        ) {
          // Between passes: the campaign's own gap.
          expect('expectedMs' in out && out.expectedMs).toBe(C);
        }
      }),
      { numRuns: 2_000 },
    );
  });
});
