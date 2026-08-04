import type { Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import { polygonBBox } from './geometry';
import {
  decideMatch,
  findCollapsedDuplicates,
  isNearMiss,
  RECONCILE_MIN_IOU,
  type ReconcileCandidate,
  reconcileOne,
  type ScoredCandidate,
  scoreCandidates,
} from './reconcile';

/** An axis-aligned box in degrees — enough to control IoU precisely without hand-drawn shorelines. */
function box(west: number, south: number, east: number, north: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ],
  };
}

const target = (poly: Polygon, gnisId?: string) => ({
  polygon: poly,
  bbox: polygonBBox(poly),
  gnisId,
});
const candidate = (
  id: string,
  poly: Polygon,
  gnisId?: string,
  name?: string,
): ReconcileCandidate => ({
  id,
  polygon: poly,
  bbox: polygonBBox(poly),
  gnisId,
  name,
});

const score = (id: string, iou: number, gnisAgrees = false): ScoredCandidate => ({
  id,
  iou,
  gnisAgrees,
});

describe('the failure this exists to prevent: a bay inheriting its parent', () => {
  // D93, measured: North Bay's interior point sits inside NHD's Moosehead Lake, so a containment
  // join gives the bay its parent's identity — and afterwards the two look like duplicates of each
  // other. IoU refuses it because a bay shares little of the union.
  const moosehead = box(-69.9, 45.5, -69.5, 45.9);
  const northBay = box(-69.88, 45.85, -69.84, 45.89); // a small lobe fully inside

  it('refuses a small bay against the lake that contains it', () => {
    // Fully contained — a containment test would have said yes with total confidence.
    const outcome = reconcileOne(target(northBay), [candidate('moosehead', moosehead)]);
    expect(outcome.verdict).toBe('none');
    // And it is refused by the AREA BOUND, before any intersection is computed: the bay is ~1% of
    // its parent, so IoU <= 0.01 is proven rather than measured. `best` is therefore absent, which
    // is why the near-miss ledger only claims completeness at or above the threshold floor.
    if (outcome.verdict === 'none') expect(outcome.best).toBeUndefined();
  });

  it('still computes a real score for a bay large enough to be a plausible rival', () => {
    // The bound only removes pairs it can PROVE are under the floor. A lobe that is half its
    // parent's area survives to be scored and then rejected on its actual overlap.
    const halfish = box(-69.9, 45.5, -69.72, 45.9);
    const outcome = reconcileOne(target(halfish), [candidate('moosehead', moosehead)]);
    expect(outcome.verdict).toBe('none');
    if (outcome.verdict === 'none') expect(outcome.best?.iou).toBeGreaterThan(0);
  });

  it('still matches the lake itself, despite its interior point sitting on its own shoreline', () => {
    // The other half of the same measurement: Moosehead matched NOTHING under a point-based join.
    const outcome = reconcileOne(target(moosehead), [
      candidate('moosehead', box(-69.9, 45.5, -69.51, 45.9)),
    ]);
    expect(outcome.verdict).toBe('matched');
  });

  it('refuses a bay even when both sides assert the same GNIS id', () => {
    // The GNIS-lowered bar is 0.3, not zero. A bay carrying its parent's GNIS id is exactly the case
    // where the strongest non-geometric evidence points the wrong way.
    const outcome = reconcileOne(target(northBay, '571641'), [
      candidate('moosehead', moosehead, '571641'),
    ]);
    expect(outcome.verdict).toBe('none');
  });
});

describe('the ordinary match', () => {
  it('matches two catalogues tracing the same shoreline', () => {
    // Measured median OSM-vs-NHD area disagreement is 2.4%; real pairs land at 0.85-0.98.
    const outcome = reconcileOne(target(box(-72, 44, -71.9, 44.1)), [
      candidate('nhd-1', box(-72.001, 43.999, -71.899, 44.101)),
    ]);
    expect(outcome.verdict).toBe('matched');
    if (outcome.verdict === 'matched') expect(outcome.iou).toBeGreaterThan(0.9);
  });

  it('reports no match rather than reaching, when nothing overlaps', () => {
    // Ordinary and successful: NHD holds water OSM does not, and the reverse.
    const outcome = reconcileOne(target(box(-72, 44, -71.9, 44.1)), [
      candidate('far-away', box(-70, 42, -69.9, 42.1)),
    ]);
    expect(outcome.verdict).toBe('none');
  });

  it('skips the expensive IoU when bounding boxes are disjoint', () => {
    // The bbox filter is the only cheap step; scoring 40,000 candidates per body depends on it.
    expect(scoreCandidates(target(box(0, 0, 1, 1)), [candidate('x', box(10, 10, 11, 11))])).toEqual(
      [],
    );
  });
});

describe('GNIS proposes, geometry decides', () => {
  it('lowers the bar when both catalogues name the same place', () => {
    // Two equal boxes offset by 40% of their width: IoU ~0.43 — below the 0.5 default, above the
    // 0.3 GNIS bar. (Computed, not eyeballed: intersection 0.06x0.1 over union 0.014.)
    const t = box(-72, 44, -71.9, 44.1);
    const c = box(-71.96, 44, -71.86, 44.1);
    expect(reconcileOne(target(t), [candidate('c', c)]).verdict).toBe('none');
    expect(reconcileOne(target(t, '869848'), [candidate('c', c, '869848')]).verdict).toBe(
      'matched',
    );
  });

  it('does not lower it for a candidate whose GNIS id differs', () => {
    const t = box(-72, 44, -71.9, 44.1);
    const c = box(-71.96, 44, -71.86, 44.1);
    expect(reconcileOne(target(t, '869848'), [candidate('c', c, '999999')]).verdict).toBe('none');
  });

  it('marks agreement on the winning candidate, so the loader can record why', () => {
    const outcome = reconcileOne(target(box(-72, 44, -71.9, 44.1), '869848'), [
      candidate('c', box(-72.001, 43.999, -71.899, 44.101), '869848'),
    ]);
    if (outcome.verdict === 'matched') expect(outcome.gnisAgrees).toBe(true);
    else expect.unreachable();
  });
});

describe('ambiguity is an outcome, not a tie-break', () => {
  it('refuses when the top two are too close to separate', () => {
    // A lake in a chain — Moose Pond's five NHD rows, the Rangeley string — overlaps two candidates
    // plausibly. Picking the marginally larger number is how it acquires a neighbour's identity.
    const outcome = decideMatch([score('a', 0.62), score('b', 0.55)]);
    expect(outcome.verdict).toBe('ambiguous');
    if (outcome.verdict === 'ambiguous') expect(outcome.candidates).toHaveLength(2);
  });

  it('accepts when the winner is clear by the margin', () => {
    const outcome = decideMatch([score('a', 0.92), score('b', 0.55)]);
    expect(outcome.verdict).toBe('matched');
    if (outcome.verdict === 'matched') expect(outcome.runnerUp?.id).toBe('b');
  });

  it('ignores a close runner-up that never cleared the bar at all', () => {
    // 0.49 is not a rival, it is a reject. Only viable candidates can create ambiguity.
    expect(decideMatch([score('a', 0.6), score('b', 0.49)]).verdict).toBe('matched');
  });

  it('keeps the best miss on a `none`, so the ledger can say how close it came', () => {
    const outcome = decideMatch([score('a', 0.31), score('b', 0.2)]);
    expect(outcome.verdict).toBe('none');
    if (outcome.verdict === 'none') expect(outcome.best?.iou).toBeCloseTo(0.31);
  });

  it('has an empty candidate list produce `none`, never a crash', () => {
    expect(decideMatch([]).verdict).toBe('none');
  });
});

describe('findCollapsedDuplicates — what OSM cannot see about itself', () => {
  it('surfaces two of our bodies landing on one catalogue id', () => {
    // Long Pond is way/150404999 at 2,552 acres AND relation/2602300 at 2,532. OSM cannot see that;
    // NHD can, because both collapse onto one Permanent_Identifier. Five known pairs do this.
    const dupes = findCollapsedDuplicates([
      { key: 'way/150404999', id: 'nhd-longpond' },
      { key: 'relation/2602300', id: 'nhd-longpond' },
      { key: 'way/999', id: 'nhd-other' },
    ]);
    expect(dupes).toEqual([{ id: 'nhd-longpond', keys: ['way/150404999', 'relation/2602300'] }]);
  });

  it('reports nothing when every body has its own counterpart', () => {
    expect(
      findCollapsedDuplicates([
        { key: 'a', id: '1' },
        { key: 'b', id: '2' },
      ]),
    ).toEqual([]);
  });
});

describe('the thresholds are the design', () => {
  it('requires more shared area than not', () => {
    expect(RECONCILE_MIN_IOU).toBe(0.5);
  });
});

describe('the area bound — an exact skip, not a heuristic', () => {
  it('skips a pair whose sizes alone put IoU under every threshold', () => {
    // IoU <= min(|A|,|B|) / max(|A|,|B|). A body 100x smaller than its candidate cannot reach 0.3,
    // so no intersection needs computing — and this is exactly the bay-against-parent case, which is
    // both the most expensive comparison and the one guaranteed to be rejected.
    const tiny = box(-69.88, 45.85, -69.87, 45.86);
    const huge = box(-69.9, 45.5, -69.5, 45.9);
    expect(scoreCandidates(target(tiny), [candidate('huge', huge)])).toEqual([]);
  });

  it('does NOT skip a pair the bound leaves viable, even at very different scales', () => {
    // Same-size polygons always survive the bound; the real IoU then decides.
    const a = box(-72, 44, -71.9, 44.1);
    const scored = scoreCandidates(target(a), [
      candidate('b', box(-72.001, 43.999, -71.899, 44.101)),
    ]);
    expect(scored).toHaveLength(1);
    expect(scored[0]?.iou).toBeGreaterThan(0.9);
  });

  it('honours a lowered threshold, so a custom bar cannot be silently skipped past', () => {
    // The bound must key off the LOWEST bar in play, or re-tuning downward would stop finding pairs
    // that the new threshold accepts — a silent behaviour change from a performance optimisation.
    const t = box(-72, 44, -71.9, 44.1);
    const c = box(-72, 44, -71.8, 44.2); // 4x the area: ceiling 0.25
    expect(scoreCandidates(target(t), [candidate('c', c)])).toEqual([]);
    expect(scoreCandidates(target(t), [candidate('c', c)], { minIouWithGnis: 0.1 })).toHaveLength(
      1,
    );
  });
});

describe('isNearMiss', () => {
  const cand = (iou: number) => ({ id: 'x', iou, gnisAgrees: false });

  // 815 of the 9,022 unmatched bodies had a real candidate; 196 were within 0.05 of the bar. Today
  // they are indistinguishable from "no catalogue has heard of this lake", which is a different fact.
  it('separates a rejected candidate from nothing at all', () => {
    expect(isNearMiss({ verdict: 'none', best: cand(0.47) })).toBe(true);
    expect(isNearMiss({ verdict: 'none', best: cand(0.12) })).toBe(false);
    expect(isNearMiss({ verdict: 'none' })).toBe(false);
  });

  it('is a reading of `none`, never of a match — nothing may be written on it', () => {
    expect(isNearMiss({ verdict: 'matched', id: 'x', iou: 0.9, gnisAgrees: false })).toBe(false);
    expect(isNearMiss({ verdict: 'ambiguous', candidates: [cand(0.6), cand(0.55)] })).toBe(false);
  });
});
