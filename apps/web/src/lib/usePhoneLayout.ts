import { mediaQueryStore, useMediaQuery } from './mediaQuery';

/**
 * The phone's breakpoint: below Tailwind's `md` (48 rem) an app swaps its chrome and lays its pages
 * out one column at a time. CSS owns what can be decided by CSS (`max-md:` classes); these hooks
 * are for the few choices CSS can't make — which overlay mounts (two copies of a controlled
 * popover would both open), and whether a second map instance is created at all.
 *
 * The same edge as `max-md:` (`width < 48rem`), written as `max-width` for the broadest support.
 */
export const PHONE_QUERY = '(max-width: 47.99rem)';

/**
 * Between `md` and `xl` (48–80 rem): wide enough for Latest's filters and feed, too narrow for its
 * right column — the same edges as `md:` and `max-xl:`.
 */
export const MID_QUERY = '(min-width: 48rem) and (max-width: 79.99rem)';

const phone = mediaQueryStore(PHONE_QUERY);
const mid = mediaQueryStore(MID_QUERY);

/** True below `md`: the phone's layout. The server and the hydration pass say `false`. */
export function useIsPhone(): boolean {
  return useMediaQuery(phone);
}

/** True between `md` and `xl`, where Latest's right column steps out. */
export function useIsMidWidth(): boolean {
  return useMediaQuery(mid);
}
