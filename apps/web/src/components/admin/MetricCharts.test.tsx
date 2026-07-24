/**
 * The analytics-query → chart bridge (Phase 7b). What matters is that a not-yet-collected metric shows
 * a friendly empty state instead of a broken chart (these series are forward-only, so "empty" is the
 * common early case), and that every card carries its table fallback (D34). Recharts itself needs
 * layout jsdom doesn't provide, so these assert the scaffolding around the SVG, not the plot.
 */
import { render, screen } from '@testing-library/react';
import { ThemeProvider } from 'next-themes';
import { describe, expect, it, vi } from 'vitest';

const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock('convex/react', () => ({ useQuery }));

import { GateScatterCard, MetricComposition, ScalarTrend, useCatalogue } from './MetricCharts';

function withTheme(node: React.ReactNode) {
  return render(<ThemeProvider attribute="class">{node}</ThemeProvider>);
}

describe('ScalarTrend', () => {
  it('shows an empty state when every day in the window is unmeasured', () => {
    useQuery.mockReturnValue({
      dates: ['2026-01-01', '2026-01-02'],
      series: { signups: [{ scalar: null }, { scalar: null }] },
    });
    withTheme(
      <ScalarTrend
        title="New accounts"
        metrics={[{ key: 'signups', label: 'Signups' }]}
        days={2}
      />,
    );
    expect(screen.getByText(/No data in the last 2 days yet/)).toBeInTheDocument();
  });

  it('offers the series as a table once there is data', () => {
    useQuery.mockReturnValue({
      dates: ['2026-01-01'],
      series: { signups: [{ scalar: 3 }] },
    });
    withTheme(
      <ScalarTrend title="New accounts" metrics={[{ key: 'signups', label: 'Signups' }]} />,
    );
    expect(screen.getByText('View as table')).toBeInTheDocument();
  });
});

describe('MetricComposition', () => {
  it('renders the humanized meta keys with their counts', () => {
    // The catalogue call and the latest call share the same mock; return by shape.
    useQuery.mockImplementation((_fn: unknown, args: { metrics?: string[] }) => {
      if (!args?.metrics)
        return [
          { key: 'bounty_outcomes', label: 'Bounty outcomes', kind: 'rollup', shape: 'meta' },
        ];
      return { bounty_outcomes: { date: '2026-01-01', meta: { fulfilled: 3, expired: 1 } } };
    });
    const catalogue = useCatalogue();
    withTheme(<MetricComposition metricKey="bounty_outcomes" catalogue={catalogue} semantic />);
    // The label appears in both the composition bar and the table fallback — both are wanted.
    expect(screen.getAllByText('Fulfilled').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Expired').length).toBeGreaterThan(0);
    expect(screen.getByText('75%')).toBeInTheDocument(); // 3 of 4 fulfilled
  });
});

describe('GateScatterCard', () => {
  it('explains the empty scatter rather than drawing a blank frame', () => {
    useQuery.mockReturnValue({ truncated: false, points: [] });
    withTheme(<GateScatterCard />);
    expect(screen.getByText(/fills as people post bounties/)).toBeInTheDocument();
  });
});
