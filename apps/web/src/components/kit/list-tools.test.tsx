import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fc from 'fast-check';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { FacetMenu } from './facet-menu';
import { FilterChip, FilterChipRow, FilterCount } from './filter-chip';
import { matchParts, SearchMark } from './search-mark';
import { TableGroupRow } from './table-group-row';
import { LedStrip } from './trace-chart';

describe('matchParts', () => {
  it('marks every occurrence of the whole text, ignoring case and accents', () => {
    expect(matchParts('Lake Morey', 'mor')).toEqual([
      { text: 'Lake ', match: false },
      { text: 'Mor', match: true },
      { text: 'ey', match: false },
    ]);
    expect(matchParts('Memphrémagog', 'EMAG').filter((p) => p.match)).toEqual([
      { text: 'émag', match: true },
    ]);
    expect(matchParts('Morey Morses', 'mor').filter((p) => p.match)).toHaveLength(2);
  });
  it('marks nothing for a blank search or no match', () => {
    expect(matchParts('Echo Lake', '  ')).toEqual([{ text: 'Echo Lake', match: false }]);
    expect(matchParts('Echo Lake', 'xyz')).toEqual([{ text: 'Echo Lake', match: false }]);
  });
  it('never loses or adds a character', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (text, query) => {
        expect(
          matchParts(text, query)
            .map((p) => p.text)
            .join(''),
        ).toBe(text);
      }),
    );
  });
  it('draws the match as a mark', () => {
    render(
      <p>
        <SearchMark text="Moreau Lake" query="mor" />
      </p>,
    );
    expect(screen.getByText('Mor').tagName).toBe('MARK');
  });
});

describe('LedStrip', () => {
  it('is a meter with one segment per part, the lit ones marked', () => {
    render(<LedStrip aria-label="Complete" value={9} max={10} full size="tall" />);
    const meter = screen.getByRole('meter', { name: 'Complete' });
    expect(meter).toHaveAttribute('aria-valuenow', '9');
    expect(meter).toHaveAttribute('aria-valuetext', '9 of 10');
    const segs = meter.querySelectorAll('[data-slot="led-segment"]');
    expect(segs).toHaveLength(10);
    expect(meter.querySelectorAll('[data-on]')).toHaveLength(9);
  });
  it('clamps what it is handed', () => {
    render(<LedStrip aria-label="Over" value={14} max={10} />);
    render(<LedStrip aria-label="Under" value={-2} max={10} />);
    expect(screen.getByRole('meter', { name: 'Over' })).toHaveAttribute('aria-valuenow', '10');
    expect(screen.getByRole('meter', { name: 'Under' })).toHaveAttribute('aria-valuenow', '0');
  });
  it('draws a part not recorded yet dashed and leaves it out of the count', () => {
    render(<LedStrip aria-label="Known" segments={['on', 'off', 'unknown']} />);
    const meter = screen.getByRole('meter', { name: 'Known' });
    expect(meter).toHaveAttribute('aria-valuenow', '1');
    expect(meter).toHaveAttribute('aria-valuemax', '3');
    expect(meter.querySelectorAll('[data-state="unknown"]')).toHaveLength(1);
  });
});

describe('FilterChip', () => {
  it('names its remove button for the option it takes off', async () => {
    const onRemove = vi.fn();
    render(
      <FilterChipRow>
        <FilterChip facet="Size" onRemove={onRemove}>
          1,000 ac and up
        </FilterChip>
        <FilterCount count={1} />
      </FilterChipRow>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove Size: 1,000 ac and up' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

describe('TableGroupRow', () => {
  it('is a header for the rows under it, across every column', () => {
    render(
      <table>
        <tbody>
          <TableGroupRow colSpan={8} label="Dormant" count={4} />
        </tbody>
      </table>,
    );
    const head = screen.getByText('Dormant').closest('th') as HTMLElement;
    expect(head).toHaveTextContent('Dormant4');
    expect(head).toHaveAttribute('colspan', '8');
    expect(head).toHaveAttribute('scope', 'colgroup');
  });
});

describe('FacetMenu', () => {
  const FACETS = [
    {
      id: 'class',
      label: 'Class',
      options: [
        { id: 'lake', label: 'Lake', count: 132 },
        { id: 'pond', label: 'Pond', count: 6 },
      ],
    },
    {
      id: 'outline',
      label: 'Outline',
      options: [{ id: 'catalog', label: 'From a catalog', disabled: true }],
    },
    {
      id: 'size',
      label: 'Size',
      options: [
        { id: 'small', label: 'Under 10 ac' },
        { id: 'mid', label: '10–100' },
        { id: 'big', label: '1,000 and up', count: 0 },
      ],
    },
  ];
  function Harness({ onToggle }: { onToggle: (f: string, o: string) => void }) {
    const [selected, setSelected] = useState<Record<string, string[]>>({ size: ['mid'] });
    return (
      <FacetMenu
        facets={FACETS}
        selected={selected}
        onToggle={(f, o) => {
          onToggle(f, o);
          setSelected((s) => {
            const cur = s[f] ?? [];
            return { ...s, [f]: cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o] };
          });
        }}
      />
    );
  }

  it('starts on the applied option, with one tab stop', () => {
    render(<Harness onToggle={() => {}} />);
    const mid = screen.getByRole('button', { name: '10–100' });
    expect(mid).toHaveAttribute('aria-pressed', 'true');
    expect(mid).toHaveAttribute('tabindex', '0');
    expect(
      screen.getAllByRole('button').filter((b) => b.getAttribute('tabindex') === '0'),
    ).toHaveLength(1);
  });
  it('moves ↑↓ between facets (skipping one with nothing live), ←→ along one, Space applies', async () => {
    const onToggle = vi.fn();
    render(<Harness onToggle={onToggle} />);
    screen.getByRole('button', { name: '10–100' }).focus();
    await userEvent.keyboard('{ArrowUp}');
    // Outline has nothing live: ↑ goes on to Class, at the nearest place along the row.
    expect(screen.getByRole('button', { name: /^Pond/ })).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}{ }');
    expect(onToggle).toHaveBeenLastCalledWith('class', 'lake');
    expect(screen.getByRole('button', { name: /^Lake/ })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.keyboard('{ArrowDown}{End}');
    expect(screen.getByRole('button', { name: /^1,000 and up/ })).toHaveFocus();
    await userEvent.keyboard('{Home}{Enter}');
    expect(onToggle).toHaveBeenLastCalledWith('size', 'small');
    // The facet with focus is the current one.
    const current = screen
      .getAllByRole('group')
      .find((g) => g.hasAttribute('data-current')) as HTMLElement;
    expect(within(current).getByText('Size')).toBeInTheDocument();
  });
  it('keeps its counts, a zero included, and leaves a disabled option inert', async () => {
    const onToggle = vi.fn();
    render(<Harness onToggle={onToggle} />);
    expect(screen.getByRole('button', { name: /^1,000 and up/ })).toHaveTextContent('0');
    const disabled = screen.getByRole('button', { name: 'From a catalog' });
    expect(disabled).toBeDisabled();
    await userEvent.click(disabled);
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.getByText('Facet')).toBeInTheDocument();
  });
});
