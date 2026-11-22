import { useCallback, useSyncExternalStore } from 'react';

import type { DockMode } from './ticketModel';

/**
 * **What a moderator typed in a ticket's dock, kept by ticket** — so a draft outlives what can take
 * the dock away under them: a colleague resolving the ticket (the dock goes with its levers, and
 * comes back with the draft if it is reopened), another item opened and this one opened again, a
 * write refused. It is cleared only when its write lands. Kept for the page's life, in memory: a
 * ticket's words are PII (D37), so nothing is written to storage.
 */

export type TicketDraft = { text: string; mode: DockMode };

const EMPTY: TicketDraft = { text: '', mode: 'reply' };

const drafts = new Map<string, TicketDraft>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function set(key: string, next: TicketDraft): void {
  if (next.text === '' && next.mode === EMPTY.mode) drafts.delete(key);
  else drafts.set(key, next);
  for (const l of listeners) l();
}

/** A ticket's draft and its setter; `clear` keeps the mode and empties the words. */
export function useTicketDraft(key: string): {
  draft: TicketDraft;
  setText: (text: string) => void;
  setMode: (mode: DockMode) => void;
  clear: () => void;
} {
  const draft = useSyncExternalStore(
    subscribe,
    () => drafts.get(key) ?? EMPTY,
    () => EMPTY,
  );
  const setText = useCallback(
    (text: string) => set(key, { ...(drafts.get(key) ?? EMPTY), text }),
    [key],
  );
  const setMode = useCallback(
    (mode: DockMode) => set(key, { ...(drafts.get(key) ?? EMPTY), mode }),
    [key],
  );
  const clear = useCallback(() => set(key, { ...(drafts.get(key) ?? EMPTY), text: '' }), [key]);
  return { draft, setText, setMode, clear };
}

/** Test and story support: every draft forgotten. */
export function forgetTicketDrafts(): void {
  drafts.clear();
  for (const l of listeners) l();
}
