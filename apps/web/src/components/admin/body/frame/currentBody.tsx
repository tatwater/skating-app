import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { errorText } from '../../adminUi';

/**
 * **A write lands on the body it was composed for, or nowhere.** The frame keys every body-scoped
 * subtree by body, so a draft dies with its body — and, in case a reset is ever missed, every write
 * also checks this: the body the page shows now. A tab's write wrapper asks `useBodyBound(bodyId)`,
 * which holds the body its subtree was mounted for (the subtree is that body's for life — a prop
 * that later names another body is exactly the missed reset this guards) and refuses to send when
 * the page has moved on; a write already on its way lands (it was the right body when sent) but its
 * receipt is dropped, so another body's toast never shows over this one — History keeps the row and
 * its undo.
 */
const CurrentBody = createContext<{ readonly current: string } | null>(null);

/**
 * The frame's: the body the page *shows*, read by every write as it sends and as it lands. Moved
 * at commit, never during a render: a navigation renders in a transition, and the body on screen
 * stays the last one (and takes presses) until that render commits.
 */
export function CurrentBodyProvider({ bodyId, children }: { bodyId: string; children: ReactNode }) {
  const ref = useRef(bodyId);
  useLayoutEffect(() => {
    ref.current = bodyId;
  }, [bodyId]);
  return <CurrentBody.Provider value={ref}>{children}</CurrentBody.Provider>;
}

/**
 * Is the page still on the body this subtree was mounted for (`bodyId` at mount)? Outside a frame
 * (a story, a test of one view) there is no other body to move to, so it always is.
 */
export function useBodyBound(bodyId: string): () => boolean {
  const ref = useContext(CurrentBody);
  // The mount's body, not the latest prop: a subtree that missed its reset and now reads another
  // body's id still holds the first body's draft, and must send nothing for the second.
  const [bound] = useState(bodyId);
  return useCallback(() => ref === null || ref.current === bound, [ref, bound]);
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
  if (!here()) return;
  try {
    await receipt();
  } catch {
    // The write landed; only its receipt didn't (History keeps the row) — never a refusal, as
    // `useTabAction` and the boost say it.
  }
}
