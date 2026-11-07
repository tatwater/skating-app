import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AddressField, splitAddress } from './AddressField';
import type { AddressLookup } from './geocoder';

const ATTR = 'Powered by Geoapify | © OpenStreetMap contributors';
const LIST: AddressLookup = {
  state: 'ok',
  attribution: ATTR,
  suggestions: [
    { label: '14 School Street, Hanover, NH 03755, USA', lat: 43.7, lng: -72.29 },
    { label: '14 School Street, Lebanon, NH 03766, USA', lat: 43.64, lng: -72.25 },
    { label: '14 Schoolhouse Road, Canaan, NH 03741', lat: 43.66, lng: -72.01 },
  ],
};

function field(lookup: AddressLookup = LIST, value = '14 School') {
  const onPick = vi.fn();
  const onValueChange = vi.fn();
  const utils = render(
    <AddressField
      label="Home address"
      hint="We work out your drive-time zones from it."
      value={value}
      onValueChange={onValueChange}
      lookup={lookup}
      onPick={onPick}
    />,
  );
  return { ...utils, onPick, onValueChange, input: screen.getByRole('combobox') };
}

describe('splitAddress', () => {
  it('splits the street from the rest and drops the country', () => {
    expect(splitAddress('14 School Street, Hanover, NH 03755, USA')).toEqual({
      street: '14 School Street',
      rest: 'Hanover, NH 03755',
    });
    expect(splitAddress('Hanover')).toEqual({ street: 'Hanover', rest: null });
    expect(splitAddress('Main St, USA')).toEqual({ street: 'Main St', rest: null });
  });
});

describe('AddressField', () => {
  it('lists the suggestions with the typed part bold and the attribution under them', () => {
    const { input } = field();
    expect(input).toHaveAttribute('aria-expanded', 'true');
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[0]?.querySelector('b')?.textContent).toBe('14 School');
    expect(screen.getByText(ATTR)).toBeInTheDocument();
    expect(input.closest('.ph-no-capture')).not.toBeNull();
  });

  it('↑↓ move the lit row (wrapping), Enter picks it, Esc closes the list', () => {
    const { input, onPick } = field();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    expect(input.getAttribute('aria-activedescendant')).toMatch(/-1$/);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith(LIST.state === 'ok' && LIST.suggestions[2]);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Esc closes the list once, and ↓ opens it again', () => {
    const outer = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: a stand-in for the page under the field
      <div onKeyDown={outer}>
        <AddressField
          label="Home address"
          hint="h"
          value="14 School"
          onValueChange={() => {}}
          lookup={LIST}
          onPick={() => {}}
        />
      </div>,
    );
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' }); // nothing open: not ours
    fireEvent.keyDown(input, { key: 'Enter' }); // nothing open: nothing picked
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('a press picks, a hover lights, and typing reopens', () => {
    const { input, onPick, onValueChange } = field();
    fireEvent.pointerMove(screen.getAllByRole('option')[1] as HTMLElement);
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.pointerDown(screen.getAllByRole('option')[1] as HTMLElement);
    fireEvent.click(screen.getAllByRole('option')[1] as HTMLElement);
    expect(onPick).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { value: '14 School S' } });
    expect(onValueChange).toHaveBeenCalledWith('14 School S');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('a new list starts lit at its top', () => {
    const { input, rerender, onPick } = field();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const next: AddressLookup = {
      state: 'loading',
      attribution: ATTR,
      suggestions: [{ label: 'Elm Street, Lebanon, NH', lat: 43.6, lng: -72.2 }],
    };
    rerender(
      <AddressField
        label="Home address"
        hint="h"
        value="Main"
        onValueChange={() => {}}
        lookup={next}
        onPick={onPick}
      />,
    );
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    // No match on the street: nothing bolded.
    expect(screen.getAllByRole('option')[0]?.querySelector('b')).toBeNull();
    // A loading list carries no attribution of its own until it lands.
    expect(screen.queryByText(ATTR)).toBeInTheDocument();
  });

  it('says so when suggestions fail, and draws no list', () => {
    field({ state: 'error', attribution: null }, 'Elm');
    expect(screen.getByText(/didn’t load/)).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
