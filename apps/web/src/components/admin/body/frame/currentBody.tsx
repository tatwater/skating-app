import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';

import { errorText } from '../../adminUi';

/**
 * **A write lands on the body it was composed for, while that body's console is on screen — or
 * nowhere.** The frame keys every body-scoped subtree by body, so a draft dies with its body; and,
 * in case a reset is ever missed, every write also asks its **binding**.
 *
 * **One lifetime, explicit.** A binding is one console's hold on one body. `BodyBindingProvider`
 * creates it for its body and it is alive from that render's commit until the console goes away
 * for any reason: the body changes (a new binding is made, the old one dies at that commit), the
 * page shows a loading or failed state instead (the provider unmounts), the tab host unmounts, the
 * route is left, the shell remounts. Unmount invalidates — nothing else revives it: a new console
 * for the same body is a new binding, so coming back to a body never resurrects its old queue.
 *
 * A consumer holds the binding that was current when it mounted (`useBodyBound`), never a later
 * one: a subtree that missed its reset still holds its own body's binding, now dead, and sends
 * nothing. A write checks it before it sends, and again before it surfaces anything (a refusal, a
 * receipt and its Undo): a write already on its way lands (it was the right body when sent), but
 * says nothing over another body's console — History keeps the row.
 */
type Binding = { readonly body: string; alive: boolean };

const BindingContext = createContext<Binding | null>(null);

export function BodyBindingProvider({ bodyId, children }: { bodyId: string; children: ReactNode }) {
  // A fresh binding for this mount and this body; it comes alive at commit, so a navigation that
  // is still rendering (in a transition) leaves the body on screen bound until it commits.
  const binding = useMemo<Binding>(() => ({ body: bodyId, alive: false }), [bodyId]);
  useLayoutEffect(() => {
    binding.alive = true;
    return () => {
      binding.alive = false;
    };
  }, [binding]);
  return <BindingContext.Provider value={binding}>{children}</BindingContext.Provider>;
}

/**
 * Is the console this subtree mounted under still the one on screen? The binding is the one current
 * at mount. Outside a frame (a story, a test of one view) there is no other console, so it is.
 */
export function useBodyBound(): () => boolean {
  const current = useContext(BindingContext);
  const [held] = useState(current);
  return useMemo(() => () => held === null || held.alive, [held]);
}

/**
 * A write, bound: nothing is sent unless the binding is alive; a refusal is thrown (in the
 * server's words) only while it still is; the receipt is put up only then too, and its failure is
 * never a refusal (the write landed; History keeps the row).
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
    // The write landed; only its receipt didn't.
  }
}
