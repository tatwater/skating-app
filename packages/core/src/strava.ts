/**
 * Strava brand + connection copy (Phase 8, L7) — single-sourced so web and mobile can't drift.
 *
 * Strava's brand guidelines are a **contractual build criterion**, not a design preference: the
 * official "Connect with Strava" wording on the connect control and "Powered by Strava" wherever the
 * integration surfaces. Strictly, attribution is required where Strava *data* is displayed, and a pure
 * push displays none — but we surface the connection state, so we honor the kit anyway rather than
 * litigating the edge.
 *
 * The user-facing copy also carries the honest framing of what the integration is and isn't: we send
 * your skate to your own Strava, and we never read anything back. That's not marketing — it's the
 * legal shape of the integration (L7 forbids showing one athlete's Strava data to anyone else), and
 * saying so plainly is what makes the permission prompt intelligible.
 */

/** The exact wording Strava's kit requires on the connect control. */
export const STRAVA_CONNECT_LABEL = 'Connect with Strava';

/** The attribution shown wherever the integration surfaces. */
export const STRAVA_ATTRIBUTION = 'Powered by Strava';

/** Strava's brand orange — for the connect button, per the kit. */
export const STRAVA_BRAND_COLOR = '#FC4C02';

/** What connecting actually does, in plain words, before the OAuth screen appears. */
export const STRAVA_CONNECT_EXPLAINER =
  'We’ll upload skates you record here to your own Strava account. We never read your Strava activities, and nothing from Strava is shown to anyone else.';

/** The per-session toggle's label + why you might turn it off. */
export const STRAVA_UPLOAD_TOGGLE_LABEL = 'Also upload to Strava';
export const STRAVA_UPLOAD_TOGGLE_HINT =
  'Turn this off if your watch already records to Strava — it would upload the same skate twice, and the watch’s version is usually better.';

/** Shown once a connection exists. */
export const STRAVA_CONNECTED_LABEL = 'Connected to Strava';
export const STRAVA_DISCONNECT_LABEL = 'Disconnect';

/** Shown when the deployment has no Strava credentials — honest rather than a broken button. */
export const STRAVA_UNCONFIGURED_NOTE = 'Strava uploads aren’t available yet.';
