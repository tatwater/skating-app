/**
 * Address suggestions for a typed home (B03 §11, board 7.18). An action because it calls out, and on
 * the server so the provider key stays here and the provider sees no skater. See `lib/geocoder.ts`.
 */

import { ConvexError, v } from 'convex/values';
import { action } from './_generated/server';
import {
  type GeocodeResult,
  type GeocoderAdapter,
  geoapifyGeocoder,
  suggestWith,
} from './lib/geocoder';

/**
 * Which provider is on: **Geoapify** (founder, 2026-11-08; `04-integrations.md` § Geocoding has the
 * terms and the quota). It is off in effect until `GEOAPIFY_API_KEY` is set on the deployment: the
 * adapter answers `off` without it, and no address leaves the server.
 */
function activeGeocoder(): GeocoderAdapter {
  return geoapifyGeocoder;
}

export const suggest = action({
  args: { text: v.string() },
  handler: async (ctx, { text }): Promise<GeocodeResult> => {
    // Signed-in only: the quota is a shared pool, and this is the one thing standing in front of it.
    if (!(await ctx.auth.getUserIdentity())) throw new ConvexError('Not signed in');
    return suggestWith(activeGeocoder(), text);
  },
});
