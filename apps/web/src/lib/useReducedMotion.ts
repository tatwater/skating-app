import { useSyncExternalStore } from 'react';

const REDUCE = '(prefers-reduced-motion: reduce)';

function subscribeReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCE);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/**
 * Whether the reader asked for less motion — live, so a settings change applies at once. For what
 * script animates (a shimmer's sweep, a time bar's glide); CSS transitions already follow the
 * motion tokens, which collapse to zero on their own.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCE).matches,
    // Server render: assume the quieter page.
    /* v8 ignore next */
    () => true,
  );
}
