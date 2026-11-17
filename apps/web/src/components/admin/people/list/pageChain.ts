/**
 * **The People list's chain of pages, stitched** — pure, so the rule is tested without Convex.
 *
 * `people.listPage` is read as a chain of cursor pages (it isn't Convex's paginated contract, so
 * Convex's own stitching never applies). Each page is a subscription, and a page read unbounded
 * ends wherever its rows end *now*: a person joining or leaving it moves its end, and the pages
 * after it would start in the wrong place. So, as Convex's reactive pagination does:
 *
 * - **A page read past is pinned.** When the next page is asked for, the page before it is read
 *   again as exactly `(cursor, end]`, `end` being where it ended — the server then keeps that end
 *   as its `continueCursor`, whatever joins or leaves it. Only the last page is unbounded.
 * - **A pinned page that grew past the server's cap is split** (`pageStatus: 'SplitRequired'`) at
 *   the `splitCursor` the server gives, into `(cursor, split]` and `(split, end]`. A search gives no
 *   split point: that page is read again unbounded, and the chain goes on from its new end — the
 *   pages after it are asked again (rows can't be lost or repeated, only re-read).
 * - **A page read past that is now done** ends the chain there; a page whose end no longer meets
 *   the next page's start (a server that didn't hold the end) re-anchors the pages after it.
 */

/** One page of the chain: where it starts, and — once it is read past — where it ends. */
export type ChainLink = { cursor: string | null; end: string | null };

/** What the chain reads of a page's answer. */
export type PageEnd = {
  isDone: boolean;
  continueCursor: string;
  splitCursor?: string | null | undefined;
  pageStatus?: string | null | undefined;
};

/** A list's chain before anything is read: one page from the start, unbounded. */
export const FIRST_CHAIN: readonly ChainLink[] = Object.freeze([{ cursor: null, end: null }]);

/** The server says this page holds more than one page may: it must be split before it is whole. */
export const mustSplit = (page: PageEnd): boolean => page.pageStatus === 'SplitRequired';

/**
 * The chain once each page's answer is read, or `null` when nothing changes (every page meets the
 * next, or a page before a change is still on its way).
 */
export function settleChain(
  chain: readonly ChainLink[],
  answers: readonly (PageEnd | undefined)[],
): ChainLink[] | null {
  for (const [i, link] of chain.entries()) {
    const answer = answers[i];
    if (answer === undefined) return null;
    if (mustSplit(answer)) {
      const split = answer.splitCursor;
      if (link.end !== null && typeof split === 'string' && split !== '') {
        return [
          ...chain.slice(0, i),
          { cursor: link.cursor, end: split },
          { cursor: split, end: link.end },
          ...chain.slice(i + 1),
        ];
      }
      // No split point (a search): read the range again unbounded, and go on from where it ends.
      return [...chain.slice(0, i), { cursor: link.cursor, end: null }];
    }
    const next = chain[i + 1];
    if (next === undefined) return null;
    if (answer.isDone) return chain.slice(0, i + 1);
    if (answer.continueCursor !== next.cursor) {
      return [...chain.slice(0, i + 1), { cursor: answer.continueCursor, end: null }];
    }
  }
  return null;
}

/**
 * Ask for the page after the last: the last page is pinned to where it ended (a page already
 * pinned keeps its end), and the next starts there. The chain as it was while the last page is on
 * its way, done, or to be split.
 */
export function extendChain(
  chain: readonly ChainLink[],
  last: PageEnd | undefined,
): readonly ChainLink[] {
  const link = chain.at(-1);
  if (link === undefined || last === undefined || last.isDone || mustSplit(last)) return chain;
  return [
    ...chain.slice(0, -1),
    { cursor: link.cursor, end: link.end ?? last.continueCursor },
    { cursor: last.continueCursor, end: null },
  ];
}
