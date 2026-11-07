import { afterEach, describe, expect, it } from 'vitest';

import {
  BOOT_COOKIE,
  bootCookieString,
  isBootZone,
  readBootZone,
  readBootZoneFromCookie,
} from './boot';

function clearBootCookie() {
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API; this module reads document.cookie
  document.cookie = `${BOOT_COOKIE}=; path=/; max-age=0`;
}

afterEach(clearBootCookie);

describe('isBootZone', () => {
  it.each(['auth', 'onboarding', 'reack', 'app'])('accepts the settled zone %s', (zone) => {
    expect(isBootZone(zone)).toBe(true);
  });

  it.each([undefined, '', 'loading', 'App', 'admin'])('rejects %s', (value) => {
    // `loading` is rejected on purpose: it is the absence of an answer, so it can never be stored.
    expect(isBootZone(value)).toBe(false);
  });
});

describe('readBootZoneFromCookie', () => {
  it('reads the zone out of a lone cookie', () => {
    expect(readBootZoneFromCookie('gli-boot=app')).toBe('app');
  });

  it('reads it from among other cookies, whatever the spacing', () => {
    expect(readBootZoneFromCookie('gli-theme=dark; gli-boot=auth; __session=x')).toBe('auth');
    expect(readBootZoneFromCookie('a=1;gli-boot=reack;b=2')).toBe('reack');
  });

  it('is null when there is no cookie — which is the cold start', () => {
    expect(readBootZoneFromCookie('')).toBeNull();
    expect(readBootZoneFromCookie('gli-theme=dark')).toBeNull();
  });

  it('is null for a value that is not a zone, rather than trusting it', () => {
    expect(readBootZoneFromCookie('gli-boot=loading')).toBeNull();
    expect(readBootZoneFromCookie('gli-boot=%3Cscript%3E')).toBeNull();
  });

  it('does not match a cookie whose name merely ends in the boot cookie’s', () => {
    expect(readBootZoneFromCookie('not-gli-boot=app')).toBeNull();
  });
});

describe('bootCookieString', () => {
  it('writes a session cookie on the whole site: no max-age, so it dies with the session', () => {
    const written = bootCookieString('app');
    expect(written).toBe('gli-boot=app; path=/; samesite=lax');
    expect(written).not.toMatch(/max-age|expires/i);
  });

  it('round-trips through the document', () => {
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API; this module reads document.cookie
    document.cookie = bootCookieString('onboarding');
    expect(readBootZoneFromCookie(document.cookie)).toBe('onboarding');
  });
});

describe('readBootZone', () => {
  it('reads the document’s cookie in a browser', () => {
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API; this module reads document.cookie
    document.cookie = bootCookieString('app');
    expect(readBootZone()).toBe('app');
  });

  it('is null with nothing stored', () => {
    clearBootCookie();
    expect(readBootZone()).toBeNull();
  });
});
