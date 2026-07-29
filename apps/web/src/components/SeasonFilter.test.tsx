import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SeasonEmptyState } from './SeasonFilter';

/**
 * The empty state is the only announcement the seasonal reset gets (D63). On July 1 a skater's
 * favourite lake goes blank, which is correct and will read as a bug unless the copy names the season
 * and points at the way back — so what it says is load-bearing, not decoration.
 */
describe('SeasonEmptyState', () => {
  it('names the season being browsed when a past one is empty', () => {
    render(<SeasonEmptyState browseSeason={2024} currentSeason={2026} />);
    expect(screen.getByText(/'24\/'25/)).toBeInTheDocument();
  });

  it('names this season and points at the menu when the current one is empty', () => {
    render(<SeasonEmptyState browseSeason={null} currentSeason={2026} />);
    // "No reports yet this '26/'27 season" — not a bare "no reports", which reads as a broken lake.
    expect(screen.getByText(/'26\/'27/)).toBeInTheDocument();
    expect(screen.getByText(/season menu/i)).toBeInTheDocument();
  });

  it('degrades to plain copy before the season list has loaded', () => {
    render(<SeasonEmptyState browseSeason={null} currentSeason={undefined} />);
    expect(screen.getByText(/be the first to say how it skates/i)).toBeInTheDocument();
  });
});
