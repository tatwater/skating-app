/**
 * The chart kit renders under jsdom (Phase 7b). Recharts needs a real layout to draw its SVG, so these
 * assert the *scaffolding* — the accessible table view and the legend that keep identity from being
 * color-alone (D34) — plus that a chart mounts without throwing. The visual correctness is the dataviz
 * skill's validated palette, not something a DOM test can see.
 */
import { render, screen } from '@testing-library/react';
import { ThemeProvider } from 'next-themes';
import { describe, expect, it } from 'vitest';
import { ChartCard, ChartLegend, CompositionChart, MiniTable } from './Charts';

function withTheme(node: React.ReactNode) {
  return render(<ThemeProvider attribute="class">{node}</ThemeProvider>);
}

describe('ChartCard', () => {
  it('offers the data as a table — the non-visual path every chart must have', () => {
    withTheme(
      <ChartCard
        title="Signups"
        description="new accounts per day"
        table={<MiniTable headers={['Day', 'Count']} rows={[['Mon', 3]]} />}
      >
        <div>chart</div>
      </ChartCard>,
    );
    expect(screen.getByText('View as table')).toBeInTheDocument();
    expect(screen.getByText('new accounts per day')).toBeInTheDocument();
  });
});

describe('ChartLegend', () => {
  it('names every series so identity is never carried by color alone', () => {
    withTheme(
      <ChartLegend
        items={[
          { label: 'Allowed', color: '#159143' },
          { label: 'Suppressed', color: '#c81e2b' },
        ]}
      />,
    );
    expect(screen.getByText('Allowed')).toBeInTheDocument();
    expect(screen.getByText('Suppressed')).toBeInTheDocument();
  });
});

describe('CompositionChart', () => {
  it('sorts slices by magnitude and shows each value with its share', () => {
    withTheme(
      <CompositionChart
        slices={[
          { key: 'a', label: 'Allowed', value: 3 },
          { key: 's', label: 'Suppressed', value: 1 },
        ]}
      />,
    );
    const labels = screen.getAllByTitle(/Allowed|Suppressed/).map((el) => el.textContent);
    expect(labels[0]).toBe('Allowed'); // 3 sorts above 1
    expect(screen.getByText('75%')).toBeInTheDocument(); // 3 of 4
  });

  it('shows an empty state rather than a blank frame when there is nothing yet', () => {
    withTheme(<CompositionChart slices={[]} />);
    expect(screen.getByText('No data yet.')).toBeInTheDocument();
  });
});
