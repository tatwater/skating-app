import { createContext, type ReactNode, useCallback, useContext, useRef } from 'react';

import { errorText } from '../../adminUi';

/**
 * **A write lands on the body it was composed for, or nowhere.** The frame keys every body-scoped
 * subtree by body, so a draft dies with its body — and, in case a reset is ever missed, every write
 * also checks this: the body the page shows now. A tab's write wrapper asks `useBodyBound(bodyId)`
 * with the body its draft was started on (its own prop: the subtree is that body's for life) and
 * refuses to send when the page has moved on; a write already on its way lands (it was the right
 * body when sent) but its receipt is dropped, so another body's toast never shows over this one —
 * History keeps the row and its undo.
 */
const CurrentBody = createContext<{ readonly current: string } | null>(null);

/** The frame's: the body the page shows, read by every write as it sends and as it lands. */
export function CurrentBodyProvider({ bodyId, children }: { bodyId: string; children: ReactNode }) {
  const ref = useRef(bodyId);
  ref.current = bodyId;
  return <CurrentBody.Provider value={ref}>{children}</CurrentBody.Provider>;
}

/**
 * Is the page still on `bodyId`? Outside a frame (a story, a test of one view) there is no other
 * body to move to, so it always is.
 */
export function useBodyBound(bodyId: string): () => boolean {
  const ref = useContext(CurrentBody);
  return useCallback(() => ref === null || ref.current === bodyId, [ref, bodyId]);
}

/**
 * A tab's write, bound to its body: nothing is sent once the page has moved on; a refusal is thrown
 * in the server's words only while the page is still there; the receipt is put up only then too.
 */
export async function sendFor(
  here: () => boolean,
  write: () => Promise<unknown>,
  receipt: () => Promise<unknown>,
): Promise<void> {
  if (!here()) return;
  try {
    await write();
  } catch (err) {
    if (here()) throw new Error(errorText(err));
    return;
  }
  if (here()) await receipt();
}
