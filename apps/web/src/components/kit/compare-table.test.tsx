import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CompareTable } from './compare-table';

/** The compare table: a real table, its heads toned by meaning, a cell lit where the two agree. */

const table = () =>
  render(
    <CompareTable
      aria-label="Same place?"
      columns={[
        { label: 'The ask', tone: 'lit' },
        { label: 'The Narrows · OpenStreetMap', tone: 'warn' },
      ]}
      rows={[
        {
          label: 'Name',
          cells: [
            { value: '“the Narrows”', same: true },
            { value: 'The Narrows', same: true },
          ],
        },
        { label: 'Kind', cells: [{ value: 'Landmark' }, { value: 'Narrows' }] },
        {
          label: 'Point',
          cells: [
            { value: '43.6702 −71.7588', mono: true },
            { value: '43.6760 −71.7571', mono: true },
          ],
        },
      ]}
    />,
  );

describe('CompareTable', () => {
  it('is a table named by its caller, its columns and rows headed', () => {
    table();
    const t = screen.getByRole('table', { name: 'Same place?' });
    expect(
      within(t)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['The ask', 'The Narrows · OpenStreetMap']);
    expect(
      within(t)
        .getAllByRole('rowheader')
        .map((h) => h.textContent),
    ).toEqual(['Name', 'Kind', 'Point']);
  });

  it('tones each head as asked, the default quiet', () => {
    table();
    const heads = screen.getAllByRole('columnheader');
    expect(heads.map((h) => h.dataset.tone)).toEqual(['lit', 'warn']);
    expect(heads[0]?.className).toContain('text-fg');
    expect(heads[1]?.className).toContain('text-warn');
  });

  it('lights a cell where the two agree, and sets a figure in mono', () => {
    table();
    const cells = screen.getAllByRole('cell').filter((c) => c.dataset.slot === 'compare-cell');
    expect(cells.filter((c) => c.hasAttribute('data-same')).map((c) => c.textContent)).toEqual([
      '“the Narrows”',
      'The Narrows',
    ]);
    expect(cells[4]?.className).toContain('family-mono');
    expect(cells[2]?.className).toContain('text-fg2');
  });
});
