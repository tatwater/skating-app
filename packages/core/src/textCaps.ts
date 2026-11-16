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

/**
 * The total length of one landmark's catalog ids (the sum of their characters) — bounded by length,
 * never by count: a waterway the ETL stitches from many ways carries one id per way (the largest
 * measured on dev, 142 ids, is about 3,550 characters; this is over four times that). With each id at
 * most {@link MAX_EXTERNAL_ID_CHARS}, a landmark's ids weigh at most this many characters.
 */
export const MAX_LANDMARK_EXTERNAL_ID_CHARS = 16_384;

/**
 * The catalog ids a landmark keeps, oldest first as given: every one while their total length fits
 * {@link MAX_LANDMARK_EXTERNAL_ID_CHARS}; past it, the newest that fit — an id the catalogs still use
 * outranks one that left them — and how many were dropped. Repeats are folded first. One rule for
 * every writer of a landmark's ids (the load, a merge's fold).
 */
export function landmarkIdsToKeep(ids: readonly string[]): { kept: string[]; dropped: number } {
  const distinct = [...new Set(ids)];
  let total = 0;
  let from = distinct.length;
  while (from > 0) {
    const next = total + (distinct[from - 1] as string).length;
    if (next > MAX_LANDMARK_EXTERNAL_ID_CHARS) break;
    total = next;
    from--;
  }
  return { kept: distinct.slice(from), dropped: from };
}

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
