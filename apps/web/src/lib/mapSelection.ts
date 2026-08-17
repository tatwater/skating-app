/**
 * Pure URL ↔ map-selection mapping (Phase 2 §D). Selection lives in the URL so a lake or report is
 * deep-linkable off-platform (a settled requirement — the community coordinates over email/text);
 * the map layout parses the current pathname to decide what to highlight and which drawer to open.
 * Kept pure so the route grammar is tested without a router harness (the components stay thin).
 *
 * `/water/$id`, `/report/$id` and `/hazard/$id` mirror the file routes under the `_map` layout;
 * anything else (the `/` map, or a non-map route) is `none` — no drawer, no selection highlight.
 *
 * `/hazard/$id` (Phase 9) is deep-linkable for the same reason the others are, plus one specific to
 * safety content: it is the target a future on-ice notification tap will land on (D54 Layer 2), so the
 * route grammar exists before the notification that uses it. The eventual `?action=confirm` query param
 * (focus the confirm control) is **not parsed yet** — only the route + `skating://` scheme are wired.
 */

export type MapSelection =
  | { kind: 'none' }
  | { kind: 'water'; waterBodyId: string }
  | { kind: 'report'; reportId: string }
  | { kind: 'hazard'; hazardId: string };

export function parseMapSelection(pathname: string): MapSelection {
  const water = pathname.match(/^\/water\/([^/]+)\/?$/);
  if (water?.[1]) return { kind: 'water', waterBodyId: decodeURIComponent(water[1]) };
  const report = pathname.match(/^\/report\/([^/]+)\/?$/);
  if (report?.[1]) return { kind: 'report', reportId: decodeURIComponent(report[1]) };
  const hazard = pathname.match(/^\/hazard\/([^/]+)\/?$/);
  if (hazard?.[1]) return { kind: 'hazard', hazardId: decodeURIComponent(hazard[1]) };
  return { kind: 'none' };
}

/**
 * Is this pathname one of the `_map` layout's routes — the map itself, or a detail panel over it?
 *
 * **Wider than `parseMapSelection`, deliberately.** That function answers "what should the map
 * highlight", and a bounty pin has no highlight, so `/bounty/$id` isn't in its grammar. This one
 * answers "is the map on screen", which governs chrome: the app shell gives a map route the whole
 * viewport (no page scroll, no `max-w`) and puts the lake search in the header, and `/bounty/$id`
 * needs all of that exactly as much as `/water/$id` does. Keeping the two separate is why the
 * bounty drawer doesn't have to pretend to be a selection to get the right frame.
 */
export function isMapRoute(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  if (path === '/') return true;
  return /^\/(water|report|hazard|bounty)\/[^/]+$/.test(path);
}

/**
 * Is a detail panel open over the map? `true` for every `_map` child except the bare map.
 *
 * The sidebar is always open on desktop (it shows what's in view when nothing is selected), so this
 * is what decides *which* of its two contents renders — and, on a phone, whether it renders at all.
 */
export function hasMapDrawer(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  return isMapRoute(path) && path !== '/';
}
