import { ConvexError } from 'convex/values';
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';

import { type RefusalWords, said, sayRefusal } from '../../said';
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
 * - **A result is said honestly, and names its body.** A receipt always names its body ("Links
 *   saved · Mascoma Lake"), so its Undo is unambiguous on any page; a refusal is always a toast
 *   naming the body and what was not saved (D268), wherever the moderator is when it comes.
 * - **A missed reset still can't write.** A subtree holds the binding of the console it mounted
 *   under; a write that names another body than that one (a subtree that kept a draft across a body
 *   change) is refused, loudly.
 */
type Binding = { readonly body: string; name: string | undefined };

const BindingContext = createContext<Binding | null>(null);

export function BodyBindingProvider({
  bodyId,
  name,
  children,
}: {
  bodyId: string;
  /** The body's name, for every result ("· Mascoma Lake"). */
  name?: string | undefined;
  children: ReactNode;
}) {
  // A fresh binding for this console and this body. Held in state, not a memo (a cache React may
  // drop); a new body replaces it during render.
  const [binding, setBinding] = useState<Binding>(() => ({ body: bodyId, name }));
  if (binding.body !== bodyId) setBinding({ body: bodyId, name });
  // The name is the body's, and may land after the console does: kept current on the same
  // binding, never a new one (that would leave every mounted consumer holding a stale binding) —
  // and only while it is the same body (never the last body's binding taking the next one's name).
  // A name once landed is kept while the same body's console reloads or fails (no name then): a
  // result said in that moment still names its body.
  else if (name !== undefined) binding.name = name;
  return <BindingContext.Provider value={binding}>{children}</BindingContext.Provider>;
}

/** What a write needs to know about where it was composed. */
export type BodyHold = {
  /** The body that console is for; `null` outside a frame (a story, a test of one view). */
  body: string | null;
  /** The body's name, for every result. */
  subject: string | undefined;
};

/** The binding current when the subtree mounted — never a later one. */
export function useBodyHold(): BodyHold {
  const current = useContext(BindingContext);
  const [held] = useState(current);
  return useMemo(
    () => ({
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
 * A save that didn't land: a toast naming the body ("Not saved · Mascoma Lake") with what failed,
 * there until dismissed. The one wording every write path and queue uses.
 */
export function sayNotSaved(hold: BodyHold, description: string): void {
  sayRefusal({ title: notSavedTitle(hold.subject), description });
}

/** A refusal's words for what was not saved ("Not saved · Mascoma Lake" — "The ruling: …"). */
export function notSavedWords(hold: BodyHold, what: string): (why: string) => RefusalWords {
  return (why) => ({ title: notSavedTitle(hold.subject), description: notSavedWhat(what, why) });
}

/**
 * **The one write path.** `body` is the body the write names; `what` says what it was ("The links",
 * "The ruling"), for its refusal. Sends unless the write names another body than the console's own;
 * a refusal (the server's, a server error, a failed send) is a toast naming the body and what was
 * not saved; a list that moved underneath is thrown as it came, for the queue to re-apply; the
 * receipt follows a landed write wherever the page is, naming its body, and its failure is never a
 * refusal.
 *
 * Resolves `true` when the write landed and `false` when it was refused — said already, so the
 * caller only keeps its dialog open or goes back to the record; it never has words to say.
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
  if (hold.body !== null && hold.body !== body) {
    sayNotSaved(hold, OTHER_BODY);
    return false;
  }
  const answer = await said(write, notSavedWords(hold, what), (err) => listChanged(err) !== null);
  if (!answer.landed) return false;
  try {
    await receipt(hold.subject);
  } catch {
    // The write landed; only its receipt didn't (History keeps the row).
  }
  return true;
}
