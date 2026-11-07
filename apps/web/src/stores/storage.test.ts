import { afterEach, describe, expect, it, vi } from 'vitest';
import { localStore, readJson, removeKey, sessionStore, writeJson } from './storage';

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('readJson', () => {
  it('round-trips a value', () => {
    writeJson(localStorage, 'k', { a: 1 });
    expect(readJson(localStorage, 'k')).toEqual({ a: 1 });
  });

  it('is null for a missing key, an undefined storage, and unparseable JSON', () => {
    expect(readJson(localStorage, 'missing')).toBeNull();
    expect(readJson(undefined, 'k')).toBeNull();
    localStorage.setItem('bad', '{not json');
    expect(readJson(localStorage, 'bad')).toBeNull();
  });

  it('is null when the storage itself throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readJson(localStorage, 'k')).toBeNull();
  });
});

describe('writeJson / removeKey', () => {
  it('swallow a throwing storage — in-memory state stays authoritative', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => writeJson(localStorage, 'k', 1)).not.toThrow();
    expect(() => removeKey(localStorage, 'k')).not.toThrow();
  });

  it('are no-ops on an undefined storage', () => {
    expect(() => writeJson(undefined, 'k', 1)).not.toThrow();
    expect(() => removeKey(undefined, 'k')).not.toThrow();
  });
});

describe('localStore / sessionStore', () => {
  it('return the real storages in a browser-shaped environment', () => {
    expect(localStore()).toBe(localStorage);
    expect(sessionStore()).toBe(sessionStorage);
  });
});
