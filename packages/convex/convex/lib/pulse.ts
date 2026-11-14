/**
 * What the Overview's pulse counts (B01, Metrics' *Each day*), shared by the day rollup and the
 * season's reach so a strip and its season total count the same rows.
 */

import type { Doc } from '../_generated/dataModel';

/**
 * A comment the pulse counts: visible, and neither withdrawn by its author (D248) nor emptied when
 * its author left (D62). Shared with the season's reach, so the strip and its total agree.
 */
export function isCountedComment(c: Doc<'comments'>): boolean {
  return (
    c.moderationStatus === 'visible' &&
    c.authorDeletedAt === undefined &&
    c.redactedAt === undefined
  );
}
