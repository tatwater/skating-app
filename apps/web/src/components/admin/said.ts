import { useMutation } from 'convex/react';
import type { FunctionReference } from 'convex/server';
import { ConvexError } from 'convex/values';
import { useCallback } from 'react';

import { type ToastManager, toast } from '@/components/kit/toast';

/**
 * **A server's refusal is a toast — always** (D268, the founder's call of 2026-11-16). A write the
 * server refuses, that throws, or whose send fails is said once, in a toast that names its subject
 * and what was not changed, and that stays until it is dismissed — wherever the operator is when the
 * answer comes: the same place, another tab, another body or person, another section, the skater
 * app, the console's loading splash. Never also printed in place: nothing predicts whether the place
 * that asked is still drawn, because three such predictions were three defects.
 *
 * This is the one helper every admin write goes through, and the only place that reads a refusal's
 * words. Its caller learns *that* a write was refused (`landed: false`) — enough to keep a dialog open
 * with what was typed, or to go back to the server's value — and never the words, so no component
 * has anything to print. `packages/guards/src/adminWriters.test.ts` holds the console to it.
 */

/**
 * A refusal's words: the operator-facing line the server wrote (a `ConvexError`'s), or — a server
 * error, or a send that failed — the same plain line for both. Read here and nowhere else.
 */
function errorText(err: unknown): string {
  if (err instanceof ConvexError) {
    const data = err.data as { message?: string } | string;
    return typeof data === 'string' ? data : (data?.message ?? 'That write was rejected.');
  }
  return 'Something went wrong — check your connection and try again.';
}

/** What a write tells its caller: whether it landed. A refusal's words went to its toast. */
export type Said<T> = { landed: true; value: T } | { landed: false; why?: never };

/** A refusal's toast: its subject and what was not changed, then why. It stays until dismissed. */
export type RefusalWords = { title: string; description?: string };

/**
 * Says a refusal: a toast in the failure's tone that never times out (its *Dismiss* closes it), with
 * no Undo — a refusal changed nothing, so there is nothing to undo.
 */
export function sayRefusal(
  { title, description }: RefusalWords,
  /** The toast queue: the app's one, unless a story or a test draws its own. */
  manager?: ToastManager,
): void {
  const options = {
    title,
    ...(description !== undefined && description !== '' && { description }),
    tone: 'bad' as const,
    timeout: 0,
  };
  if (manager === undefined) toast(options);
  else toast(options, manager);
}

/**
 * **The one write helper.** Runs `write`; a throw — the server's refusal, a server error, a failed
 * send — is said once in the toast `words` builds from the server's own words, and answered
 * `{ landed: false }`. `passOn` names a throw that is not an answer for the operator but for a queue
 * (a whole list that moved underneath, re-applied by its queue): it is rethrown untouched, unsaid.
 */
export async function said<T>(
  write: () => Promise<T>,
  words: (why: string) => RefusalWords,
  { passOn, manager }: { passOn?: (err: unknown) => boolean; manager?: ToastManager } = {},
): Promise<Said<T>> {
  try {
    return { landed: true, value: await write() };
  } catch (err) {
    if (passOn?.(err) === true) throw err;
    sayRefusal(words(errorText(err)), manager);
    return { landed: false };
  }
}

/** The Legacy pages' words: a refusal in the server's own words, its subject the page's to say. */
export const NOT_SAVED = 'Not saved';

/**
 * Thrown by a Legacy write once its refusal is in its toast. It carries no words — a page that
 * catches it has nothing to print, only the fact: a dialog stays open, a form keeps what was typed.
 */
export class Refused extends Error {
  constructor() {
    super('');
    this.name = 'Refused';
  }
}

/**
 * **The Legacy pages' net**, until each page retires: a mutation whose refusal is said in a toast
 * ("Not saved", the server's words) wherever the operator is, and then rethrown as {@link Refused}
 * — so a page's `try` still skips what follows a write that didn't land, and a reason dialog still
 * stays open over its reason. The console's own writes name their subject (`sendFor`, the People
 * write paths); a Legacy toast names only what the server says.
 */
export function useSaidMutation<M extends FunctionReference<'mutation'>>(
  ref: M,
): (args: M['_args']) => Promise<M['_returnType']> {
  const mutate = useMutation(ref);
  // As stable as the mutation it wraps: a page that lists it in a hook's dependencies runs as before.
  return useCallback(
    async (args: M['_args']) => {
      const answer = await said(
        () => mutate(args),
        (why) => ({ title: NOT_SAVED, description: why }),
      );
      if (!answer.landed) throw new Refused();
      return answer.value;
    },
    [mutate],
  );
}
