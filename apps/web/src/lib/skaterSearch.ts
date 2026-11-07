import { z } from 'zod';

/**
 * The skater routes' root search params (D242 — the B03 route grammar).
 *
 * `?post=` is the New report sheet, open over whatever page you came from; `?postBody=` seeds
 * which lake a new report starts on. They are **root** params — valid from any skater page — but
 * they are validated on the pathless *skater layout* route, never on `__root`: `/admin`,
 * `/sign-in`, `/sign-up`, `/onboarding`, `/reack` and `/google-photos/callback` sit outside the
 * layout, so `?post=new` can never open the report sheet over the admin console (§1.0 of the
 * phase doc).
 *
 * Every schema here uses `.catch()` so a bad or stale link degrades to the default view instead
 * of an error page — the grammar's contract is "old links keep working", and a link that half
 * works is a link that works.
 */

/** `?post=new` opens a blank sheet; `?post=<reportId>` opens that report for editing. */
export const skaterRootSearchSchema = z.object({
  post: z
    .string()
    .min(1)
    .optional()
    .catch(() => undefined),
  postBody: z
    .string()
    .min(1)
    .optional()
    .catch(() => undefined),
});

export type SkaterRootSearch = z.infer<typeof skaterRootSearchSchema>;

/** The sentinel `post` value that means "a new report" rather than an edit. */
export const POST_NEW = 'new';
