import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FirstSkatedTile, IceWatchTile, ImageryTile, WinterTile } from './SeasonTiles';
import { isoDay } from './seasonFacts';

const tile = (label: string) =>
  screen.getByText(label, { selector: '[data-slot="stat-label"]' }).parentElement;

/** 1 July to 30 September: the new season has begun, its record hasn't (the founder, 2026-11-13). */
describe('the season’s four before its record begins', () => {
  const pending = { state: 'pending', opensOn: isoDay('2027-10-01') } as const;

  it('has the watch waiting, counting nights from the opening', () => {
    render(<IceWatchTile data={pending} />);
    expect(tile('Ice watch')).toHaveTextContent('WaitingCounting nights from 1 Oct');
  });

  it('has the other three say when the record begins, and nothing about last winter', () => {
    render(
      <>
        <WinterTile data={pending} />
        <ImageryTile data={pending} />
        <FirstSkatedTile data={pending} />
      </>,
    );
    for (const label of ['Winter, region-wide', 'Imagery', 'First skated']) {
      expect(tile(label)).toHaveTextContent('—Record begins 1 Oct');
    }
    expect(screen.queryByText(/Last winter/)).toBeNull();
  });

  it('keeps the unread state apart from the pending one', () => {
    render(<WinterTile data={null} />);
    expect(tile('Winter, region-wide')).toHaveTextContent('—Not recorded yet');
  });
});
