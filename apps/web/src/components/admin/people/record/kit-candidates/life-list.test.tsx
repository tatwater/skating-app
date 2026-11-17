import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { LifeLineMeaning, LifeStation } from '@/components/kit/life-strip';

import { LifeList } from './life-list';

/** Its life, top to bottom (kit candidate): the strip's stations, marks and key, read down. */

const LINES: LifeLineMeaning[] = [
  { line: 'heavy', label: 'Visible to skaters' },
  { line: 'thin', label: 'Out of sight' },
];
const STATIONS: LifeStation[] = [
  { when: 'Tue 22 Sep', title: 'Posted', mark: 'dot', next: 'heavy', lasted: '1 day' },
  { when: 'Wed 23 Sep', title: 'Hidden', sub: 'By Ana', mark: 'hollow', next: 'thin' },
  { when: 'Today', title: 'On the record', mark: 'now', next: 'dashed', lasted: '21 days' },
  { when: 'If overturned', title: 'Erased Sun 25 Oct', mark: 'end', lasted: 'never drawn' },
];

const stations = () => [
  ...document.querySelectorAll<HTMLElement>('[data-slot="life-list-station"]'),
];

describe('LifeList (kit candidate)', () => {
  it('is a list named for its life, one item a station, each with its mark', () => {
    render(<LifeList aria-label="Its life" stations={STATIONS} lines={LINES} />);
    const list = screen.getByRole('list', { name: 'Its life' });
    expect(list.tagName).toBe('OL');
    expect(stations().map((s) => s.dataset.mark)).toEqual(['dot', 'hollow', 'now', 'end']);
    expect(stations()[1]).toHaveTextContent('By Ana');
  });

  it('draws each station’s line down to the next, the last none, and says what each means', () => {
    render(<LifeList aria-label="Its life" stations={STATIONS} lines={LINES} />);
    const lines = [...document.querySelectorAll<HTMLElement>('[data-slot="life-list-line"]')];
    expect(lines.map((l) => l.dataset.line)).toEqual(['heavy', 'thin', 'dashed']);
    expect(stations()[3]?.querySelector('[data-slot="life-list-line"]')).toBeNull();
    // A line the key doesn't hold is drawn, but says nothing it can't name.
    expect(stations()[0]).toHaveTextContent('Then: Visible to skaters');
    expect(stations()[1]).toHaveTextContent('Then: Out of sight');
    expect(stations()[2]).not.toHaveTextContent('Then:');
  });

  it('says how long each state lasted, but not after the last station', () => {
    render(<LifeList aria-label="Its life" stations={STATIONS} lines={LINES} />);
    expect(stations()[0]).toHaveTextContent('1 day');
    expect(stations()[2]).toHaveTextContent('21 days');
    expect(stations()[3]).not.toHaveTextContent('never drawn');
  });

  it('inks today and a warning in their tones', () => {
    render(
      <LifeList
        aria-label="Its life"
        stations={[
          { when: 'Fri 25 Sep', title: 'Deleted by Rob', mark: 'warn', next: 'thin' },
          { when: 'Today', title: 'On the record', mark: 'now' },
        ]}
        lines={LINES}
      />,
    );
    expect(screen.getByText('Fri 25 Sep')).toHaveClass('text-warn');
    expect(screen.getByText('Deleted by Rob')).toHaveClass('text-warn');
    expect(screen.getByText('On the record')).toHaveClass('text-fg');
  });

  it('draws the strip’s key under it unless told not to', () => {
    const { rerender } = render(
      <LifeList aria-label="Its life" stations={STATIONS} lines={LINES} />,
    );
    expect(document.querySelectorAll('[data-slot="life-key-item"]')).toHaveLength(2);
    rerender(<LifeList aria-label="Its life" stations={STATIONS} lines={LINES} showKey={false} />);
    expect(document.querySelector('[data-slot="life-key"]')).toBeNull();
  });
});
