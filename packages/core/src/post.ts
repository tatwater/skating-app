/**
 * The Post (A10 / D186) — the narrative, the photo set, the ordering, and one or more Reports.
 *
 * A Report stays one body, one visit, one `skateEndTime`, the hard data; a Post wraps one or more
 * of them with the author's title and prose. The rules a writer has to hold are small and pure, so
 * they live here where `posts.create`, the sheet reducer and the offline queue can all agree:
 *
 * - a Post **requires at least one Report** (the platform is for reports; questions and planning
 *   stay on the email lists — founder call), and takes at most `POST_MAX_REPORTS`;
 * - the title and prose are the author's, trimmed, bounded, never required — a legacy Post has
 *   neither and a five-chip report needs neither;
 * - the Post's photo set is **derived**: the ordered union of its Reports' lists, because every
 *   photo is tagged to the Report it belongs to (`photos.reportId`, one photo one report) and the
 *   Post is the album over them. One writer (`posts.ts`) recomputes it whenever a member's list
 *   changes, so the three never drift.
 *
 * Validation returns the `ReportValidationError` shape so a sheet can show a Post error beside a
 * Report error with one renderer.
 */

import type { ReportValidationError } from './report';

/**
 * How many Reports one Post may carry. A multi-lake day is a handful; the Champlain
 * circumnavigation is one body with many bays (A09), not many Reports. Bounds the transactional
 * `posts.create` — each Report is dozens of writes — rather than describing a real ceiling.
 */
export const POST_MAX_REPORTS = 10;

/** The subject-line habit — "Crystal Lake, Enfield 12/6" — is short; this is generous for it. */
export const POST_TITLE_MAX_CHARS = 120;

/** Journal-length write-ups exist in the corpus (the longest ~9,000 characters); room for them. */
export const POST_BODY_MAX_CHARS = 20_000;

export interface PostInput {
  title?: string;
  body?: string;
}

export interface NormalizedPost {
  title?: string;
  body?: string;
}

export type PostValidationResult =
  | { ok: true; normalized: NormalizedPost }
  | { ok: false; errors: ReportValidationError[] };

/** Trim, bound, and drop an empty title or body — the Post-level half of the write contract. */
export function validatePostInput(input: PostInput): PostValidationResult {
  const errors: ReportValidationError[] = [];
  const normalized: NormalizedPost = {};
  if (input.title !== undefined) {
    if (typeof input.title !== 'string') errors.push({ field: 'title', message: 'must be text' });
    else {
      const title = input.title.trim();
      if (title.length > POST_TITLE_MAX_CHARS)
        errors.push({
          field: 'title',
          message: `must be at most ${POST_TITLE_MAX_CHARS} characters`,
        });
      else if (title) normalized.title = title;
    }
  }
  if (input.body !== undefined) {
    if (typeof input.body !== 'string') errors.push({ field: 'body', message: 'must be text' });
    else {
      const body = input.body.trim();
      if (body.length > POST_BODY_MAX_CHARS)
        errors.push({
          field: 'body',
          message: `must be at most ${POST_BODY_MAX_CHARS} characters`,
        });
      else if (body) normalized.body = body;
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, normalized };
}

/**
 * The Post's photo set from its members: each Report's list in Report order, first mention wins.
 * Ids are opaque strings here so the queue (local ids) and the server (Convex ids) share it.
 */
export function postPhotoIds<T extends string>(
  reports: readonly { photoIds: readonly T[] }[],
): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const report of reports) {
    for (const id of report.photoIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Which of a Post's Reports a reader may see, and whether the Post shows at all (the moderation
 * rule, A10 §2.4): a hidden Post hides every member; one hidden Report leaves and the Post shows
 * the rest with all its prose; zero visible Reports and the Post is not shown. The same shape
 * serves the feed filters — pass the Reports that matched and the Post appears with only those,
 * or not at all.
 */
export function visiblePostReports<R extends { moderationStatus: string }>(
  post: { moderationStatus: string },
  reports: readonly R[],
): R[] {
  if (post.moderationStatus !== 'visible') return [];
  return reports.filter((r) => r.moderationStatus === 'visible');
}
