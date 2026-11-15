import { ConvexError } from 'convex/values';
import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';

import { toast } from '@/components/kit/toast';
import { errorText } from '../../adminUi';
import { notSavedTitle, notSavedWhat, OTHER_BODY } from '../consoleWords';

/**
 * **A pressed save completes against the body it was composed for; a result names its body.**
 *
 * - **Drafts die with their console.** The frame keys every body-scoped subtree by body (and tab),
 *   so a draft, a pick, an open dialog and its typed reason never travel to another body.
 * - **A save, once pressed, is the moderator's decision, and it is never lost.** It carries the body
 *   it was composed for and runs to its end against *that* body wherever the page goes next — a tab
 *   switch, another body, an uncached body loading, out of the Bodies area. Whole-list saves queue
 *   above the consoles (`ListWritersProvider`), per body, so a queued one goes out too.
 * - **A result is said honestly.** A receipt always names its body ("Links saved · Mascoma Lake"),
 *   so its Undo is unambiguous on any page. A refusal is said in place while the console that sent
 *   it is on screen; once that console has gone, it is a toast naming the body and what failed —
 *   never swallowed.
 * - **A missed reset still can't write.** A subtree holds the binding of the console it mounted
 *   under; a write that names another body than that one (a subtree that kept a draft across a body
 *   change) is refused, loudly.
 *
 * The binding is alive from its console's commit until that console goes away; it only decides
 * *where* a result is said, never *whether* a pressed save is sent.
 */
type Binding = { readonly body: string; name: string | undefined; alive: boolean };

const BindingContext = createContext<Binding | null>(null);

export function BodyBindingProvider({
  bodyId,
  name,
  children,
}: {
  bodyId: string;
  /** The body's name, for every result said off its console ("· Mascoma Lake"). */
  name?: string | undefined;
  children: ReactNode;
}) {
  // A fresh binding for this console and this body, alive at commit (a navigation still rendering
  // leaves the body on screen bound) and dead the moment the console goes. Held in state, not a
  // memo (a cache React may drop); a new body replaces it during render.
  const [binding, setBinding] = useState<Binding>(() => ({ body: bodyId, name, alive: false }));
  if (binding.body !== bodyId) setBinding({ body: bodyId, name, alive: false });
  // The name is the body's, and may land after the console does: kept current on the same
  // binding, never a new one (that would leave every mounted consumer holding a dead binding) —
  // and only while it is the same body (never the last body's binding taking the next one's name).
  else binding.name = name;
  useLayoutEffect(() => {
    binding.alive = true;
    return () => {
      binding.alive = false;
    };
  }, [binding]);
  return <BindingContext.Provider value={binding}>{children}</BindingContext.Provider>;
}

/** What a write needs to know about where it was composed. */
export type BodyHold = {
  /** Is the console it was composed on still the one on screen? Decides where a result is said. */
  here: () => boolean;
  /** The body that console is for; `null` outside a frame (a story, a test of one view). */
  body: string | null;
  /** The body's name, for a result said anywhere else. */
  subject: string | undefined;
};

/** The binding current when the subtree mounted — never a later one. */
export function useBodyHold(): BodyHold {
  const current = useContext(BindingContext);
  const [held] = useState(current);
  return useMemo(
    () => ({
      here: () => held === null || held.alive,
      body: held?.body ?? null,
      get subject() {
        return held?.name;
      },
    }),
    [held],
  );
}

/** A whole-list write refused because the list moved underneath (`{ code: 'list_changed', current }`). */
export function listChanged(err: unknown): readonly unknown[] | null {
  if (!(err instanceof ConvexError)) return null;
  const data = err.data as { code?: unknown; current?: unknown } | null;
  return data !== null && data.code === 'list_changed' && Array.isArray(data.current)
    ? (data.current as unknown[])
    : null;
}

/**
 * A save that didn't land, said off its console: a toast naming the body ("Not saved · Mascoma
 * Lake") with what failed. The one wording every write path and queue uses.
 */
export function sayNotSaved(hold: BodyHold, description: string): void {
  toast({
    title: notSavedTitle(hold.subject),
    description,
    tone: 'bad',
  });
}

/**
 * **The one write path.** `body` is the body the write names; `what` says what it was ("The links",
 * "The ruling"), for a refusal said off the console. Sends unless the write names another body than
 * the console's own; a refusal is thrown (in the server's words) while that console is on screen —
 * for the caller to say in place — and otherwise put in a toast naming the body; a list that moved
 * underneath is thrown as it came, for the queue to re-apply; the receipt follows a landed write
 * wherever the page is, naming its body, and its failure is never a refusal.
 *
 * Resolves `true` when the write landed, `false` when it was refused off its console (already said
 * in the toast) — so a caller never takes a refused write for a landed one.
 */
export async function sendFor(
  hold: BodyHold,
  {
    body,
    write,
    receipt,
    what,
  }: {
    body: string;
    write: () => Promise<unknown>;
    receipt: (subject: string | undefined) => Promise<unknown>;
    what: string;
  },
): Promise<boolean> {
  if (hold.body !== null && hold.body !== body) throw new Error(OTHER_BODY);
  try {
    await write();
  } catch (err) {
    if (listChanged(err) !== null) throw err;
    const said = errorText(err);
    if (hold.here()) throw new Error(said);
    sayNotSaved(hold, notSavedWhat(what, said));
    return false;
  }
  try {
    await receipt(hold.subject);
  } catch {
    // The write landed; only its receipt didn't (History keeps the row).
  }
  return true;
}
