/**
 * The water-body drawer's three sub-tabs (N6h Workstream H, open question 4).
 *
 * ## Why the vocabulary lives in core
 *
 * Both clients draw the same three tabs over the same three groups of panels, and the founder's
 * taxonomy is the *only* thing that decides which panel goes where:
 *
 * - **Overview** — machine-compiled facts about the body: access ruling, posted rules, wind
 *   climatology, reference links, provenance credits. The place multi-season climatology (D153,
 *   deferred) and N6e's phenology brackets will land.
 * - **Reporting** — user-supplied, this season: the season filter, bounties, ice history, hazards,
 *   reports.
 * - **Planning** — the trip decision: the weather timeline, the forecast, put-ins, directions.
 *
 * If the ids or labels were declared per client, the two drawers could drift on a rename and the
 * shared tab store below would carry a value one of them no longer recognises. So the ids are one
 * list, the labels are one map, and each client renders them rather than restating them.
 *
 * ⚠ **The NWS alert belongs to none of these** and is deliberately not a tab concern. It sits above
 * the strip on both clients, always visible, because a tabbed alert is an alert you can be one tap
 * away from not seeing — and that is what preserves the authority ordering (alert > observation >
 * prediction) under the new IA.
 *
 * ## The store
 *
 * Tab selection **persists across bodies for the session** (founder call, 2026-09-03: *"preserve
 * tab selection and see how it feels"*). Comparing five lakes on *Planning* should not cost four
 * re-selections. It is in memory only: a reload is a new session, and nothing about which tab was
 * open is worth surviving one.
 *
 * `createDetailTabStore` is a factory rather than a module singleton so it can be tested without
 * leaking state between cases; each client instantiates exactly one and wraps it in
 * `useSyncExternalStore`. The store is framework-free on purpose — core has no React, and the
 * three lines each client needs to subscribe are not worth a dependency.
 */

export const DETAIL_TABS = ['overview', 'reporting', 'planning'] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];

export const DETAIL_TAB_LABELS: Readonly<Record<DetailTab, string>> = {
  overview: 'Overview',
  reporting: 'Reporting',
  planning: 'Planning',
};

/**
 * Where a fresh session opens. The first tab, because that is what a tab strip promises — and the
 * founder's own guess was that a fresh body is expected to open on *Overview*. The session store
 * then carries whatever the reader picked. If usage says the first thing people do is tap
 * *Planning*, this is one word to change.
 */
export const DEFAULT_DETAIL_TAB: DetailTab = 'overview';

export function isDetailTab(value: unknown): value is DetailTab {
  return typeof value === 'string' && (DETAIL_TABS as readonly string[]).includes(value);
}

export type DetailTabStore = {
  /** The current tab. Stable between changes, so it is safe as a `useSyncExternalStore` snapshot. */
  get: () => DetailTab;
  /** Set the tab. Unknown values are ignored rather than thrown: a stale deep link is not an error. */
  set: (next: unknown) => void;
  /** Subscribe to changes; returns the unsubscribe. Listeners fire only on a real change. */
  subscribe: (listener: () => void) => () => void;
};

export function createDetailTabStore(initial: DetailTab = DEFAULT_DETAIL_TAB): DetailTabStore {
  let current: DetailTab = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (next) => {
      if (!isDetailTab(next) || next === current) return;
      current = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
