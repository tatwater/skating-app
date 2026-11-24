/**
 * The typed-address field for the Home step (B03 §9.6 boards 11.10–11.11, §9.7): the phone's own,
 * over `geocode.suggest`, with the rules the web's Settings field keeps (`apps/web` `geocoder.ts`),
 * because they protect one shared, metered provider account:
 *
 * - **Debounced** — one call per 300 ms pause, never one per keystroke.
 * - **Three characters or nothing** — below that a query matches half of New England.
 * - **A quota refusal stops the session.** Once the provider says `quota`, nothing calls it again
 *   until the app restarts. *Use my current location* stays.
 * - **`off` is learned once** — the provider's key isn't set on the deployment — by a first ask with
 *   an empty text, which the server answers without calling any provider.
 *
 * A plain controller over an injected `suggest`, so it runs under Vitest's fake timers.
 */

export interface AddressSuggestion {
  label: string;
  lat: number;
  lng: number;
  /** "Hanover, NH" — the Profile step's Town, when the provider names one. */
  town?: string;
}

/** `geocode.suggest`'s answer. */
export type SuggestResult =
  | { status: 'ok'; suggestions: AddressSuggestion[]; attribution: string }
  | { status: 'unavailable'; reason: 'off' | 'quota' | 'error'; suggestions: [] };

export type SuggestFn = (args: { text: string }) => Promise<SuggestResult>;

export const SUGGEST_DEBOUNCE_MS = 300;
export const SUGGEST_MIN_CHARS = 3;

export type AddressLookup =
  | { state: 'unknown' }
  | { state: 'off' }
  | { state: 'quota' }
  | { state: 'idle'; attribution: string | null }
  | { state: 'loading'; attribution: string | null; suggestions: AddressSuggestion[] }
  | { state: 'ok'; attribution: string; suggestions: AddressSuggestion[] }
  | { state: 'error'; attribution: string | null };

/** Why the typed address is out for this session: no provider, or the provider's limit. */
let latch: 'off' | 'quota' | null = null;

/** Test seam: a new session. */
export function resetGeocoderSession(): void {
  latch = null;
}

/** What one answer means for the field — and, for `off` or `quota`, for the rest of the session. */
export function settleLookup(
  result: SuggestResult,
  query: string,
  attribution: string | null,
): { lookup: AddressLookup; attribution: string | null } {
  if (result.status === 'ok') {
    return {
      attribution: result.attribution,
      lookup:
        query.length >= SUGGEST_MIN_CHARS
          ? { state: 'ok', attribution: result.attribution, suggestions: result.suggestions }
          : { state: 'idle', attribution: result.attribution },
    };
  }
  if (result.reason === 'off' || result.reason === 'quota') {
    latch = result.reason;
    return { lookup: { state: result.reason }, attribution };
  }
  return { lookup: { state: 'error', attribution }, attribution };
}

/** The suggestions a lookup is showing (kept while the next call is out, so the list doesn't blink). */
export function shownSuggestions(lookup: AddressLookup): AddressSuggestion[] {
  return lookup.state === 'ok' || lookup.state === 'loading' ? lookup.suggestions : [];
}

/** The provider's credit, wherever its suggestions show. */
export function lookupAttribution(lookup: AddressLookup): string | null {
  return 'attribution' in lookup ? lookup.attribution : null;
}

export interface AddressLookupController {
  /** The field's text changed. */
  setText(text: string): void;
  current(): AddressLookup;
  dispose(): void;
}

export function createAddressLookup({
  suggest,
  onChange,
}: {
  suggest: SuggestFn;
  onChange: (lookup: AddressLookup) => void;
}): AddressLookupController {
  let lookup: AddressLookup = latch !== null ? { state: latch } : { state: 'unknown' };
  let attribution: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by every new text: an answer for an older one is dropped. */
  let generation = 0;
  let disposed = false;

  const set = (next: AddressLookup) => {
    lookup = next;
    if (!disposed) onChange(next);
  };

  // The first ask learns whether a provider is on at all, for free.
  if (latch === null) {
    suggest({ text: '' }).then(
      (result) => {
        if (lookup.state === 'unknown') {
          const settled = settleLookup(result, '', attribution);
          attribution = settled.attribution;
          set(settled.lookup);
        }
      },
      () => {
        if (lookup.state === 'unknown') set({ state: 'error', attribution: null });
      },
    );
  }

  return {
    setText(text) {
      generation++;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (latch !== null) {
        set({ state: latch });
        return;
      }
      const query = text.trim();
      if (query.length < SUGGEST_MIN_CHARS) {
        if (lookup.state !== 'unknown') set({ state: 'idle', attribution });
        return;
      }
      set({ state: 'loading', attribution, suggestions: shownSuggestions(lookup) });
      const mine = generation;
      timer = setTimeout(() => {
        timer = null;
        // Another field in this session may have hit the limit while this one waited.
        if (latch !== null) {
          set({ state: latch });
          return;
        }
        suggest({ text: query }).then(
          (result) => {
            if (mine !== generation) return;
            const settled = settleLookup(result, query, attribution);
            attribution = settled.attribution;
            set(settled.lookup);
          },
          () => {
            if (mine === generation) set({ state: 'error', attribution });
          },
        );
      }, SUGGEST_DEBOUNCE_MS);
    },
    current: () => lookup,
    dispose() {
      disposed = true;
      generation++;
      if (timer !== null) clearTimeout(timer);
    },
  };
}

/** "14 School Street, Hanover, NH 03755, USA" → the street, then the rest (the web's split). */
export function splitAddress(label: string): { street: string; rest: string | null } {
  const at = label.indexOf(',');
  if (at === -1) return { street: label, rest: null };
  const rest = label
    .slice(at + 1)
    .trim()
    .replace(/(^|,\s*)(USA|United States)$/i, '')
    .trim();
  return { street: label.slice(0, at).trim(), rest: rest || null };
}

/**
 * The credits a geocoder attribution may link, each to its canonical page (the web's list). Only
 * these names become links, and only to these URLs: a URL inside the provider's string is never
 * followed.
 */
const CREDIT_LINKS: ReadonlyArray<readonly [name: string, href: string]> = [
  ['Geoapify', 'https://www.geoapify.com/'],
  ['OpenStreetMap contributors', 'https://www.openstreetmap.org/copyright'],
];
const CREDIT_PATTERN = new RegExp(CREDIT_LINKS.map(([name]) => name).join('|'), 'g');

export interface AttributionSpan {
  text: string;
  href?: string;
}

/** "Powered by Geoapify | © OpenStreetMap contributors" → text spans, the known credits linked. */
export function attributionSpans(text: string): AttributionSpan[] {
  const spans: AttributionSpan[] = [];
  let at = 0;
  for (const match of text.matchAll(CREDIT_PATTERN)) {
    const href = CREDIT_LINKS.find(([name]) => name === match[0])?.[1] as string;
    if (match.index > at) spans.push({ text: text.slice(at, match.index) });
    spans.push({ text: match[0], href });
    at = match.index + match[0].length;
  }
  if (at < text.length) spans.push({ text: text.slice(at) });
  return spans;
}
