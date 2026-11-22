import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SearchLane } from './search-lane';

/**
 * The search lane's one hard rule: typing belongs to the place it was typed in. The Bodies list was
 * caught sending a search typed in one lane after the operator had moved to another; these hold
 * every way the place can move.
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const field = () => screen.getByRole('searchbox', { name: 'Search any account' });
const type = (text: string) => fireEvent.change(field(), { target: { value: text } });

function draw(props: Partial<Parameters<typeof SearchLane>[0]> = {}) {
  const onSearch = vi.fn();
  const all = { value: '', label: 'Search any account', onSearch, place: 'a', ...props };
  const result = render(<SearchLane {...all} />);
  return {
    onSearch,
    redraw: (next: Partial<typeof all>) => result.rerender(<SearchLane {...all} {...next} />),
    ...result,
  };
}

describe('SearchLane', () => {
  it('sends what was typed, trimmed, once typing rests', () => {
    const { onSearch } = draw();
    type(' ro');
    type(' rob ');
    act(() => vi.advanceTimersByTime(249));
    expect(onSearch).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith('rob');
  });

  it('drops pending typing when the place moves, and shows the search the place holds', () => {
    const { onSearch, redraw } = draw({ value: 'kate' });
    type('kate d');
    // Another lane opens (its search is empty) before typing rests.
    redraw({ place: 'b', value: '' });
    act(() => vi.advanceTimersByTime(1_000));
    expect(onSearch).not.toHaveBeenCalled();
    expect(field()).toHaveValue('');
  });

  it('drops pending typing when the place moves even if both searches are the same', () => {
    const { onSearch, redraw } = draw();
    type('rob');
    redraw({ place: 'b' });
    act(() => vi.advanceTimersByTime(1_000));
    expect(onSearch).not.toHaveBeenCalled();
    expect(field()).toHaveValue('');
  });

  it('sends nothing once it is gone', () => {
    const { onSearch, unmount } = draw();
    type('rob');
    unmount();
    act(() => vi.advanceTimersByTime(1_000));
    expect(onSearch).not.toHaveBeenCalled();
  });

  it('follows the search the page holds when it changes from outside (the back button)', () => {
    const { redraw } = draw({ value: 'rob' });
    redraw({ value: 'kate' });
    expect(field()).toHaveValue('kate');
  });

  it('clears on Escape at once, and asks for nothing when nothing had been sent', () => {
    const { onSearch, redraw } = draw({ value: 'rob' });
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(onSearch).toHaveBeenCalledWith('');
    expect(field()).toHaveValue('');
    onSearch.mockClear();
    redraw({ value: '' });
    type('ka');
    fireEvent.keyDown(field(), { key: 'Escape' });
    act(() => vi.advanceTimersByTime(1_000));
    expect(onSearch).not.toHaveBeenCalled();
    // Escape on an empty field is the page's.
    expect(fireEvent.keyDown(field(), { key: 'Escape' })).toBe(true);
    // Other keys are the field's.
    expect(fireEvent.keyDown(field(), { key: 'a' })).toBe(true);
  });

  it('shows its key at rest, or none', () => {
    const { container, redraw } = draw();
    expect(container.querySelector('[data-slot="kbd"]')).toHaveTextContent('/');
    redraw({ focusKey: null });
    expect(container.querySelector('[data-slot="kbd"]')).toBeNull();
  });
});
