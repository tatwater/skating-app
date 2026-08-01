/**
 * Centralized, validated access to client env (D26/D2/D29). All three are *public*
 * client keys, so they use Expo's `EXPO_PUBLIC_` prefix (Metro inlines them at build).
 * Real values live in `.env.local` (gitignored); `.env.example` documents them.
 *
 * We fall back to obvious placeholders rather than throwing so the app still boots
 * for UI work before keys are provisioned — sign-in / telemetry simply stay inert.
 */

const CONVEX_URL_PLACEHOLDER = 'https://placeholder.convex.cloud';

export const env = {
  clerkPublishableKey: process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '',
  convexUrl: process.env.EXPO_PUBLIC_CONVEX_URL ?? CONVEX_URL_PLACEHOLDER,
  sentryDsn: process.env.EXPO_PUBLIC_SENTRY_DSN ?? '',
  // Self-built Vermont `.pmtiles` extract later; empty ⇒ the map falls back to the Protomaps demo
  // tiles (§F, mirrors web's VITE_PMTILES_URL). Read natively by MapLibre via the pmtiles:// scheme.
  pmtilesUrl: process.env.EXPO_PUBLIC_PMTILES_URL ?? '',
  // Layer-3 offline-basemap spike, route (1) (Phase 9.5): when '1', download the regional `.pmtiles`
  // to device storage and render the map from that local `file://` archive. Off by default — it's an
  // unverified device experiment (does native pmtiles read `file://`?), see `offlineBasemap.ts`.
  offlineBasemap: process.env.EXPO_PUBLIC_OFFLINE_BASEMAP === '1',
  // Bathymetric contours (N6b), mirroring web's VITE_BATHYMETRY_PMTILES_URL. A second `.pmtiles`
  // archive added to the style only while a lake's drawer is open (D81). Blank ⇒ the layer never
  // mounts, which is correct rather than degraded: contours are decoration under D82, so an
  // unconfigured build shows a flat lake exactly as it does for the majority of bodies no agency
  // ever surveyed.
  bathymetryPmtilesUrl: process.env.EXPO_PUBLIC_BATHYMETRY_PMTILES_URL ?? '',
} as const;

/** True once the corresponding real key has been provisioned (not a placeholder). */
export const isConfigured = {
  clerk: env.clerkPublishableKey.startsWith('pk_'),
  convex: env.convexUrl !== CONVEX_URL_PLACEHOLDER,
  sentry: env.sentryDsn.length > 0,
  bathymetry: env.bathymetryPmtilesUrl.length > 0,
} as const;
