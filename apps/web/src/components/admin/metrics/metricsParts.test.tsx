import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ChartLegend } from './ChartLegend';
import { CoverageByState, ListedBodiesBar } from './CoverageByState';
import { KeepingUpStats } from './KeepingUp';
import {
  BOARD_COVERAGE,
  BOARD_DAYS,
  BOARD_KEEPING_UP,
  METRICS_NOW,
  RECORDED_COVERAGE,
} from './metricsFixtures';
import { metricsNotRecorded } from './metricsModel';
import { AgeValue, DayTick } from './metricsParts';
import { MostReported, ShowingUpStats, VantageSplit } from './ShowingUp';

describe('ChartLegend', () => {
  it('draws a bar as a square and a line as a hairline, in the series ink', () => {
    const { container } = render(
      <ChartLegend
        items={[
          { label: 'Hours waiting', ink: 'var(--fg)', mark: 'line' },
          { label: 'Safety', ink: 'var(--bad)' },
        ]}
      />,
    );
    const [line, bar] = container.querySelectorAll<HTMLElement>(
      '[data-slot="chart-legend-swatch"]',
    );
    expect(line?.dataset.mark).toBe('line');
    expect(line?.style.borderColor).toBe('var(--fg)');
    expect(bar?.dataset.mark).toBe('bar');
    expect(bar?.style.background).toBe('var(--bad)');
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Hours waiting',
      'Safety',
    ]);
  });
});

describe('AgeValue and DayTick', () => {
  it('sets each figure with its unit', () => {
    const { container } = render(
      <AgeValue
        parts={[
          { n: 3, unit: 'd' },
          { n: 22, unit: 'h' },
        ]}
      />,
    );
    expect(container.textContent).toBe('3 d22 h');
    expect(container.querySelectorAll('[data-slot="value-unit"]')).toHaveLength(2);
  });

  it('says Today for the last day, in the bright ink, and a date otherwise', () => {
    const { container } = render(
      <svg>
        <title>Axis</title>
        <DayTick payload={{ value: '2027-01-16' }} today="2027-01-16" />
        <DayTick payload={{ value: '2027-01-03' }} today="2027-01-16" />
      </svg>,
    );
    const [today, other] = container.querySelectorAll('text');
    expect(today?.textContent).toBe('Today');
    expect(today?.style.fill).toBe('var(--fg)');
    expect(other?.textContent).toBe('3 Jan');
    expect(other?.hasAttribute('data-today')).toBe(false);
  });
});

describe('Keeping up stats', () => {
  it('drops the ticket stat for a viewer without support access', () => {
    render(<KeepingUpStats data={{ ...BOARD_KEEPING_UP, support: null }} now={METRICS_NOW} />);
    expect(screen.queryByText('Open tickets')).toBeNull();
    expect(screen.getByText('Open flags')).toBeTruthy();
  });

  it('says nothing is open rather than inventing an age', () => {
    render(
      <KeepingUpStats
        data={{ ...BOARD_KEEPING_UP, oldestOpenFlag: null, openFlags: { total: 0, safety: 0 } }}
        now={METRICS_NOW}
      />,
    );
    expect(screen.getByText('Nothing open')).toBeTruthy();
    // No "0 safety": an empty clause is left out.
    expect(screen.queryByText(/safety/)).toBeNull();
  });
});

describe('Showing up', () => {
  it('leaves out a sub-line with nothing to say', () => {
    render(
      <ShowingUpStats
        week={{
          reports: { count: 0, people: 0 },
          accounts: { added: 0, total: 1 },
          signedIn: { people: 1, twoDaysOrMore: 0 },
          contributors: { people: 0, firstTime: 0 },
        }}
      />,
    );
    expect(screen.queryByText(/^By /)).toBeNull();
    expect(screen.queryByText(/two days/)).toBeNull();
    expect(screen.queryByText(/first time/)).toBeNull();
    expect(screen.getByText('1 total')).toBeTruthy();
  });

  it('draws unstated reports hollow, and only when there are some', () => {
    const { container, rerender } = render(
      <VantageSplit counts={{ on_ice: 2, shore: 11, secondhand: 1, unstated: 0 }} />,
    );
    expect(container.querySelector('[data-key="unstated"]')).toBeNull();
    rerender(<VantageSplit counts={{ on_ice: 2, shore: 0, secondhand: 1, unstated: 5 }} />);
    const unstated = container.querySelector<HTMLElement>(
      '[data-slot="vantage-segment"][data-key="unstated"]',
    );
    expect(unstated?.style.flexGrow).toBe('5');
    expect(unstated?.className).toContain('border-line2');
    // A zero vantage keeps its key (it says 0) but draws no segment.
    expect(container.querySelector('[data-slot="vantage-segment"][data-key="shore"]')).toBeNull();
    expect(screen.getByText('From shore').closest('div')?.textContent).toBe('From shore0');
  });

  it('draws an empty split as one quiet bar', () => {
    const { container } = render(
      <VantageSplit counts={{ on_ice: 0, shore: 0, secondhand: 0, unstated: 0 }} />,
    );
    expect(container.querySelectorAll('[data-slot="vantage-segment"]')).toHaveLength(0);
    expect(screen.getByRole('img').querySelector('i')?.className).toContain('bg-line');
  });

  it('dates the last report in the reader’s zone', () => {
    render(
      <MostReported
        rows={[
          {
            bodyId: 'm',
            name: 'Mascoma Lake',
            reports: 7,
            photos: 12,
            people: 4,
            lastReportAt: Date.UTC(2027, 0, 14, 3, 0),
          },
        ]}
        timeZone="America/New_York"
      />,
    );
    const row = screen.getByText('Mascoma Lake').closest('tr') as HTMLElement;
    expect(within(row).getByText('13 Jan')).toBeTruthy();
  });
  // The empty list-end tab measures its face (`document.fonts`), which jsdom lacks: the Quiet
  // story checks it in a browser.
});

describe('Coverage by state', () => {
  it('splits the listed bodies by state, each in its own swatch', () => {
    const { container } = render(<ListedBodiesBar data={BOARD_COVERAGE} />);
    const shares = [...container.querySelectorAll<HTMLElement>('[data-slot="state-share"]')];
    expect(shares.map((s) => s.dataset.state)).toEqual(['VT', 'NH', 'ME', 'NY', 'MA']);
    expect(shares[1]?.style.flexGrow).toBe('6120');
    expect(shares[0]?.style.background).toBe('var(--fg)');
    expect(screen.getByText('24,953')).toBeTruthy();
  });

  it('names states in full, writes the rate, and dims a zero', () => {
    render(<CoverageByState data={BOARD_COVERAGE} />);
    const nh = screen.getByText('New Hampshire').closest('tr') as HTMLElement;
    expect(within(nh).getByText('1.47')).toBeTruthy();
    const ny = screen.getByText('New York').closest('tr') as HTMLElement;
    for (const zero of within(ny).getAllByText('0')) expect(zero.className).toContain('text-fg3');
  });

  it('reads an unrecorded column as a dash, never a zero', () => {
    const { container } = render(<CoverageByState data={RECORDED_COVERAGE} />);
    const dashes = container.querySelectorAll('[data-unrecorded]');
    expect(dashes).toHaveLength(20);
    for (const dash of dashes) expect(dash.textContent).toBe('—');
  });

  it('reads an unrecorded report count as a dash in the rate too', () => {
    render(
      <CoverageByState
        data={{
          listedBodies: 10,
          states: [
            {
              state: 'QC',
              bodies: 10,
              reports: null,
              comments: null,
              photos: null,
              kudos: null,
              contributors: null,
            },
          ],
        }}
      />,
    );
    const row = screen.getByText('QC').closest('tr') as HTMLElement;
    // Six count columns and the rate: every one a dash.
    expect(within(row).getAllByText('—')).toHaveLength(6);
  });
});

describe('the tab before its reads exist', () => {
  const unread = metricsNotRecorded(BOARD_DAYS, { support: true });

  it('says every stat is not recorded, and guesses no "nothing open"', () => {
    render(<KeepingUpStats data={unread.keepingUp} now={METRICS_NOW} />);
    expect(screen.getAllByText('Not recorded yet')).toHaveLength(4);
    expect(screen.queryByText('Nothing open')).toBeNull();
    for (const value of document.querySelectorAll('[data-slot="value"]')) {
      expect(value).toHaveTextContent('—');
    }
  });

  it('draws the week unread on the right too', () => {
    render(<ShowingUpStats week={unread.showingUp.week} />);
    expect(screen.getAllByText('Not recorded yet')).toHaveLength(4);
  });

  // The two tables' unread list-end tabs measure their face (`document.fonts`), which jsdom lacks:
  // the Not read yet story checks them in a browser.
  it('draws vantage and the listed bodies as unread, never as zero', () => {
    render(
      <>
        <VantageSplit counts={unread.showingUp.vantage} />
        <ListedBodiesBar data={unread.coverage} />
      </>,
    );
    expect(screen.getByText('Not recorded yet')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Not recorded yet' })).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('leaves the support half out for a viewer who may not read it', () => {
    const modView = metricsNotRecorded(BOARD_DAYS, { support: false });
    expect(modView.keepingUp.support).toBeNull();
    render(<KeepingUpStats data={modView.keepingUp} now={METRICS_NOW} />);
    expect(screen.queryByText('Open tickets')).toBeNull();
  });
});
