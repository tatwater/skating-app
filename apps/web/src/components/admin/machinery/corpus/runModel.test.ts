import { runLiveness } from '@skating/core';
import { describe, expect, test, vi } from 'vitest';
import { laneTailAt, livenessAt, rowsAt } from '../liveness';
import {
  assembledCampaign,
  at,
  boardCampaign,
  boardPasses,
  LAST_FLUSH,
  LOAD_ID,
  loadDoc,
  loadView,
  MARKED,
  NOW_LATE,
  NOW_MARKED,
  NOW_RUNNING,
  NOW_STALLED,
  WAITING,
  ZONE,
} from './runFixtures';
import {
  actionTarget,
  campaignLivenessAt,
  defaultTailRun,
  headBadge,
  kindOfPass,
  passesLine,
  passState,
  quietLine,
  runLivenessAt,
  stageSegments,
  tailState,
} from './runModel';
import type { LivenessView } from './runViews';

const MIN = 60_000;
const running = (quietMs: number): LivenessView => ({
  state: 'running',
  quietMs,
  expectedMs: 3 * MIN,
  waitUntil: null,
});
const late: LivenessView = {
  state: 'late',
  quietMs: 7 * MIN,
  expectedMs: 3 * MIN,
  waitUntil: null,
};
const stalled: LivenessView = {
  state: 'stalled',
  quietMs: 41 * MIN,
  expectedMs: 3 * MIN,
  waitUntil: null,
};

describe('the liveness at the page clock', () => {
  test("a campaign re-reads its row by core's rule, as the list does", () => {
    const view = boardCampaign(NOW_RUNNING);
    expect(view.row.liveness.state).toBe('running');
    expect(campaignLivenessAt(view, NOW_STALLED).state).toBe('stalled');
    expect(campaignLivenessAt(view, NOW_LATE).state).toBe('late');
    // The list's row and the page's head read one function: the same answer at the same clock.
    for (const now of [NOW_RUNNING, NOW_LATE, NOW_STALLED]) {
      expect(campaignLivenessAt(view, now)).toEqual(livenessAt(view.row, now));
    }
    const rule = vi.fn(runLiveness);
    campaignLivenessAt(view, NOW_STALLED, rule);
    expect(rule).toHaveBeenCalledWith(
      { kind: 'canonical_water', status: 'running', progressAt: LAST_FLUSH },
      NOW_STALLED,
    );
  });

  test('a wait reaches the rule; a mark ends the re-reading', () => {
    const view = boardCampaign(NOW_STALLED, { waiting: WAITING });
    expect(campaignLivenessAt(view, NOW_STALLED)).toMatchObject({
      state: 'waiting',
      waitUntil: WAITING.until,
    });
    const marked = boardCampaign(NOW_STALLED, { marked: MARKED });
    const rule = vi.fn(runLiveness);
    expect(campaignLivenessAt(marked, NOW_STALLED, rule)).toBe(marked.row.liveness);
    expect(rule).not.toHaveBeenCalled();
  });

  test('without inputs (ended, marked, rebuilt, or an older read) the server verdict stands', () => {
    const view = boardCampaign(NOW_STALLED);
    const rule = vi.fn(runLiveness);
    const bare = { ...view, row: { ...view.row, livenessInputs: null } };
    expect(campaignLivenessAt(bare, NOW_RUNNING, rule)).toBe(view.row.liveness);
    const { livenessInputs: _, ...older } = view.row;
    expect(campaignLivenessAt({ row: older }, NOW_RUNNING, rule)).toBe(view.row.liveness);
    const done = assembledCampaign();
    expect(campaignLivenessAt(done, NOW_RUNNING, rule)).toBe(done.row.liveness);
    expect(rule).not.toHaveBeenCalled();
  });

  test('the list re-reads each row on the same clock', () => {
    const view = boardCampaign(NOW_RUNNING);
    const finished = assembledCampaign().row;
    const [live, ended] = rowsAt([view.row, finished], NOW_STALLED);
    expect(live?.liveness.state).toBe('stalled');
    expect(ended).toBe(finished);
    expect(rowsAt([view.row], NOW_RUNNING)[0]?.liveness).toEqual(view.row.liveness);
  });

  test('the sidebar’s tail re-reads on the list’s clock, and agrees with the list row', () => {
    const view = boardCampaign(NOW_RUNNING);
    const inputs = view.row.livenessInputs ?? undefined;
    const tail = {
      state: view.row.liveness.state,
      at: LAST_FLUSH,
      kind: 'campaign' as const,
      ...(inputs !== undefined && { livenessInputs: inputs }),
    };
    expect(tail.state).toBe('running');
    for (const now of [NOW_RUNNING, NOW_LATE, NOW_STALLED]) {
      expect(laneTailAt(tail, now).state).toBe(rowsAt([view.row], now)[0]?.liveness.state);
    }
    expect(laneTailAt(tail, NOW_STALLED).state).toBe('stalled');
    // Unchanged, the same object; a finished tail (no inputs) keeps the server's word.
    expect(laneTailAt(tail, NOW_RUNNING)).toBe(tail);
    const ok = { state: 'ok' as const, at: 1 };
    expect(laneTailAt(ok, NOW_STALLED)).toBe(ok);
  });

  test('a run re-reads its own row while it runs', () => {
    expect(runLivenessAt(loadView(NOW_RUNNING), NOW_STALLED).state).toBe('stalled');
    const waited = loadView(NOW_STALLED, {
      doc: loadDoc({
        stallWait: {
          until: at(14, 42),
          byUserId: WAITING.by.id,
          at: at(14, 12),
          actionId: 'a' as never,
        },
      }),
    });
    expect(runLivenessAt(waited, NOW_STALLED).state).toBe('waiting');
    const marked = loadView(NOW_STALLED, {
      doc: loadDoc({
        markedFailed: {
          byUserId: MARKED.by.id,
          at: NOW_MARKED,
          reason: 'x',
          actionId: 'a' as never,
        },
      }),
    });
    expect(runLivenessAt(marked, NOW_STALLED).state).toBe('finished');
    const noBeat = loadView(NOW_STALLED, { doc: loadDoc({ progressAt: undefined }) });
    expect(noBeat.liveness.state).toBe('notRecorded');
    expect(runLivenessAt(noBeat, NOW_STALLED).state).toBe('notRecorded');
    const finished = loadView(NOW_STALLED, { doc: loadDoc({ status: 'succeeded' }) });
    expect(runLivenessAt(finished, NOW_STALLED)).toBe(finished.liveness);
  });

  test('a pass names its kind', () => {
    expect(kindOfPass('load')).toBe('canonical_water');
    expect(kindOfPass('nope')).toBeNull();
  });
});

describe('the head badge', () => {
  test('each state its words and tone', () => {
    expect(headBadge(running(18_000), 'running', null)).toEqual({ words: 'Running', tone: 'live' });
    expect(headBadge(late, 'running', null)).toEqual({ words: 'Late · 7 min quiet', tone: 'warn' });
    expect(headBadge(stalled, 'running', null)).toEqual({
      words: 'Stalled · 41 min quiet',
      tone: 'bad',
    });
    expect(
      headBadge({ ...stalled, state: 'waiting', waitUntil: at(14, 42) }, 'running', null, ZONE),
    ).toEqual({ words: 'Waiting until 14:42', tone: 'warn' });
    expect(headBadge({ ...stalled, state: 'waiting' }, 'running', null)).toEqual({
      words: 'Waiting',
      tone: 'warn',
    });
    expect(headBadge({ state: 'notRecorded' }, 'running', null).words).toBe(
      'No heartbeat recorded',
    );
    expect(headBadge({ state: 'finished' }, 'failed', NOW_MARKED, ZONE)).toEqual({
      words: 'Marked failed · 14:20',
      tone: 'bad',
    });
    expect(headBadge({ state: 'finished' }, 'failed', null)).toEqual({
      words: 'Failed',
      tone: 'bad',
    });
    expect(headBadge({ state: 'finished' }, 'succeeded', null).tone).toBe('quiet');
    expect(headBadge({ state: 'finished' }, 'running', null).tone).toBe('live');
  });
});

describe('the stage bar and its line', () => {
  test('the board: two done, the load stalled, the rest waiting', () => {
    const passes = boardPasses('stalled');
    expect(stageSegments(passes, stalled, false, false).map((s) => s.tone)).toEqual([
      'done',
      'done',
      'stalled',
      'idle',
      'idle',
      'idle',
      'idle',
      'idle',
      'idle',
      'idle',
    ]);
    expect(passesLine(passes, stalled)).toBe('2 done · load stalled · 7 waiting');
  });

  test('the running pass follows the liveness: ice, amber late or held', () => {
    const passes = boardPasses('running');
    expect(stageSegments(passes, running(1), false, false)[2]?.tone).toBe('running');
    expect(stageSegments(passes, late, false, false)[2]?.tone).toBe('late');
    expect(stageSegments(passes, { ...stalled, state: 'waiting' }, false, false)[2]?.tone).toBe(
      'waiting',
    );
    expect(passesLine(passes, late)).toBe('2 done · load late · 7 waiting');
    expect(passesLine(passes, { ...stalled, state: 'waiting' })).toBe(
      '2 done · load waiting · 7 waiting',
    );
    expect(passesLine(passes, running(1))).toBe('2 done · load running · 7 waiting');
  });

  test('marked: the failed pass and every one it never reached are spent', () => {
    const passes = boardPasses('failed');
    const tones = stageSegments(passes, { state: 'finished' }, true, true).map((s) => s.tone);
    expect(tones.slice(0, 7)).toEqual(['done', 'done', 'dead', 'dead', 'dead', 'dead', 'dead']);
    expect(stageSegments(passes, { state: 'finished' }, true, false)[2]?.tone).toBe('failed');
    expect(stageSegments(passes, running(1), false, true)[2]?.tone).toBe('dead');
    expect(passesLine(passes, { state: 'finished' })).toBe('2 done · load failed · 7 waiting');
  });

  test('skipped, dry runs, and no plan', () => {
    const passes = boardPasses('running').map((p) =>
      p.pass === 'load-sub-areas'
        ? { ...p, state: 'skipped' as const, skipped: 'no actor given' }
        : p,
    );
    passes[0] = { ...(passes[0] as (typeof passes)[0]), state: 'dryRun' };
    expect(stageSegments(passes, running(1), false, false)[3]?.tone).toBe('dead');
    expect(stageSegments(passes, running(1), false, false)[0]?.tone).toBe('done');
    expect(passesLine(passes, running(1))).toBe('2 done · load running · 6 waiting · 1 skipped');
    expect(passesLine([], running(1))).toBe('No plan recorded');
  });
});

describe('a pass row', () => {
  const [region, , load, sub] = boardPasses('running');
  test('the running pass takes the campaign liveness', () => {
    if (load === undefined) throw new Error('no load');
    expect(passState(load, stalled)).toEqual({ words: 'stalled', tone: 'bad' });
    expect(passState(load, late)).toEqual({ words: 'late', tone: 'warn' });
    expect(passState(load, { ...stalled, state: 'waiting' })).toEqual({
      words: 'waiting',
      tone: 'warn',
    });
    expect(passState(load, running(1))).toEqual({ words: 'running', tone: 'fg' });
  });
  test('the rest by their own state', () => {
    if (region === undefined || sub === undefined) throw new Error('no rows');
    expect(passState(region, stalled)).toEqual({ words: 'done', tone: 'quiet' });
    expect(passState(sub, stalled)).toEqual({ words: 'waiting', tone: 'dim' });
    expect(passState({ ...sub, state: 'failed' }, stalled).tone).toBe('bad');
    expect(passState({ ...sub, state: 'required' }, stalled)).toEqual({
      words: 'required',
      tone: 'warn',
    });
    expect(passState({ ...sub, state: 'notRun' }, stalled).words).toBe('not run');
  });
});

describe('the tail', () => {
  test('its drawing state', () => {
    expect(tailState('running', false)).toBe('live');
    expect(tailState('running', true)).toBe('failed');
    expect(tailState('failed', false)).toBe('failed');
    expect(tailState('succeeded', false)).toBe('finished');
  });

  test('the quiet line only when late or stalled, the stall red-washed', () => {
    expect(quietLine(running(1), LAST_FLUSH, ZONE)).toBeNull();
    expect(quietLine(stalled, LAST_FLUSH, ZONE)).toEqual({
      word: 'stalled',
      tone: 'bad',
      text: 'no flush since 13:31:18 · one about every 3 min · 41 min is about 13 missed',
      fail: true,
    });
    expect(quietLine(late, null, ZONE)).toMatchObject({ word: 'late', tone: 'warn', fail: false });
    expect(quietLine({ ...late, expectedMs: null }, LAST_FLUSH, ZONE)?.text).toBe(
      'no flush since 13:31:18',
    );
  });

  test('between passes and after the end, current is the last pass that ran: never the target', () => {
    const view = boardCampaign(NOW_STALLED);
    const between = {
      ...view,
      passes: view.passes.map((p) =>
        p.run?.id === LOAD_ID
          ? { ...p, state: 'done' as const, run: { ...p.run, finishedAt: NOW_LATE } }
          : p,
      ),
    };
    expect(actionTarget(between)).toEqual({ runId: view.row.id, title: 'a07a-20261012' });
    expect(defaultTailRun(between)).toBe(view.row.id);
    const ended = { ...between, row: { ...between.row, status: 'succeeded' as const } };
    expect(defaultTailRun(ended)).toBe(LOAD_ID);
  });

  test('a campaign tail opens on the running pass, else its own row; the actions target the same', () => {
    const view = boardCampaign(NOW_STALLED);
    expect(defaultTailRun(view)).toBe(LOAD_ID);
    expect(actionTarget(view)).toEqual({ runId: LOAD_ID, title: 'load' });
    expect(defaultTailRun({ ...view, current: null })).toBe(view.row.id);
    expect(actionTarget({ ...view, current: null })).toEqual({
      runId: view.row.id,
      title: 'a07a-20261012',
    });
  });
});
