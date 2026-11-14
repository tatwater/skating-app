import { act, fireEvent, render } from '@testing-library/react';
import fc from 'fast-check';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { KeysProvider } from '@/lib/keys';
import { BodiesTable, resetScrollMemory } from './BodiesTable';
import type { BodiesListData } from './bodiesData';
import { BIG_ROWS, LIST_ACTIVE, NOW } from './bodiesFixtures';
import { laneById } from './bodyLanes';
import { spacedRows, withPinned } from './virtualRows';

/**
 * A virtualized table can't place a row at its own offset, so the rows it doesn't render are
 * spacers. A row pinned into the range — the cursor's — sits apart from the visible run, and the
 * rows between them must still take their room: a row's place never depends on which other rows
 * happen to be rendered.
 */

beforeAll(() => {
  if (!('fonts' in document)) {
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
  }
});

const ROW = 32;
const GROUP = 40;

/** The run the virtualizer renders on its own: `start` to `end`, inclusive. */
const span = (start: number, end: number) =>
  Array.from({ length: end - start + 1 }, (_, i) => start + i);

/** What the virtualizer hands for `indices`, from every row's height. */
function placed(heights: readonly number[], indices: readonly number[]) {
  const starts: number[] = [];
  let at = 0;
  for (const h of heights) {
    starts.push(at);
    at += h;
  }
  return {
    total: at,
    starts,
    items: indices.map((index) => ({
      index,
      start: starts[index] as number,
      end: (starts[index] as number) + (heights[index] as number),
    })),
  };
}

/** Each rendered row's offset, walking the laid-out body from the top. */
function offsets(heights: readonly number[], laid: ReturnType<typeof spacedRows>) {
  const at = new Map<number, number>();
  let y = 0;
  for (const part of laid) {
    if (part.kind === 'pad') y += part.height;
    else {
      at.set(part.item.index, y);
      y += heights[part.item.index] as number;
    }
  }
  return { at, height: y };
}

describe('the virtual rows as table rows', () => {
  it('cursor on row 0, rows 100–120 in view: rows 1–99 keep their room', () => {
    const heights = Array.from({ length: 300 }, () => ROW);
    const { items, total } = placed(heights, withPinned(span(100, 120), [0]));
    const laid = spacedRows(items, total);
    const { at, height } = offsets(heights, laid);
    expect(at.get(0)).toBe(0);
    expect(at.get(100)).toBe(100 * ROW);
    expect(height).toBe(total);
    expect(laid[1]).toEqual({ kind: 'pad', key: 'pad-gap-0', height: 99 * ROW });
  });

  it('any heights, any scroll, any pinned rows: the whole height, every row at its own offset, every pin present (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(ROW, GROUP, ROW, ROW, 52), { minLength: 1, maxLength: 400 }),
        fc.nat(),
        fc.nat(40),
        fc.array(fc.nat(), { maxLength: 4 }),
        (heights, start, run, pins) => {
          const n = heights.length;
          const startIndex = start % n;
          const endIndex = Math.min(n - 1, startIndex + run);
          const pinned = pins.map((p) => p % n);
          // -1 is the cursor not found in the list: no row.
          const indices = withPinned(span(startIndex, endIndex), [...pinned, -1]);
          const { items, total, starts } = placed(heights, indices);
          const laid = spacedRows(items, total);
          const { at, height } = offsets(heights, laid);
          // (a) The scrollable height is every row's height.
          expect(height).toBe(heights.reduce((a, b) => a + b, 0));
          // (b) Every rendered row sits at the sum of the heights before it.
          for (const [index, y] of at) expect(y).toBe(starts[index]);
          // (c) The pinned rows are there, and the visible run.
          for (const p of pinned) expect(at.has(p)).toBe(true);
          for (let i = startIndex; i <= endIndex; i++) expect(at.has(i)).toBe(true);
          // No spacer is empty or negative.
          for (const part of laid) if (part.kind === 'pad') expect(part.height).toBeGreaterThan(0);
        },
      ),
    );
  });
});

describe('the Bodies table, scrolled away from its cursor', () => {
  // jsdom lays nothing out: the scroller is 640 px tall and each row its own height.
  const realOffset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  const realClient = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');
  const realRect = Element.prototype.getBoundingClientRect;
  const heightOf = (el: Element) =>
    el.getAttribute('data-slot') === 'bodies-scroll'
      ? 640
      : el.tagName === 'TR' && el.hasAttribute('data-index')
        ? el.getAttribute('data-slot') === 'table-group-row'
          ? GROUP
          : ROW
        : 0;
  beforeEach(() => {
    resetScrollMemory();
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return heightOf(this);
      },
    });
    Object.defineProperty(Element.prototype, 'clientHeight', {
      configurable: true,
      get(this: Element) {
        return heightOf(this);
      },
    });
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const height = heightOf(this);
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 800,
        bottom: height,
        width: 800,
        height,
        toJSON() {},
      };
    };
  });
  afterEach(() => {
    if (realOffset) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', realOffset);
    if (realClient) Object.defineProperty(Element.prototype, 'clientHeight', realClient);
    Element.prototype.getBoundingClientRect = realRect;
  });

  it('keeps the cursor row rendered and every row at its own offset', () => {
    const lane = laneById('active');
    // Past the hundred rows the table starts virtualizing at.
    const rows = Array.from({ length: 300 }, (_, i) => {
      const r = BIG_ROWS[i % BIG_ROWS.length] as (typeof BIG_ROWS)[number];
      return { ...r, id: `${r.id}-${i}` };
    });
    const list: BodiesListData = { ...LIST_ACTIVE, rows, status: 'done' };
    const { container } = render(
      <KeysProvider>
        <BodiesTable
          lane={lane}
          list={list}
          q=""
          sort={lane.sort}
          selectedId={null}
          now={NOW}
          onSort={() => {}}
          onSelect={() => {}}
          onOpen={() => {}}
          memoryKey="virtual"
        />
      </KeysProvider>,
    );
    const scroller = container.querySelector('[data-slot=bodies-scroll]') as HTMLElement;
    act(() => {
      scroller.scrollTop = 100 * ROW;
      fireEvent.scroll(scroller);
    });
    const body = container.querySelector('[data-slot=bodies-grid] tbody') as HTMLElement;
    let y = 0;
    const at = new Map<number, number>();
    for (const tr of body.children) {
      const index = tr.getAttribute('data-index');
      if (index === null) {
        y += Number.parseFloat((tr as HTMLElement).style.height || '0');
        continue;
      }
      at.set(Number(index), y);
      y += ROW;
    }
    // The cursor's row (the first) stays, so focus and the active descendant hold.
    expect(at.get(0)).toBe(0);
    expect(container.querySelector('[data-cursor]')?.getAttribute('data-index')).toBe('0');
    // The rows in view are where they belong, and the table is as tall as every row.
    expect(at.get(100)).toBe(100 * ROW);
    // The overscan holds: rows just out of view are rendered too.
    expect(at.has(100 - 12)).toBe(true);
    for (const [index, top] of at) expect(top).toBe(index * ROW);
    expect(y).toBe(rows.length * ROW);
    // Spacers are hidden from assistive tech: the grid's rows are only its rows.
    for (const pad of body.querySelectorAll('[data-slot=bodies-pad]')) {
      expect(pad).toHaveAttribute('aria-hidden', 'true');
    }
  });
});
