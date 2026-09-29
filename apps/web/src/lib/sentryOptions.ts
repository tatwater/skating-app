import { sentryPrivacyHooks } from '@skating/core';

/**
 * The shared hooks minus `beforeSendTransaction`, which is mobile's (SDK v10). SDK v11 streams
 * spans and never calls it, and handed one anyway it `console.warn`s on every init.
 */
const { beforeSendTransaction: _mobileOnly, ...webPrivacyHooks } = sentryPrivacyHooks;

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
     * and `beforeSendSpan` in `@skating/core` cover the breadcrumb and span paths this setting
     * does not reach.
     */
    urlQueryParams: false,

    /**
     * Four categories SDK v11 added, each collected unless refused. Nothing in the web app
     * talks to a database, a queue, a GraphQL server or a model directly, so these guard
     * against the next integration rather than a current leak — and v11's migration guide
     * names exactly these as the ones to state to keep v10's behavior. Left unset they
     * would fall to the SDK's defaults, which is the failure the note above describes.
     */
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    queues: false,
    graphQL: { document: false, variables: false },

    /**
     * No local variable values in server stack frames — the second of two locks. The first is
     * that `includeLocalVariables` is unset, so the Node SDK's local-variables integration never
     * starts; this category (on by default) is what it would consult if someone turned that on.
     * A server function mid-report holds a report's coordinates, a home location, a Clerk token,
     * and they would arrive as frame data, where `beforeSend` in `@skating/core` does not walk —
     * so PRIVACY.md's "location fields are removed before anything is sent" would not hold for
     * them. Stack traces and the surrounding source lines still go; that is what a crash needs.
     */
    stackFrameVariables: false,
  },

  /**
   * The last thing that runs before anything leaves the process: `beforeSend`,
   * `beforeSendSpan`, and `beforeBreadcrumb`, all from `@skating/core`.
   * `sentryOptions.{client,server}.test.ts` prove what actually leaves.
   */
  ...webPrivacyHooks,
};
