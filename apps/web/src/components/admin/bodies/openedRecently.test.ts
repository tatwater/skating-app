import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OPENED_KEY,
  OPENED_MAX,
  parseOpened,
  readOpened,
  rememberOpened,
  withOpened,
} from './openedRecently';

const id = (n: number) => `k17${String(n).padStart(29, '0')}`;

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('the opened list', () => {
  it('moves a body to the front, once, and keeps no more than the cap', () => {
    expect(withOpened([id(1), id(2)], id(2))).toEqual([id(2), id(1)]);
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 40 }), { maxLength: 60 }), (ns) => {
        let list: string[] = [];
        for (const n of ns) list = withOpened(list, id(n));
        expect(list.length).toBeLessThanOrEqual(OPENED_MAX);
        expect(new Set(list).size).toBe(list.length);
        if (ns.length > 0) expect(list[0]).toBe(id(ns.at(-1) ?? 0));
      }),
    );
  });

  it('reads anything but a list of ids as empty', () => {
    expect(parseOpened(null)).toEqual([]);
    expect(parseOpened('not json')).toEqual([]);
    expect(parseOpened('{"a":1}')).toEqual([]);
    expect(parseOpened(JSON.stringify([id(1), 'junk', 7, id(1)]))).toEqual([id(1)]);
  });

  it('remembers in this browser, newest first', () => {
    rememberOpened(id(1));
    rememberOpened(id(2));
    rememberOpened('not an id');
    expect(readOpened()).toEqual([id(2), id(1)]);
    expect(JSON.parse(window.localStorage.getItem(OPENED_KEY) ?? '[]')).toEqual([id(2), id(1)]);
  });

  it('never throws when storage is blocked or full: it reads empty and drops the write', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    expect(readOpened()).toEqual([]);
    expect(() => rememberOpened(id(3))).not.toThrow();
  });
});
