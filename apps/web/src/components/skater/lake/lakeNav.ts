import { useRouter, useRouterState } from '@tanstack/react-router';
import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef } from 'react';

import { blockingModalOpen, isPlainLeftClick } from '../chrome';

/**
 * The Explore pages' navigation (D242, §1.8): every view is a search param on the page's path, so
 * moving between them is an edit of the query string — and every other param (the root `?post=`,
 * `?postBody=`) rides along untouched.
 */

/** A search-param edit: a string sets the key, `null` removes it. */
export type SearchEdit = Readonly<Record<string, string | null>>;

/** `pathname` with `search` edited by `edit`, keeping every param the edit doesn't name. */
export function hrefWith(pathname: string, search: string, edit: SearchEdit): string {
  const params = new URLSearchParams(search);
  for (const [key, value] of Object.entries(edit)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export interface PageNav {
  pathname: string;
  search: string;
  push: (href: string) => void;
  replace: (href: string) => void;
  /** The current page's URL with `edit` applied. */
  with: (edit: SearchEdit) => string;
  /** Props for an in-app link: a real `href`, a plain click handed to the router. */
  link: (
    href: string,
    before?: () => void,
  ) => { href: string; onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => void };
}

export function usePageNav(): PageNav {
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const search = useRouterState({ select: (s) => s.location.searchStr });
  const push = useCallback((href: string) => router.history.push(href), [router]);
  const replace = useCallback((href: string) => router.history.replace(href), [router]);
  return {
    pathname,
    search,
    push,
    replace,
    with: (edit) => hrefWith(pathname, search, edit),
    link: (href, before) => ({
      href,
      onClick: (event) => {
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        before?.();
        push(href);
      },
    }),
  };
}

/**
 * **One Esc per screen** (Review 3, §1.8): while a view opened by a search param is up, Esc closes
 * it — by navigating with the param removed (`replace`), never `history.back()`, because a
 * deep-linked view has no history entry to pop. It stands aside when something else owns Esc: the
 * top bar's overlay (its capture-phase handler stops the event first), a modal over the page (the
 * report sheet), or a handler that already took it.
 */
export function useEscapeToClose(active: boolean, close: () => void): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (blockingModalOpen()) return;
      event.preventDefault();
      latest.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);
}
