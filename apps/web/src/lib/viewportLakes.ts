/**
 * What the map sidebar lists when no lake is open: the bodies currently in view, ordered.
 *
 * **No query of its own.** The rows are the ones `waterBodies.listInViewport` already fetched for
 * the water layer — the map hands them up through `MapSelectionContext` and this module turns them
 * into a list. A second subscription on the same viewport key would double the read cost of every
 * pan for an answer the map is already holding, and `listInViewport` is the one read path in this
 * app with a history of read-cap failures (PRs #10/#11, then N1); it does not need a second caller.
 *
 * Ordering is the whole design here. The map draws prominence spatially — a big lake is big — but a
 * list has one dimension, so it has to spend it on the same thing the map does: what is worth
 * looking at first. Favorites, then named water, then size.
 */

/** A row as it arrives from `listInViewport` — a subset of the stored body, nothing derived. */
export interface ViewportLake {
  _id: string;
  /** May be the empty string: the corpus holds plenty of unnamed ponds, and they still render. */
  name: string;
  type: string;
  surfaceAreaSqM?: number;
  states?: string[];
  summary?: { recentReportCount: number };
  /** A moderator's access ruling (N6f) — `verdict: 'none'` sinks the row and prints a chip. */
  publicAccess?: { verdict: string };
}

/** A row with the two things the list decides rather than reads. */
export interface ViewportLakeRow extends ViewportLake {
  isFavorite: boolean;
}

export interface ViewportLakeList {
  rows: ViewportLakeRow[];
  /** How many *named* bodies in view didn't fit the cap — printed, never silently dropped. */
  hiddenCount: number;
  /** How many unnamed bodies were filtered out — so the empty state can say why it's empty. */
  unnamedCount: number;
}

/**
 * How many rows the list renders before it stops.
 *
 * A regional view can hold hundreds of bodies, and past the first few dozen a list stops being a
 * list — nobody scrolls 300 ponds looking for one, they zoom or they search. The cap is a rendering
 * decision only: the count below it tells you the rest are there, so the list never quietly implies
 * it showed you everything.
 */
export const VIEWPORT_LIST_LIMIT = 50;

/**
 * Order the named bodies in view, cap the list, and say what was left off.
 *
 * **Unnamed water is filtered out entirely**, and that is a judgement about what a list can do that
 * a map can't. On the map an unnamed pond is a distinct shape in a place — you can tell two of them
 * apart at a glance, and tapping one is a deliberate act. In a list they collapse into eleven
 * identical rows reading "Unnamed water", distinguishable only by an acreage nobody is searching by.
 * They stayed selectable on the map; they just stop crowding out the rows that carry information.
 *
 * The comparator, in order:
 *  1. **Favorites first.** The map already outlines them; the list is the surface where "my lakes"
 *     is a useful sort, and a favorite that fell to row 40 behind bigger water you've never skated
 *     is the list failing at the one thing it knows about you.
 *  2. **Bodies with no public access last** (N6f) — the list's half of the map's dim. A lake you
 *     cannot lawfully reach should not take one of fifty rows from one you can. It still *has* a row,
 *     which is the same restraint the zoom demotion keeps: harder to find, never hidden.
 *     Below the favorite check on purpose — if you favorited it, you know something we don't.
 *  3. **Largest first**, then name, so the order is total and a re-render can't reshuffle equals.
 */
export function orderViewportLakes(
  bodies: readonly ViewportLake[],
  favoriteIds: ReadonlySet<string> = new Set(),
  limit: number = VIEWPORT_LIST_LIMIT,
): ViewportLakeList {
  const named = bodies.filter((body) => body.name.length > 0);
  const rows = named
    .map((body) => ({ ...body, isFavorite: favoriteIds.has(body._id) }))
    .sort((a, b) => {
      if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
      const aShut = a.publicAccess?.verdict === 'none';
      const bShut = b.publicAccess?.verdict === 'none';
      if (aShut !== bShut) return aShut ? 1 : -1;
      const area = (b.surfaceAreaSqM ?? 0) - (a.surfaceAreaSqM ?? 0);
      if (area !== 0) return area;
      return a.name.localeCompare(b.name) || a._id.localeCompare(b._id);
    });

  return {
    rows: rows.slice(0, limit),
    hiddenCount: Math.max(0, rows.length - limit),
    unnamedCount: bodies.length - named.length,
  };
}
