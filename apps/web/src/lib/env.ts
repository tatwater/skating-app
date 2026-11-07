/**
 * Centralized, validated access to client env (D2/D29). `VITE_`-prefixed vars are the only
 * ones Vite inlines into the client bundle, so they're the public keys. Clerk's keys are
 * read server-side by `@clerk/tanstack-react-start` (see `src/start.ts`), not here.
 *
 * As on mobile, we fall back to obvious placeholders rather than throwing so the app still
 * builds/boots for UI work before keys are provisioned — data + telemetry simply stay inert.
 */

const CONVEX_URL_PLACEHOLDER = 'https://placeholder.convex.cloud';

/**
 * Where the browser sends PostHog traffic: PostHog's US ingestion host, **cross-origin on purpose**
 * (D235).
 *
 * A same-origin reverse proxy would beat tracker blockers, and that was the first choice here. It
 * was reversed for a reason worth leaving written down: `posthog-js` sets no `credentials` option,
 * so `fetch` defaults to `same-origin` and the browser attaches this app's cookies — Clerk's
 * `__session` among them, since its path is `/` — to every ingestion request, and a Vercel rewrite
 * forwards request headers to the destination. That hands a session credential to a third-party
 * processor on every event, which is exactly what `sentryOptions.ts` refuses in as many words. A
 * proxy needs a hop that strips `Cookie` before it is safe, and that hop costs a billed function
 * invocation per event; at alpha volume, blocker loss is the cheaper problem.
 *
 * `VITE_POSTHOG_HOST` overrides it, so adding that proxy later needs no code change here.
 */
const POSTHOG_API_HOST = 'https://us.i.posthog.com';

export const env = {
  convexUrl: import.meta.env.VITE_CONVEX_URL ?? CONVEX_URL_PLACEHOLDER,
  sentryDsn: import.meta.env.VITE_SENTRY_DSN ?? '',
  // Basemap vector tiles (D6). Blank → the Protomaps hosted demo (`waterMap.DEMO_PMTILES_URL`);
  // set to a self-built Vermont `.pmtiles` URL to swap the basemap (PR#5). Public.
  pmtilesUrl: import.meta.env.VITE_PMTILES_URL ?? '',
  // The whole-planet z0–6 overview archive that sits *under* the regional one, so the map has an
  // ocean and a set of continents everywhere rather than ending in a straight line at the regional
  // archive's edge. ~45 MB, hosted alongside the basemap. Blank ⇒ the map falls back to the
  // single-source style, which renders but stops dead outside the region. Public.
  worldPmtilesUrl: import.meta.env.VITE_WORLD_PMTILES_URL ?? '',
  // Bathymetric contours (A06b). A SECOND `.pmtiles` archive, hosted alongside the basemap and added
  // to the style only while a lake's drawer is open (D81). Blank ⇒ the layer never mounts, which is
  // the correct behavior rather than a degraded one: contours are decoration under D82, so an
  // unconfigured deployment simply shows a flat lake exactly as it does for the majority of bodies
  // that no agency ever surveyed. Public.
  bathymetryPmtilesUrl: import.meta.env.VITE_BATHYMETRY_PMTILES_URL ?? '',
  // The freeze-up archive (A06e, D148) — a *base URL*, not a file, because unlike the three above this
  // is a directory of thousands of `.pmtiles` frames plus the JSON index that lists them. The client
  // composes addresses from it with `archiveUrl` and keys the artifacts carry, so dev and prod can
  // point at different buckets without anything in the archive knowing which one it landed in.
  //
  // Blank ⇒ no scrubber, which is correct rather than degraded: the reveal itself is Tier 1 and needs
  // none of this, so an unconfigured deployment shows the aerial and simply offers no timeline.
  // Public.
  imageryArchiveUrl: import.meta.env.VITE_IMAGERY_ARCHIVE_URL ?? '',
  // Product analytics (D29's "later" half, wired in D235). The project token is public by design —
  // it can only *write* events — which is why it rides the client bundle like the rest of this list.
  // Absent, analytics stay inert: no init, no network, every `capture` a no-op. That is the same
  // posture as the basemap and the imagery archive above, and it is why there is no throw here.
  posthogKey: import.meta.env.VITE_POSTHOG_KEY ?? '',
  // `||`, not `??`: the var is documented in `.env.example` as a blank-by-default override, and a
  // blank line sets it to `''` rather than leaving it undefined. With `??` that empty string would
  // win and silently point ingestion at the page's own root.
  posthogHost: import.meta.env.VITE_POSTHOG_HOST || POSTHOG_API_HOST,
} as const;

/** True once the corresponding real key has been provisioned (not a placeholder). */
export const isConfigured = {
  convex: env.convexUrl !== CONVEX_URL_PLACEHOLDER,
  sentry: env.sentryDsn.length > 0,
  // Keyed on the token alone, not on the host: the host has a working default (the same-origin
  // proxy), so a deployment that sets the token and nothing else is correctly configured.
  posthog: env.posthogKey.length > 0,
  // No `bathymetry` entry: the contour layer needs the URL itself, not a boolean about it, so
  // `MapView` reads `env.bathymetryPmtilesUrl` and a second way to ask the same question would only
  // be a second thing to keep in step.
} as const;
