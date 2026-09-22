import { emptySheet, type ReportSheetState, sheetReducer } from '@skating/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChipRow, SheetChip } from './SheetChip';

const NOW = Date.UTC(2026, 0, 10, 20);

/**
 * The tiers are the sheet's one legend-free explanation of whose words a value is (D188), so they
 * are asserted on the accessible name rather than on a class: that is what a screen reader hears,
 * and it is the part that must not drift between the phone and the console.
 */
describe('SheetChip tiers', () => {
  it('a ghost reads as suggested and is not pressed', () => {
    render(<SheetChip label="Black ice" tier="ghost" onClick={() => {}} />);
    const chip = screen.getByRole('button', { name: 'Black ice, suggested' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
  });

  it('an extracted chip says where it came from and is already selected', () => {
    render(<SheetChip label="Black ice" tier="extracted" onClick={() => {}} />);
    const chip = screen.getByRole('button', { name: 'Black ice, from your writing' });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
  });

  it('a chip the author tapped is just its label, pressed; an unselected option is neither', () => {
    const { rerender } = render(<SheetChip label="Black ice" tier="solid" onClick={() => {}} />);
    expect(screen.getByRole('button', { name: 'Black ice' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    rerender(<SheetChip label="Black ice" onClick={() => {}} />);
    expect(screen.getByRole('button', { name: 'Black ice' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});

describe('ChipRow', () => {
  const OPTIONS = ['black_ice', 'snow_ice'] as const;
  const row = (sheet: ReportSheetState, spies: { select: () => void; deselect: () => void }) => (
    <ChipRow<'iceTypes', (typeof OPTIONS)[number]>
      sheet={sheet}
      field="iceTypes"
      options={OPTIONS}
      label={(v) => v}
      onSelect={spies.select}
      onDeselect={spies.deselect}
    />
  );

  it('draws the vocabulary in its own order, whatever the reducer holds', () => {
    // A ghost on the *second* option must not float it to the front — nothing reorders (D187).
    const sheet = sheetReducer(emptySheet(NOW, 'wb1'), {
      type: 'suggest',
      field: 'iceTypes',
      source: 'peer',
      values: [{ key: 'snow_ice', value: { type: 'snow_ice' } }],
    });
    render(row(sheet, { select: vi.fn(), deselect: vi.fn() }));
    const labels = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['black_ice', 'snow_ice, suggested']);
  });

  it('clicking an unselected option selects it; clicking a selected one deselects', () => {
    const spies = { select: vi.fn(), deselect: vi.fn() };
    const sheet = sheetReducer(emptySheet(NOW, 'wb1'), {
      type: 'select',
      field: 'iceTypes',
      key: 'black_ice',
      value: { type: 'black_ice' },
    });
    render(row(sheet, spies));
    fireEvent.click(screen.getByRole('button', { name: 'black_ice' }));
    expect(spies.deselect).toHaveBeenCalledWith('black_ice');
    fireEvent.click(screen.getByRole('button', { name: 'snow_ice' }));
    expect(spies.select).toHaveBeenCalledWith('snow_ice');
  });

  /** A ghost is an offer, never a fill: the first click on one is a *select*, not a deselect. */
  it('a ghost selects on the first click', () => {
    const spies = { select: vi.fn(), deselect: vi.fn() };
    const sheet = sheetReducer(emptySheet(NOW, 'wb1'), {
      type: 'suggest',
      field: 'iceTypes',
      source: 'peer',
      values: [{ key: 'black_ice', value: { type: 'black_ice' } }],
    });
    render(row(sheet, spies));
    fireEvent.click(screen.getByRole('button', { name: 'black_ice, suggested' }));
    expect(spies.select).toHaveBeenCalledWith('black_ice');
    expect(spies.deselect).not.toHaveBeenCalled();
  });
});
