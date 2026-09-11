import { sentryPrivacyHooks } from '@skating/core';

/**
 * Sentry options shared by the browser and the server (D29).
 *
 * One definition for both runtimes on purpose. Privacy rules configured twice drift, and
 * the half that drifts is the half nobody notices until private data is already in a bug
 * report. The hooks that do the actual scrubbing live in `@skating/core` so the React
 * Native app gets the same ones; what remains here is the part genuinely specific to the
 * browser and Node SDKs.
 */
export const sharedSentryOptions = {
  /**
   * Deny-by-default for request data.
   *
   * ## Why every category is stated, including the ones that look like defaults
   *
   * Supplying this option at all changes what the defaults are.
   * `resolveDataCollectionOptions` picks its base from whether the key is present: absent,
   * it maps the legacy `sendDefaultPii` flag; present, it starts from the SDK's own
   * defaults, where every category is collected in full. Setting only the fields we cared
   * about would therefore have switched the rest *on*.
   *
   * ## Why the previous `sendDefaultPii: false` was not enough
   *
   * It reads like "collect nothing" and is not. `defaultPiiToCollectionOptions` maps it to
   * `{ deny: PII_HEADER_SNIPPETS }` for cookies, headers, and query parameters — so all
   * three were collected and filtered by key name, dropping values whose key contains
   * `auth`, `token`, `session`, `jwt`, `cookie` and similar. That catches credentials well,
   * and it is allow-by-default for everything else. On an app whose query parameters and
   * cookies can name a lake, a report, or a person, allow-by-default is the wrong way
   * round. These values are the deny-by-default version.
   */
  dataCollection: {
    /**
     * No user information the SDK inferred on its own, which includes the IP address the
     * event was sent from. D29 gates on the population including minors (D41) and this
     * being a location app; an IP is a coarse location the user never offered.
     */
    userInfo: false,

    /** No request or response bodies. A report body carries coordinates and photos. */
    httpBodies: [],

    /**
     * No cookies and no headers, in either direction. Both carry the Clerk session token
     * on the server, and the SDK's own key filter is not something to depend on for a
     * credential when refusing the whole category costs nothing diagnostically.
     */
    cookies: false,
    httpHeaders: { request: false, response: false },

    /**
     * No query strings. A URL here names a report, a water body, or a sub-area, and in
     * development Clerk appends its own `__clerk_db_jwt` handoff parameter. `beforeBreadcrumb`
     * in `@skating/core` covers the breadcrumb and span paths this setting does not reach.
     */
    urlQueryParams: false,
  },

  /**
   * The last thing that runs before anything leaves the process: `beforeSend`,
   * `beforeSendTransaction`, and `beforeBreadcrumb`, all from `@skating/core`.
   */
  ...sentryPrivacyHooks,
};
