import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resetGeocoderSession,
  SUGGEST_DEBOUNCE_MS,
  type SuggestFn,
  type SuggestResult,
  useAddressSuggestions,
} from './geocoder';

const ATTR = '© openrouteservice by HeiGIT | Data from OpenStreetMap';
const ok = (labels: string[] = []): SuggestResult => ({
  status: 'ok',
  attribution: ATTR,
  suggestions: labels.map((label, i) => ({ label, lat: 43.7 + i, lng: -72.3 })),
});
const off: SuggestResult = { status: 'unavailable', reason: 'off', suggestions: [] };
const quota: SuggestResult = { status: 'unavailable', reason: 'quota', suggestions: [] };
const error: SuggestResult = { status: 'unavailable', reason: 'error', suggestions: [] };

beforeEach(() => {
  vi.useFakeTimers();
  resetGeocoderSession();
});
afterEach(() => vi.useRealTimers());

async function settle() {
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
}

function hook(suggest: SuggestFn, text = '') {
  return renderHook(({ t }) => useAddressSuggestions(t, suggest), { initialProps: { t: text } });
}

describe('useAddressSuggestions', () => {
  it('learns "off" from a free empty ask and stays off for the session', async () => {
    const suggest = vi.fn<SuggestFn>().mockResolvedValue(off);
    const { result, rerender } = hook(suggest);
    expect(result.current.state).toBe('unknown');
    await settle();
    expect(suggest).toHaveBeenCalledWith({ text: '' });
    expect(result.current.state).toBe('off');
    rerender({ t: '14 School' });
    await settle();
    expect(suggest).toHaveBeenCalledTimes(1);
    // A second field this session never asks at all.
    const again = hook(suggest);
    expect(again.result.current.state).toBe('off');
    expect(suggest).toHaveBeenCalledTimes(1);
  });

  it('debounces: one call per pause, none under three characters', async () => {
    const suggest = vi
      .fn<SuggestFn>()
      .mockResolvedValueOnce(ok())
      .mockResolvedValue(ok(['14 School Street, Hanover, NH 03755, USA']));
    const { result, rerender } = hook(suggest);
    await settle();
    expect(result.current).toEqual({ state: 'idle', attribution: ATTR });
    rerender({ t: '14' });
    await settle();
    expect(suggest).toHaveBeenCalledTimes(1);
    rerender({ t: '14 S' });
    rerender({ t: '14 Sc' });
    rerender({ t: '14 School' });
    expect(result.current.state).toBe('loading');
    await act(async () => {
      vi.advanceTimersByTime(SUGGEST_DEBOUNCE_MS - 1);
    });
    expect(suggest).toHaveBeenCalledTimes(1);
    await settle();
    expect(suggest).toHaveBeenCalledTimes(2);
    expect(suggest).toHaveBeenLastCalledWith({ text: '14 School' });
    expect(result.current).toMatchObject({ state: 'ok', attribution: ATTR });
    // While the next one is out, the last list holds.
    rerender({ t: '14 School S' });
    expect(result.current).toMatchObject({ state: 'loading' });
    expect(result.current.state === 'loading' && result.current.suggestions).toHaveLength(1);
    rerender({ t: '1' });
    expect(result.current).toEqual({ state: 'idle', attribution: ATTR });
  });

  it('a quota refusal stops every call for the rest of the session', async () => {
    const suggest = vi.fn<SuggestFn>().mockResolvedValueOnce(ok()).mockResolvedValue(quota);
    const { result, rerender } = hook(suggest);
    await settle();
    rerender({ t: 'Main Street' });
    await settle();
    expect(result.current.state).toBe('quota');
    rerender({ t: 'Main Street, Hanover' });
    await settle();
    expect(suggest).toHaveBeenCalledTimes(2);
  });

  it('a limit hit elsewhere while this field waited stops it too', async () => {
    const suggest = vi.fn<SuggestFn>().mockResolvedValueOnce(ok()).mockResolvedValue(quota);
    const a = hook(suggest);
    const b = hook(suggest);
    await settle();
    a.rerender({ t: 'Main St' });
    b.rerender({ t: 'Elm St' });
    // a's call goes out first and latches the session; b's timer then finds the latch.
    await act(async () => {
      vi.advanceTimersByTime(SUGGEST_DEBOUNCE_MS);
    });
    await settle();
    expect(b.result.current.state).toBe('quota');
    expect(suggest.mock.calls.filter(([a1]) => a1.text !== '').length).toBeLessThanOrEqual(2);
  });

  it('an error keeps the field, says so, and tries again on the next pause', async () => {
    const suggest = vi
      .fn<SuggestFn>()
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(error)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(ok(['Elm Street, Lebanon, NH']));
    const { result, rerender } = hook(suggest);
    await settle();
    rerender({ t: 'Elm' });
    await settle();
    expect(result.current).toEqual({ state: 'error', attribution: ATTR });
    rerender({ t: 'Elm S' });
    await settle();
    expect(result.current.state).toBe('error');
    rerender({ t: 'Elm St' });
    await settle();
    expect(result.current.state).toBe('ok');
  });

  it('a failed first ask is an error, not "off"', async () => {
    const suggest = vi.fn<SuggestFn>().mockRejectedValue(new Error('down'));
    const { result } = hook(suggest);
    await settle();
    expect(result.current).toEqual({ state: 'error', attribution: null });
  });

  it('an answer after unmount is dropped', async () => {
    let resolve: (r: SuggestResult) => void = () => {};
    const suggest = vi.fn<SuggestFn>(() => new Promise((r) => (resolve = r)));
    const { unmount } = hook(suggest);
    unmount();
    await act(async () => resolve(off));
    // The session didn't learn "off" from a field nobody saw… but the latch is the server's word.
    expect(suggest).toHaveBeenCalledTimes(1);
  });
});
