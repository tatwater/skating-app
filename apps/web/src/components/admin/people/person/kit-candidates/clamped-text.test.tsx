import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClampedText, clampMeasure, clampOverflows } from './clamped-text';

/**
 * The clamped text (kit candidate): bounded by rendered lines, and "is there more" answered by the
 * rendered element, asked again as its width changes. jsdom lays nothing out, so the measure is
 * driven through its one seam (`clampMeasure.overflows`); the story proves the real thing.
 */

let overflowing = false;
const resized: Array<() => void> = [];
beforeEach(() => {
  overflowing = false;
  resized.length = 0;
  vi.spyOn(clampMeasure, 'overflows').mockImplementation(() => overflowing);
  vi.spyOn(globalThis, 'ResizeObserver').mockImplementation(function (
    this: unknown,
    callback: ResizeObserverCallback,
  ) {
    return {
      observe: () => resized.push(() => callback([], {} as ResizeObserver)),
      unobserve: () => {},
      disconnect: () => {},
    } as unknown as ResizeObserver;
  } as never);
});
afterEach(() => vi.restoreAllMocks());

/** The width changes: every observer hears it, as a browser tells them after a layout. */
const widthChanges = (over: boolean) =>
  act(() => {
    overflowing = over;
    for (const tell of resized) tell();
  });

const draw = (text = 'The ice by the north launch had been cut.\nIt froze over again.') =>
  render(
    <ClampedText lines={4} showAll="Show all" showLess="Show less">
      {text}
    </ClampedText>,
  );
const body = () => document.querySelector<HTMLElement>('[data-slot="clamped-text-body"]');

describe('ClampedText (kit candidate)', () => {
  it('clamps to its lines and offers nothing more while nothing is cut', () => {
    draw();
    expect(body()?.style.webkitLineClamp).toBe('4');
    expect(body()).toHaveAttribute('data-clamped');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers the rest exactly when the rendered text is cut, as a button that says its state', () => {
    overflowing = true;
    draw();
    const more = screen.getByRole('button', { name: 'Show all' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(more).toHaveAttribute('aria-controls', body()?.id);
  });

  it('shows it all on a press and clamps again on the next, focus staying on the button', async () => {
    overflowing = true;
    draw();
    await userEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(body()?.style.webkitLineClamp).toBe('');
    expect(body()).not.toHaveAttribute('data-clamped');
    const less = screen.getByRole('button', { name: 'Show less' });
    expect(less).toHaveAttribute('aria-expanded', 'true');
    expect(less).toHaveFocus();
    await userEvent.click(less);
    expect(body()?.style.webkitLineClamp).toBe('4');
    expect(screen.getByRole('button', { name: 'Show all' })).toHaveFocus();
  });

  it('keeps the text’s own line breaks, clamped or whole', async () => {
    overflowing = true;
    draw();
    expect(body()).toHaveClass('whitespace-pre-line');
    expect(body()?.textContent).toContain('\n');
    await userEvent.click(screen.getByRole('button'));
    expect(body()).toHaveClass('whitespace-pre-line');
  });

  it('asks again when its width changes: cut on a narrow screen, whole again on a wide one', () => {
    draw();
    expect(screen.queryByRole('button')).toBeNull();
    widthChanges(true);
    expect(screen.getByRole('button', { name: 'Show all' })).toBeInTheDocument();
    widthChanges(false);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('sends focus to the text, never the page, when the button it was on goes', () => {
    overflowing = true;
    draw();
    act(() => screen.getByRole('button').focus());
    widthChanges(false);
    expect(document.querySelector('[data-slot="clamped-text"]')).toHaveFocus();
  });

  it('asks again when the text changes', () => {
    const { rerender } = draw('Short');
    overflowing = true;
    rerender(
      <ClampedText lines={4} showAll="Show all" showLess="Show less">
        Longer now
      </ClampedText>,
    );
    expect(screen.getByRole('button', { name: 'Show all' })).toBeInTheDocument();
  });
});

describe('the measure', () => {
  const box = (o: { scroll: number; client: number; lineHeight?: string }) => {
    const el = document.createElement('span');
    Object.defineProperty(el, 'scrollHeight', { value: o.scroll });
    Object.defineProperty(el, 'clientHeight', { value: o.client });
    el.style.lineHeight = o.lineHeight ?? '';
    document.body.appendChild(el);
    return el;
  };

  it('is cut while clamped content runs past the box', () => {
    expect(clampOverflows(box({ scroll: 120, client: 80 }), 4)).toBe(true);
    expect(clampOverflows(box({ scroll: 80, client: 80 }), 4)).toBe(false);
  });

  it('would be cut, shown whole, when the text is taller than its lines', () => {
    expect(clampOverflows(box({ scroll: 120, client: 120, lineHeight: '20px' }), 4)).toBe(true);
    expect(clampOverflows(box({ scroll: 80, client: 80, lineHeight: '20px' }), 4)).toBe(false);
  });
});
