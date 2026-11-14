/**
 * Positive reactions — what the console counts as *kudos* (the founder, 2026-11-13).
 *
 * Kudos are positive reactions, and a report's *helpful* rating is one. A report keeps its thumbs up
 * and down for helpfulness, but a thumbs-down is not an anti-kudos: it never lowers a count of
 * positive reactions, and it is never counted here. Today the one kind is `helpful`, from
 * `reportRatings`; social-style reactions on posts can join later as new kinds, and the metric that
 * counts them (`positive_reactions`, by kind) takes them without a rename.
 */

/** Every kind of positive reaction. A new kind is a new entry, not a new metric. */
export const POSITIVE_REACTION_KINDS = ['helpful'] as const;
export type PositiveReactionKind = (typeof POSITIVE_REACTION_KINDS)[number];

/**
 * The positive-reaction kind a rating's verdict is, or `null` when it is not one — a thumbs-down
 * (`unhelpful`) is `null`, and so is anything this build has no word for.
 */
export function positiveReactionOf(verdict: string): PositiveReactionKind | null {
  return (POSITIVE_REACTION_KINDS as readonly string[]).includes(verdict)
    ? (verdict as PositiveReactionKind)
    : null;
}
