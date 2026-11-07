import type { WaterBodyOpenSource } from '@/lib/analytics';

/**
 * Which surface opened a lake, for `water_body_opened` (D240).
 *
 * A navigator that knows why it is going to `/water/$id` says so just before it goes — the In view
 * list says `list`, and search, the bell, the map and Latest are asked to do the same — and the lake
 * page takes the mark once, on arrival. A mark is good for a few seconds only, so one left behind
 * by a navigation that never landed can't label a later, unrelated open.
 *
 * With no mark: the document's own entry (a typed URL, a bookmark, an email or a push link — no
 * in-app source at all) is `deep_link`; any other unmarked arrival is the map, the one navigator
 * that opens lakes without a menu around it.
 */

const MARK_TTL_MS = 3_000;

let pending: { source: WaterBodyOpenSource; at: number } | null = null;
/** Whether this document has already counted its entry. Exported for tests through `reset`. */
let entryCounted = false;

/** Called by a navigator just before it opens a lake. */
export function markWaterBodyOpenSource(source: WaterBodyOpenSource, now = Date.now()): void {
  pending = { source, at: now };
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
  if (mark !== null && now - mark.at <= MARK_TTL_MS) return mark.source;
  return isEntry ? 'deep_link' : 'map';
}

/** Test seam: a fresh document. */
export function resetWaterBodyOpenSource(): void {
  pending = null;
  entryCounted = false;
}
