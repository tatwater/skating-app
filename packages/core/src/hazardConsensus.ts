/**
 * What a *cluster* of duplicate hazards knows, as opposed to what one row knows (A05c / D80).
 *
 * Duplicates split every gate that decides something. Three people marking the same ridge produce
 * three rows, three confirm loops and three freshness clocks, so a hazard the community is actively
 * maintaining looks — to the alert evaluator, to the map's opacity, to the corroboration ledger — like
 * three pins nobody has touched. The fix is not to hide the rows but to **read the gates off the
 * cluster**.
 *
 * **The asymmetry, which is the whole design.** Pool the evidence that a hazard *is there*; never pool
 * the evidence that it is *gone*. Sharing "gone" votes would let two people clearing one pin retire a
 * neighbouring pin nobody looked at — pooling in the unsafe direction. So archival stays strictly
 * per-row (`deriveHazardLifecycle`, untouched by this module), and what is pooled here is only ever
 * confirmation and freshness, which can make a hazard louder and never quieter.
 *
 * **Who counts as a witness.** Distinct users who *either* confirmed any member *or* drew one — always
 * excluding the pin's own author. Counting authorship matters because the commonest duplicate has no
 * confirmations at all: three skaters each mark the same ridge, nobody taps confirm, and a
 * confirmers-only count leaves every phone on the lake stuck at the soft "can you see it?" prompt.
 * Someone who independently drew the hazard is *stronger* evidence than a confirm tap, not weaker —
 * they saw it and described it. Excluding the pin's own author keeps D54's rule exactly as it was: you
 * cannot vouch for your own report, and one person double-posting from two devices is still one
 * witness.
 *
 * A singleton cluster returns precisely the row's own stored values, so the overwhelming majority of
 * hazards are unaffected by any of this — and that equivalence is a property test.
 */

import type { HazardVerdict } from './hazardLifecycle';

/** One member of a cluster, reduced to what consensus reads. */
export interface ConsensusMember {
  id: string;
  createdByUserId: string;
  /** The row's own stored values — what a singleton cluster returns unchanged. */
  confirmCount: number;
  lastConfirmedAt: number;
}

/** One stored confirmation on some member of the cluster. */
export interface ConsensusVote {
  hazardId: string;
  userId: string;
  verdict: HazardVerdict;
  /** Epoch ms the skater observed it (the clamped `observedAt`). */
  at: number;
}

/** What the gates read for one member, given everything its cluster knows. */
export interface HazardConsensus {
  /**
   * Distinct witnesses to this hazard, excluding its own author — the number the alert escalation and
   * the provisional/confirmed distinction are evaluated against, in place of the row's `confirmCount`.
   */
  confirmCount: number;
  /** The newest observation anywhere in the cluster — the freshness clock, in place of the row's. */
  lastConfirmedAt: number;
  /**
   * Every member of the cluster, in canonical order (earliest sighting first). A single id means
   * nothing was pooled and nothing changed.
   *
   * Carried rather than reduced to a count because three separate things need the membership itself:
   * the union footprint the map draws, the "every reporter" list in the drawer, and the corroboration
   * ledger, which credits each person who independently drew the thing.
   */
  memberIds: readonly string[];
}

/**
 * Consensus for every member of one cluster, keyed by hazard id.
 *
 * `votes` may hold every vote on every member; each user contributes only their **latest** vote per
 * hazard, mirroring `deriveHazardLifecycle` exactly — the same "one skater, one current opinion" rule,
 * applied across the cluster instead of down one row. Reimplementing that rule differently here is the
 * drift D77 exists to prevent, so the tie-break (`>=`, latest wins) is deliberately identical.
 */
export function clusterConsensus(
  members: readonly ConsensusMember[],
  votes: readonly ConsensusVote[],
): Map<string, HazardConsensus> {
  const result = new Map<string, HazardConsensus>();

  // The cheap path, and the one almost every hazard takes: alone in its cluster, a hazard's consensus
  // *is* its row. Short-circuited rather than derived so a lake of singletons costs nothing and can't
  // drift from the stored numbers by a rounding of the rules.
  if (members.length <= 1) {
    for (const member of members) {
      result.set(member.id, {
        confirmCount: member.confirmCount,
        lastConfirmedAt: member.lastConfirmedAt,
        memberIds: [member.id],
      });
    }
    return result;
  }

  // Each user's latest vote per hazard, so two visits by one skater to one pin stay one opinion.
  const latest = new Map<string, ConsensusVote>();
  for (const vote of votes) {
    // The separator is written as an escape, not as the byte itself: a literal NUL in the source
    // makes git treat the whole file as binary, and a file that shows no diff is a file nobody
    // reviews. Convex ids cannot contain it, so it stays an unambiguous separator.
    const key = `${vote.hazardId}\u0000${vote.userId}`;
    const prior = latest.get(key);
    if (!prior || vote.at >= prior.at) latest.set(key, vote);
  }

  /** Users who said "still there" somewhere in the cluster. */
  const confirmers = new Set<string>();
  /** Users who drew a member. */
  const authors = new Set(members.map((m) => m.createdByUserId));

  // The clock is the newest observation anywhere in the cluster, and it starts from the newest stored
  // `lastConfirmedAt` — which already folds in each member's own creation time and its author's own
  // votes, so a duplicate drawn today refreshes the whole cluster without any special case.
  let lastConfirmedAt = Number.NEGATIVE_INFINITY;
  for (const member of members) {
    lastConfirmedAt = Math.max(lastConfirmedAt, member.lastConfirmedAt);
  }
  for (const vote of latest.values()) {
    lastConfirmedAt = Math.max(lastConfirmedAt, vote.at);
    if (vote.verdict === 'still_there') confirmers.add(vote.userId);
  }

  // A "gone" verdict is NOT collected here, deliberately. See the module docstring: pooling clearance
  // would let two people retire a pin nobody examined, and that is the one direction this never errs.
  const witnesses = new Set([...confirmers, ...authors]);
  const memberIds = members.map((m) => m.id);
  for (const member of members) {
    // Excluding *this* pin's author rather than every member's: a person who drew one duplicate and a
    // person who drew another are two independent sightings of the same ridge, which is exactly the
    // corroboration duplicates were losing.
    const count = witnesses.has(member.createdByUserId) ? witnesses.size - 1 : witnesses.size;
    result.set(member.id, { confirmCount: count, lastConfirmedAt, memberIds });
  }
  return result;
}
