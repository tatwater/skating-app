/**
 * Guarded browser-storage JSON helpers for the B03 client stores (§2 of the phase doc).
 *
 * Every read and write is wrapped because storage is allowed to be absent or broken — private
 * windows, cleared site data, embedders, quota — and a store must come up with its defaults
 * rather than crash. A failed write is silently a no-op: all three persisting stores treat
 * storage as a per-viewer convenience, never as state the app depends on (that lives in Convex
 * or, for the report draft's photos, IndexedDB with its own degrade path).
 */

export function readJson<T>(storage: Storage | undefined, key: string): T | null {
  try {
    const raw = storage?.getItem(key);
    if (raw == null) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeJson(storage: Storage | undefined, key: string, value: unknown): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Quota, private window, disabled storage: the in-memory state is still right.
  }
}

export function removeKey(storage: Storage | undefined, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Same contract as writeJson.
  }
}

/** `localStorage` when the environment has one; `undefined` on the server or when blocked. */
export function localStore(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** `sessionStorage` under the same contract. */
export function sessionStore(): Storage | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}
