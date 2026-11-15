import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BulletList } from './bullet-list';

/**
 * The cursor isn't the focused element (focus stays on the list), so the browser won't reveal it:
 * every keyboard move scrolls the cursor's row into view, at once — never smoothly, so reduced
 * motion holds — and a press scrolls nothing.
 */

const ITEMS = ['Alder cove', 'Birch point', 'Cedar bay', 'Dogwood inlet'].map((title, i) => ({
  id: `a${i}`,
  kicker: 'Bay name · Inbox',
  title,
}));

afterEach(() => vi.restoreAllMocks());

afterEach(() => {
  // jsdom has no scrollIntoView; each test lends one.
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

function setup() {
  const scrolled: { row: string | null; options: unknown }[] = [];
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value(this: Element, options?: boolean | ScrollIntoViewOptions) {
      scrolled.push({ row: this.textContent, options });
    },
  });
  const onOpen = vi.fn();
  render(<BulletList label="Asked of this body" items={ITEMS} onOpen={onOpen} />);
  const list = screen.getByRole('listbox', { name: 'Asked of this body' });
  list.focus();
  return { list, scrolled, onOpen };
}

describe('BulletList — the cursor in view', () => {
  it.each([
    ['ArrowDown', { key: 'ArrowDown' }, 'Birch point'],
    ['End', { key: 'End' }, 'Dogwood inlet'],
    ['type-ahead', { key: 'c' }, 'Cedar bay'],
  ])('%s scrolls the cursor’s row into view, at its nearest edge, at once', (_n, key, row) => {
    const { list, scrolled } = setup();
    fireEvent.keyDown(list, key);
    expect(scrolled.at(-1)?.row).toContain(row);
    expect(scrolled.at(-1)?.options).toEqual({ block: 'nearest' });
    expect(list.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: new RegExp(row) }).id,
    );
  });

  it('Home goes back to the first row and reveals it', () => {
    const { list, scrolled } = setup();
    fireEvent.keyDown(list, { key: 'End' });
    fireEvent.keyDown(list, { key: 'Home' });
    expect(scrolled.at(-1)?.row).toContain('Alder cove');
  });

  it('never scrolls smoothly, so a reader who asked for reduced motion gets none', () => {
    const { list, scrolled } = setup();
    for (const key of ['ArrowDown', 'ArrowUp', 'End', 'Home', 'b'])
      fireEvent.keyDown(list, { key });
    expect(scrolled.length).toBe(5);
    for (const s of scrolled) expect(JSON.stringify(s.options)).not.toContain('smooth');
  });

  it('a press opens the row and scrolls nothing', () => {
    const { scrolled, onOpen } = setup();
    fireEvent.click(screen.getByRole('option', { name: /Cedar bay/ }));
    expect(onOpen).toHaveBeenCalledWith('a2');
    expect(scrolled).toEqual([]);
  });
});
