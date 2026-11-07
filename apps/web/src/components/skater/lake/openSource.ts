import type { WaterBodyOpenSource } from '@/lib/analytics';

/**
 * Which surface opened a lake, for `water_body_opened` (D240).
 *
 * A navigator that knows why it is going to `/water/$id` says so, and where, just before it goes —
 * the In view list (`list`), search (`search`), the bell (`notification`) and Latest (`latest`) —
 * and the lake page takes the mark on arrival. A mark is single-use and short-lived: it names the
 * path it is for, counts only an arrival at that path within a few seconds, and is spent by the
 * next arrival whatever it says. So a mark left by a navigation that went somewhere else (a skater
 * picked in search, a hazard opened from the bell) or never landed can't label a later open.
 *
 * With no mark: the document's own entry (a typed URL, a bookmark, an email or a push link — no
 * in-app source at all) is `deep_link`; any other unmarked arrival is the map, the one navigator
 * that opens lakes without a menu around it.
 */

const MARK_TTL_MS = 3_000;

let pending: { source: WaterBodyOpenSource; path: string; at: number } | null = null;
/** Whether this document has already counted its entry. Exported for tests through `reset`. */
let entryCounted = false;

/** The pathname of an in-app href (`/water/w1?sub=s1` → `/water/w1`). */
function pathOf(href: string): string {
  try {
    return new URL(href, 'https://gli.invalid').pathname;
  } catch {
    return href;
  }
}

/**
 * Called by a navigator just before it goes to `to`. Safe to call for any destination: a mark for a
 * path that isn't a lake is never counted, and the next lake arrival spends it.
 */
export function markWaterBodyOpenSource(
  source: WaterBodyOpenSource,
  to: string,
  now = Date.now(),
): void {
  pending = { source, path: pathOf(to), at: now };
}

/** The pathname this document was loaded at, from the navigation timing entry. */
function documentEntryPath(): string | null {
  if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') {
    return null;
  }
  const [entry] = performance.getEntriesByType('navigation');
  if (entry === undefined) return null;
  try {
    return new URL(entry.name).pathname;
  } catch {
    return null;
  }
}

/**
 * The source of the open that just landed at `pathname`, consuming any mark. The first unmarked
 * open whose path is the document's entry path is `deep_link`; that can happen once per document.
 */
export function takeWaterBodyOpenSource(
  pathname: string,
  {
    now = Date.now(),
    entryPath = documentEntryPath(),
  }: { now?: number; entryPath?: string | null } = {},
): WaterBodyOpenSource {
  const mark = pending;
  pending = null;
  const isEntry = !entryCounted && entryPath !== null && entryPath === pathname;
  entryCounted = true;
  if (mark !== null && mark.path === pathname && now - mark.at <= MARK_TTL_MS) return mark.source;
  return isEntry ? 'deep_link' : 'map';
}

/** Test seam: a fresh document. */
export function resetWaterBodyOpenSource(): void {
  pending = null;
  entryCounted = false;
}
