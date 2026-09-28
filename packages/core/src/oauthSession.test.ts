import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  browserOwnsOAuthFlow,
  clearStateCookie,
  OAUTH_STATE_COOKIE,
  readCookie,
  serializeStateCookie,
} from './oauthSession';

describe('serializeStateCookie', () => {
  const cookie = serializeStateCookie('abc123', 900);

  it('carries the nonce and the TTL', () => {
    expect(cookie).toContain(`${OAUTH_STATE_COOKIE}=abc123`);
    expect(cookie).toContain('Max-Age=900');
  });

  it('is HttpOnly + Secure and scoped to the OAuth routes only', () => {
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/strava');
  });

  it('is SameSite=Lax — Strict would break the callback entirely', () => {
    // The callback is a cross-site top-level GET navigation from strava.com. Lax sends cookies on
    // exactly that; Strict withholds them, so every single connect would fail the session check.
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('SameSite=Strict');
    expect(cookie).not.toContain('SameSite=None');
  });

  it('never emits a negative Max-Age', () => {
    expect(serializeStateCookie('x', -5)).toContain('Max-Age=0');
  });

  it('clearStateCookie expires it on the same path, so it actually clears', () => {
    const cleared = clearStateCookie();
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Path=/strava');
  });
});

describe('readCookie', () => {
  it('finds a cookie among several, whatever the spacing', () => {
    expect(readCookie('a=1; skating_oauth_state=xyz; b=2', OAUTH_STATE_COOKIE)).toBe('xyz');
    expect(readCookie('a=1;skating_oauth_state=xyz', OAUTH_STATE_COOKIE)).toBe('xyz');
    expect(readCookie('skating_oauth_state=xyz;', OAUTH_STATE_COOKIE)).toBe('xyz');
  });

  it('returns null for a missing cookie or a missing header', () => {
    expect(readCookie('a=1; b=2', OAUTH_STATE_COOKIE)).toBeNull();
    expect(readCookie(null, OAUTH_STATE_COOKIE)).toBeNull();
    expect(readCookie(undefined, OAUTH_STATE_COOKIE)).toBeNull();
    expect(readCookie('', OAUTH_STATE_COOKIE)).toBeNull();
  });

  it('matches the name exactly — a decoy cookie must not satisfy the lookup', () => {
    expect(readCookie('skating_oauth_state_decoy=evil', OAUTH_STATE_COOKIE)).toBeNull();
    expect(readCookie('xskating_oauth_state=evil', OAUTH_STATE_COOKIE)).toBeNull();
    // ...and a real one alongside a decoy still resolves to the real one.
    expect(
      readCookie('skating_oauth_state_decoy=evil; skating_oauth_state=good', OAUTH_STATE_COOKIE),
    ).toBe('good');
  });

  it('handles a value containing = and percent-encoding', () => {
    expect(readCookie('skating_oauth_state=a=b', OAUTH_STATE_COOKIE)).toBe('a=b');
    expect(readCookie('skating_oauth_state=a%20b', OAUTH_STATE_COOKIE)).toBe('a b');
    // A malformed escape is returned raw rather than throwing mid-flow.
    expect(readCookie('skating_oauth_state=a%zz', OAUTH_STATE_COOKIE)).toBe('a%zz');
  });

  it('round-trips whatever serializeStateCookie produced', () => {
    fc.assert(
      fc.property(fc.hexaString({ minLength: 1, maxLength: 64 }), (nonce) => {
        const header = serializeStateCookie(nonce, 900).split(';')[0] as string;
        expect(readCookie(header, OAUTH_STATE_COOKIE)).toBe(nonce);
      }),
    );
  });
});

describe('browserOwnsOAuthFlow — the account-linking guard', () => {
  it('accepts the browser that started the flow', () => {
    expect(browserOwnsOAuthFlow('skating_oauth_state=nonce-1', 'nonce-1')).toBe(true);
  });

  it("REFUSES a victim's browser, which never received the attacker's cookie", () => {
    // The attack: an attacker mints a state on their own account and gets a victim to complete the
    // Strava consent screen. Without this check the victim's tokens land on the attacker's profile.
    expect(browserOwnsOAuthFlow(null, 'nonce-1')).toBe(false);
    expect(browserOwnsOAuthFlow('a=1; b=2', 'nonce-1')).toBe(false);
  });

  it('refuses a cookie for a different flow', () => {
    expect(browserOwnsOAuthFlow('skating_oauth_state=nonce-2', 'nonce-1')).toBe(false);
  });

  it('refuses an empty state, however inviting the cookie looks', () => {
    expect(browserOwnsOAuthFlow('skating_oauth_state=', '')).toBe(false);
  });

  it('property: only the exact matching nonce ever passes', () => {
    fc.assert(
      fc.property(
        fc.hexaString({ minLength: 8, maxLength: 32 }),
        fc.hexaString({ minLength: 8, maxLength: 32 }),
        (a, b) => {
          expect(browserOwnsOAuthFlow(`${OAUTH_STATE_COOKIE}=${a}`, b)).toBe(a === b);
        },
      ),
    );
  });
});
