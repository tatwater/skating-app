import { useCallback, useSyncExternalStore } from 'react';

import type { DockMode } from './ticketModel';

/**
 * **What a moderator typed in a ticket's dock, and whether its send is out — kept by ticket** — so
 * both outlive what can take the dock away under them: a colleague resolving the ticket, another item
 * opened and this one opened again (the handler remounts; this store doesn't), a write refused.
 *
 * - **A send out is the ticket's, not the handler's.** While a reply or note is out, the dock is busy
 *   for that ticket wherever it is drawn, so leaving and coming back can't send the same words twice.
 *   When it lands, only the words that were sent are cleared — anything typed since stays.
 * - **Each press has its own key** (`clientKey`), so the server writes a press once however often it
 *   arrives; a press retried with the same words and mode after a refusal reuses its key.
 *
 * Kept for the page's life, in memory: a ticket's words are PII (D37), so nothing is written to storage.
 */

export type TicketDraft = { text: string; mode: DockMode; sending: boolean };

type Entry = {
  text: string;
  mode: DockMode;
  /** The words out, trimmed, while a send is out. */
  out: string | null;
  /** The last press's words, mode and key, kept for a retry of the same press. */
  attempt: { text: string; mode: DockMode; key: string } | null;
};

const EMPTY: TicketDraft = { text: '', mode: 'reply', sending: false };
const BLANK: Entry = { text: '', mode: 'reply', out: null, attempt: null };

const entries = new Map<string, Entry>();
/** One stable snapshot per entry, so `useSyncExternalStore` sees a change only on a write. */
const views = new Map<string, TicketDraft>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function set(key: string, next: Entry): void {
  if (next.text === '' && next.mode === BLANK.mode && next.out === null && next.attempt === null) {
    entries.delete(key);
    views.delete(key);
  } else {
    entries.set(key, next);
    views.set(key, { text: next.text, mode: next.mode, sending: next.out !== null });
  }
  for (const l of listeners) l();
}

/** A fresh key for a press: 8–64 of `[A-Za-z0-9_-]`, as the server takes it. */
function newKey(): string {
  return crypto.randomUUID();
}

/** A ticket's draft, its setters, and the send's bracket (`beginSend` → the write → `endSend`). */
export function useTicketDraft(key: string): {
  draft: TicketDraft;
  setText: (text: string) => void;
  setMode: (mode: DockMode) => void;
  /** The press's key, or `null` while a send for this ticket is already out (nothing is sent). */
  beginSend: (mode: DockMode, text: string) => string | null;
  /** The send answered: landed, its words cleared (only if unchanged); else kept, with its key. */
  endSend: (landed: boolean) => void;
} {
  const draft = useSyncExternalStore(
    subscribe,
    () => views.get(key) ?? EMPTY,
    () => EMPTY,
  );
  const setText = useCallback(
    (text: string) => set(key, { ...(entries.get(key) ?? BLANK), text }),
    [key],
  );
  const setMode = useCallback(
    (mode: DockMode) => set(key, { ...(entries.get(key) ?? BLANK), mode }),
    [key],
  );
  const beginSend = useCallback(
    (mode: DockMode, text: string): string | null => {
      const entry = entries.get(key) ?? BLANK;
      if (entry.out !== null) return null;
      const again = entry.attempt;
      const clientKey =
        again !== null && again.text === text && again.mode === mode ? again.key : newKey();
      set(key, { ...entry, out: text, attempt: { text, mode, key: clientKey } });
      return clientKey;
    },
    [key],
  );
  const endSend = useCallback(
    (landed: boolean) => {
      const entry = entries.get(key) ?? BLANK;
      const sent = entry.out;
      if (!landed) {
        set(key, { ...entry, out: null });
        return;
      }
      set(key, {
        ...entry,
        out: null,
        attempt: null,
        // Only the words that went: anything typed since stays.
        text: sent !== null && entry.text.trim() === sent ? '' : entry.text,
      });
    },
    [key],
  );
  return { draft, setText, setMode, beginSend, endSend };
}

/** Test and story support: every draft forgotten. */
export function forgetTicketDrafts(): void {
  entries.clear();
  views.clear();
  for (const l of listeners) l();
}
