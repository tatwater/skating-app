import { useMutation } from 'convex/react';
import type { FunctionReference } from 'convex/server';
import { useCallback, useContext } from 'react';

import { toast } from '@/components/kit/toast';

import { errorText } from './adminUi';
import { askingPlace, PagePlace, type Place } from './place';

/** The net's words: a refusal said in the server's own words, its subject the page's to say. */
export const NOT_SAVED = 'Not saved';

/**
 * **The Legacy pages' net** (D268's rule, before each page retires): a write whose refusal is never
 * lost — said in a toast in the server's words unless its place is drawn when the answer comes, and
 * always rethrown, so a page that says it in place keeps doing so.
 *
 * Its place (`Place`, `./place`) is the reason dialog that started it (`askFrom`, around its
 * confirm), else the `place` the page hands the hook — the element that shows its refusal, by ref.
 * With neither, the toast is the only voice. A mounted hook is never a place: a component that
 * stops drawing its error slot while it stays mounted (a permission flipping, a read failing) has no
 * place, and the toast says it.
 *
 * The console's own writes don't use this: they name their subject (`sendFor`, the pick store,
 * the People write paths). A Legacy toast names only what the server says.
 */
export function useSaidMutation<M extends FunctionReference<'mutation'>>(
  ref: M,
  place?: Place | null,
): (args: M['_args']) => Promise<M['_returnType']> {
  const mutate = useMutation(ref);
  // No place of its own: the page's, where the page says every refusal in one place.
  const page = useContext(PagePlace);
  const own = place === undefined ? page : place;
  // As stable as the mutation it wraps: a page that lists it in a hook's dependencies runs as before.
  return useCallback(
    async (args: M['_args']) => {
      // The place asking, captured as the write starts: a dialog's, else the page's.
      const where = askingPlace() ?? own ?? null;
      try {
        return await mutate(args);
      } catch (err) {
        if (where === null || !where.here()) {
          toast({ title: NOT_SAVED, description: errorText(err), tone: 'bad' });
        }
        throw err;
      }
    },
    [mutate, own],
  );
}
