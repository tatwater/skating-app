import { z } from 'zod';

/**
 * `/latest`'s search params (D242). Only the transient view rides the URL — the filters are the
 * saved D166 preference (Q3), so a link never carries them. Every field `.catch()`es to its
 * default, so a stale or hand-edited link degrades to the plain feed instead of an error page.
 * The root params (`?post=`, `?postBody=`) are the skater layout's, not these.
 *
 * - `report` — the report open in the drawer from the right (4.5–4.7).
 * - `q` — text search over reports (4.9), behind `latest-text-search`. Blank is no search.
 * - `skater` — one skater's reports, by username, behind `latest-skater-filter`.
 * - `view=map` — the region map in a Latest frame (4.4).
 */

/** The server trims a search past this anyway (`posts.searchFeed`); the URL never holds more. */
export const SEARCH_MAX_CHARS = 200;

/** Trimmed and capped; blank, missing or not a string is no value at all. */
const optionalText = (max: number) =>
  z.preprocess((raw) => {
    if (typeof raw !== 'string') return undefined;
    const value = raw.trim().slice(0, max);
    return value === '' ? undefined : value;
  }, z.string().optional());

export const latestSearchSchema = z.object({
  report: z
    .string()
    .min(1)
    .optional()
    .catch(() => undefined),
  q: optionalText(SEARCH_MAX_CHARS),
  skater: optionalText(64),
  view: z
    .literal('map')
    .optional()
    .catch(() => undefined),
});

export type LatestSearch = z.infer<typeof latestSearchSchema>;
