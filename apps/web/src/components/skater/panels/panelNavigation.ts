import {
  type HistoryState,
  useCanGoBack,
  useNavigate,
  useRouter,
  useRouterState,
} from '@tanstack/react-router';
import { useCallback, useEffect, useRef } from 'react';

import { ANALYTICS_ENUMS, type PanelViewSource, useAnalytics } from '@/lib/analytics';
import { useChromeStore } from '@/stores/chromeStore';

/**
 * How an inset card (a report, a hazard, a bounty) is reached and left (B03 §1.8, "Navigation
 * mechanics"). A card is a **route**, not a component over its opener, so three things that a
 * dialog gets for free have to be done by hand here:
 *
 * - **Where it came from.** A door into a card says so in the navigation state
 *   (`state={panelLinkState('water_body')}`); a card reached with no state and no in-app history was
 *   deep-linked (an email, a notification tap, a pasted link).
 * - **How it closes.** Esc and "Back to Mascoma Lake" return to the lake. Opened from that lake's own
 *   sidebar, that is one step back in history; anything else — a deep link above all — navigates to
 *   the lake with `replace`, never `history.back()`, which would leave the app or land on a page that
 *   isn't the one the bar names.
 * - **Where focus goes after.** The card's opener unmounted when the route changed, so focus is put
 *   back by hand on the row that opened it (`data-panel-trigger`), or on the lake's sidebar, or on
 *   the page.
 */

/** The navigation state a door into a card passes. Read back with {@link panelSourceOf}. */
interface PanelLinkState {
  panelSource?: unknown;
}

const SOURCES: ReadonlySet<string> = new Set(ANALYTICS_ENUMS.panel_view_source);

/** The door a card was opened through, if the navigation said; anything else is `undefined`. */
export function panelSourceOf(state: unknown): PanelViewSource | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  const source = (state as PanelLinkState).panelSource;
  return typeof source === 'string' && SOURCES.has(source)
    ? (source as PanelViewSource)
    : undefined;
}

/**
 * The state a door into a card passes, so the card can count where it was opened from and knows
 * whether Back can be a step back: `<Link to="/report/$id" state={panelLinkState('water_body')} />`.
 */
export function panelLinkState(source: PanelViewSource): HistoryState {
  return { panelSource: source } as HistoryState;
}

/** The kinds of card, and the key a row that opens one carries (`data-panel-trigger`). */
export type PanelKind = 'report' | 'hazard' | 'bounty';

export function panelTriggerKey(kind: PanelKind, id: string): string {
  return `${kind}:${id}`;
}

/** Spread on whatever opens a card, so focus can come back to it: `{...panelTriggerProps('report', id)}`. */
export function panelTriggerProps(kind: PanelKind, id: string): { 'data-panel-trigger': string } {
  return { 'data-panel-trigger': panelTriggerKey(kind, id) };
}

/** The lake a card belongs to, which is where Back goes. A bay rides as `?sub=`. */
export interface PanelLake {
  bodyId: string;
  subAreaId?: string;
}

/**
 * Where the card was opened from. `null` means "inside the app, but the door didn't say" — counted
 * as nothing rather than guessed (a mislabeled source is worse than a missing one).
 */
export function resolvePanelSource(state: unknown, canGoBack: boolean): PanelViewSource | null {
  return panelSourceOf(state) ?? (canGoBack ? null : 'deep_link');
}

/**
 * The close: one step back when that step is the lake the bar names (opened from its sidebar, with
 * history to pop); otherwise a `replace` navigation to the lake, or to `/` when the lake isn't known
 * (a card that never resolved).
 */
export function useClosePanel(lake: PanelLake | null): () => void {
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const state = useRouterState({ select: (s) => s.location.state });
  const fromLake = panelSourceOf(state) === 'water_body';
  return useCallback(() => {
    if (lake !== null && fromLake && canGoBack) {
      router.history.back();
      return;
    }
    if (lake === null) {
      void navigate({ to: '/', replace: true });
      return;
    }
    void navigate({
      to: '/water/$id',
      params: { id: lake.bodyId },
      search: lake.subAreaId !== undefined ? { sub: lake.subAreaId } : {},
      replace: true,
    });
  }, [lake, fromLake, canGoBack, navigate, router]);
}

/**
 * Fires the card's `*_viewed` event once per card id, with the door it came through (D240: the
 * shape only — never the id).
 */
export function usePanelViewed(
  event: 'report_viewed' | 'hazard_viewed' | 'bounty_viewed',
  id: string,
): void {
  const analytics = useAnalytics();
  const canGoBack = useCanGoBack();
  const state = useRouterState({ select: (s) => s.location.state });
  const source = resolvePanelSource(state, canGoBack);
  const fired = useRef<string | null>(null);
  useEffect(() => {
    if (fired.current === id) return;
    fired.current = id;
    if (source !== null) analytics.capture(event, { source });
  }, [analytics, event, id, source]);
}

/**
 * Whether Esc belongs to something above the card: a top-bar plate (search, the bell, the avatar
 * menu) or the New report sheet (`?post=`). One Esc per screen, and it closes the outermost thing.
 */
export function escBelongsElsewhere(): boolean {
  if (useChromeStore.getState().overlay !== null) return true;
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).has('post');
}

// ── Focus return ───────────────────────────────────────────────────────────────────────────────

/** Where focus goes when a card closes, best first. */
export interface FocusReturn {
  /** What held focus when the card opened, if it was outside the card. Usually gone by close. */
  opener: HTMLElement | null;
  /** The `data-panel-trigger` key of the row that opens this card. */
  key: string;
}

/** The lake sidebar's root, the fallback when the row that opened the card isn't on the page. */
export const LAKE_SIDEBAR_SELECTOR = '[data-slot="lake-sidebar"]';
const PAGE_SELECTOR = '[data-slot="skater-page"]';

function focusable(el: Element | null): el is HTMLElement {
  return el instanceof HTMLElement && el.isConnected;
}

function focusEl(el: HTMLElement): void {
  // A region isn't tabbable; give it a programmatic stop so `focus()` lands.
  if (!el.hasAttribute('tabindex') && el.tabIndex < 0) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: false });
}

/**
 * Finds the best target now: the opener if it survived, else the row with this card's key, else the
 * lake's sidebar. `null` when none is on the page yet (the lake page may still be loading its rows).
 */
export function focusReturnTarget(
  ret: FocusReturn,
  root: ParentNode = document,
): HTMLElement | null {
  if (focusable(ret.opener)) return ret.opener;
  const row = root.querySelector(`[data-panel-trigger="${CSS.escape(ret.key)}"]`);
  if (focusable(row)) return row;
  const sidebar = root.querySelector(LAKE_SIDEBAR_SELECTOR);
  return focusable(sidebar) ? sidebar : null;
}

/**
 * Puts focus back after a close. The lake's rows arrive a beat after its route mounts (they're a
 * Convex read), so this looks for a few frames before settling on the page itself — and gives up
 * if something else took focus in the meantime (the page knew better).
 */
export function restoreFocus(
  ret: FocusReturn,
  options: { frames?: number; schedule?: (fn: () => void) => void } = {},
): void {
  const { frames = 30, schedule = (fn) => requestAnimationFrame(fn) } = options;
  let left = frames;
  const tick = () => {
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const target = focusReturnTarget(ret);
    if (target !== null) {
      focusEl(target);
      return;
    }
    left -= 1;
    if (left > 0) {
      schedule(tick);
      return;
    }
    const page = document.querySelector(PAGE_SELECTOR);
    if (focusable(page)) focusEl(page);
  };
  schedule(tick);
}
