import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { MiddleList } from './middle-list';

/**
 * The middle list's cursor isn't the focused element (focus stays on the list), so each keyboard
 * move scrolls the cursor's row into view — at its nearest edge, at once, never smoothly.
 */

const ITEMS = ['Alder cove', 'Birch point', 'Cedar bay', 'Dogwood inlet'].map((title, i) => ({
  id: `a${i}`,
  title,
}));

beforeAll(() => {
  if (!('fonts' in document)) {
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
  }
});

afterEach(() => {
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
  render(
    <MiddleList label="Open asks" emptyLabel="Nothing open" items={ITEMS} onOpen={() => {}} />,
  );
  const list = screen.getByRole('listbox', { name: 'Open asks' });
  fireEvent.focus(list);
  return { list, scrolled };
}

describe('MiddleList — the cursor in view', () => {
  it.each([
    ['ArrowDown', ['ArrowDown'], 'Birch point'],
    ['End', ['End'], 'Dogwood inlet'],
    ['Home', ['End', 'Home'], 'Alder cove'],
    ['type-ahead', ['c'], 'Cedar bay'],
  ])('%s reveals the cursor’s row at its nearest edge, never smoothly', (_n, keys, row) => {
    const { list, scrolled } = setup();
    for (const key of keys) fireEvent.keyDown(list, { key });
    expect(scrolled.at(-1)?.row).toContain(row);
    expect(scrolled.at(-1)?.options).toEqual({ block: 'nearest' });
  });
});
