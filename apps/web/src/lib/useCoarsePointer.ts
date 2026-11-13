import { mediaQueryStore, useMediaQuery } from './mediaQuery';

/**
 * Is the primary pointer a finger — a phone or tablet, not a desk? The *When* row keys off this
 * (founder, 2026-11-07): "9:25 AM · now" is only an honest offer on a device that was at the lake,
 * and nobody brings their laptop to the lake. A viewport width would call a narrow window a phone;
 * the pointer does not.
 */
const coarse = mediaQueryStore('(pointer: coarse)');

export function useCoarsePointer(): boolean {
  return useMediaQuery(coarse);
}
