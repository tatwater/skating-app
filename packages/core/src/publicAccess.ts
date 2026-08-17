/**
 * "No public access" — a corroborated community claim, and the moderator verdict that settles it (N6f).
 *
 * ## The claim, stated precisely
 *
 * **No public access means every approach crosses private land — there is no lawful way in.** It says
 * nothing about who owns the water, and that restraint is the point. A public pond ringed by private
 * parcels is the common Northeast case: the water may legally be yours to skate, and you still cannot
 * get to it. What a skater needs is the second fact, and it is also the only one a moderator can check
 * against a parcel map.
 *
 * ## Why this is not `accessAlerts`, and not `remove`
 *
 * An access alert is a decaying claim about a *launch or lot* — 30-day TTL, hard-expired at the season
 * boundary. Private land does not thaw, so that lifecycle would delete the fact every July.
 * `waterBodies.remove` (D48) is the other extreme: it drops the body's cell rows and the lake vanishes.
 * Neither expresses *on the map, and marked*, which is the state this adds.
 *
 * ## Why this one may suppress, when `postedAccess` may not
 *
 * `postedAccess.ts` promises that posted hours "annotate and never suppress" — a skater out at dusk is
 * exactly who most needs to file. This field dims and demotes, which is suppression, so it is a
 * separate field with a separate justification rather than a flag smuggled in beside a posted sign.
 * The justification: posted hours are a fact about *when*, and being wrong costs a reader nothing;
 * this is a fact about *whether you may be there at all*, and a body nobody can lawfully reach should
 * not compete for attention with one they can.
 *
 * ## The corroboration mechanism is `contentFlags`, and needs nothing new
 *
 * `contentFlags` already dedups to one open flag per (flagger, target), so N distinct people asserting
 * a body is private is exactly N open rows — the count is free, and a votes table would only have
 * re-implemented the dedup that already exists.
 */

/**
 * A moderator's ruling. Absence is the third state and means nobody has ruled.
 *
 * - `none` — no lawful way in. Dims and demotes.
 * - `open` — reviewed, there **is** public access. Renders nothing on the map; its job is to stop the
 *   body being reported again, which is why it is a stored verdict rather than just a dismissed flag.
 */
export const PUBLIC_ACCESS_VERDICTS = ['none', 'open'] as const;
export type PublicAccessVerdict = (typeof PUBLIC_ACCESS_VERDICTS)[number];

export interface PublicAccess {
  verdict: PublicAccessVerdict;
  /**
   * When the ruling was made.
   *
   * Load-bearing rather than decoration: it is what makes an `open` verdict *dated*, so a later report
   * can be recognised as disputing a specific review rather than repeating a settled one.
   */
  decidedAt: number;
  decidedByUserId: string;
  /** Shown publicly — "Ringed by posted parcels; no legal approach." */
  note?: string;
}

/** Does this body draw dimmed and demoted? */
export function isNoPublicAccess(body: { publicAccess?: PublicAccess } | undefined): boolean {
  return body?.publicAccess?.verdict === 'none';
}

/**
 * How much a dimmed body's fill and outline are scaled.
 *
 * A **multiplier**, not a fixed opacity, so it composes with whatever base the layer already uses —
 * web varies its fill by selection (`0.6` / `0.35`) and mobile is flat, and a fixed value would flatten
 * that distinction on one platform while fighting it on the other.
 */
export const NO_PUBLIC_ACCESS_OPACITY_SCALE = 0.5;

/**
 * True when a feature should draw dimmed — either a moderator ruled `none`, or *this viewer* has
 * reported it and is seeing their own claim reflected back.
 *
 * Both signals ride the GeoJSON `properties` bag rather than one being feature-state. Favourites use
 * feature-state on web, and copying that here would have forced mobile into a parallel filtered-layer
 * implementation, because the React Native binding has no ergonomic `setFeatureState`. Two mechanisms
 * for one visual effect is how the two platforms drift.
 *
 * `['==', …, true]` rather than a bare `['get', …]`: a missing property reads as `null`, and `any`
 * over a null throws in MapLibre's expression evaluator instead of reading as false.
 */
export function dimmedForAccessExpression(): unknown[] {
  return ['any', ['==', ['get', 'noPublicAccess'], true], ['==', ['get', 'selfFlagged'], true]];
}

/** Wrap a layer's existing opacity expression (or constant) with the access dim. */
export function withAccessDim(baseOpacity: unknown): unknown[] {
  return [
    '*',
    baseOpacity,
    ['case', dimmedForAccessExpression(), NO_PUBLIC_ACCESS_OPACITY_SCALE, 1],
  ];
}

/**
 * The drawer line for a settled verdict, or `null` when nobody has ruled.
 *
 * An `open` verdict says so out loud rather than rendering nothing. It is what explains why the report
 * control behaves differently, and stating the date is what makes the ruling contestable instead of
 * merely final.
 */
export function describePublicAccess(
  access: PublicAccess | undefined,
  timeZone?: string,
): string | null {
  if (!access) return null;
  if (access.verdict === 'none') {
    return 'No public access — every approach crosses private land.';
  }
  return `A moderator reviewed this on ${formatDecidedAt(access.decidedAt, timeZone)} and found public access.`;
}

/** "3 people have reported no public access here — under review." `null` below one report. */
export function describePendingAccessReports(count: number): string | null {
  if (count <= 0) return null;
  const people = count === 1 ? '1 person has' : `${count} people have`;
  return `${people} reported no public access here — under review.`;
}

/**
 * The refusal a note-less report gets while an `open` verdict stands.
 *
 * The gate is a **note requirement, not a block.** A permanent block would be wrong — land is sold and
 * gates go up, and a body that was public in 2026 may not be in 2029 — but letting the same report be
 * refiled with one tap makes the review worthless. Asking what changed costs a genuine reporter one
 * sentence and stops the casual re-flag entirely.
 */
export function accessReportGateMessage(access: PublicAccess, timeZone?: string): string {
  return `A moderator reviewed this on ${formatDecidedAt(access.decidedAt, timeZone)} and found public access. If that has changed, say what changed.`;
}

/**
 * Is this report disputing a prior `open` ruling rather than making a fresh claim?
 *
 * Derived from the two timestamps rather than stored on the flag: a stored copy could disagree with
 * the verdict it describes once a moderator re-rules, and the label would then be lying about a
 * decision it names.
 *
 * **`>=`, not `>`.** A report filed in the same millisecond as the ruling still post-dates it — the
 * flag was checked against a verdict that already existed, so it cannot be anything *but* a dispute.
 * Any report genuinely older than the ruling was resolved by it and is no longer open, so the
 * boundary case is only ever reachable from the disputing side.
 */
export function disputesReview(
  access: PublicAccess | undefined,
  reportedAt: number,
): PublicAccess | null {
  if (access?.verdict !== 'open') return null;
  return reportedAt >= access.decidedAt ? access : null;
}

function formatDecidedAt(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    ...(timeZone !== undefined ? { timeZone } : {}),
  }).format(new Date(ms));
}
