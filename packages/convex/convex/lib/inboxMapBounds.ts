/**
 * The bounds an Inbox item's embedded map is sent within (`inbox.itemMap`) — a leaf module, imported
 * by `inbox.ts` (which re-exports them) and `lib/inboxViews.ts` alike. They lived in `inbox.ts` and
 * were read by `lib/inboxViews.ts`'s module-level `MAP_BOUNDS`; the two modules import each other, so
 * when `inbox.ts` loaded first `MAP_BOUNDS` was built before these existed and read `undefined` —
 * every outline then sent simplified, and every track empty (B01-5c). A leaf can't be caught that way.
 */

/** The most an embed's own outline (or a skate's track) weighs as stored before it is sent thinned. */
export const MAP_OUTLINE_BYTES = 256 * 1024;

/** Points a thinned outline, or a thinned track, keeps. */
export const MAP_RING_POINTS = 512;
