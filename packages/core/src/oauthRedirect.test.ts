import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  isSafeOAuthRedirect,
  OAUTH_RESULT_PARAM,
  planOAuthRedirect,
  withOAuthResult,
} from './oauthRedirect';

const WEB = 'https://skating.example';

describe('isSafeOAuthRedirect', () => {
  it('allows our own web origin', () => {
    expect(isSafeOAuthRedirect(`${WEB}/settings`, WEB)).toBe(true);
    expect(isSafeOAuthRedirect(`${WEB}/settings?foo=1`, WEB)).toBe(true);
  });

  it('REFUSES another origin — this endpoint would otherwise be an open redirect', () => {
    expect(isSafeOAuthRedirect('https://evil.example/steal', WEB)).toBe(false);
    // A lookalike subdomain and a userinfo-prefixed host are the two classic bypasses.
    expect(isSafeOAuthRedirect('https://skating.example.evil.com/', WEB)).toBe(false);
    expect(isSafeOAuthRedirect('https://skating.example@evil.example/', WEB)).toBe(false);
    // Same host, different scheme/port is still a different origin.
    expect(isSafeOAuthRedirect('http://skating.example/settings', WEB)).toBe(false);
    expect(isSafeOAuthRedirect('https://skating.example:8443/settings', WEB)).toBe(false);
  });

  it('allows an app scheme — it can only reach an app on this device', () => {
    expect(isSafeOAuthRedirect('skating://settings', WEB)).toBe(true);
    expect(isSafeOAuthRedirect('exp://192.168.1.5:8081/--/settings', WEB)).toBe(true);
    // ...and still does when no web origin is configured at all.
    expect(isSafeOAuthRedirect('skating://settings', undefined)).toBe(true);
  });

  it('refuses a relative path — it would resolve against the Convex host and 404', () => {
    expect(isSafeOAuthRedirect('/settings', WEB)).toBe(false);
    expect(isSafeOAuthRedirect('settings?strava=connected', WEB)).toBe(false);
    expect(isSafeOAuthRedirect('', WEB)).toBe(false);
  });

  it('refuses a web target when no web origin is configured', () => {
    expect(isSafeOAuthRedirect(`${WEB}/settings`, undefined)).toBe(false);
  });
});

describe('withOAuthResult', () => {
  it('adds the flag to a bare URL', () => {
    expect(withOAuthResult('skating://settings', 'connected')).toContain(
      `${OAUTH_RESULT_PARAM}=connected`,
    );
  });

  it('does not corrupt a target that already has a query — the old concat bug', () => {
    const out = withOAuthResult('skating://settings?foo=1', 'connected');
    // The bug this pins: string concatenation produced `...?foo=1connected`.
    expect(out).not.toContain('1connected');
    const url = new URL(out);
    expect(url.searchParams.get('foo')).toBe('1');
    expect(url.searchParams.get(OAUTH_RESULT_PARAM)).toBe('connected');
  });

  it('replaces an existing flag rather than appending a second one', () => {
    const out = withOAuthResult(`${WEB}/settings?strava=failed`, 'connected');
    expect(new URL(out).searchParams.getAll(OAUTH_RESULT_PARAM)).toEqual(['connected']);
  });

  it('property: the result is always readable back off the URL', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('skating://settings', `${WEB}/settings`, `${WEB}/settings?a=1&b=2`),
        fc.constantFrom('connected' as const, 'failed' as const, 'declined' as const),
        (target, result) => {
          expect(
            new URL(withOAuthResult(target, result)).searchParams.get(OAUTH_RESULT_PARAM),
          ).toBe(result);
        },
      ),
    );
  });
});

describe('planOAuthRedirect', () => {
  it('prefers the deep link the flow started with', () => {
    const plan = planOAuthRedirect('skating://settings', WEB, 'connected');
    expect(plan).toEqual({ kind: 'redirect', location: 'skating://settings?strava=connected' });
  });

  it('falls back to the configured web app when there is no target', () => {
    const plan = planOAuthRedirect(null, WEB, 'failed');
    expect(plan.kind).toBe('redirect');
    if (plan.kind !== 'redirect') return;
    expect(plan.location).toBe(`${WEB}/settings?strava=failed`);
  });

  it('tolerates a trailing slash on the configured web app URL', () => {
    const plan = planOAuthRedirect(null, `${WEB}/`, 'connected');
    if (plan.kind !== 'redirect') return;
    expect(plan.location).toBe(`${WEB}/settings?strava=connected`);
  });

  it('renders a page rather than emitting a dead-end relative redirect', () => {
    // Nothing configured and no target: the old code sent `/settings?strava=…`, which resolves
    // against the Convex .site host and 404s.
    expect(planOAuthRedirect(null, undefined, 'connected')).toEqual({
      kind: 'page',
      result: 'connected',
    });
  });

  it('ignores a hostile target and uses the safe fallback instead', () => {
    const plan = planOAuthRedirect('https://evil.example', WEB, 'connected');
    expect(plan.kind).toBe('redirect');
    if (plan.kind !== 'redirect') return;
    expect(plan.location.startsWith(WEB)).toBe(true);
  });

  it('renders a page when the target is hostile AND there is no fallback', () => {
    expect(planOAuthRedirect('https://evil.example', undefined, 'connected')).toEqual({
      kind: 'page',
      result: 'connected',
    });
  });

  it('property: never returns a location outside the web origin or an app scheme', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.webUrl(),
          fc.constant('skating://settings'),
          fc.constant('/settings'),
          fc.string({ maxLength: 40 }),
        ),
        fc.constantFrom(WEB, undefined),
        (target, web) => {
          const plan = planOAuthRedirect(target, web, 'connected');
          if (plan.kind !== 'redirect') return;
          const url = new URL(plan.location);
          if (url.protocol === 'http:' || url.protocol === 'https:') {
            expect(url.origin).toBe(new URL(web as string).origin);
          }
        },
      ),
    );
  });
});
