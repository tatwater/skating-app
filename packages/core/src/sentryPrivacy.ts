/**
 * What must never leave a device or a server inside a Sentry event (D29).
 *
 * ## Why this exists at all, given the SDK already filters
 *
 * `@sentry/core` scrubs request data on its own: cookies, request/response headers, and
 * query parameters are run through a key-name filter that drops anything containing
 * `auth`, `token`, `session`, `jwt`, `cookie` and a dozen similar snippets. That is real
 * protection and it is why no Clerk or Strava credential has ever ridden out in a header.
 *
 * It covers exactly three fields, and none of the ones an application fills in. `extra`,
 * `contexts`, `tags`, `user`, and every breadcrumb's `data` are untouched by it. The first
 * `Sentry.setContext('skate', { path, homeCoord })` anyone writes lands in Sentry
 * unfiltered, and nothing in the SDK is going to notice that a `coordinates` array is a
 * person's route. The SDK knows about credentials; only this file knows that this is a
 * location app.
 *
 * ## What PRIVACY.md commits us to — and this file is what makes it true
 *
 * The notice's "Device & diagnostic data" bullet now makes specific promises: that we do
 * not send IP address, cookies, request bodies, or form contents; that web addresses lose
 * their query strings before leaving the device; and that location fields (coordinates,
 * home location, and everything derived from it), date of birth, bio, and connected-
 * account credentials are removed before anything is sent. The first two are
 * `dataCollection` in `apps/web/src/lib/sentryOptions.ts` and `sendDefaultPii` on mobile;
 * the rest are the deny list and hooks below. **Change what this file redacts and the
 * notice has to change with it** — it is quoting this module, not describing an
 * aspiration. D29's session-replay gating turns on the same fact this does: the
 * population includes minors (D41) and this is a location app.
 *
 * ## Scope, stated plainly
 *
 * This redacts values in structured data, by field name, plus query strings inside
 * URL-shaped strings. It cannot find a coordinate interpolated into a free-text error
 * message, because there is no key to match — keep them out of `throw` sites instead. The
 * two rules are complementary and neither is sufficient alone.
 */

/** Replaces a withheld value. Deliberately obvious in a report. */
export const REDACTION_PLACEHOLDER = '[redacted]';

/** Guards against hostile or cyclic structures. Deeper than any event we produce. */
const MAXIMUM_DEPTH = 12;

/**
 * Reduces a key to a comparable form, so `homeCoord`, `home_coord`, and `home-coord` are
 * one field. Module-private: the useful thing to export is the question
 * `isSensitiveFieldName` answers, not the step it takes to answer it.
 */
function normalizeFieldName(fieldName: string): string {
  return fieldName.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Field names matched in full, because as substrings they would catch ordinary words.
 *
 * `lat` is the clearest case: as a fragment it also matches `latency`, `translate`,
 * `related`, and `latest`. `lon` matches `long`, `along`, and `belong`. Matching those
 * would blank out unrelated diagnostics and make reports useless, which is the failure
 * mode a deny list has to avoid as carefully as it avoids leaking.
 */
const EXACT_SENSITIVE_FIELD_NAMES: ReadonlySet<string> = new Set([
  // Coordinates, in every spelling the codebase and its libraries use. `coordinates` is
  // the one that matters most: a GeoJSON geometry is `{ type, coordinates }`, so matching
  // it here redacts a GPS track's actual points wherever the walk reaches one, including
  // inside `gpsActivities.path` and inside a cached isochrone.
  'lat',
  'lng',
  'lon',
  'latitude',
  'longitude',
  'coord',
  'coords',
  'coordinate',
  'coordinates',

  // `profiles.bio` and the derived age fields. Exact because `bio` as a fragment would
  // match `biometric` and worse, and `dob` is three letters.
  'bio',
  'dob',
  'isminor',

  // Sentry's own user object. Nothing sets these today — the app calls `Sentry.setUser`
  // nowhere — and matching them means a later one cannot quietly attach a real name.
  'username',
  'displayname',
  'ipaddress',
]);

/**
 * Field-name fragments matched anywhere in a key.
 *
 * Each is distinctive enough that a substring match will not catch an unrelated field:
 * `homecoord` matches `homeCoord`, `isochrone` matches both `cachedIsochrones` and
 * `cachedIsochronesAt`, `birth` matches `dateOfBirth`.
 *
 * ## Three names deliberately absent, because the cost outweighs the gain
 *
 * `path` is the GPS track on `gpsActivities`, and it is also what every router,
 * breadcrumb, and file error in the app calls its most useful diagnostic field. Redacting
 * it would blind us to routing bugs to protect a value that `coordinates` above already
 * catches one level down, since the track is stored as GeoJSON.
 *
 * `geometry` is mostly a *lake's* outline — public data, the substance of the map, and the
 * thing a rendering bug is about. Its coordinate array is matched regardless.
 *
 * `state` is the OAuth nonce on `oauthStates`, and it is also React state, router state,
 * and request state. It is server-side only and reaches an event only if someone attaches
 * it by hand; redacting every `state` key to prevent that is a bad trade.
 */
const SENSITIVE_FIELD_NAME_FRAGMENTS: readonly string[] = [
  // Credentials and session material. The SDK covers these in headers and cookies; this
  // covers them in `extra`, `contexts`, `tags`, and breadcrumb data, where it does not.
  // `activityConnections.accessToken` and `refreshToken` are the rows the schema calls the
  // worst in the app to leak: they grant continuing access to someone else's Strava.
  'token',
  'secret',
  'password',
  'credential',
  'authorization',
  'apikey',
  'sessionid',
  'jwt',
  'bearer',
  'cookie',

  // Private location. `homeCoord` is marked PRIVATE in the schema and is filter input
  // only; the isochrone bands are computed from it, so a band polygon is a home address
  // with extra steps. `homeTownLabel` is a public label, but it is still where someone
  // lives and it is not diagnostic.
  'homecoord',
  'isochrone',
  'hometown',
  'geolocation',
  'address',

  // Identity beyond the exact names above.
  'birth',
  'email',
  'phone',

  // A moderator's free text about a person, and the private tally beside it. Neither is
  // content the person wrote, and neither helps debug anything.
  'statusreason',
  'contradictioncount',
];

/** Whether a field name must have its value withheld from an error report. */
export function isSensitiveFieldName(fieldName: string): boolean {
  const normalized = normalizeFieldName(fieldName);

  if (EXACT_SENSITIVE_FIELD_NAMES.has(normalized)) {
    return true;
  }

  return SENSITIVE_FIELD_NAME_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/**
 * Removes the query string and fragment from a URL-shaped string.
 *
 * The deny list above cannot help here. A fetch breadcrumb is `{ method, status_code, url }`
 * and a navigation breadcrumb is `{ from, to }` — none of those keys is sensitive, and
 * `url` is one of the most useful diagnostic fields there is. What is sensitive lives
 * *inside* the string, and field-name matching never looks at values.
 *
 * Keeping the path and dropping the query is the deliberate split: knowing that
 * `GET /water/abc123` returned 500 is most of a breadcrumb's value and none of its risk,
 * while parameters are where tokens and record identifiers live. It is the same decision
 * `dataCollection.urlQueryParams: false` makes for `event.request`, applied to the path
 * that setting does not reach.
 *
 * The fragment goes too. It never reaches a server, which is precisely why OAuth implicit
 * flows put tokens there.
 *
 * String operations rather than `URL`, because this runs on Hermes as well as in a browser
 * and in Node, and Hermes' `URL` support is partial.
 */
export function redactUrlQuery(value: string): string {
  if (!looksLikeUrl(value)) {
    return value;
  }

  const cutAt = firstIndexOfEither(value, '?', '#');

  return cutAt === -1 ? value : value.slice(0, cutAt);
}

/**
 * Whether a string should be treated as a URL rather than as prose.
 *
 * Deliberately narrow, and deliberately erring toward leaving things alone: an absolute
 * HTTP URL or a root-relative path is a URL, a sentence containing a question mark is not,
 * and truncating one would silently destroy a diagnostic message.
 */
function looksLikeUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://') || value.startsWith('/');
}

/**
 * Applies `redactUrlQuery` to each whitespace-separated token of a string.
 *
 * For a span description like `GET https://skating.app/api?token=x`, the URL is the second
 * token; `looksLikeUrl` rejects the string as a whole because it starts with `GET`. Tokens
 * that are not URL-shaped come back untouched, so this is `redactUrlQuery`'s narrowness
 * preserved rather than widened — it just gets a second chance at the right substring.
 */
function redactUrlQueryInText(value: string): string {
  if (!value.includes(' ')) {
    return redactUrlQuery(value);
  }

  return value
    .split(' ')
    .map((token) => redactUrlQuery(token))
    .join(' ');
}

function firstIndexOfEither(value: string, first: string, second: string): number {
  const firstIndex = value.indexOf(first);
  const secondIndex = value.indexOf(second);

  if (firstIndex === -1) return secondIndex;
  if (secondIndex === -1) return firstIndex;

  return Math.min(firstIndex, secondIndex);
}

/**
 * Returns a copy of `value` with sensitive fields replaced.
 *
 * The structure survives, so a report still shows which fields were present and what shape
 * the data had; only the values are withheld. Knowing a home coordinate was set is useful
 * when debugging. Knowing what it was is not.
 */
export function redactSensitiveData(value: unknown): unknown {
  return redactValue(value, 0, new WeakSet());
}

/**
 * @param ancestors The containers on the path from the root to `value`, and only those —
 *                  see the cycle note below for why this is not "everything visited".
 */
function redactValue(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  if (depth > MAXIMUM_DEPTH) {
    return '[redacted: maximum depth exceeded]';
  }

  // Strings are inspected as well as keyed, because a token in a URL arrives under an
  // entirely reasonable name like `url`. See `redactUrlQuery`.
  if (typeof value === 'string') {
    return redactUrlQuery(value);
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  // Only ancestors count as a cycle. A structure may legitimately reach the same object by
  // two paths — an event mentioning one lake in two places is ordinary, not pathological —
  // and tracking every object ever visited would report the second path as circular and
  // blank out real data, which is the opposite of the point.
  if (ancestors.has(value)) {
    return '[redacted: circular reference]';
  }

  // Anything that is neither an array nor a plain object — a Date, Map, or Error — is left
  // alone rather than half-copied into something misleading.
  if (!Array.isArray(value) && !isPlainObject(value)) {
    return value;
  }

  ancestors.add(value);
  const redacted = redactContainer(value, depth, ancestors);
  ancestors.delete(value);

  return redacted;
}

function redactContainer(
  container: readonly unknown[] | Record<string, unknown>,
  depth: number,
  ancestors: WeakSet<object>,
): unknown {
  if (Array.isArray(container)) {
    return container.map((entry) => redactValue(entry, depth + 1, ancestors));
  }

  const result: Record<string, unknown> = {};

  for (const [fieldName, fieldValue] of Object.entries(container)) {
    if (isSensitiveFieldName(fieldName)) {
      result[fieldName] = REDACTION_PLACEHOLDER;
      continue;
    }

    result[fieldName] = redactValue(fieldValue, depth + 1, ancestors);
  }

  return result;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

/**
 * Minimal structural types for the values the hooks receive.
 *
 * Described structurally, and only for the fields actually touched, rather than imported
 * from an SDK. `@skating/core` is shared by the web app and the React Native app and must
 * depend on neither SDK, and both SDKs' event types are far larger than what these read.
 * The hooks are generic over the concrete types so they stay assignable to each SDK's own
 * signature, which requires back the exact type it was passed.
 */
export type SentryEventLike = {
  extra?: unknown;
  contexts?: unknown;
  request?: unknown;
  tags?: unknown;
  user?: unknown;
};

export type SentryBreadcrumbLike = {
  data?: unknown;
};

/**
 * A transaction carries everything an event does, plus its spans.
 *
 * `data` is a span's attribute bag, which for an HTTP span holds `http.url` and friends.
 * `description` is the human-readable summary, which for the same span is literally
 * `GET https://host/path?query` — a full URL, in a string, with no key to match on.
 */
export type SentrySpanLike = {
  data?: unknown;
  description?: string;
};

export type SentryTransactionEventLike = SentryEventLike & {
  spans?: SentrySpanLike[];
};

/**
 * Applies redaction to the parts of an event that carry structured application data.
 *
 * `extra`, `contexts`, `request`, `tags`, and `user` are every field on an event whose
 * contents this application chooses. All five are walked rather than only the ones
 * something writes today — the point of putting the rules in one module is that the first
 * person to call `Sentry.setTag('homeCoord', …)` is covered without knowing this file
 * exists.
 *
 * Not covered, deliberately: `message`, `exception[].value`, and stack traces. Those are
 * strings with no field names to match against, so there is nothing here that could decide
 * what to withhold.
 *
 * `breadcrumbs` need no pass here. Every breadcrumb goes through `beforeBreadcrumb` when it
 * is recorded, so by the time one is attached to an event it is already redacted.
 */
function redactSentryEvent<Event extends SentryEventLike>(event: Event): Event {
  const redacted: Event = { ...event };

  if (event.extra !== undefined) redacted.extra = asRecord(redactSensitiveData(event.extra));
  if (event.contexts !== undefined) {
    redacted.contexts = asRecord(redactSensitiveData(event.contexts));
  }
  if (event.request !== undefined) redacted.request = asRecord(redactSensitiveData(event.request));
  if (event.tags !== undefined) redacted.tags = asRecord(redactSensitiveData(event.tags));
  if (event.user !== undefined) redacted.user = asRecord(redactSensitiveData(event.user));

  return redacted;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

/**
 * The `beforeSend` and `beforeBreadcrumb` hooks both SDKs install.
 *
 * They live in `@skating/core` rather than in each app because the implementations were
 * going to be identical and there is nothing platform-specific in them. What genuinely
 * differs between web and native is only the surrounding option names — the browser and
 * Node SDKs take `dataCollection`, the React Native SDK exposes `sendDefaultPii` — and
 * that stays in each app. Privacy rules configured twice drift, and the half that drifts
 * is the half nobody notices until private data is already in a bug report.
 *
 * These are the last thing that runs before an event leaves the process.
 */
export const sentryPrivacyHooks = {
  beforeSend: <Event extends SentryEventLike>(event: Event): Event => redactSentryEvent(event),

  /**
   * Transactions need their own pass. `beforeSend` is not called for them, and with
   * `tracesSampleRate` at 1.0 every pageload and navigation produces one, which makes
   * spans the highest-volume thing this app sends.
   *
   * The router integration names transactions after the *matched route* (`/u/$username`,
   * not `/u/teagan`), so the name itself is already parameterized. The URLs are in the
   * spans: an HTTP span puts one in `data['http.url']` and another in `description`.
   */
  beforeSendTransaction: <Event extends SentryTransactionEventLike>(event: Event): Event => {
    const redacted = redactSentryEvent(event);

    if (event.spans === undefined) {
      return redacted;
    }

    return {
      ...redacted,
      spans: event.spans.map((span) => ({
        ...span,
        ...(span.data === undefined ? {} : { data: asRecord(redactSensitiveData(span.data)) }),
        ...(span.description === undefined
          ? {}
          : { description: redactUrlQueryInText(span.description) }),
      })),
    };
  },

  /**
   * Breadcrumbs record navigation and network activity and carry the same data an event
   * does — plus the URLs that `redactUrlQuery` exists for.
   */
  beforeBreadcrumb: <Breadcrumb extends SentryBreadcrumbLike>(
    breadcrumb: Breadcrumb,
  ): Breadcrumb => {
    if (breadcrumb.data === undefined) {
      return breadcrumb;
    }

    return { ...breadcrumb, data: asRecord(redactSensitiveData(breadcrumb.data)) };
  },
};
