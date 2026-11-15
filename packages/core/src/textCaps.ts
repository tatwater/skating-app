/**
 * **The caps on free text that lands in an audit row, or on a row a read must bound** (B01-3h,
 * founder-approved): a lake's or a place's name, a URL, a catalog's machine id, a launch's walk.
 * Each is enforced at its own writers — a moderator's write is refused with a plain message; an
 * import skips the row and counts it, never failing the campaign on one bad row. Where a writer
 * already holds a stricter cap (a landmark's name at 80, a launch's at 60, a request's at 80, a link's
 * label at 80, a moderator's alias at 120), the stricter one stands.
 *
 * Rows written before the caps keep working everywhere (reads, undo, merges): nothing refuses a
 * stored value, and a read that charges a row charges its real size.
 */

/** A lake's, bay's, lot's or place's name, and each alias — the most any writer stores. */
export const MAX_PLACE_NAME_CHARS = 200;

/** A link's URL — the length browsers and servers reliably carry. */
export const MAX_URL_CHARS = 2_048;

/**
 * A catalog's machine id for a row (`node/123`, `way/…`, a GNIS or NHD key, `osm:relation/…`) —
 * every format ingested is under 40 characters; this is three times that.
 */
export const MAX_EXTERNAL_ID_CHARS = 128;

/** How many catalog ids one landmark carries — one per catalog row merged into it, with room. */
export const MAX_LANDMARK_EXTERNAL_IDS = 32;

/**
 * Points a launch's walk keeps — a route from a lot to the shore; a longer one is thinned to this,
 * its first and last points kept (a drawing, so never skipped).
 */
export const MAX_APPROACH_PATH_POINTS = 256;

/**
 * Why `name` is too long for its `what`, or `null` — measured as given, padding included, since some
 * writers store the string as it arrived (Greptile on #131).
 */
export function nameTooLong(name: string, what: string): string | null {
  const n = name.length;
  return n > MAX_PLACE_NAME_CHARS
    ? `${what} is ${n} characters; keep it to ${MAX_PLACE_NAME_CHARS}.`
    : null;
}

/** Whether a catalog id is within its cap. */
export function externalIdFits(id: string): boolean {
  return id.length <= MAX_EXTERNAL_ID_CHARS;
}

/** A walk thinned to at most {@link MAX_APPROACH_PATH_POINTS}, its first and last points kept. */
export function thinPath<P>(path: readonly P[]): P[] {
  const max = MAX_APPROACH_PATH_POINTS;
  if (path.length <= max) return [...path];
  const out: P[] = [];
  for (let i = 0; i < max; i++) {
    out.push(path[Math.round((i * (path.length - 1)) / (max - 1))] as P);
  }
  return out;
}
