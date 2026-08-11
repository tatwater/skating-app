/**
 * "Temporarily inaccessible" as a decaying community claim, not a note (N6d Workstream C / D73).
 *
 * ## Why this isn't a text field
 *
 * *"Road closed south of the gate until repairs are done"* is the most useful sentence on a lake page
 * and the one most certain to be wrong. It is correct the day it's written and wrong by spring, and
 * nothing in the system knows the difference — because nothing in the system is *asked*. So an access
 * blocker is modelled the way a hazard is: somebody asserts it, other people confirm or deny it, and
 * absent either it goes away on its own.
 *
 * ## The one thing this must not borrow from hazards
 *
 * **A locked gate does not thaw.** The D56 weather multiplier makes an ice hazard fade faster through
 * a warm week, which is right for ice and catastrophic here: a February thaw would silently expire
 * every road closure in the corpus, and the failure would be invisible because expiring is what alerts
 * are *supposed* to do. So the decay here is a plain TTL extended by confirmation, and this module
 * imports nothing from `hazardWeatherDecay`. The temptation to reuse `HAZARD_DECAY` wholesale is real,
 * which is why the absence is stated rather than merely arranged.
 *
 * ## The seasonal rule, and the exception the founder took
 *
 * Community alerts hard-expire at the N5a season boundary: the map starts each winter clean and the
 * community re-establishes what is actually true, which is also the cheapest possible re-survey.
 * **A moderator-pinned `official` alert is exempt** (founder call, 2026-08-10) — it is the analogue of
 * an `official` put-in, it carries a name and an audit row, and it stays until a moderator clears it.
 * That exemption is why `official` is a *status* rather than a flag: it keeps pinned rows out of the
 * expiry sweep's index range entirely (see `ACCESS_ALERT_STATUSES`).
 */

/** Why a launch or lot is unreachable. `other` carries free text; the rest are the common cases. */
export const ACCESS_ALERT_REASONS = [
  'road_closed',
  'gate_locked',
  'not_plowed',
  'lot_full',
  'private_no_access',
  'other',
] as const;
export type AccessAlertReason = (typeof ACCESS_ALERT_REASONS)[number];

/**
 * The lifecycle states, and the reason `official` is one of them rather than a boolean.
 *
 * A pinned alert never expires (founder call), so the expiry sweep must never see it. Convex indexes
 * on optional fields **are not sparse** — an absent `expiresAt` sorts *first*, so a bare
 * `lte('expiresAt', now)` range would match every pinned row rather than skipping it, which is a trap
 * this repo has already been bitten by once. Making `official` a distinct status puts it in a
 * different equality prefix of `by_status_expires_at`, so the sweep's range cannot reach it at all and
 * the correctness does not depend on anybody remembering the trap.
 *
 * - `active` — a community claim, decaying. **The only status the expiry sweep reads.**
 * - `official` — moderator-pinned. No TTL, no season boundary; cleared by a moderator or not at all.
 * - `expired` — its TTL ran out, or the season turned.
 * - `resolved` — enough people said it's open again.
 * - `retracted` — it never existed (D65). Different from `resolved`, which means it did and no longer does.
 * - `hidden` — moderator-suppressed as bad content.
 */
export const ACCESS_ALERT_STATUSES = [
  'active',
  'official',
  'expired',
  'resolved',
  'retracted',
  'hidden',
] as const;
export type AccessAlertStatus = (typeof ACCESS_ALERT_STATUSES)[number];

/**
 * What a passer-by can say about an existing alert.
 *
 * Deliberately *not* hazards' three-tier vote. That one is shaped by a safety asymmetry — a wrong
 * "all clear" on ice can kill someone, so `fully_healed` needs two votes while `still_there` needs
 * one. A gate is not ice: being wrong in either direction costs a wasted drive, and pretending
 * otherwise would import a caution that has nothing to protect here (D3 is about ice, not access).
 */
export const ACCESS_ALERT_VERDICTS = ['still_blocked', 'open'] as const;
export type AccessAlertVerdict = (typeof ACCESS_ALERT_VERDICTS)[number];

/** What an alert hangs off. Both are access points; only the table differs. */
export const ACCESS_ALERT_TARGETS = ['put_in', 'parking_area'] as const;
export type AccessAlertTarget = (typeof ACCESS_ALERT_TARGETS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long an unconfirmed alert lives.
 *
 * Thirty days is the plan's figure and it is the right order of magnitude for the thing being
 * described: gates, plowing and road work change on a scale of weeks, not hours. Shorter would expire
 * true closures between visits to an out-of-the-way pond; longer would outlive a spring reopening,
 * which is the exact rot C1 exists to prevent.
 */
export const ACCESS_ALERT_TTL_MS = 30 * DAY_MS;

/**
 * Distinct skaters who must say "it's open" before an alert resolves.
 *
 * Two rather than one, for the same reason the hazard removal threshold is two: a single passer-by can
 * be at the wrong gate, or find a lot plowed on the one day it was. Unlike hazards, this is not a
 * safety threshold — it is a noise threshold, and it is symmetric with the single confirmation that
 * extends the alert because neither direction is the dangerous one.
 */
export const ACCESS_ALERT_RESOLVE_VOTES = 2;

/** One skater's latest word on one alert. Distinct users, latest vote each — the hazard discipline. */
export interface AccessAlertVote {
  userId: string;
  verdict: AccessAlertVerdict;
  /** When they stood there, not when the row was written — an offline flush must not re-date it. */
  observedAt: number;
}

/** The subset of a stored alert the lifecycle math reads. */
export interface AccessAlertRecord {
  status: AccessAlertStatus;
  createdAt: number;
  /** Absent **only** for `official` pins, which have no TTL by founder call. */
  expiresAt?: number;
}

/** The recomputed lifecycle: what the row should say after a vote or a sweep. */
export interface AccessAlertLifecycle {
  status: AccessAlertStatus;
  expiresAt?: number;
  confirmCount: number;
  denyCount: number;
  lastConfirmedAt?: number;
}

/**
 * When an alert created (or confirmed) at `atMs` should lapse, given the season it belongs to.
 *
 * Two independent bounds, and the **earlier** wins: the plain TTL, and the season end. Expressed as a
 * `min` rather than as two code paths because the whole point of the seasonal rule is that it is not
 * negotiable — an alert must never outlive the evidence for it, and a closure asserted in March with
 * thirty days on the clock would otherwise reach into a season nobody has looked at yet.
 */
export function accessAlertExpiryFor(atMs: number, seasonEndMs: number): number {
  return Math.min(atMs + ACCESS_ALERT_TTL_MS, seasonEndMs);
}

/**
 * Is this alert currently saying anything?
 *
 * `official` is live regardless of the clock — it has no `expiresAt` at all — and that is the whole
 * content of the founder's exemption. An `active` row is live until its TTL passes, which is checked
 * here as well as by the sweep: a row whose expiry has passed but which the cron hasn't reached yet
 * must not annotate a put-in in the meantime, or the sweep's schedule would become a visible
 * behaviour.
 */
export function accessAlertIsLive(alert: AccessAlertRecord, nowMs: number): boolean {
  if (alert.status === 'official') return true;
  if (alert.status !== 'active') return false;
  return alert.expiresAt === undefined || alert.expiresAt > nowMs;
}

/**
 * Recompute an alert from the full vote set — the single place the lifecycle turns.
 *
 * Mirrors `deriveHazardLifecycle`'s shape on purpose: counts come from **distinct users' latest
 * votes**, never from an incremented column, so a replayed offline confirmation updates one row and
 * re-derives the same numbers instead of double-counting.
 *
 * Three rules, in precedence order:
 *
 * 1. **A pinned or already-closed alert is not moved by votes.** A moderator's pin outranks the crowd
 *    (that is what pinning means), and re-opening a `retracted` row by voting on it would let the
 *    crowd overturn a "this never existed" verdict the author or a moderator issued.
 * 2. **Enough denials resolve it.** `resolved`, not deleted — the row is the record that somebody
 *    checked, and the put-in's history is the only thing that makes the next alert legible.
 * 3. **Otherwise the newest confirmation resets the clock.** A confirmation is evidence gathered
 *    *now*, so the TTL runs from the observation rather than from the original assertion — which is
 *    what lets a genuinely long closure stay up through a winter without anybody re-authoring it.
 */
export function deriveAccessAlertLifecycle(
  alert: AccessAlertRecord,
  votes: readonly AccessAlertVote[],
  seasonEndMs: number,
): AccessAlertLifecycle {
  const latestByUser = new Map<string, AccessAlertVote>();
  for (const vote of votes) {
    const held = latestByUser.get(vote.userId);
    if (!held || vote.observedAt > held.observedAt) latestByUser.set(vote.userId, vote);
  }
  const latest = [...latestByUser.values()];
  const confirms = latest.filter((v) => v.verdict === 'still_blocked');
  const denies = latest.filter((v) => v.verdict === 'open');
  const confirmCount = confirms.length;
  const denyCount = denies.length;
  const lastConfirmedAt = confirms.length
    ? Math.max(...confirms.map((v) => v.observedAt))
    : undefined;

  const settled: AccessAlertStatus[] = ['official', 'retracted', 'hidden'];
  if (settled.includes(alert.status)) {
    return { status: alert.status, expiresAt: alert.expiresAt, confirmCount, denyCount, lastConfirmedAt };
  }

  if (denyCount >= ACCESS_ALERT_RESOLVE_VOTES) {
    return { status: 'resolved', expiresAt: alert.expiresAt, confirmCount, denyCount, lastConfirmedAt };
  }

  const base = lastConfirmedAt ?? alert.createdAt;
  return {
    status: alert.status === 'expired' && lastConfirmedAt === undefined ? 'expired' : 'active',
    expiresAt: accessAlertExpiryFor(base, seasonEndMs),
    confirmCount,
    denyCount,
    lastConfirmedAt,
  };
}
