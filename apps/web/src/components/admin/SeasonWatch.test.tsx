import { DEFAULT_SEASON_WATCH_SETTINGS, evaluateSeason } from '@skating/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { toForm } from '@/lib/seasonPreview';
import {
  FieldDates,
  historyFillHint,
  ImageryPanel,
  PreviewTable,
  SettingsEditor,
  WatchCard,
  type WatchRow,
} from './SeasonWatch';

const ROW: WatchRow = {
  season: 'winter-2026-27',
  opensOn: '2026-10-03',
  openedBy: ['sentinel'],
  winterFrom: null,
  detectedAt: Date.parse('2026-10-04T20:46:00Z'),
  settingsVersion: 1,
  opening: {
    sentinels: [
      { name: 'Upper Lake of the Clouds', state: 'NH', lowC: -0.4 },
      { name: 'Eagle Lake', state: 'NH', lowC: 0 },
    ],
    corpus: { frozen: 0, reporting: 25 },
  },
  imageryNudgeOn: '2026-10-06',
  emailsSent: [{ kind: 'opened', sentOn: '2026-10-04' }],
  emailQueue: [{ email: { kind: 'imagery', date: '2026-10-06' } }],
};

describe('WatchCard', () => {
  it('says plainly when no watch is open', () => {
    render(
      <WatchCard season="winter-2026-27" floor="2026-10-01" row={null} onReset={async () => {}} />,
    );
    expect(screen.getByText(/No ice watch is open for winter-2026-27/)).toBeInTheDocument();
  });

  it('shows what opened it, the emails sent and queued, and resets only on the word', async () => {
    const onReset = vi.fn(async () => {});
    render(<WatchCard season="winter-2026-27" floor="2026-10-01" row={ROW} onReset={onReset} />);
    expect(screen.getByText('Upper Lake of the Clouds, NH')).toBeInTheDocument();
    expect(screen.getByText('31.3°F')).toBeInTheDocument();
    expect(screen.getByText('Opened by a sentinel')).toBeInTheDocument();
    expect(screen.getByText(/0 of 25 ordinary lakes/)).toBeInTheDocument();
    expect(screen.getByText('sent Oct 4')).toBeInTheDocument();
    expect(screen.getByText('queued — one a day')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Reset this watch…' }));
    const confirm = screen.getByRole('button', { name: 'Reset the watch' });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Type “reset” to confirm'), 'reset');
    await userEvent.click(confirm);
    expect(onReset).toHaveBeenCalledWith('reset');
  });

  it('names version 0 as the defaults it shipped with', () => {
    render(
      <WatchCard
        season="winter-2026-27"
        floor="2026-10-01"
        row={{ ...ROW, settingsVersion: 0 }}
        onReset={async () => {}}
      />,
    );
    expect(
      screen.getByText(/the defaults it shipped with \(before versions\)/),
    ).toBeInTheDocument();
  });

  it('a legacy row says its detail is coming', () => {
    const { opening: _o, ...legacy } = ROW;
    render(
      <WatchCard
        season="winter-2026-27"
        floor="2026-10-01"
        row={legacy}
        onReset={async () => {}}
      />,
    );
    expect(screen.getByText(/next daily check fills this in/)).toBeInTheDocument();
  });
});

describe('ImageryPanel', () => {
  const activity = {
    runs: [
      { _id: 'r1', kind: 'poll', startedAt: 0, outcome: 'ok', counts: { queued: 3 } },
      { _id: 'r2', kind: 'reconcile', startedAt: 0, outcome: 'failed', detail: 'boom' },
    ],
    counts: { queued: 1, spawned: 0, landed: 5, empty: 2, failed: 1 },
    failed: [{ granuleId: 'S2C_X', lastError: 'exit 1' }],
    configured: false,
    pollCap: 300,
    maxLive: 25,
  };

  it('offers Start when not started, and warns when credentials are missing', async () => {
    const onStart = vi.fn(async () => {});
    render(
      <ImageryPanel row={ROW} activity={activity} onStart={onStart} onPause={async () => {}} />,
    );
    expect(screen.getByText('Not started. Nothing is cut until you start it.')).toBeInTheDocument();
    expect(screen.getByText(/missing imagery credentials/)).toBeInTheDocument();
    expect(screen.getByText('queued 3')).toBeInTheDocument();
    expect(screen.getByText(/S2C_X \(exit 1\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Start imagery' }));
    expect(onStart).toHaveBeenCalled();
  });

  it('offers Pause while running, and shows an action error', async () => {
    const onPause = vi.fn(async () => {
      throw new Error('[CONVEX M] Uncaught ConvexError: No watch is open for winter-2026-27.');
    });
    render(
      <ImageryPanel
        row={{ ...ROW, imageryStartedAt: 1 }}
        activity={{ ...activity, configured: true }}
        onStart={async () => {}}
        onPause={onPause}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Pause imagery' }));
    expect(await screen.findByText('No watch is open for winter-2026-27.')).toBeInTheDocument();
  });

  it('offers Retry failed beside the failures, and shows a backoff', async () => {
    const onRetryFailed = vi.fn(async () => {});
    const onTryAgain = vi.fn(async () => {});
    render(
      <ImageryPanel
        row={{ ...ROW, imageryStartedAt: 1 }}
        activity={{ ...activity, configured: true, backoffUntil: Date.now() + 60_000 }}
        onStart={async () => {}}
        onPause={async () => {}}
        onRetryFailed={onRetryFailed}
        onTryAgain={onTryAgain}
      />,
    );
    expect(screen.getByText(/Backing off until/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again now' }));
    expect(onTryAgain).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Retry failed' }));
    expect(onRetryFailed).toHaveBeenCalled();
  });

  it('says why there is nothing to do', () => {
    const { rerender } = render(
      <ImageryPanel
        row={null}
        activity={undefined}
        onStart={async () => {}}
        onPause={async () => {}}
      />,
    );
    expect(screen.getByText(/No watch is open/)).toBeInTheDocument();
    rerender(
      <ImageryPanel
        row={{ ...ROW, closesOn: '2027-05-01' }}
        activity={undefined}
        onStart={async () => {}}
        onPause={async () => {}}
      />,
    );
    expect(screen.getByText(/The watch ended May 1/)).toBeInTheDocument();
    rerender(
      <ImageryPanel
        row={{ ...ROW, imageryStartedAt: 1, imageryPausedAt: 2 }}
        activity={undefined}
        onStart={async () => {}}
        onPause={async () => {}}
      />,
    );
    expect(screen.getByText(/Paused/)).toBeInTheDocument();
  });
});

describe('SettingsEditor', () => {
  const props = {
    form: toForm(DEFAULT_SEASON_WATCH_SETTINGS),
    edited: DEFAULT_SEASON_WATCH_SETTINGS,
    sentinels: [{ waterBodyId: 'a', name: 'Upper Lake of the Clouds', state: 'NH' }],
    pinned: [],
    picker: () => <span>picker</span>,
    onDiscard: () => {},
  };

  it('saves only a dirty, valid draft, with the note', async () => {
    const onSave = vi.fn(async () => {});
    const { rerender } = render(
      <SettingsEditor
        {...props}
        onFormChange={() => {}}
        onRosterChange={() => {}}
        dirty={false}
        onSave={onSave}
      />,
    );
    expect(screen.getByRole('button', { name: 'Save as a new version' })).toBeDisabled();
    rerender(
      <SettingsEditor
        {...props}
        onFormChange={() => {}}
        onRosterChange={() => {}}
        dirty
        onSave={onSave}
      />,
    );
    await userEvent.type(screen.getByLabelText('What changed, and why'), 'Matt');
    await userEvent.click(screen.getByRole('button', { name: 'Save as a new version' }));
    expect(onSave).toHaveBeenCalledWith('Matt');
  });

  it('names an invalid value and refuses to save it', () => {
    render(
      <SettingsEditor
        {...props}
        edited={{ ...DEFAULT_SEASON_WATCH_SETTINGS, winterFraction: 3 }}
        onFormChange={() => {}}
        onRosterChange={() => {}}
        dirty
        onSave={async () => {}}
      />,
    );
    expect(screen.getByText(/The winter share must be 1–100%/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save as a new version' })).toBeDisabled();
  });

  it('refuses an eleventh sentinel before the server has to', () => {
    render(
      <SettingsEditor
        {...props}
        sentinels={Array.from({ length: 11 }, (_, i) => ({ waterBodyId: `s${i}`, name: `S${i}` }))}
        onFormChange={() => {}}
        onRosterChange={() => {}}
        dirty
        onSave={async () => {}}
      />,
    );
    expect(screen.getByText('At most ten sentinels and ten pinned sites.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save as a new version' })).toBeDisabled();
  });

  it('edits a field and removes a sentinel', async () => {
    const onFormChange = vi.fn();
    const onRosterChange = vi.fn();
    render(
      <SettingsEditor
        {...props}
        onFormChange={onFormChange}
        onRosterChange={onRosterChange}
        dirty={false}
        onSave={async () => {}}
      />,
    );
    await userEvent.type(screen.getByLabelText(/Sentinel nights in a row/), '3');
    expect(onFormChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ sentinelNights: '13' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove Upper Lake of the Clouds' }));
    expect(onRosterChange).toHaveBeenCalledWith({ sentinels: [], pinned: [] });
  });
});

describe('PreviewTable', () => {
  it('strikes through the saved date where an edit changes it', () => {
    const series = [
      {
        siteId: 'c',
        sentinel: true,
        days: [
          { date: '2026-10-03', minTempC: -1 },
          { date: '2026-10-04', minTempC: -2 },
        ],
      },
    ];
    const row = (nights: number) => ({
      season: 'winter-2026-27',
      source: 'archive' as const,
      evaluation: evaluateSeason(
        series,
        { ...DEFAULT_SEASON_WATCH_SETTINGS, sentinelNights: nights },
        'winter-2026-27',
      ),
      firstSkated: '2026-11-20',
      lastSkated: null,
      leadDays: nights === 1 ? 48 : 47,
      watched: 28,
      missingLows: 0,
    });
    render(<PreviewTable edited={[row(2)]} saved={[row(1)]} fillHint="Fill history fills them" />);
    expect(screen.getByText('Oct 4')).toBeInTheDocument();
    expect(screen.getByText('Oct 3')).toHaveClass('line-through');
    expect(screen.getByText('47 days')).toBeInTheDocument();
    expect(screen.getByText('(archive)')).toBeInTheDocument();
    expect(screen.queryByText(/No lows for/)).toBeNull();
  });

  it('says when a season is replayed over fewer lakes than the watch reads', () => {
    const row = {
      season: 'winter-2024-25',
      source: 'archive' as const,
      evaluation: evaluateSeason([], DEFAULT_SEASON_WATCH_SETTINGS, 'winter-2024-25'),
      firstSkated: null,
      lastSkated: null,
      leadDays: null,
      watched: 28,
      missingLows: 4,
    };
    render(<PreviewTable edited={[row]} saved={[row]} fillHint="saving fills them" />);
    expect(screen.getByText('No lows for 4 of 28 lakes — saving fills them')).toBeInTheDocument();
  });
});

describe('FieldDates', () => {
  it('lists, adds and removes', async () => {
    const onAdd = vi.fn(async () => {});
    const onRemove = vi.fn(async () => {});
    render(
      <FieldDates
        dates={[
          {
            _id: 'f1',
            season: 'winter-2025-26',
            kind: 'first_skated',
            date: '2025-12-01',
            place: 'Low Plains',
          },
        ]}
        seasons={['winter-2026-27', 'winter-2025-26']}
        onAdd={onAdd}
        onRemove={onRemove}
      />,
    );
    expect(screen.getByText('Low Plains')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onRemove).toHaveBeenCalledWith('f1');
    await userEvent.type(screen.getByLabelText('Date'), '2026-11-20');
    await userEvent.type(screen.getByLabelText('Where'), 'Eagle Lake');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onAdd).toHaveBeenCalledWith({
      season: 'winter-2026-27',
      kind: 'first_skated',
      date: '2026-11-20',
      place: 'Eagle Lake',
      note: '',
    });
  });

  it('says the fill is spread out', () => {
    expect(historyFillHint(10)).toContain('about 38 hours');
  });
});
