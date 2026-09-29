/**
 * The chart kit renders under jsdom (Phase 07-2). Recharts needs a real layout to draw its SVG, so these
 * assert the *scaffolding* — the accessible table view and the legend that keep identity from being
 * color-alone (D34) — plus that a chart mounts without throwing. The visual correctness is the dataviz
 * skill's validated palette, not something a DOM test can see.
 */
import { render, screen } from '@testing-library/react';
import { ThemeProvider } from 'next-themes';
import { describe, expect, it } from 'vitest';
import {
  ChartCard,
  ChartLegend,
  CompositionChart,
  formatShare,
  formatTooltipValue,
  MiniTable,
  timeSeriesYAxis,
} from './Charts';

function withTheme(node: React.ReactNode) {
  return render(<ThemeProvider attribute="class">{node}</ThemeProvider>);
}

describe('timeSeriesYAxis', () => {
  it('keeps counts on whole-number ticks and a fixed axis', () => {
    expect(timeSeriesYAxis(false)).toEqual({ allowDecimals: false, width: 40 });
  });

  it('gives a fraction decimal ticks and an axis sized to its labels', () => {
    // Whole-number ticks drew a 0.4% share on a 0–400% axis; a fixed 40 px clipped `0.450%`.
    expect(timeSeriesYAxis(true)).toEqual({ allowDecimals: true, width: 'auto' });
  });
});

describe('formatTooltipValue', () => {
  const percent = (v: number) => `${Math.round(v * 100)}%`;

  it('formats a measured value', () => {
    expect(formatTooltipValue(0.42, percent)).toBe('42%');
    expect(formatTooltipValue(0, percent)).toBe('0%');
  });

  it('shows a never-measured day as absent rather than formatting it', () => {
    expect(formatTooltipValue(null, percent)).toBe('—');
    expect(formatTooltipValue(undefined, percent)).toBe('—');
  });
});

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

/**
 * The catalog-coverage panel's whole job is to be readable while the number it reports is almost zero — USGS has
 * re-surveyed 0% of our five states and will for some years. A formatter that rounds to whole
 * percents renders every one of those years as "0%", which reads as a broken chart rather than as a
 * real measurement, and would hide the first genuine movement when it finally arrives.
 */
describe('formatShare', () => {
  it('keeps the zero honest and unadorned', () => {
    expect(formatShare(0)).toBe('0%');
  });

  it('distinguishes the first real movement from zero', () => {
    // The live service's actual reading on 2026-08-03: 1,590 of 356,980.
    expect(formatShare(1590 / 356_980)).toBe('0.445%');
    // A whole-percent formatter would render both of these as "0%".
    expect(formatShare(0)).not.toBe(formatShare(1590 / 356_980));
  });

  it('scales precision to the value rather than fixing it', () => {
    expect(formatShare(0.00005)).toBe('0.0050%'); // one work unit in a big state
    expect(formatShare(0.004)).toBe('0.400%');
    expect(formatShare(0.055)).toBe('5.5%');
    expect(formatShare(0.42)).toBe('42%'); // the day this matters, decimals are noise
  });

  it('renders an unmeasured value as absent, never as zero', () => {
    // A year we did not measure is not a year with no coverage.
    expect(formatShare(null)).toBe('—');
    expect(formatShare(undefined)).toBe('—');
  });
});
