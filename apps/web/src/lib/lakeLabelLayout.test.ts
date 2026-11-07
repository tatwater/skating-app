import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  LABEL_DOT_RADIUS,
  LABEL_GAP,
  type LabelCandidate,
  LEADER_RUN,
  LOCKUP_BOTTOM,
  LOCKUP_INSET,
  LOCKUP_TOP_NAME_ONLY,
  LOCKUP_TOP_WITH_SLUG,
  labelPriority,
  labelSlug,
  layoutLakeLabels,
  MAP_EDGE_MARGIN,
  MAX_LAKE_LABELS,
  openBountiesLabel,
  placeLabel,
  type Rect,
  rectsOverlap,
} from './lakeLabelLayout';

const MAP = { width: 1000, height: 844 };

const anchorArb = fc.record({
  x: fc.double({ min: 0, max: MAP.width, noNaN: true }),
  y: fc.double({ min: 0, max: MAP.height, noNaN: true }),
});
const sizeArb = fc.record({
  width: fc.double({ min: 20, max: 260, noNaN: true }),
  hasSlug: fc.boolean(),
});

const candidateArb = (i: number): fc.Arbitrary<LabelCandidate> =>
  fc.record({
    id: fc.constant(`b${i}`),
    anchor: anchorArb,
    width: fc.double({ min: 20, max: 200, noNaN: true }),
    hasSlug: fc.boolean(),
    priority: fc.integer({ min: 0, max: 5 }),
  });

const candidatesArb = fc
  .integer({ min: 0, max: 40 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => candidateArb(i))));

const obstacleArb: fc.Arbitrary<Rect> = anchorArb.map(({ x, y }) => ({
  left: x - 16,
  top: y - 16,
  right: x + 16,
  bottom: y + 16,
}));

describe('placeLabel — the mock’s geometry', () => {
  it('matches mapLabel: the lockup 18 px right of the anchor, its top at −53 with a slug', () => {
    const p = placeLabel({ x: 100, y: 200 }, { width: 120, hasSlug: true }, MAP.width);
    expect(p.mirrored).toBe(false);
    expect(p.lockup).toEqual({ left: 118, top: 147, right: 238, bottom: 184 });
    expect(p.leaderEnd).toEqual({ x: 116, y: 184 });
  });

  it('sits a name alone at −34', () => {
    expect(placeLabel({ x: 0, y: 100 }, { width: 50, hasSlug: false }, MAP.width).lockup.top).toBe(
      100 + LOCKUP_TOP_NAME_ONLY,
    );
  });

  it('mirrors near the right edge (the mock’s right − 12 px rule)', () => {
    const p = placeLabel({ x: 900, y: 200 }, { width: 120, hasSlug: false }, MAP.width);
    expect(p.mirrored).toBe(true);
    expect(p.lockup.right).toBe(900 - LOCKUP_INSET);
    expect(p.leaderEnd).toEqual({ x: 900 - LEADER_RUN, y: 200 - LEADER_RUN });
  });

  it('keeps a fixed 45° leader of 16 px each way, whichever side it falls', () => {
    fc.assert(
      fc.property(anchorArb, sizeArb, (anchor, size) => {
        const p = placeLabel(anchor, size, MAP.width);
        expect(Math.abs(p.leaderEnd.x - anchor.x)).toBeCloseTo(LEADER_RUN);
        expect(anchor.y - p.leaderEnd.y).toBeCloseTo(LEADER_RUN);
        expect(Math.sign(p.leaderEnd.x - anchor.x)).toBe(p.mirrored ? -1 : 1);
      }),
    );
  });

  it('mirrors exactly: the flipped lockup is the unflipped one reflected about the anchor', () => {
    fc.assert(
      fc.property(anchorArb, sizeArb, (anchor, size) => {
        const p = placeLabel(anchor, size, MAP.width);
        const unflipped = placeLabel(anchor, size, Number.POSITIVE_INFINITY);
        expect(unflipped.mirrored).toBe(false);
        if (p.mirrored) {
          expect(p.lockup.left + unflipped.lockup.right).toBeCloseTo(2 * anchor.x);
          expect(p.lockup.right + unflipped.lockup.left).toBeCloseTo(2 * anchor.x);
        } else {
          expect(p.lockup).toEqual(unflipped.lockup);
        }
      }),
    );
  });

  it('stays inside the right margin whenever either side fits, and only flips when it must', () => {
    fc.assert(
      fc.property(anchorArb, sizeArb, (anchor, size) => {
        const p = placeLabel(anchor, size, MAP.width);
        const fitsRight = anchor.x + LOCKUP_INSET + size.width <= MAP.width - MAP_EDGE_MARGIN;
        const fitsLeft = anchor.x - LOCKUP_INSET - size.width >= MAP_EDGE_MARGIN;
        if (fitsRight) expect(p.mirrored).toBe(false);
        if (!fitsRight && fitsLeft) {
          expect(p.mirrored).toBe(true);
          expect(p.lockup.left).toBeGreaterThanOrEqual(MAP_EDGE_MARGIN - 1e-9);
        }
      }),
    );
  });

  it('rests the lockup’s foot on the leader’s end, its height fixed by the slug', () => {
    fc.assert(
      fc.property(anchorArb, sizeArb, (anchor, size) => {
        const p = placeLabel(anchor, size, MAP.width);
        expect(p.lockup.bottom).toBeCloseTo(anchor.y + LOCKUP_BOTTOM);
        expect(p.lockup.bottom - p.lockup.top).toBeCloseTo(
          (size.hasSlug ? -LOCKUP_TOP_WITH_SLUG : -LOCKUP_TOP_NAME_ONLY) + LOCKUP_BOTTOM,
        );
      }),
    );
  });

  it('covers the dot, leader and lockup in its collision box', () => {
    fc.assert(
      fc.property(anchorArb, sizeArb, (anchor, size) => {
        const { box, lockup, leaderEnd } = placeLabel(anchor, size, MAP.width);
        expect(box.left).toBeLessThanOrEqual(
          Math.min(lockup.left, anchor.x - LABEL_DOT_RADIUS, leaderEnd.x),
        );
        expect(box.right).toBeGreaterThanOrEqual(
          Math.max(lockup.right, anchor.x + LABEL_DOT_RADIUS, leaderEnd.x),
        );
        expect(box.top).toBe(lockup.top);
        expect(box.bottom).toBe(anchor.y + LABEL_DOT_RADIUS);
      }),
    );
  });
});

describe('layoutLakeLabels', () => {
  it('never overlaps two labels', () => {
    fc.assert(
      fc.property(candidatesArb, (candidates) => {
        const placed = [...layoutLakeLabels(candidates, MAP).values()];
        placed.forEach((a, i) => {
          for (const b of placed.slice(i + 1)) {
            expect(rectsOverlap(a.box, b.box, LABEL_GAP)).toBe(false);
          }
        });
      }),
    );
  });

  it('never covers a hazard mark (D3): the label gives way', () => {
    fc.assert(
      fc.property(
        candidatesArb,
        fc.array(obstacleArb, { maxLength: 8 }),
        (candidates, obstacles) => {
          for (const p of layoutLakeLabels(candidates, MAP, { obstacles }).values()) {
            for (const o of obstacles) expect(rectsOverlap(p.box, o, LABEL_GAP)).toBe(false);
          }
        },
      ),
    );
  });

  it('drops a label only for a reason: off the map, clipped at the top, or blocked by a higher one', () => {
    fc.assert(
      fc.property(
        candidatesArb,
        fc.array(obstacleArb, { maxLength: 4 }),
        (candidates, obstacles) => {
          const placed = layoutLakeLabels(candidates, MAP, { obstacles, maxLabels: 1000 });
          for (const c of candidates) {
            if (placed.has(c.id)) continue;
            const p = placeLabel(c.anchor, c, MAP.width);
            const offMap =
              c.anchor.x < 0 || c.anchor.x > MAP.width || c.anchor.y < 0 || c.anchor.y > MAP.height;
            const clipped = p.lockup.top < 0;
            const blocked =
              obstacles.some((o) => rectsOverlap(p.box, o, LABEL_GAP)) ||
              [...placed.entries()].some(([otherId, other]) => {
                const o = candidates.find((x) => x.id === otherId) as LabelCandidate;
                const ahead = o.priority > c.priority || (o.priority === c.priority && o.id < c.id);
                return ahead && rectsOverlap(p.box, other.box, LABEL_GAP);
              });
            expect(offMap || clipped || blocked).toBe(true);
          }
        },
      ),
    );
  });

  it('lays the same set out the same way whatever order it arrives in', () => {
    fc.assert(
      fc.property(candidatesArb, (candidates) => {
        const a = layoutLakeLabels(candidates, MAP);
        const b = layoutLakeLabels([...candidates].reverse(), MAP);
        expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
      }),
    );
  });

  it('caps the count', () => {
    fc.assert(
      fc.property(candidatesArb, fc.integer({ min: 0, max: 10 }), (candidates, max) => {
        expect(layoutLakeLabels(candidates, MAP, { maxLabels: max }).size).toBeLessThanOrEqual(max);
      }),
    );
    expect(MAX_LAKE_LABELS).toBe(24);
  });

  it('gives a contested spot to the higher priority', () => {
    const at = { x: 300, y: 300 };
    const placed = layoutLakeLabels(
      [
        { id: 'low', anchor: at, width: 80, hasSlug: true, priority: 1 },
        { id: 'high', anchor: { x: 302, y: 302 }, width: 80, hasSlug: true, priority: 9 },
      ],
      MAP,
    );
    expect([...placed.keys()]).toEqual(['high']);
  });

  it('skips an anchor off the map and a lockup the top would clip', () => {
    const placed = layoutLakeLabels(
      [
        { id: 'off', anchor: { x: -5, y: 300 }, width: 50, hasSlug: false, priority: 1 },
        { id: 'top', anchor: { x: 300, y: 20 }, width: 50, hasSlug: true, priority: 1 },
        { id: 'ok', anchor: { x: 300, y: 400 }, width: 50, hasSlug: true, priority: 1 },
      ],
      MAP,
    );
    expect([...placed.keys()]).toEqual(['ok']);
  });
});

describe('labelPriority', () => {
  const base = { favorite: false, openBounties: 0, recentReports: 0, inactive: false };

  it('ranks favorites, then bounties, then news, then size — and inactive last', () => {
    const huge = labelPriority({ ...base, surfaceAreaSqM: 1e9 });
    const news = labelPriority({ ...base, recentReports: 1 });
    const bounty = labelPriority({ ...base, openBounties: 1 });
    const favorite = labelPriority({ ...base, favorite: true });
    const inactive = labelPriority({
      ...base,
      favorite: true,
      inactive: true,
      surfaceAreaSqM: 1e9,
    });
    expect(favorite).toBeGreaterThan(bounty);
    expect(bounty).toBeGreaterThan(news);
    expect(news).toBeGreaterThan(huge);
    expect(inactive).toBeLessThan(labelPriority(base));
  });

  it('lets size break a tie, never cross a tier', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1e10, noNaN: true }), (area) => {
        expect(labelPriority({ ...base, surfaceAreaSqM: area })).toBeLessThan(
          labelPriority({ ...base, recentReports: 1 }),
        );
      }),
    );
  });
});

describe('labelSlug', () => {
  const tz = 'America/New_York';
  // Saturday 16 January 2027, 11:52 AM in Enfield — the mocks' "today".
  const now = Date.UTC(2027, 0, 16, 16, 52);
  const recent = (count: number, newest?: number, capped = false) => ({
    count,
    capped,
    ...(newest !== undefined ? { newestSkateEndTime: newest } : {}),
  });

  it('says how many and when, never what the ice is (D3)', () => {
    expect(labelSlug({ inactive: false, recent: recent(3, now - 3600e3), now, timeZone: tz })).toBe(
      '3 reports · today',
    );
    // Tuesday 12 January.
    expect(
      labelSlug({
        inactive: false,
        recent: recent(1, Date.UTC(2027, 0, 12, 18)),
        now,
        timeZone: tz,
      }),
    ).toBe('1 report · Tuesday');
  });

  it('says "5+" when the read was capped, so a busy lake isn’t undercounted', () => {
    expect(labelSlug({ inactive: false, recent: recent(5, now, true), now, timeZone: tz })).toBe(
      '5+ reports · today',
    );
    // At the cap but not over it: exactly five.
    expect(labelSlug({ inactive: false, recent: recent(5, now), now, timeZone: tz })).toBe(
      '5 reports · today',
    );
  });

  it('says nothing while the counts load, and "No recent reports" (not "yet") when there are none', () => {
    expect(labelSlug({ inactive: false, recent: undefined, now })).toBeNull();
    expect(labelSlug({ inactive: false, recent: recent(0), now })).toBe('No recent reports');
  });

  it('marks an inactive body, whatever its reports', () => {
    expect(labelSlug({ inactive: true, recent: recent(2, now), now })).toBe('Inactive');
  });
});

describe('openBountiesLabel', () => {
  it('counts bounties, never points (Review 2, Review 4)', () => {
    expect(openBountiesLabel(1)).toBe('1 open bounty');
    expect(openBountiesLabel(3)).toBe('3 open bounties');
  });
});
