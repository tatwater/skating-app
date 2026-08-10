/**
 * **D95's re-key lane** — split a junk source key by corpus body membership, not by its own id.
 *
 * ## What is broken, and why the ordinary splitter cannot fix it
 *
 * Maine files **MIDAS 870** as North Pond, 59 acres. It holds **17,922 soundings spanning
 * 151 × 348 km** — essentially the whole state — of which 0.51% are inside North Pond. Every row is
 * `FMSRC=depthmap`, `FMSRCORG=meifw`: the digitised IF&W paper maps, where everything the
 * digitisation could not key was dumped. It is not a lake; it is a bucket.
 *
 * `splitByBody` already exists to break a key that holds several ponds, and on this one it fails in a
 * way worth stating precisely, because the failure is a property of its *design* rather than a bug:
 * it derives its gap threshold from the cloud's own extent (`disjointGapFor`), which is scale-free
 * and correct when the cloud is one region. MIDAS 870's 348 km span yields a **27.8 km** gap
 * threshold — wider than the spacing between real Maine lakes — so the entire state collapses into
 * two clusters. Both were rejected by the containment gate at 0% and 8%, and the run's own reject
 * list shows them: `me-dep-soundings:870#1`, `me-dep-soundings:870#2`.
 *
 * A bootstrapped threshold cannot work here. The corpus can: **soundings in different bodies are in
 * different bodies, full stop** (D95 rule 2). So this splits on membership and falls back to
 * `splitByBody` only for the leftovers that matched nothing.
 *
 * Measured: 96.3% of the 17,922 land in a body, across **263 distinct bodies**, of which **217 clear
 * `MIN_SOUNDINGS` and the density gate — and all 217 are net new**, taking the layer from 2,022 to
 * ~2,239 (+11%) out of one broken key.
 *
 * ## Rule 0 — this lane never touches a key that already works
 *
 * Founder, 2026-08-03: *"We should only do this if the soundings source points at a lake and then
 * doesn't match up with the lake's polygon. If there is a direct match (name/id/coords) then we
 * don't need to get creative about re-keying any of the soundings within."*
 *
 * **Eligibility is the containment gate and nothing else.** `isRekeyEligible` reads the join's own
 * rejection reason; a key that matched, or that failed for any other reason, is not re-examined, not
 * re-clustered and not split. This is a hard boundary rather than a heuristic — it is the difference
 * between recovering 17,922 orphaned soundings and quietly re-deciding where 2.4 million
 * measurements belong. `rekey.test.ts` asserts it with **China Lake (MIDAS 5448)**, a real
 * 3,939-acre lake with 25,807 legitimate soundings, because a future refactor that generalises this
 * is exactly the change that would break it silently.
 *
 * ## What it does NOT do
 *
 * It does not gate, and it does not decide that a group is a lake. It regroups, and the ordinary
 * join runs over the result with its containment gate intact — so every recovered body is admitted
 * by the same rule as every other one. And per D95's cost note, the attribution is **ours, not the
 * surveying agency's**: these lanes already render as `interpolated`, and the credit line must say
 * that the lake assignment is ours.
 */

import type { ArchivedLake } from './lakes';
import { contourVertices } from './lakes';

/**
 * The one rejection reason that opens this lane.
 *
 * `join.ts` emits it as `no body here holds the survey: best is "…" with N% of M sampled
 * measurements`, so the test is a prefix. Every other reason — `no listed body within 25 m of this
 * point`, a query failure — means something *other* than "the key points somewhere the survey isn't",
 * and Rule 0 keeps those out.
 *
 * ⚠ **A reject with no body at all is deliberately NOT eligible.** "No listed body within 25 m"
 * means the survey is somewhere we have no corpus coverage; re-keying it point-by-point would return
 * nothing and cost a scan of every sounding to learn it. That is D92's problem, not this lane's.
 */
export const CONTAINMENT_REJECT_PREFIX = 'no body here holds the survey';

export function isRekeyEligible(reason: string): boolean {
  return reason.startsWith(CONTAINMENT_REJECT_PREFIX);
}

/** What the corpus said about one point. `null` = it is inside no body we carry. */
export type PointAssignment = { externalId?: string; name: string } | null;

/** One re-keyed group, plus the bookkeeping that keeps the lane honest. */
export interface RekeyResult {
  /**
   * One synthetic lake per corpus body the survey touched, largest group first.
   *
   * Keyed `<lakeKey>@<externalId>` — an `@` rather than `splitByBody`'s `#`, so a key that has been
   * re-keyed against the corpus is distinguishable at a glance from one merely split by distance,
   * and so the two can never collide. The suffix is the body's `externalId` rather than an ordinal
   * because it is **stable**: a re-run that gains or loses a sounding renames nothing, where `#1`,
   * `#2` renumber whenever the sizes reorder.
   */
  parts: ArchivedLake[];
  /** Measurements that fell inside no body at all — reported, never silently dropped. */
  unmatched: number;
  /** Bodies the survey touched, whatever it took to gate them. The honest denominator. */
  bodiesTouched: number;
}

/**
 * Split one lake's measurements by which corpus body contains each of them.
 *
 * `assignments` is parallel to `shapePoints(lake)` — the caller resolves each point against the
 * corpus index and hands them back in order. Keeping the resolution outside makes this a pure
 * function over two arrays, which is what lets the fixtures below be named lakes rather than a
 * mocked deployment or a loaded corpus.
 *
 * **A contour is assigned by its first vertex, matching `splitByBody`.** A contour line that
 * straddles two bodies cannot exist — that is what "separate bodies" means — and a per-vertex split
 * would shred one isobath into fragments belonging to neither.
 */
export function rekeyByBody(
  lake: ArchivedLake,
  assignments: readonly PointAssignment[],
): RekeyResult {
  const buckets = new Map<
    string,
    {
      soundings: NonNullable<ArchivedLake['soundings']>;
      contours: NonNullable<ArchivedLake['contours']>;
    }
  >();
  let unmatched = 0;
  const bucket = (externalId: string) => {
    let b = buckets.get(externalId);
    if (!b) {
      b = { soundings: [], contours: [] };
      buckets.set(externalId, b);
    }
    return b;
  };

  if (lake.soundings) {
    lake.soundings.forEach((sounding, i) => {
      const id = assignments[i]?.externalId;
      if (id === undefined) {
        unmatched++;
        return;
      }
      bucket(id).soundings.push(sounding);
    });
  } else {
    let cursor = 0;
    for (const contour of lake.contours ?? []) {
      const id = assignments[cursor]?.externalId;
      cursor += contourVertices(contour).length;
      if (id === undefined) {
        unmatched++;
        continue;
      }
      bucket(id).contours.push(contour);
    }
  }

  const parts = [...buckets.entries()]
    .map(([externalId, records]) => ({
      externalId,
      count: records.soundings.length + records.contours.length,
      records,
    }))
    .filter((p) => p.count > 0)
    // Largest first, like `splitByBody`, so the principal body of a bucket key reads first in a log.
    .sort((a, b) => b.count - a.count || (a.externalId < b.externalId ? -1 : 1))
    .map(({ externalId, records }) => ({
      ...lake,
      lakeKey: `${lake.lakeKey}@${externalId}`,
      ...(lake.soundings
        ? { soundings: records.soundings, contours: undefined }
        : { contours: records.contours, soundings: undefined }),
    }));

  return { parts, unmatched, bodiesTouched: buckets.size };
}
