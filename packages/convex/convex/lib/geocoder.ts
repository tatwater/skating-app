/**
 * Forward geocoding behind one small adapter (B03 §11, board 7.18): the provider-specific half of
 * `geocode.suggest`, so changing provider is one adapter and no caller. `04-integrations.md`
 * § Geocoding has the terms and the quota, and why ORS — the account we already had — was not used.
 *
 * **The text is a home address, so it is never logged.** Nothing here passes it to `console`, and no
 * error from the request is printed, because a fetch error can carry the URL it was asked for. It is
 * sent only to the provider, from the server, with nothing that says whose it is. It is not stored:
 * the one coordinate kept is the one the skater then saves through `profiles.setHome`.
 *
 * **No key is `off`.** Until the provider's key is set on the deployment, nothing is sent and the
 * client offers "Use my current location", as it did before any provider was chosen.
 *
 * **A refusal is never answered from a cache.** A 403 (the day's quota) or a 429 (the minute's) comes
 * back as `unavailable`, for the client to show, and "Use my current location" is still there.
 */

import { isValidCoord } from '@skating/core';

export interface GeocodeSuggestion {
  label: string;
  lat: number;
  lng: number;
}

export type GeocodeResult =
  | {
      status: 'ok';
      suggestions: GeocodeSuggestion[];
      /** What the provider requires shown wherever these results are. */
      attribution: string;
    }
  | {
      status: 'unavailable';
      /** `off`: the provider's key isn't set. `quota`: try again later. `error`: anything else. */
      reason: 'off' | 'quota' | 'error';
      suggestions: [];
    };

/** Below this a query matches half of New England and spends quota saying so. */
export const GEOCODE_MIN_CHARS = 3;
/** Longer than any address. The rest is not sent. */
export const GEOCODE_MAX_CHARS = 160;
export const GEOCODE_MAX_SUGGESTIONS = 5;

export interface GeocoderAdapter {
  attribution: string;
  /**
   * The request for this text, or `null` when the provider's key isn't set — which reads as `off`,
   * exactly like no provider at all: the account not existing yet is a normal state, not a fault.
   */
  request(text: string): { url: string; headers: Record<string, string> } | null;
  /** The usable suggestions in a response body. Must not throw on a shape it doesn't expect. */
  parse(body: unknown): GeocodeSuggestion[];
}

/**
 * Geoapify's address autocomplete: a free account of its own (3,000 credits a day, one per request,
 * 5 a second), so a skater's typed home touches neither HeiGIT's personal-data clause nor the account
 * the drive-time bands depend on (founder, 2026-11-08). US results only; no `bias`, though it would
 * rank better: the only point to bias toward is the skater's home, and it never leaves the server
 * (D11). Its key travels in the query string — the only way Geoapify takes one — which is one more
 * reason the URL is never printed.
 */
export const geoapifyGeocoder: GeocoderAdapter = {
  // Geoapify's free plan requires its own credit, and every plan the OpenStreetMap one.
  attribution: 'Powered by Geoapify | © OpenStreetMap contributors',
  request(text) {
    const apiKey = process.env.GEOAPIFY_API_KEY;
    if (!apiKey) return null;
    const params = new URLSearchParams({
      text,
      filter: 'countrycode:us',
      limit: String(GEOCODE_MAX_SUGGESTIONS),
      lang: 'en',
      format: 'json',
      apiKey,
    });
    return { url: `https://api.geoapify.com/v1/geocode/autocomplete?${params}`, headers: {} };
  },
  parse(body) {
    const results = (body as { results?: unknown } | null)?.results;
    if (!Array.isArray(results)) return [];
    const suggestions: GeocodeSuggestion[] = [];
    for (const result of results as { formatted?: unknown; lat?: unknown; lon?: unknown }[]) {
      const label = result?.formatted;
      const lat = result?.lat;
      const lng = result?.lon;
      if (typeof label !== 'string' || label === '') continue;
      if (typeof lat !== 'number' || typeof lng !== 'number' || !isValidCoord({ lat, lng }))
        continue;
      suggestions.push({ label, lat, lng });
    }
    return suggestions;
  },
};

/** One lookup through an adapter: the bounds, the refusals and the no-logging rule live here. */
export async function suggestWith(adapter: GeocoderAdapter, text: string): Promise<GeocodeResult> {
  const trimmed = text.trim().slice(0, GEOCODE_MAX_CHARS);
  // Building the request sends nothing; asking first means an empty text — the client's opening
  // probe — learns `off` too, rather than an `ok` the first real query would contradict.
  const request = adapter.request(trimmed);
  if (request === null) {
    console.warn('geocode: the provider key is not set');
    return { status: 'unavailable', reason: 'off', suggestions: [] };
  }
  if (trimmed.length < GEOCODE_MIN_CHARS) {
    return { status: 'ok', suggestions: [], attribution: adapter.attribution };
  }
  try {
    const res = await fetch(request.url, { headers: request.headers });
    if (res.status === 403 || res.status === 429) {
      console.warn(`geocode: the provider refused for quota (${res.status})`);
      return { status: 'unavailable', reason: 'quota', suggestions: [] };
    }
    if (!res.ok) {
      console.warn(`geocode: the provider answered ${res.status}`);
      return { status: 'unavailable', reason: 'error', suggestions: [] };
    }
    const suggestions = adapter.parse(await res.json()).slice(0, GEOCODE_MAX_SUGGESTIONS);
    return { status: 'ok', suggestions, attribution: adapter.attribution };
  } catch {
    // The error itself is not printed: see the file note.
    console.warn('geocode: the request failed');
    return { status: 'unavailable', reason: 'error', suggestions: [] };
  }
}
