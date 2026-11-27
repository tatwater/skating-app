import { describe, expect, test } from 'vitest';

import type { LivenessView } from '../corpus/runViews';
import { runActions, STOP_DRAWN } from './actionsShown';

const at = (state: LivenessView['state']): LivenessView =>
  state === 'finished' || state === 'notRecorded'
    ? { state }
    : { state, quietMs: 0, expectedMs: 180_000, waitUntil: null };

describe('which actions a run offers', () => {
  test('no bar before late', () => {
    expect(runActions({ status: 'running', liveness: at('running'), marked: false })).toEqual({
      bar: false,
      markFailed: false,
      campaignToo: false,
      wait: false,
      stop: false,
    });
  });

  test('late: Mark failed alone', () => {
    expect(runActions({ status: 'running', liveness: at('late'), marked: false })).toEqual({
      bar: true,
      markFailed: true,
      campaignToo: false,
      wait: false,
      stop: false,
    });
  });

  test('stalled: Mark failed and Wait', () => {
    expect(runActions({ status: 'running', liveness: at('stalled'), marked: false })).toMatchObject(
      {
        bar: true,
        markFailed: true,
        wait: true,
      },
    );
  });

  test('held by a wait, or never beat: Mark failed, no second wait', () => {
    for (const s of ['waiting', 'notRecorded'] as const) {
      expect(runActions({ status: 'running', liveness: at(s), marked: false })).toMatchObject({
        bar: true,
        markFailed: true,
        wait: false,
      });
    }
  });

  test('finished or marked: nothing', () => {
    expect(runActions({ status: 'failed', liveness: at('finished'), marked: false }).bar).toBe(
      false,
    );
    expect(runActions({ status: 'succeeded', liveness: at('stalled'), marked: false }).bar).toBe(
      false,
    );
    expect(runActions({ status: 'running', liveness: at('stalled'), marked: true }).bar).toBe(
      false,
    );
  });

  test('Stop is hidden: the switch is off', () => {
    expect(STOP_DRAWN).toBe(false);
    for (const s of ['running', 'late', 'stalled', 'waiting', 'notRecorded', 'finished'] as const) {
      expect(runActions({ status: 'running', liveness: at(s), marked: false }).stop).toBe(false);
    }
  });

  test('with the switch on, Stop on any running run not already asked', () => {
    const on = { stopDrawn: true };
    expect(runActions({ status: 'running', liveness: at('running'), marked: false }, on)).toEqual({
      bar: true,
      markFailed: false,
      campaignToo: false,
      wait: false,
      stop: true,
    });
    expect(
      runActions({ status: 'running', liveness: at('running'), marked: false, stopAsked: true }, on)
        .stop,
    ).toBe(false);
    expect(
      runActions({ status: 'running', liveness: at('finished'), marked: false }, on).stop,
    ).toBe(false);
  });

  describe('Mark the campaign failed too: the server’s offer, never a clock reading', () => {
    test('drawn whenever the offer holds, at any liveness, in place of the campaign’s own mark', () => {
      for (const s of ['running', 'late', 'stalled', 'waiting', 'notRecorded'] as const) {
        const shown = runActions({
          status: 'running',
          liveness: at(s),
          marked: false,
          campaignToo: true,
        });
        expect(shown).toMatchObject({ bar: true, campaignToo: true, markFailed: false });
        expect(shown.wait).toBe(s === 'stalled');
      }
    });

    test('on the marked pass’s own page too: the pass is finished, the offer still drawn', () => {
      expect(
        runActions({ status: 'failed', liveness: at('finished'), marked: true, campaignToo: true }),
      ).toEqual({ bar: true, markFailed: false, campaignToo: true, wait: false, stop: false });
    });

    test('gone when the read drops it (a later pass, the campaign closed, a mark undone)', () => {
      for (const campaignToo of [false, undefined]) {
        expect(
          runActions({
            status: 'running',
            liveness: at('stalled'),
            marked: false,
            ...(campaignToo !== undefined && { campaignToo }),
          }),
        ).toMatchObject({ campaignToo: false, markFailed: true });
        expect(
          runActions({
            status: 'failed',
            liveness: at('finished'),
            marked: true,
            ...(campaignToo !== undefined && { campaignToo }),
          }).bar,
        ).toBe(false);
      }
    });
  });
});
