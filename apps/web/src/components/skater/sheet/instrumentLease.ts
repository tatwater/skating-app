import { useSyncExternalStore } from 'react';

/**
 * Never more than two GL contexts (B03 §1.8): the region map, and one short-lived instrument. A
 * hazard sheet stacked inside the report (5.10.1) brings its own instrument — the board draws the
 * lake beside the hazard's questions — and covers the report's, so while it is open the report's
 * instrument steps down and gives its context back. This is the one bit of state that says so: a
 * count of the stacked sheets holding the slot (a count, so a quick close-and-reopen can't strand
 * it).
 */
let holders = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Take the instrument slot; the returned call gives it back (once, however often it's called). */
export function holdInstrument(): () => void {
  holders += 1;
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    emit();
  };
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

const held = () => holders > 0;

/** True while a stacked sheet holds the slot: the report's instrument draws no canvas. */
export function useInstrumentHeld(): boolean {
  return useSyncExternalStore(subscribe, held, held);
}
