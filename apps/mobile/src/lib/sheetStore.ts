/**
 * The open Post sheet, held outside the screen (A10-3). The sheet is one full-screen route that
 * every door navigates to, and two of its affordances leave it — *mark one here* hands off to the
 * map's `HazardCapture`, the body picker opens over it — so its state lives here, in a module
 * singleton the screen subscribes to (`useSyncExternalStore`, the `feedFiltersStore` pattern),
 * rather than in the screen's own state, which the navigator would unmount. It dies with the
 * process; *Save draft* is the durable copy (`draftStore`), and a sheet that was opened from a
 * draft is re-saved under the same id.
 *
 * Nothing here decides anything: the pure model (`sheetModel.ts`) does, and this holds it.
 */

import { useSyncExternalStore } from 'react';
import type { PostSheet } from './sheetModel';

let current: PostSheet | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The open sheet, or `null` when none is. */
export function getSheet(): PostSheet | null {
  return current;
}

/** Replace the open sheet (a door opening it), or close it. */
export function setSheet(next: PostSheet | null): void {
  current = next;
  emit();
}

/** Advance the open sheet through the pure model. A no-op when no sheet is open. */
export function updateSheet(update: (sheet: PostSheet) => PostSheet): void {
  if (current === null) return;
  const next = update(current);
  if (next === current) return;
  current = next;
  emit();
}

export function useSheet(): PostSheet | null {
  return useSyncExternalStore(subscribe, getSheet, getSheet);
}
