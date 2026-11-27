import { describe, expect, it } from 'vitest';

import { isRebuilt, type RunRowView } from '../machineryTypes';
import {
  BOARD_ROWS,
  liveRow,
  NOW,
  REBUILT_FAILED,
  REBUILT_FLAGGED,
  runId,
  STALLED_CAMPAIGN,
  ZONE,
} from './runListFixtures';
import { ageOf, liveOf, monthLabel, rowModel, stateChip, subLine, withMonths } from './runRows';

const MIN = 60_000;
const row = (title: string) => BOARD_ROWS.find((r) => r.title === title) as RunRowView;

describe('a run row, as board 6.2 draws it', () => {
  it('draws the stalled campaign: red, its passes and the pass that stalled, its quiet', () => {
    const m = rowModel(STALLED_CAMPAIGN, NOW, ZONE);
    expect(m.state).toEqual({ label: 'stalled', tone: 'bad' });
    expect(m.kind).toEqual({ label: 'campaign', tone: 'default' });
    expect(m.sub).toBe('Full canonical · 2 of 10 passes · load stalled');
    expect(m.age).toBe('41 min');
    expect(m.live).toBe('stalled');
    expect(m.rebuilt).toBe(false);
  });

  it('draws the passes run on their own: outcome, headline, day and month', () => {
    const names = rowModel(row('load-landmark-names'), NOW, ZONE);
    expect(names.state).toEqual({ label: 'succeeded', tone: 'ok' });
    expect(names.kind.label).toBe('single pass');
    expect(names.sub).toBe('237 place names queued');
    expect(names.age).toBe('9 Oct');
    expect(stateChip(row('referee-duplicates')).label).toBe('dry run');
    // A by-hand pass that wrote is *applied*; a script pass that finished is *succeeded*.
    expect(stateChip(row('seed-standing')).label).toBe('applied');
    expect(stateChip(row('prune-floor')).label).toBe('applied');
    expect(subLine(row('load'))).toBe('One state · VT · 8,214 bodies loaded');
  });

  it.each([
    ['running', 'running', 'lit', '2 min'],
    ['late', 'late', 'warn', '9 min'],
    ['waiting', 'waiting', 'warn', '41 min'],
    ['notRecorded', 'no heartbeat', 'warn', null],
  ] as const)('draws a %s run', (state, label, tone, age) => {
    const r = liveRow(state);
    expect(stateChip(r)).toEqual({ label, tone });
    expect(liveOf(r)).toBe(state);
    if (age !== null) expect(ageOf(r, NOW, ZONE)).toBe(age);
    // Without a heartbeat there's no quiet to show: the age is when it started.
    else expect(ageOf(r, NOW, ZONE)).toBe('12:58');
  });

  it('names the pass at work by its state, and without a heartbeat says so', () => {
    expect(subLine(liveRow('late'))).toBe('Full canonical · 2 of 10 passes · load late');
    expect(subLine(liveRow('notRecorded'))).toBe(
      'Full canonical · 2 of 10 passes · load · no heartbeat',
    );
  });

  it('reads a marked run as failed, whatever its liveness said', () => {
    const marked = { ...STALLED_CAMPAIGN, marked: true, status: 'failed' } as const;
    expect(stateChip(marked)).toEqual({ label: 'failed', tone: 'bad' });
    expect(liveOf(marked)).toBeNull();
    // Marked while the row's status is still running (a late close not yet in): still failed.
    expect(stateChip({ ...STALLED_CAMPAIGN, marked: true })).toEqual({
      label: 'failed',
      tone: 'bad',
    });
  });

  it('writes Not recorded for each fact a row lacks — never a zero', () => {
    const bare: RunRowView = {
      ...STALLED_CAMPAIGN,
      status: 'succeeded',
      liveness: { state: 'finished' },
      scope: null,
      line: {
        kind: 'campaign',
        passesDone: 0,
        passesPlanned: null,
        current: null,
        stoppedAt: null,
        bodiesLoaded: null,
        recorded: true,
      },
    };
    expect(subLine(bare)).toBe('0 passes · Not recorded');
    const pass = { ...row('load-landmarks'), line: { kind: 'pass', headline: null } } as const;
    expect(subLine(pass)).toBe('Not recorded');
  });
});

describe('a campaign rebuilt from its runs', () => {
  it('reads the flag from the one accessor: the stored flag, or no record of its own', () => {
    // Flag absent: `recorded: false` on the view.
    expect(isRebuilt(REBUILT_FAILED)).toBe(true);
    // Flag present: the backfill's `reconstructed`, whatever `recorded` says.
    expect(isRebuilt(REBUILT_FLAGGED)).toBe(true);
    expect(isRebuilt({ ...REBUILT_FLAGGED, reconstructed: false } as RunRowView)).toBe(false);
    expect(
      isRebuilt({
        ...REBUILT_FAILED,
        line: { ...REBUILT_FAILED.line, recorded: true, reconstructed: true },
      } as unknown as RunRowView),
    ).toBe(true);
    expect(isRebuilt(STALLED_CAMPAIGN)).toBe(false);
    // A pass is never a rebuilt campaign.
    expect(isRebuilt(row('load'))).toBe(false);
  });

  it('says it was rebuilt, and Not recorded where its runs don’t tell', () => {
    expect(subLine(REBUILT_FAILED)).toBe(
      'Rebuilt from its runs · 2 passes · Stopped at load-sub-areas · 25,050 bodies loaded',
    );
    expect(stateChip(REBUILT_FAILED)).toEqual({ label: 'failed', tone: 'bad' });
    const unknown = { ...REBUILT_FLAGGED, line: { ...REBUILT_FLAGGED.line, bodiesLoaded: null } };
    expect(subLine(unknown as RunRowView)).toBe('Rebuilt from its runs · 3 passes · Not recorded');
  });

  it('never reads live, even if the stored row still says running', () => {
    const stuck = {
      ...REBUILT_FAILED,
      status: 'running',
      liveness: {
        state: 'stalled',
        quietMs: 90 * 86_400_000,
        expectedMs: 3 * MIN,
        waitUntil: null,
      },
      line: { ...REBUILT_FAILED.line, current: 'load', stoppedAt: null },
    } as RunRowView;
    expect(liveOf(stuck)).toBeNull();
    expect(stateChip(stuck)).toEqual({ label: 'not recorded', tone: 'dim' });
    expect(subLine(stuck)).not.toMatch(/stalled|late|running/);
    expect(ageOf(stuck, NOW, ZONE)).not.toMatch(/min$/);
  });
});

describe('when a row says it ran', () => {
  it('writes minutes within the hour, the clock today, the date before', () => {
    const at = (ms: number) =>
      ageOf({ ...row('load'), startedAt: NOW - ms, finishedAt: NOW - ms }, NOW, ZONE);
    expect(at(12 * MIN)).toBe('12 min');
    expect(at(3 * 60 * MIN)).toBe('11:12');
    // 14:12 in New York: yesterday evening is a date, not a clock.
    expect(at(15 * 60 * MIN)).toBe('11 Oct');
  });
});

describe('month dividers', () => {
  it('puts one before each month the rows start in, newest first', () => {
    const entries = withMonths(BOARD_ROWS, NOW, ZONE);
    expect(entries.filter((e) => e.type === 'month').map((e) => e.label)).toEqual([
      'October',
      'September',
      'August',
      'July',
    ]);
    const rows = entries.flatMap((e) => (e.type === 'row' ? [e] : []));
    expect(rows.map((e) => e.index)).toEqual(BOARD_ROWS.map((_, i) => i));
    expect(rows[0]?.row.id).toBe(runId(1));
  });

  it('names the year of a month outside this one, and reads months in the reader’s zone', () => {
    expect(monthLabel(Date.UTC(2025, 6, 18, 12), NOW, ZONE)).toBe('July 2025');
    // 1 November 01:00 UTC is still 31 October in New York.
    expect(monthLabel(Date.UTC(2026, 10, 1, 1), NOW, ZONE)).toBe('October');
    expect(withMonths([], NOW, ZONE)).toEqual([]);
  });
});
