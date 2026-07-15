/**
 * Pure URL ↔ map-selection mapping (Phase 2 §D). Selection lives in the URL so a lake or report is
 * deep-linkable off-platform (a settled requirement — the community coordinates over email/text);
 * the map layout parses the current pathname to decide what to highlight and which drawer to open.
 * Kept pure so the route grammar is tested without a router harness (the components stay thin).
 *
 * `/water/$id` and `/report/$id` mirror the file routes under the `_map` layout; anything else
 * (the `/` map, or a non-map route) is `none` — no drawer, no selection highlight.
 */

export type MapSelection =
  | { kind: 'none' }
  | { kind: 'water'; waterBodyId: string }
  | { kind: 'report'; reportId: string }

export function parseMapSelection(pathname: string): MapSelection {
  const water = pathname.match(/^\/water\/([^/]+)\/?$/)
  if (water?.[1]) return { kind: 'water', waterBodyId: decodeURIComponent(water[1]) }
  const report = pathname.match(/^\/report\/([^/]+)\/?$/)
  if (report?.[1]) return { kind: 'report', reportId: decodeURIComponent(report[1]) }
  return { kind: 'none' }
}
