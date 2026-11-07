import { useEffect, useRef, useState } from 'react';

/**
 * The typed-address half of setting a home (7.18), over `geocode.suggest`. The rules that keep a
 * shared, metered provider account safe live here, not in the field:
 *
 * - **Debounced** — one call per 300 ms pause, never one per keystroke.
 * - **Three characters or nothing** — below that a query matches half of New England and spends
 *   quota saying so (the server's own floor; asking below it is a wasted round trip).
 * - **A quota refusal stops the session.** Once the provider says `quota`, nothing calls it again
 *   until the page reloads: hammering a limit risks the shared account the drive-time bands
 *   depend on. "Use my current location" stays.
 * - **`off` is learned once** — no provider is switched on yet — and the field gives way to the
 *   fallback for the rest of the session. The first ask is an empty text, which the server answers
 *   without calling any provider.
 */

export interface AddressSuggestion {
  label: string;
  lat: number;
  lng: number;
}

/** `geocode.suggest`'s answer, as the client reads it. */
export type SuggestResult =
  | { status: 'ok'; suggestions: AddressSuggestion[]; attribution: string }
  | { status: 'unavailable'; reason: 'off' | 'quota' | 'error'; suggestions: [] };

export type SuggestFn = (args: { text: string }) => Promise<SuggestResult>;

export const SUGGEST_DEBOUNCE_MS = 300;
export const SUGGEST_MIN_CHARS = 3;

/** Why the typed address is out for this session: no provider, or the provider's limit. */
type Latch = 'off' | 'quota' | null;
let latch: Latch = null;

/** Test seam: a new session. */
export function resetGeocoderSession(): void {
  latch = null;
}

export type AddressLookup =
  | { state: 'unknown' }
  | { state: 'off' }
  | { state: 'quota' }
  | { state: 'idle'; attribution: string | null }
  | { state: 'loading'; attribution: string | null; suggestions: AddressSuggestion[] }
  | { state: 'ok'; attribution: string; suggestions: AddressSuggestion[] }
  | { state: 'error'; attribution: string | null };

/** What one answer means for the field — and, for `off` or `quota`, for the rest of the session. */
function settle(
  result: SuggestResult,
  query: string,
  attribution: { current: string | null },
): AddressLookup {
  if (result.status === 'ok') {
    attribution.current = result.attribution;
    return query.length >= SUGGEST_MIN_CHARS
      ? { state: 'ok', attribution: result.attribution, suggestions: result.suggestions }
      : { state: 'idle', attribution: result.attribution };
  }
  if (result.reason === 'off' || result.reason === 'quota') {
    latch = result.reason;
    return { state: result.reason };
  }
  return { state: 'error', attribution: attribution.current };
}

/**
 * Suggestions for `text`. Holds the last good suggestions while the next call is out, so the list
 * doesn't blink between keystrokes.
 */
export function useAddressSuggestions(text: string, suggest: SuggestFn): AddressLookup {
  const [lookup, setLookup] = useState<AddressLookup>(() =>
    latch !== null ? { state: latch } : { state: 'unknown' },
  );
  const attribution = useRef<string | null>(null);
  const suggestRef = useRef(suggest);
  suggestRef.current = suggest;

  // The first ask learns whether a provider is on at all, for free.
  useEffect(() => {
    if (latch !== null) return;
    let live = true;
    suggestRef
      .current({ text: '' })
      .then((result) => {
        if (live)
          setLookup((now) => (now.state === 'unknown' ? settle(result, '', attribution) : now));
      })
      .catch(() => {
        if (live) setLookup({ state: 'error', attribution: null });
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (latch !== null) {
      setLookup({ state: latch });
      return;
    }
    const query = text.trim();
    if (query.length < SUGGEST_MIN_CHARS) {
      setLookup((now) =>
        now.state === 'unknown' ? now : { state: 'idle', attribution: attribution.current },
      );
      return;
    }
    setLookup((now) => ({
      state: 'loading',
      attribution: attribution.current,
      suggestions: now.state === 'ok' || now.state === 'loading' ? now.suggestions : [],
    }));
    let live = true;
    const timer = setTimeout(() => {
      // Another field in this session may have hit the limit while this one waited.
      if (latch !== null) {
        if (live) setLookup({ state: latch });
        return;
      }
      suggestRef
        .current({ text: query })
        .then((result) => {
          if (live) setLookup(settle(result, query, attribution));
        })
        .catch(() => {
          if (live) setLookup({ state: 'error', attribution: attribution.current });
        });
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text]);

  return lookup;
}
