/**
 * Forward geocoding behind one small adapter (B03 §11, board 7.18): the provider-specific half of
 * `geocode.suggest`, so changing provider is one adapter and no caller. `04-integrations.md`
 * § Geocoding has the terms and the quota each option comes with.
 *
 * **The text is a home address, so it is never logged.** Nothing here passes it to `console`, and no
 * error from the request is printed, because a fetch error can carry the URL it was asked for. It is
 * sent only to the provider, from the server, with nothing that says whose it is. It is not stored:
 * the one coordinate kept is the one the skater then saves through `profiles.setHome`.
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
      /** `off`: no provider is switched on. `quota`: try again later. `error`: anything else. */
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
  /** The request for this text, or `null` when the provider's key isn't set. */
  request(text: string): { url: string; headers: Record<string, string> } | null;
  /** The usable suggestions in a response body. Must not throw on a shape it doesn't expect. */
  parse(body: unknown): GeocodeSuggestion[];
}

/**
 * OpenRouteService's Pelias autocomplete: the account the drive-time bands already use, in its own
 * quota pool (100 a minute, 1,000 a day). No `focus.point`, though it would rank better: the only
 * point to focus on is the skater's home, and it never leaves the server (D11).
 */
export const orsGeocoder: GeocoderAdapter = {
  attribution: '© openrouteservice by HeiGIT | Data from OpenStreetMap',
  request(text) {
    const apiKey = process.env.ORS_API_KEY;
    if (!apiKey) return null;
    const params = new URLSearchParams({
      text,
      'boundary.country': 'USA',
      layers: 'address,locality,postalcode',
      size: String(GEOCODE_MAX_SUGGESTIONS),
    });
    return {
      url: `https://api.openrouteservice.org/geocode/autocomplete?${params}`,
      headers: { Authorization: apiKey },
    };
  },
  parse(body) {
    const features = (body as { features?: unknown } | null)?.features;
    if (!Array.isArray(features)) return [];
    const suggestions: GeocodeSuggestion[] = [];
    for (const feature of features as {
      geometry?: { coordinates?: unknown };
      properties?: { label?: unknown };
    }[]) {
      const label = feature?.properties?.label;
      const coordinates = feature?.geometry?.coordinates;
      if (typeof label !== 'string' || label === '' || !Array.isArray(coordinates)) continue;
      const [lng, lat] = coordinates as number[];
      if (lat === undefined || lng === undefined || !isValidCoord({ lat, lng })) continue;
      suggestions.push({ label, lat, lng });
    }
    return suggestions;
  },
};

/** One lookup through an adapter: the bounds, the refusals and the no-logging rule live here. */
export async function suggestWith(adapter: GeocoderAdapter, text: string): Promise<GeocodeResult> {
  const trimmed = text.trim().slice(0, GEOCODE_MAX_CHARS);
  if (trimmed.length < GEOCODE_MIN_CHARS) {
    return { status: 'ok', suggestions: [], attribution: adapter.attribution };
  }
  const request = adapter.request(trimmed);
  if (request === null) {
    console.warn('geocode: the provider key is not set');
    return { status: 'unavailable', reason: 'error', suggestions: [] };
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
