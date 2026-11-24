import type { EntryRoute } from '@skating/core';
import { describe, expect, it } from 'vitest';
import { authZoneTarget, ENTRY_PATHS } from './authZone';

describe('authZoneTarget', () => {
  it('never redirects while loading', () => {
    expect(authZoneTarget('loading', '/')).toBeNull();
    expect(authZoneTarget('loading', '/sign-in')).toBeNull();
    expect(authZoneTarget('loading', '/terms')).toBeNull();
  });

  it('sends signed-out users to sign-in from protected paths, but leaves auth/about alone', () => {
    expect(authZoneTarget('auth', '/')).toBe('/sign-in');
    expect(authZoneTarget('auth', '/feed')).toBe('/sign-in');
    expect(authZoneTarget('auth', '/onboarding')).toBe('/sign-in');
    expect(authZoneTarget('auth', '/know-before-you-go')).toBe('/sign-in');
    expect(authZoneTarget('auth', '/sign-in')).toBeNull();
    expect(authZoneTarget('auth', '/sign-up')).toBeNull();
    expect(authZoneTarget('auth', '/about')).toBeNull();
  });

  it.each([
    ['account', '/onboarding'],
    ['terms', '/terms'],
    ['questions', '/know-before-you-go'],
    ['welcome', '/welcome'],
  ] as const)('pins the %s step to %s until the route moves on', (route, path) => {
    expect(ENTRY_PATHS[route]).toBe(path);
    expect(authZoneTarget(route, path)).toBeNull();
    expect(authZoneTarget(route, '/')).toBe(path);
    expect(authZoneTarget(route, '/sign-in')).toBe(path);
    expect(authZoneTarget(route, '/water/abc')).toBe(path);
    // Every other step's path is the wrong one.
    for (const other of Object.values(ENTRY_PATHS)) {
      if (other !== path) expect(authZoneTarget(route, other)).toBe(path);
    }
  });

  it('keeps the receipt where the acceptance was recorded — either of the Terms step’s homes', () => {
    expect(authZoneTarget('receipt', '/onboarding')).toBeNull();
    expect(authZoneTarget('receipt', '/terms')).toBeNull();
    // Anywhere else mid-hold, the receipt is drawn on /terms, which knows the account now exists.
    expect(authZoneTarget('receipt', '/')).toBe('/terms');
    expect(authZoneTarget('receipt', '/know-before-you-go')).toBe('/terms');
    expect(authZoneTarget('receipt', '/welcome')).toBe('/terms');
  });

  it('bounces a skater who is through off the auth pages and every step of the way in', () => {
    expect(authZoneTarget('app', '/sign-in')).toBe('/');
    expect(authZoneTarget('app', '/sign-up')).toBe('/');
    for (const path of Object.values(ENTRY_PATHS)) expect(authZoneTarget('app', path)).toBe('/');
    expect(authZoneTarget('app', '/')).toBeNull();
    expect(authZoneTarget('app', '/feed')).toBeNull();
    expect(authZoneTarget('app', '/u/ada')).toBeNull();
    expect(authZoneTarget('app', '/about')).toBeNull();
    expect(authZoneTarget('app', '/settings/data')).toBeNull();
  });

  it('sends an old /reack bookmark home, and never to it', () => {
    expect(authZoneTarget('app', '/reack')).toBe('/');
    for (const route of ['account', 'terms', 'questions', 'welcome', 'receipt'] as EntryRoute[]) {
      expect(authZoneTarget(route, '/reack')).not.toBe('/reack');
    }
  });
});
