import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * **Whether the item a write was sent for is still the one open here** — the receipt's binding (the
 * shell's rule: a receipt never shows over another item). True while this handler shows `itemId`;
 * false once it shows another, and false once it has gone — switching items unmounts the handler, so
 * its last item must not still count as here when a write's answer comes back.
 */
export function useStillHere(itemId: string): () => boolean {
  const current = useRef<string | null>(itemId);
  current.current = itemId;
  // Set in the effect's setup as well as its render: StrictMode (or an `<Activity>` hidden and shown
  // again) tears an effect down and sets it up again, and a cleanup that only clears would leave a
  // mounted handler reading "gone".
  useLayoutEffect(() => {
    current.current = itemId;
    return () => {
      current.current = null;
    };
  }, [itemId]);
  return useCallback(() => current.current === itemId, [itemId]);
}
