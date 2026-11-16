import { useMutation } from 'convex/react';
import type { FunctionReference } from 'convex/server';
import { useCallback, useLayoutEffect, useRef } from 'react';

import { toast } from '@/components/kit/toast';

import { errorText } from './adminUi';

/** The net's words: a refusal said in the server's own words, its subject the page's to say. */
export const NOT_SAVED = 'Not saved';

/**
 * **The Legacy pages' net** (D268's rule, before each page retires): a write whose refusal is
 * said in a toast, in the server's words, so it is never lost — and rethrown, so a page that also
 * says it keeps doing so. Two modes, by what the page does with a refusal:
 *
 * - `always` — the page says nothing of its own (no `catch`): the net is the only voice.
 * - `inPlace` — the page says it in its place (its `catch` sets a note): the net speaks only once
 *   the component that asked has gone, so nothing is said twice.
 *
 * The console's own writes don't use this: they name their subject (`sendFor`, the pick store,
 * the People write paths). A Legacy toast names only what the server says.
 */
export function useSaidMutation<M extends FunctionReference<'mutation'>>(
  ref: M,
  mode: 'always' | 'inPlace' = 'always',
): (args: M['_args']) => Promise<M['_returnType']> {
  const mutate = useMutation(ref);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // As stable as the mutation it wraps: a page that lists it in a hook's dependencies runs as before.
  return useCallback(
    async (args: M['_args']) => {
      try {
        return await mutate(args);
      } catch (err) {
        if (mode === 'always' || !mounted.current) {
          toast({ title: NOT_SAVED, description: errorText(err), tone: 'bad' });
        }
        throw err;
      }
    },
    [mutate, mode],
  );
}
