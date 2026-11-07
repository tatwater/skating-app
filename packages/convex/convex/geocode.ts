/**
 * Address suggestions for a typed home (B03 §11, board 7.18). An action because it calls out, and on
 * the server so the provider key stays here and the provider sees no skater. See `lib/geocoder.ts`.
 */

import { ConvexError, v } from 'convex/values';
import { action } from './_generated/server';
import { type GeocodeResult, type GeocoderAdapter, suggestWith } from './lib/geocoder';

/**
 * Which provider is on: **none yet.** Switching one on is a founder call, because every candidate
 * has a cost a skater's home address would pay (`04-integrations.md` § Geocoding): HeiGIT's terms
 * prohibit transmitting personal data, on the account the drive-time bands depend on. Until it's made,
 * no address leaves the server, and the client offers "Use my current location". To switch on, return
 * `orsGeocoder` from `./lib/geocoder` here and update the test that pins this.
 */
function activeGeocoder(): GeocoderAdapter | null {
  return null;
}

export const suggest = action({
  args: { text: v.string() },
  handler: async (ctx, { text }): Promise<GeocodeResult> => {
    // Signed-in only: the quota is a shared pool, and this is the one thing standing in front of it.
    if (!(await ctx.auth.getUserIdentity())) throw new ConvexError('Not signed in');
    const adapter = activeGeocoder();
    if (adapter === null) return { status: 'unavailable', reason: 'off', suggestions: [] };
    return suggestWith(adapter, text);
  },
});
