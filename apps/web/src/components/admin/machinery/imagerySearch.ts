import { ID_SHAPE } from '../reads/readArgs';

/**
 * **Machinery › Imagery's place in the URL** (B01-8b-2), validated, never trusted (the route's
 * `validateSearch`):
 *
 * - **`granule`**: an `imageryGranules` id. Opens that granule's detail.
 * - **`attempt`**: an attempt number (1-based, at most {@link ATTEMPT_MAX}) within the open granule:
 *   its log opened. Dropped without a `granule`.
 * - **`runs`**: one of the page's three crons (`poll`, `pump`, `index`): its runs drawer opened.
 *
 * Anything else is dropped, and so is a value of the wrong shape.
 */

/** The page's three crons, as the drawer's tabs name them. */
export const IMAGERY_RUNS_TABS = ['poll', 'pump', 'index'] as const;
export type ImageryRunsTab = (typeof IMAGERY_RUNS_TABS)[number];

/** The highest attempt number the URL holds (the detail reads ten). */
export const ATTEMPT_MAX = 99;

/** What the page's search holds, every default left out. */
export type ImagerySearch = { granule?: string; attempt?: number; runs?: ImageryRunsTab };

/** An `imageryGranules` id `raw` names, or `null`. */
export function granuleOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  return ID_SHAPE.test(text) ? text : null;
}

/** An attempt number `raw` names (a positive integer, as a number or its digits), or `null`. */
export function attemptOf(raw: unknown): number | null {
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\d+$/.test(raw.trim())
        ? Number(raw.trim())
        : Number.NaN;
  return Number.isInteger(n) && n >= 1 && n <= ATTEMPT_MAX ? n : null;
}

/** The drawer's tab `raw` names, or `null`. */
export function runsTabOf(raw: unknown): ImageryRunsTab | null {
  return typeof raw === 'string' && (IMAGERY_RUNS_TABS as readonly string[]).includes(raw)
    ? (raw as ImageryRunsTab)
    : null;
}

/** The route's `validateSearch`. */
export function validateImagerySearch(raw: Record<string, unknown>): ImagerySearch {
  const granule = granuleOf(raw.granule);
  const attempt = granule === null ? null : attemptOf(raw.attempt);
  const runs = runsTabOf(raw.runs);
  return {
    ...(granule !== null && { granule }),
    ...(attempt !== null && { attempt }),
    ...(runs !== null && { runs }),
  };
}
