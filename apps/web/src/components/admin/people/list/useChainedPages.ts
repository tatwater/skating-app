import { useCallback, useEffect, useRef, useState } from 'react';

import { type Loadable, loaded, type ReadSpec, useConsoleReadSet } from '../../reads/consoleReads';
import {
  type ChainLink,
  extendChain,
  FIRST_CHAIN,
  mustSplit,
  type PageEnd,
  settleChain,
} from './pageChain';

/**
 * **A chain of cursor pages, read and stitched** — the one hook every People list that pages by
 * cursor reads (the People list, the record sheet's Standing, Deleted and Reversed), over the pure
 * rule in `pageChain`. Each page is a read through the console's one read layer; each page's answer
 * moves the chain on (a page to split is split, a page now done ends it); asking for more pins the
 * last page to where it ended and asks from there.
 *
 * While a page is pinned its rows stand from its last answer, which covered exactly `(cursor, end]`
 * — its end is the one pinned — so they don't blink out each time the list asks on. A page being
 * split stands the same way for its first half, `(cursor, split]`: the answer that asked for the
 * split holds the start of its range, so its rows stand — and nothing after them — until the half
 * lands. Held per list, by where a page starts.
 */
export interface ChainedPages<P extends PageEnd> {
  /** Each page of the chain: on its way, failed, or its answer (or a stand-in for it). */
  pages: Loadable<P>[];
  /** Ask for the next page; nothing while the last is on its way, done, or to be split. */
  loadMore: () => void;
  retry: () => void;
  /** A *Try again* is on its way. */
  retrying: boolean;
}

export function useChainedPages<P extends PageEnd>(
  /** This list, as it stands: the chain starts over when it changes (`''`: no list). */
  key: string,
  /** The read for one page of the chain, or `null` when no read is made. */
  readOf: ((link: ChainLink, index: number) => ReadSpec) | null,
): ChainedPages<P> {
  const [chain, setChain] = useState<{ key: string; links: readonly ChainLink[] }>({
    key,
    links: FIRST_CHAIN,
  });
  const links = chain.key === key ? chain.links : FIRST_CHAIN;

  const specs: Record<string, ReadSpec | null> = {};
  if (readOf !== null) {
    links.forEach((link, i) => {
      specs[`p${i}`] = readOf(link, i);
    });
  }
  const { reads, retry, pending: retrying } = useConsoleReadSet(specs);
  const pages = useStandIns(
    key,
    links,
    links.map((_, i) => reads[`p${i}`] as Loadable<P>),
  );

  const answers = pages.map((p) => loaded(p));
  const settleKey = JSON.stringify([
    links,
    answers.map((a) =>
      a === undefined
        ? null
        : [a.isDone, a.continueCursor, a.pageStatus ?? null, a.splitCursor ?? null],
    ),
  ]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the chain and the pages' ends, by value.
  useEffect(() => {
    if (readOf === null) return;
    const next = settleChain(links, answers);
    if (next !== null) setChain({ key, links: next });
  }, [settleKey, key]);

  const last = answers.at(-1);
  // Stable while the chain and its last page hold still, so a list's load-ahead check isn't rebuilt
  // every render — and rebuilt whenever there may be a next page to ask for.
  const loadMore = useCallback(() => {
    const next = extendChain(links, last);
    if (next !== links) setChain({ key, links: next });
  }, [links, last, key]);
  return { pages, loadMore, retry, retrying };
}

function useStandIns<P extends PageEnd>(
  key: string,
  links: readonly ChainLink[],
  pages: readonly Loadable<P>[],
): Loadable<P>[] {
  const held = useRef<{ key: string; byStart: Map<string, P> }>({ key, byStart: new Map() });
  if (held.current.key !== key) held.current = { key, byStart: new Map() };
  const byStart = held.current.byStart;
  const out = pages.map((page, i) => {
    const link = links[i] as ChainLink;
    const start = JSON.stringify(link.cursor);
    const answer = loaded(page);
    if (answer !== undefined) {
      byStart.set(start, answer);
      return page;
    }
    const before = byStart.get(start);
    if (page !== undefined || link.end === null || before === undefined) return page;
    if (!mustSplit(before)) return before.continueCursor === link.end ? before : page;
    return before.splitCursor === link.end ? firstHalfOf(before) : page;
  });
  // Only the pages the chain still holds are kept.
  const starts = new Set(links.map((l) => JSON.stringify(l.cursor)));
  for (const start of byStart.keys()) if (!starts.has(start)) byStart.delete(start);
  return out;
}

/** Each split answer's first half, made once, so the list drawn from it keeps its identity. */
const halves = new WeakMap<object, object>();

/**
 * A page the server said must be split, standing in for its first half: the same rows, ending where
 * the half ends — not to be split again, and not the list's end. Any of its rows past the split
 * point (Convex may split inside the rows it read) are the next page's too, drawn once.
 */
function firstHalfOf<P extends PageEnd>(page: P): P {
  const made = halves.get(page);
  if (made !== undefined) return made as P;
  const half: P = {
    ...page,
    isDone: false,
    continueCursor: page.splitCursor as string,
    pageStatus: undefined,
    splitCursor: undefined,
  };
  halves.set(page, half);
  return half;
}
