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
  useLayoutEffect(
    () => () => {
      current.current = null;
    },
    [],
  );
  return useCallback(() => current.current === itemId, [itemId]);
}
