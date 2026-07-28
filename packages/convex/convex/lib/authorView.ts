/**
 * Public author attribution, derived in exactly one place (N3).
 *
 * Four surfaces build this shape — the feed card, the report detail, the comment thread and the bounty
 * list — and they had four copies of the same three lines. That was harmless until deletion arrived,
 * because a tombstone is a *profile row that still exists*: every copy happily read its
 * `reputationPoints` and rendered a trust ring for someone who no longer has an account, and one copy
 * (`profiles.publicByIds`) had already been fixed by hand while the others hadn't. A deleted skater
 * showing a trust ring on the feed and none on their profile is the kind of inconsistency nobody
 * reports as a bug and everybody notices.
 *
 * So: one builder, three cases — live, tombstone, gone.
 */

import type { FeedAuthor } from '@skating/core';
import type { Doc } from '../_generated/dataModel';
import { trustClassFor } from './reputation';

/**
 * The public attribution for a profile, or the fallback when there isn't one.
 *
 * A **tombstone** keeps its (already-scrubbed) name and loses everything that implies a person you
 * might interact with: no avatar (scrubbed at finalize anyway), and no trust class — a trust class is a
 * claim about whether to weigh someone's *future* reports, and there aren't going to be any.
 *
 * A **missing** profile is a different thing from a deleted one and reads differently: 'Unknown' means
 * we couldn't resolve the author at all, where 'Deleted skater' means we know exactly what happened.
 */
export function publicAuthor(profile: Doc<'profiles'> | null, now: number): FeedAuthor {
  if (profile === null) return { displayName: 'Unknown', username: '', trustClass: null };
  // A **ghost** — deletion requested, not yet finalized — is presented exactly like a tombstone
  // (D62 amendment). Their row still holds a reserved handle and a trust score, and rendering either
  // one would put a live-looking author on content whose author has already gone: a name that links
  // to a 404, next to a ring that says "weigh this person's future reports".
  if (profile.status === 'deleted' || profile.deletionRequestedAt !== undefined) {
    return {
      // Already scrubbed to `DELETED_DISPLAY_NAME` by the request (or by the tombstone), so this is
      // the stored value rather than a substitution — one place decides what a departed author reads
      // as, and it isn't this function.
      displayName: profile.displayName,
      // Emptied, not passed through: the handle is *reserved* during the ghost window, and a link to
      // a profile that deliberately 404s is worse than no link.
      username: '',
      trustClass: null,
      deleted: true,
    };
  }
  return {
    displayName: profile.displayName,
    username: profile.username,
    ...(profile.profileImageUrl !== undefined ? { profileImageUrl: profile.profileImageUrl } : {}),
    trustClass: trustClassFor(profile, now),
  };
}
