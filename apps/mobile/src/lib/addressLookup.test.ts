import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AddressLookup,
  attributionSpans,
  createAddressLookup,
  lookupAttribution,
  resetGeocoderSession,
  SUGGEST_DEBOUNCE_MS,
  type SuggestResult,
  settleLookup,
  shownSuggestions,
  splitAddress,
} from './addressLookup';

const ATTRIBUTION = 'Powered by Geoapify | © OpenStreetMap contributors';
const SCHOOL = { label: '14 School Street, Hanover, NH 03755, USA', lat: 43.7, lng: -72.29 };
const ok = (suggestions = [SCHOOL]): SuggestResult => ({
  status: 'ok',
  suggestions,
  attribution: ATTRIBUTION,
});
const unavailable = (reason: 'off' | 'quota' | 'error'): SuggestResult => ({
  status: 'unavailable',
  reason,
  suggestions: [],
});

beforeEach(() => {
  vi.useFakeTimers();
  resetGeocoderSession();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(answer: (text: string) => Promise<SuggestResult> = () => Promise.resolve(ok())) {
  const suggest = vi.fn(({ text }: { text: string }) => answer(text));
  const seen: AddressLookup[] = [];
  const lookup = createAddressLookup({ suggest, onChange: (l) => seen.push(l) });
  return { suggest, seen, lookup };
}

describe('createAddressLookup', () => {
  it('learns the provider is on with a free empty ask, then debounces the typing', async () => {
    const { suggest, lookup } = setup();
    expect(suggest).toHaveBeenCalledWith({ text: '' });
    await vi.runAllTimersAsync();
    expect(lookup.current()).toEqual({ state: 'idle', attribution: ATTRIBUTION });

    lookup.setText('14 S');
    lookup.setText('14 Sc');
    lookup.setText('14 School');
    expect(lookup.current().state).toBe('loading');
    await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS - 1);
    expect(suggest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(suggest).toHaveBeenCalledTimes(2);
    expect(suggest).toHaveBeenLastCalledWith({ text: '14 School' });
    expect(lookup.current()).toEqual({
      state: 'ok',
      attribution: ATTRIBUTION,
      suggestions: [SCHOOL],
    });
  });

  it('never asks below three characters', async () => {
    const { suggest, lookup } = setup();
    await vi.runAllTimersAsync();
    lookup.setText('  14 ');
    await vi.runAllTimersAsync();
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(lookup.current()).toEqual({ state: 'idle', attribution: ATTRIBUTION });
  });

  it('keeps the last list while the next call is out', async () => {
    const { lookup } = setup();
    await vi.runAllTimersAsync();
    lookup.setText('14 School');
    await vi.runAllTimersAsync();
    lookup.setText('14 School S');
    expect(shownSuggestions(lookup.current())).toEqual([SCHOOL]);
  });

  it('drops an answer for text that has since changed', async () => {
    let release!: (r: SuggestResult) => void;
    const { lookup } = setup((text) =>
      text === '14 School'
        ? new Promise((r) => {
            release = r;
          })
        : Promise.resolve(ok([])),
    );
    await vi.runAllTimersAsync();
    lookup.setText('14 School');
    await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS);
    lookup.setText('Main');
    await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS);
    release(ok());
    await vi.runAllTimersAsync();
    expect(shownSuggestions(lookup.current())).toEqual([]);
  });

  it('an emptied field closes its list and forgets the query, an answer still out included', async () => {
    let release!: (r: SuggestResult) => void;
    const { suggest, lookup } = setup((text) =>
      text === '14 School Street'
        ? new Promise((r) => {
            release = r;
          })
        : Promise.resolve(ok()),
    );
    await vi.runAllTimersAsync();
    lookup.setText('14 School');
    await vi.runAllTimersAsync();
    expect(shownSuggestions(lookup.current())).toEqual([SCHOOL]);
    // What the skater typed, echoed back as the value: nothing changes.
    lookup.setValue('14 School');
    expect(shownSuggestions(lookup.current())).toEqual([SCHOOL]);
    // A failed skip empties the field from outside: no list for words no longer there.
    lookup.setValue('');
    expect(lookup.current()).toEqual({ state: 'idle', attribution: ATTRIBUTION });
    // An answer out when the field was emptied is dropped too, and a pending ask never goes.
    lookup.setText('14 School Street');
    await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS);
    lookup.setText('14 School Street, Han');
    lookup.setValue('');
    release(ok());
    await vi.runAllTimersAsync();
    expect(shownSuggestions(lookup.current())).toEqual([]);
    expect(suggest).toHaveBeenCalledTimes(3);
    // A pick sets the value from outside too: the list closes and the old query is gone.
    lookup.setText('14 School');
    await vi.runAllTimersAsync();
    lookup.setValue(SCHOOL.label);
    expect(shownSuggestions(lookup.current())).toEqual([]);
  });

  it('stops asking for the session after a quota refusal', async () => {
    const first = setup((text) => Promise.resolve(text ? unavailable('quota') : ok()));
    await vi.runAllTimersAsync();
    first.lookup.setText('14 School');
    await vi.runAllTimersAsync();
    expect(first.lookup.current()).toEqual({ state: 'quota' });
    first.lookup.setText('14 School Street');
    await vi.runAllTimersAsync();
    expect(first.suggest).toHaveBeenCalledTimes(2);
    // A new field in the same session doesn't ask at all.
    const second = setup();
    expect(second.suggest).not.toHaveBeenCalled();
    expect(second.lookup.current()).toEqual({ state: 'quota' });
  });

  it('learns once that no provider is on', async () => {
    const { lookup } = setup(() => Promise.resolve(unavailable('off')));
    await vi.runAllTimersAsync();
    expect(lookup.current()).toEqual({ state: 'off' });
  });

  it('a latch hit by another field while this one waited stops the call', async () => {
    const { suggest, lookup } = setup();
    await vi.runAllTimersAsync();
    lookup.setText('14 School');
    // Another field hits the limit meanwhile.
    settleLookup(unavailable('quota'), '14', null);
    await vi.runAllTimersAsync();
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(lookup.current()).toEqual({ state: 'quota' });
  });

  it('says a failed call failed, keeping the credit, and recovers on the next', async () => {
    let fail = true;
    const { lookup } = setup((text) =>
      text && fail ? Promise.reject(new Error('offline')) : Promise.resolve(ok()),
    );
    await vi.runAllTimersAsync();
    lookup.setText('14 School');
    await vi.runAllTimersAsync();
    expect(lookup.current()).toEqual({ state: 'error', attribution: ATTRIBUTION });
    fail = false;
    lookup.setText('14 School S');
    await vi.runAllTimersAsync();
    expect(lookup.current().state).toBe('ok');
  });

  it('reads an error from the provider as a failed call', async () => {
    const { lookup } = setup((text) => Promise.resolve(text ? unavailable('error') : ok()));
    await vi.runAllTimersAsync();
    lookup.setText('14 School');
    await vi.runAllTimersAsync();
    expect(lookup.current()).toEqual({ state: 'error', attribution: ATTRIBUTION });
  });

  it('a failed first ask reads as an error with no credit yet', async () => {
    const { lookup } = setup(() => Promise.reject(new Error('offline')));
    await vi.runAllTimersAsync();
    expect(lookup.current()).toEqual({ state: 'error', attribution: null });
  });

  it('leaves an unknown field alone below three characters', async () => {
    const { lookup } = setup(() => new Promise(() => {}));
    lookup.setText('14');
    expect(lookup.current()).toEqual({ state: 'unknown' });
  });

  it('a first answer arriving after typing has moved on changes nothing', async () => {
    let first!: (r: SuggestResult) => void;
    const { lookup } = setup((text) =>
      text === ''
        ? new Promise((r) => {
            first = r;
          })
        : Promise.resolve(ok()),
    );
    lookup.setText('14 School');
    await vi.runAllTimersAsync();
    first(unavailable('off'));
    await vi.runAllTimersAsync();
    expect(lookup.current().state).toBe('ok');
  });

  it('a failed first answer after typing has moved on changes nothing', async () => {
    let first!: (e: unknown) => void;
    const { lookup } = setup((text) =>
      text === ''
        ? new Promise((_, reject) => {
            first = reject;
          })
        : Promise.resolve(ok()),
    );
    lookup.setText('14 School');
    await vi.runAllTimersAsync();
    first(new Error('late'));
    await vi.runAllTimersAsync();
    expect(lookup.current().state).toBe('ok');
  });

  it('says nothing and calls nothing after dispose', async () => {
    const { suggest, seen, lookup } = setup();
    await vi.runAllTimersAsync();
    lookup.setText('14 School');
    const count = seen.length;
    lookup.dispose();
    await vi.runAllTimersAsync();
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(count);
  });

  it('a first answer after dispose is kept quiet, and dispose with nothing pending is safe', async () => {
    const { seen, lookup } = setup();
    lookup.dispose();
    await vi.runAllTimersAsync();
    expect(seen).toHaveLength(0);
  });

  it('a failed call after newer text is dropped', async () => {
    let fail!: (e: unknown) => void;
    const { lookup } = setup((text) =>
      text === '14 School'
        ? new Promise((_, reject) => {
            fail = reject;
          })
        : Promise.resolve(ok([])),
    );
    await vi.runAllTimersAsync();
    lookup.setText('14 School');
    await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS);
    lookup.setText('Main');
    await vi.runAllTimersAsync();
    fail(new Error('late'));
    await vi.runAllTimersAsync();
    expect(lookup.current().state).toBe('ok');
  });
});

describe('lookupAttribution', () => {
  it('reads the credit wherever one is known', () => {
    expect(lookupAttribution({ state: 'ok', attribution: 'A', suggestions: [] })).toBe('A');
    expect(lookupAttribution({ state: 'idle', attribution: null })).toBeNull();
    expect(lookupAttribution({ state: 'off' })).toBeNull();
  });
});

describe('splitAddress', () => {
  it('splits the street from the rest and drops the country', () => {
    expect(splitAddress(SCHOOL.label)).toEqual({
      street: '14 School Street',
      rest: 'Hanover, NH 03755',
    });
    expect(splitAddress('Hanover')).toEqual({ street: 'Hanover', rest: null });
    expect(splitAddress('Somewhere, USA')).toEqual({ street: 'Somewhere', rest: null });
  });
});

describe('attributionSpans', () => {
  it('links only the known credits, to their own pages', () => {
    expect(attributionSpans(ATTRIBUTION)).toEqual([
      { text: 'Powered by ' },
      { text: 'Geoapify', href: 'https://www.geoapify.com/' },
      { text: ' | © ' },
      {
        text: 'OpenStreetMap contributors',
        href: 'https://www.openstreetmap.org/copyright',
      },
    ]);
    expect(attributionSpans('Geoapify')).toEqual([
      { text: 'Geoapify', href: 'https://www.geoapify.com/' },
    ]);
    expect(attributionSpans('See https://evil.example')).toEqual([
      { text: 'See https://evil.example' },
    ]);
  });
});
