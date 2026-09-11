import { describe, expect, it } from 'vitest';
import {
  isSensitiveFieldName,
  REDACTION_PLACEHOLDER,
  redactSensitiveData,
  redactUrlQuery,
  type SentryBreadcrumbLike,
  type SentrySpanLike,
  sentryPrivacyHooks,
} from './sentryPrivacy';

describe('isSensitiveFieldName', () => {
  it.each([
    // Coordinates, in the spellings the schema and GeoJSON actually use.
    'lat',
    'lng',
    'longitude',
    'coordinates',
    'coords',
    // The private home location and everything derived from it.
    'homeCoord',
    'home_coord',
    'cachedIsochrones',
    'cachedIsochronesAt',
    'homeTownLabel',
    // Identity.
    'bio',
    'dateOfBirth',
    'dob',
    'isMinor',
    'username',
    'displayName',
    'email',
    'phoneNumber',
    // Credentials. `accessToken`/`refreshToken` are the activityConnections rows the
    // schema calls the worst in the app to leak.
    'accessToken',
    'refreshToken',
    'authorization',
    'apiKey',
    '__clerk_db_jwt',
    'sessionId',
    // Moderator notes and the private tally beside them.
    'statusReason',
    'contradictionCount',
  ])('treats %s as sensitive', (fieldName) => {
    expect(isSensitiveFieldName(fieldName)).toBe(true);
  });

  it.each([
    // The near misses the exact-match entries exist to protect. Each of these is a
    // diagnostic field a fragment match would have blanked out.
    'latency',
    'translateX',
    'relatedReports',
    'latestReport',
    'longPress',
    'belongsTo',
    // Deliberately not redacted, with the reasoning recorded in sentryPrivacy.ts.
    'path',
    'geometry',
    'state',
    // Ordinary diagnostics.
    'waterBodyId',
    'reportId',
    'provider',
    'statusCode',
    'method',
    'url',
    'appVersion',
    'deviceModel',
  ])('leaves %s alone', (fieldName) => {
    expect(isSensitiveFieldName(fieldName)).toBe(false);
  });
});

describe('redactSensitiveData', () => {
  it('withholds a value but keeps the field, so a report still shows the shape', () => {
    const redacted = redactSensitiveData({ homeCoord: { lat: 44.4, lng: -73.2 }, reportId: 'r1' });

    expect(redacted).toEqual({ homeCoord: REDACTION_PLACEHOLDER, reportId: 'r1' });
  });

  it("redacts a GPS track's points through the GeoJSON coordinates key, not through `path`", () => {
    // `path` is left alone on purpose so routing diagnostics survive. This is the assertion
    // that the track is nonetheless covered, one level down.
    const redacted = redactSensitiveData({
      path: { type: 'LineString', coordinates: [[-73.2, 44.4]] },
    });

    expect(redacted).toEqual({ path: { type: 'LineString', coordinates: REDACTION_PLACEHOLDER } });
  });

  it('reaches into arrays and nested objects', () => {
    const redacted = redactSensitiveData({
      activities: [{ provider: 'strava', accessToken: 'abc' }],
    });

    expect(redacted).toEqual({
      activities: [{ provider: 'strava', accessToken: REDACTION_PLACEHOLDER }],
    });
  });

  it('survives a cycle instead of recursing forever', () => {
    const cyclic: Record<string, unknown> = { reportId: 'r1' };
    cyclic.self = cyclic;

    expect(redactSensitiveData(cyclic)).toEqual({
      reportId: 'r1',
      self: '[redacted: circular reference]',
    });
  });

  it('does not treat the same object reached twice by different paths as a cycle', () => {
    const lake = { waterBodyId: 'w1' };

    expect(redactSensitiveData({ nearest: lake, selected: lake })).toEqual({
      nearest: { waterBodyId: 'w1' },
      selected: { waterBodyId: 'w1' },
    });
  });

  it('leaves values that are neither arrays nor plain objects intact', () => {
    const date = new Date(0);

    expect(redactSensitiveData({ detectedAt: date })).toEqual({ detectedAt: date });
  });

  it('stops at the depth limit rather than walking a pathological structure forever', () => {
    // Deeper than MAXIMUM_DEPTH, built without a cycle so it is the depth guard being
    // exercised and not the ancestor check.
    let nested: Record<string, unknown> = { reportId: 'r1' };
    for (let i = 0; i < 15; i += 1) {
      nested = { nested };
    }

    expect(JSON.stringify(redactSensitiveData(nested))).toContain(
      '[redacted: maximum depth exceeded]',
    );
  });
});

describe('redactUrlQuery', () => {
  it('keeps the path and drops the query, which is where identifiers and tokens live', () => {
    expect(redactUrlQuery('https://skating.app/water/abc?token=secret')).toBe(
      'https://skating.app/water/abc',
    );
  });

  it('drops the fragment, which is where implicit OAuth flows put tokens', () => {
    expect(redactUrlQuery('/feed#access_token=secret')).toBe('/feed');
  });

  it('leaves prose alone rather than truncating a diagnostic message at its question mark', () => {
    expect(redactUrlQuery('Could not resolve the lake. Was it deleted?')).toBe(
      'Could not resolve the lake. Was it deleted?',
    );
  });

  it('cuts at whichever of the query and the fragment comes first', () => {
    // A URL carrying both. The fragment leads here, so cutting at the `?` would leave the
    // fragment's contents attached — which is the half that carries implicit-flow tokens.
    expect(redactUrlQuery('/feed#access_token=secret?report=r1')).toBe('/feed');
    expect(redactUrlQuery('/feed?report=r1#access_token=secret')).toBe('/feed');
  });

  it('leaves a URL with neither a query nor a fragment exactly as it is', () => {
    expect(redactUrlQuery('https://skating.app/water/abc')).toBe('https://skating.app/water/abc');
  });
});

describe('sentryPrivacyHooks', () => {
  it('redacts every event field whose contents the application chooses', () => {
    const event = sentryPrivacyHooks.beforeSend({
      extra: { homeCoord: { lat: 44.4 } },
      contexts: { profile: { dateOfBirth: 1 } },
      request: { url: 'https://skating.app/feed?report=r1' },
      tags: { username: 'teagan' },
      user: { email: 'someone@example.com', id: 'clerk_abc' },
    });

    expect(event).toEqual({
      extra: { homeCoord: REDACTION_PLACEHOLDER },
      contexts: { profile: { dateOfBirth: REDACTION_PLACEHOLDER } },
      request: { url: 'https://skating.app/feed' },
      tags: { username: REDACTION_PLACEHOLDER },
      user: { email: REDACTION_PLACEHOLDER, id: 'clerk_abc' },
    });
  });

  it('leaves an event with none of those fields untouched', () => {
    expect(sentryPrivacyHooks.beforeSend({})).toEqual({});
  });

  it('strips the query from a fetch breadcrumb, which no field name could have caught', () => {
    const breadcrumb = sentryPrivacyHooks.beforeBreadcrumb({
      data: {
        method: 'GET',
        status_code: 500,
        url: 'https://skating.app/api?__clerk_db_jwt=dvb_x',
      },
    });

    expect(breadcrumb.data).toEqual({
      method: 'GET',
      status_code: 500,
      url: 'https://skating.app/api',
    });
  });

  it('strips the query from both ends of a navigation breadcrumb', () => {
    const breadcrumb = sentryPrivacyHooks.beforeBreadcrumb({
      data: { from: '/feed?report=r1', to: '/water/w1?sub=s1' },
    });

    expect(breadcrumb.data).toEqual({ from: '/feed', to: '/water/w1' });
  });

  it('passes a breadcrumb with no data through unchanged', () => {
    // Annotated rather than inferred: `SentryBreadcrumbLike` has one optional property, so
    // a bare `{ category }` literal shares nothing with it and TypeScript rejects it as a
    // weak type. A real SDK breadcrumb always declares `data`, so this is an artifact of
    // the test literal, not of the hook's signature.
    const breadcrumb: SentryBreadcrumbLike & { category: string } = { category: 'ui.click' };

    expect(sentryPrivacyHooks.beforeBreadcrumb(breadcrumb)).toBe(breadcrumb);
  });

  it('strips URLs from span attributes and descriptions, which beforeSend never sees', () => {
    const transaction = sentryPrivacyHooks.beforeSendTransaction({
      spans: [
        {
          description: 'GET https://skating.app/api/water?__clerk_db_jwt=dvb_x',
          data: { 'http.url': 'https://skating.app/api/water?report=r1', 'http.method': 'GET' },
        },
      ],
    });

    expect(transaction.spans).toEqual([
      {
        description: 'GET https://skating.app/api/water',
        data: { 'http.url': 'https://skating.app/api/water', 'http.method': 'GET' },
      },
    ]);
  });

  it('redacts a transaction the same way it redacts an event', () => {
    const transaction = sentryPrivacyHooks.beforeSendTransaction({
      tags: { homeTownLabel: 'Burlington' },
    });

    expect(transaction.tags).toEqual({ homeTownLabel: REDACTION_PLACEHOLDER });
  });

  it('leaves a transaction with no spans alone rather than inventing an empty list', () => {
    expect(sentryPrivacyHooks.beforeSendTransaction({ tags: { reportId: 'r1' } })).toEqual({
      tags: { reportId: 'r1' },
    });
  });

  it('handles a span carrying only one of data and description', () => {
    const transaction = sentryPrivacyHooks.beforeSendTransaction({
      spans: [
        { data: { 'http.url': 'https://skating.app/a?x=1' } },
        // A bare URL with no verb in front of it, which is the single-token path through
        // `redactUrlQueryInText`.
        { description: 'https://skating.app/b?y=2' },
        // Annotated for the same weak-type reason as the breadcrumb above: a literal with
        // neither `data` nor `description` shares nothing with `SentrySpanLike`.
        { op: 'ui.render' } as SentrySpanLike & { op: string },
      ],
    });

    expect(transaction.spans).toEqual([
      { data: { 'http.url': 'https://skating.app/a' } },
      { description: 'https://skating.app/b' },
      { op: 'ui.render' },
    ]);
  });

  it('drops an event field that is not an object rather than passing a bare value on', () => {
    // Sentry's own types allow `extra` to be loosely shaped, and a caller can set it to a
    // string. Substituting an empty object keeps the event well-formed instead of shipping
    // something the wire format does not expect.
    expect(sentryPrivacyHooks.beforeSend({ extra: 'a bare string' })).toEqual({ extra: {} });
  });
});
