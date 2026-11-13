import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { HazardsTabView, type HazardsTabViewProps } from './HazardsTabView';
import {
  BODY_NOW,
  FEB_ARCHIVED,
  FEB_HAZARDS,
  FEB_NOW,
  MASCOMA_FEATURE_ROWS,
  MASCOMA_WINTERS,
  SEASON,
  WATCH_OPENED,
} from './hazardsFixtures';
import { archivedRows, hazardRows } from './hazardsModel';

const base: HazardsTabViewProps = {
  season: SEASON,
  currentSeason: SEASON,
  onSeasonChange: vi.fn(),
  bodyName: 'Mascoma',
  watchOpenedAt: WATCH_OPENED,
  hazards: [],
  archived: [],
  features: MASCOMA_FEATURE_ROWS,
  winters: MASCOMA_WINTERS,
  patternsWaiting: 2,
  onOpenRecurrence: vi.fn(),
  onDemote: vi.fn(async () => {}),
  onMarkHazard: vi.fn(),
  onAddFeature: vi.fn(),
  onEditShape: vi.fn(),
  lit: null,
  onLitChange: vi.fn(),
};

const FEB = {
  hazards: hazardRows(FEB_HAZARDS, FEB_NOW),
  archived: archivedRows(FEB_ARCHIVED),
};

describe('HazardsTabView — the default board', () => {
  it('says nothing was marked, never that nothing is there', () => {
    render(<HazardsTabView {...base} />);
    const onLake = screen.getByRole('region', { name: 'On the lake' });
    expect(within(onLake).getByText('0')).toBeVisible();
    expect(within(onLake).getByText('Nothing marked yet')).toBeVisible();
    expect(
      within(onLake).getByText(
        'No one has marked a hazard on Mascoma since the watch opened 3 Oct 2026. No reports is not a reading of the ice.',
      ),
    ).toBeVisible();
    // The two winters: this one bare, last one's record.
    expect(
      within(onLake).getByRole('img', {
        name: /^2026–27: Nothing marked yet; 2025–26: \d+ in all$/,
      }),
    ).toBeVisible();
  });

  it('without the watch’s date, says this winter instead', () => {
    render(<HazardsTabView {...base} watchOpenedAt={null} winters={null} />);
    expect(screen.getByText(/No one has marked a hazard on Mascoma this winter\./)).toBeVisible();
    expect(screen.queryByRole('img', { name: /2026–27/ })).toBeNull();
  });

  it('draws the known features with their tools, the promotion count and Mark a hazard', async () => {
    const onEditShape = vi.fn();
    const onOpenRecurrence = vi.fn();
    render(
      <HazardsTabView {...base} onEditShape={onEditShape} onOpenRecurrence={onOpenRecurrence} />,
    );
    const known = screen.getByRole('region', { name: 'Known features' });
    expect(
      within(known)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'Spring / currentMascoma River inletPoint, 60 m · From a pin, 21 Jan 2026Edit shapeDemote',
      'Bridge narrowsShaker BridgeLine, 40 m band · Drawn 18 Nov 2025Edit shapeDemote',
    ]);
    await userEvent.click(
      within(known).getAllByRole('button', { name: 'Edit shape' })[0] as HTMLElement,
    );
    expect(onEditShape).toHaveBeenCalledWith('f-spring');
    expect(screen.getByText('2 patterns on Mascoma wait in the pre-ice pass')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /Recurrence/ }));
    expect(onOpenRecurrence).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Mark a hazard/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /Add a feature/ })).toBeVisible();
    expect(document.querySelectorAll('[data-slot="feature-glyph"] rect').length).toBeGreaterThan(0);
  });

  it('draws no tool without its writer', () => {
    render(
      <HazardsTabView
        {...base}
        onDemote={undefined}
        onMarkHazard={undefined}
        onAddFeature={undefined}
        onEditShape={undefined}
        patternsWaiting={null}
      />,
    );
    expect(
      screen.queryByRole('button', { name: /Demote|Edit shape|Mark a hazard|Add a feature/ }),
    ).toBeNull();
    expect(screen.queryByText('Promotion')).toBeNull();
  });

  it('demoting asks a reason first, and waits until there is one', async () => {
    const onDemote = vi.fn(async () => {});
    render(<HazardsTabView {...base} onDemote={onDemote} />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Demote' })[1] as HTMLElement);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Bridge narrows, Shaker Bridge\./)).toBeVisible();
    const confirm = within(dialog).getByRole('button', { name: /Demote/ });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox'), 'The bridge was replaced');
    await userEvent.click(confirm);
    await userEvent.click(within(dialog).getByRole('button', { name: /again/ }));
    expect(onDemote).toHaveBeenCalledWith('f-narrows', 'The bridge was replaced');
  });

  it('a refused demotion keeps the dialog and says why', async () => {
    const onDemote = vi.fn(async () => {
      throw new Error('Body feature not found');
    });
    render(<HazardsTabView {...base} onDemote={onDemote} />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Demote' })[0] as HTMLElement);
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'x');
    await userEvent.click(within(dialog).getByRole('button', { name: /Demote/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: /again/ }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Body feature not found');
  });

  it('a feature’s glyph lights it on the map', async () => {
    const onLitChange = vi.fn();
    render(<HazardsTabView {...base} onLitChange={onLitChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show Spring / current on the map' }));
    expect(onLitChange).toHaveBeenCalledWith('feature:f-spring');
  });

  it('picks the winter from the bar or from Earlier', async () => {
    const onSeasonChange = vi.fn();
    render(<HazardsTabView {...base} onSeasonChange={onSeasonChange} />);
    const bar = screen.getByRole('group', { name: 'Winter' });
    expect(
      within(bar)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['2026–27', '2025–26', '2024–25']);
    await userEvent.click(within(bar).getByRole('button', { name: '2025–26' }));
    expect(onSeasonChange).toHaveBeenLastCalledWith(2025);
    await userEvent.click(screen.getByRole('button', { name: /Earlier/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: '2022–23' }));
    expect(onSeasonChange).toHaveBeenLastCalledWith(2022);
  });

  it('says so while loading', () => {
    render(<HazardsTabView {...base} hazards={undefined} features={undefined} />);
    expect(screen.getByText('Loading the hazards')).toBeVisible();
  });
});

describe('HazardsTabView — a list, and a past winter', () => {
  it('lists every hazard with its state in words, stale and unconfirmed included', () => {
    render(<HazardsTabView {...base} {...FEB} />);
    const rows = screen
      .getAllByRole('button', { pressed: false })
      .filter((b) => b.dataset.slot === 'hazard-row');
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual([
      'fresh',
      'aging',
      'fresh',
      'stale',
      'unconfirmed',
    ]);
    expect(rows[1]).toHaveTextContent('Wet / working crack · aging');
    expect(
      within(rows[2] as HTMLElement).getByRole('img', { name: '1 of 2 said gone' }),
    ).toBeVisible();
    // The groups are closed, their counts on their heads; the known features fold into one.
    expect(screen.getByRole('button', { name: /Archived this winter/ })).toHaveTextContent('2');
    expect(screen.queryByRole('region', { name: 'Known features' })).toBeNull();
  });

  it('a row lights its hazard; pressing it again lets go', async () => {
    const onLitChange = vi.fn();
    const { rerender } = render(<HazardsTabView {...base} {...FEB} onLitChange={onLitChange} />);
    const ridge = screen.getByText('Black Point to Wood Island').closest('button') as HTMLElement;
    await userEvent.click(ridge);
    expect(onLitChange).toHaveBeenLastCalledWith('hazard:h-ridge');
    rerender(<HazardsTabView {...base} {...FEB} lit="hazard:h-ridge" onLitChange={onLitChange} />);
    expect(ridge).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(ridge);
    expect(onLitChange).toHaveBeenLastCalledWith(null);
  });

  it('opens the archived group: where, what, and when anyone last saw it', async () => {
    render(<HazardsTabView {...base} {...FEB} />);
    await userEvent.click(screen.getByRole('button', { name: /Archived this winter/ }));
    const rows = await screen.findAllByText(/Last seen/);
    expect(rows.map((r) => r.textContent)).toEqual(['Last seen 9 Feb', 'Last seen 26 Jan']);
  });

  it('a past winter is read-only: the solid badge, no tools, past tense', () => {
    render(<HazardsTabView {...base} season={SEASON - 1} hazards={[]} />);
    expect(screen.getByText('Read-only')).toHaveAttribute('data-slot', 'badge');
    expect(screen.getByText('Nothing was marked')).toBeVisible();
    expect(screen.getByText(/No one marked a hazard on Mascoma in 2025–26\./)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /Demote|Edit shape|Mark a hazard|Add a feature/ }),
    ).toBeNull();
  });

  it('a past winter’s list names its groups by that winter', () => {
    render(<HazardsTabView {...base} season={SEASON - 1} {...FEB} />);
    expect(screen.getByRole('button', { name: /Archived in 2025–26/ })).toBeVisible();
    expect(BODY_NOW).toBeGreaterThan(FEB_NOW);
  });
});
