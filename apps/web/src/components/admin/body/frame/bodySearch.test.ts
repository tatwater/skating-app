import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  BODY_TABS,
  bodyConsoleHref,
  bodyTabOf,
  DEFAULT_RETURN,
  isLit,
  RETURN_PATHS,
  returnPathOf,
  safeReturnPath,
  searchFor,
  validateBodySearch,
} from './bodySearch';

describe('validateBodySearch', () => {
  it('keeps a known tab other than Shape, and writes Shape as no param', () => {
    expect(validateBodySearch({ tab: 'names' })).toEqual({ tab: 'names' });
    expect(validateBodySearch({ tab: 'shape' })).toEqual({});
    expect(validateBodySearch({ tab: 'Shape' })).toEqual({});
    expect(validateBodySearch({ tab: 'nope' })).toEqual({});
    expect(validateBodySearch({ tab: 3 })).toEqual({});
  });

  it('keeps a lit address of a kind and an id, and drops anything else', () => {
    expect(validateBodySearch({ lit: 'bay:k57abc' })).toEqual({ lit: 'bay:k57abc' });
    expect(validateBodySearch({ lit: 'landmarkAsk:j9_x-1.2' })).toEqual({
      lit: 'landmarkAsk:j9_x-1.2',
    });
    for (const bad of ['bay', ':id', 'Bay:x', 'bay:', 'bay:<script>', 'bay:a b', 7, null]) {
      expect(validateBodySearch({ lit: bad })).toEqual({});
    }
  });

  it('keeps a return path under the lists, with its own search', () => {
    expect(validateBodySearch({ from: '/admin/bodies?q=mascoma&sort=area' })).toEqual({
      from: '/admin/bodies?q=mascoma&sort=area',
    });
    expect(validateBodySearch({ from: '/admin/water' })).toEqual({ from: '/admin/water' });
  });

  it('opens on Shape and goes back to the default list without a param', () => {
    expect(bodyTabOf({})).toBe('shape');
    expect(bodyTabOf({ tab: 'links' })).toBe('links');
    expect(returnPathOf({})).toBe(DEFAULT_RETURN);
    expect(DEFAULT_RETURN).toBe('/admin/bodies');
    expect(returnPathOf({ from: '/admin/bodies?x=1' })).toBe('/admin/bodies?x=1');
  });
});

describe('safeReturnPath', () => {
  it('refuses anything that could leave the console', () => {
    for (const bad of [
      'https://evil.example/admin/bodies',
      '//evil.example/admin/bodies',
      '/\\evil.example',
      'javascript:alert(1)',
      '/admin/bodiesx',
      '/admin',
      '/admin/body/abc',
      '/',
      '',
      'admin/bodies',
      `/admin/bodies?${'x'.repeat(3000)}`,
    ]) {
      expect(safeReturnPath(bad), bad).toBeNull();
    }
  });

  it('normalizes a path that climbs out of the list', () => {
    expect(safeReturnPath('/admin/bodies/../users')).toBeNull();
    expect(safeReturnPath('/admin/bodies/./x')).toBe('/admin/bodies/x');
  });

  it('only ever returns a same-origin path under a list (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), fc.webPath(), (junk, path) => {
        for (const candidate of [junk, path, `/admin/bodies${path}`, `/admin/water${junk}`]) {
          const out = safeReturnPath(candidate);
          if (out === null) continue;
          expect(out.startsWith('/')).toBe(true);
          expect(out.startsWith('//')).toBe(false);
          const url = new URL(out, 'https://x.invalid');
          expect(url.origin).toBe('https://x.invalid');
          expect(
            RETURN_PATHS.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`)),
          ).toBe(true);
        }
      }),
    );
  });
});

describe('searchFor', () => {
  it('drops the lit item when the tab changes, keeps it when it does not', () => {
    const s = { tab: 'places' as const, lit: 'landmark:a', from: '/admin/bodies' };
    expect(searchFor(s, { tab: 'names' })).toEqual({ tab: 'names', from: '/admin/bodies' });
    expect(searchFor(s, {})).toEqual(s);
    expect(searchFor(s, { tab: 'shape', lit: 'bay:b' })).toEqual({
      lit: 'bay:b',
      from: '/admin/bodies',
    });
    expect(searchFor(s, { lit: null })).toEqual({ tab: 'places', from: '/admin/bodies' });
  });

  it('never writes an invalid lit address', () => {
    expect(searchFor({}, { lit: 'not an address' })).toEqual({});
  });

  it('round-trips through the validator for every tab', () => {
    for (const tab of BODY_TABS) {
      const next = searchFor({ from: '/admin/water' }, { tab, lit: 'bay:x1' });
      expect(validateBodySearch(next)).toEqual(next);
    }
  });
});

describe('bodyConsoleHref', () => {
  it('links a body with the list it came from, and drops a return path it would refuse', () => {
    expect(bodyConsoleHref('abc')).toBe('/admin/body/abc');
    expect(bodyConsoleHref('abc', '/admin/bodies?q=m', 'names')).toBe(
      '/admin/body/abc?tab=names&from=%2Fadmin%2Fbodies%3Fq%3Dm',
    );
    expect(bodyConsoleHref('abc', 'https://evil.example')).toBe('/admin/body/abc');
    expect(bodyConsoleHref('a/b')).toBe('/admin/body/a%2Fb');
  });

  it('is what the validator reads back', () => {
    const href = bodyConsoleHref('abc', '/admin/bodies?q=m&page=2', 'water');
    const params = Object.fromEntries(new URL(href, 'https://x.invalid').searchParams);
    expect(validateBodySearch(params)).toEqual({ tab: 'water', from: '/admin/bodies?q=m&page=2' });
  });
});

describe('isLit', () => {
  it('reads a kind and an id', () => {
    expect(isLit('ask:abc')).toBe(true);
    expect(isLit('ask')).toBe(false);
  });
});
