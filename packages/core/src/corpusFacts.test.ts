import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { CLAIM_SOURCES, type ClaimSource } from './confidence';
import { splitOfNames } from './corpusFacets';
import {
  type ClassConsequence,
  CONSEQUENCE_LEAD,
  classConsequence,
  classConsequenceLine,
  NAME_SPLIT_WORDS,
  nameRankWords,
  nameSplit,
  neighborOffset,
  ringInsidePoint,
} from './corpusFacts';
import { CORPUS_TASK_FACETS } from './corpusTasks';
import { haversineMeters, pointInPolygon } from './geometry';
import { NAME_SOURCE_RANK } from './nameClaims';
import { WATER_BODY_CLASSES, type WaterBodyClass } from './types';
import { SQM_PER_ACRE } from './units';

const ac = (acres: number) => acres * SQM_PER_ACRE;

/**
 * D3: no word here may say or imply that ice is safe, unsafe, skateable or predictable — or speak of
 * the ice at all. A consequence is what the app does with a body.
 */
const BANNED =
  /\bice\b|\bsafe|unsafe|skat(e)?able|good to go|all clear|predict|forecast|thick|thin\b|solid|frozen|freez|danger|hazard|risk|caution|warn/i;

describe('classConsequence: what each class would do (board 4.3)', () => {
  it('stays under a class the size rules admit, named for the class', () => {
    const body = { name: 'Lake Auburn', surfaceAreaSqM: ac(2263) };
    expect(classConsequence(body, 'lakePond')).toEqual({
      kind: 'stays',
      words: 'Stays, as a lake or pond',
      lead: 'Stays',
    });
    expect(classConsequence(body, 'reservoir')).toEqual({
      kind: 'stays',
      words: 'Stays, as a reservoir',
      lead: 'Stays',
    });
    expect(classConsequence(body, 'river').words).toBe('Stays, as a slow river reach');
    expect(classConsequence(body, 'wetland').words).toBe('Stays, as a wetland');
    expect(classConsequence(body, 'unclassified').words).toBe('Stays, as water no catalog classed');
  });

  it('is refused as unnamed wetland under 50 ac, the board 4.3 rung', () => {
    const body = { name: '', surfaceAreaSqM: ac(7) };
    expect(classConsequence(body, 'wetland')).toEqual({
      kind: 'leaves',
      words: 'Refused by the size rules next campaign, as unnamed wetland under 50 ac',
      lead: 'Refused by the size rules',
    });
    // The same body as a lake or pond stays: only the wetland bar reads the class.
    expect(classConsequence(body, 'lakePond').kind).toBe('stays');
    // At 50 acres the unnamed wetland is in.
    expect(classConsequence({ name: '', surfaceAreaSqM: ac(50) }, 'wetland').kind).toBe('stays');
  });

  it('says which size rule refuses it, between one and five acres and under one', () => {
    expect(classConsequence({ name: 'Mud Pond', surfaceAreaSqM: ac(3) }, 'wetland').words).toBe(
      'Refused by the size rules next campaign, as wetland under 5 ac',
    );
    expect(classConsequence({ name: '', surfaceAreaSqM: ac(3) }, 'wetland').words).toBe(
      'Refused by the size rules next campaign, as unnamed wetland under 5 ac',
    );
    expect(classConsequence({ name: '', surfaceAreaSqM: ac(3) }, 'lakePond').words).toBe(
      'Refused by the size rules next campaign, as unnamed water under 5 ac',
    );
    // A name carries a one-to-five-acre lake or pond in.
    expect(classConsequence({ name: 'Mud Pond', surfaceAreaSqM: ac(3) }, 'lakePond').kind).toBe(
      'stays',
    );
    for (const cls of WATER_BODY_CLASSES) {
      expect(classConsequence({ name: 'Mud Pond', surfaceAreaSqM: ac(0.5) }, cls).words).toBe(
        'Refused by the size rules next campaign, as water under 1 ac',
      );
    }
  });

  it('keeps a body someone asked for, and says so', () => {
    const asked = { name: '', surfaceAreaSqM: ac(7), includedByRequest: true };
    expect(classConsequence(asked, 'wetland')).toEqual({
      kind: 'stays',
      words: 'Stays, as a wetland: someone asked for it',
      lead: 'Stays',
    });
    // A request the rules don't need is not mentioned.
    expect(classConsequence({ ...asked, surfaceAreaSqM: ac(70) }, 'wetland').words).toBe(
      'Stays, as a wetland',
    );
  });

  it('waits for a parent as a bay the rules admit, and is refused as one they do not', () => {
    expect(classConsequence({ name: 'Half Moon Cove', surfaceAreaSqM: ac(330) }, 'bay')).toEqual({
      kind: 'waitsForParent',
      words: 'Waits for a parent: a bay needs a lake to hold it',
      lead: 'Waits for a parent',
    });
    expect(classConsequence({ name: '', surfaceAreaSqM: ac(3) }, 'bay').kind).toBe('leaves');
    expect(
      classConsequence({ name: '', surfaceAreaSqM: ac(3), includedByRequest: true }, 'bay').words,
    ).toBe('Waits for a parent: a bay needs a lake to hold it: someone asked for it');
  });

  it('stays, saying why, when no area is on file (the prune keeps it)', () => {
    expect(classConsequence({ name: '', surfaceAreaSqM: null }, 'wetland')).toEqual({
      kind: 'stays',
      words: 'Stays, as a wetland: no area is on file for the size rules',
      lead: 'Stays',
    });
    expect(classConsequence({ name: '', surfaceAreaSqM: Number.NaN }, 'bay').kind).toBe('stays');
  });

  it('agrees with belongsInCorpus on every body and class (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(''), fc.constant('Mud Pond')),
        fc.double({ min: 0, max: ac(200), noNaN: true }),
        fc.boolean(),
        fc.constantFrom(...WATER_BODY_CLASSES),
        (name, area, requested, cls) => {
          const c = classConsequence(
            { name, surfaceAreaSqM: area, includedByRequest: requested },
            cls,
          );
          if (requested) expect(c.kind).not.toBe('leaves');
          expect(c.kind === 'waitsForParent').toBe(cls === 'bay' && c.kind !== 'leaves');
          expect(c.words.length).toBeGreaterThan(0);
          expect(c.words).not.toMatch(BANNED);
          // The lead is the kind's, and the words begin with it (the inspector brightens it alone).
          expect(c.lead).toBe(CONSEQUENCE_LEAD[c.kind]);
          expect(c.words.startsWith(c.lead)).toBe(true);
          expect(c.words.length).toBeGreaterThan(c.lead.length);
        },
      ),
    );
  });
});

describe('nameSplit: the Name conflicts tabs', () => {
  it('is the rule the writer files a task under (one rule, not two)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 24 }), fc.string({ maxLength: 24 }), (a, b) => {
        expect(nameSplit(a, b)).toBe(splitOfNames(a, b));
      }),
    );
    for (const [a, b] of [
      ['The Basin', 'Lake Auburn'],
      ['Lake Sunapee', 'Little Lake Sunapee'],
      ['Tuttle Pond', 'Turtle Pond'],
    ] as const) {
      expect(nameSplit(a, b)).toBe(splitOfNames(a, b));
    }
    expect(nameSplit('The Basin', 'Lake Auburn')).toBe('different');
    expect(nameSplit('Lake Sunapee', 'Little Lake Sunapee')).toBe('qualifier');
    expect(nameSplit('Tuttle Pond', 'Turtle Pond')).toBe('oneLetter');
  });

  it('has a word for exactly each lane facet, none about the ice', () => {
    expect(Object.keys(NAME_SPLIT_WORDS).sort()).toEqual(
      [...CORPUS_TASK_FACETS.nameConflicts].sort(),
    );
    for (const word of Object.values(NAME_SPLIT_WORDS)) expect(word).not.toMatch(BANNED);
  });
});

describe('nameRankWords: a catalog rank in words', () => {
  it('says the board examples', () => {
    expect(nameRankWords('gnis')).toBe('First: the authority on US names');
    expect(nameRankWords('osm')).toBe("Last: a mapper's free text");
    expect(nameRankWords('nhd')).toBe("Second: the gazetteer's name, as NHD publishes it");
    expect(nameRankWords('3dhp')).toBe("Third: the gazetteer's name, a later release");
    expect(nameRankWords('user')).toBe("Above every catalog: a moderator's choice");
    expect(nameRankWords('name')).toBe("Not a catalog: a word read from a catalog's name");
  });

  it("orders the catalogs' ordinals by NAME_SOURCE_RANK, and says nothing of the ice", () => {
    const catalogs = CLAIM_SOURCES.filter((s) => s !== 'user' && s !== 'name').sort(
      (a, b) => NAME_SOURCE_RANK[a] - NAME_SOURCE_RANK[b],
    );
    const ordinals = catalogs.map((s) => nameRankWords(s).split(':')[0]);
    expect(ordinals).toEqual(['First', 'Second', 'Third', 'Last']);
    for (const s of CLAIM_SOURCES as readonly ClaimSource[]) {
      expect(nameRankWords(s)).not.toMatch(BANNED);
    }
  });
});

describe('classConsequenceLine: a class conflict row’s third line (board 4.3)', () => {
  it('says the board’s rows: refused if a wetland, a wait if a bay, nothing where every class stays', () => {
    // Groton's unnamed 5 ac water: a pond to OSM, a wetland to NHD.
    expect(
      classConsequenceLine({ name: '', surfaceAreaSqM: ac(5) }, 'lakePond', [
        'wetland',
        'lakePond',
      ]),
    ).toEqual({ kind: 'leaves', cls: 'wetland', words: 'Refused if a wetland' });
    // Rand Cove: a bay to OSM.
    expect(
      classConsequenceLine({ name: 'Rand Cove', surfaceAreaSqM: ac(22) }, 'lakePond', [
        'lakePond',
        'bay',
      ]),
    ).toEqual({ kind: 'waitsForParent', cls: 'bay', words: 'Waits for a parent if a bay' });
    // Bog Pond, 38 ac and named: a wetland stays, so no line.
    expect(
      classConsequenceLine({ name: 'Bog Pond', surfaceAreaSqM: ac(38) }, 'lakePond', [
        'wetland',
        'lakePond',
      ]),
    ).toBeNull();
    // A river reach stays: no line (the board's "moving water" line is not drawn).
    expect(
      classConsequenceLine({ name: 'Little Black Deadwater', surfaceAreaSqM: ac(27) }, 'wetland', [
        'wetland',
        'river',
      ]),
    ).toBeNull();
    // No claims recorded: nothing to say.
    expect(classConsequenceLine({ name: '', surfaceAreaSqM: ac(5) }, 'lakePond', [])).toBeNull();
  });

  it('never speaks of the body’s own class, and a refusal outweighs a wait', () => {
    // Already a wetland: its own class is no choice, so nothing.
    expect(
      classConsequenceLine({ name: '', surfaceAreaSqM: ac(5) }, 'wetland', ['wetland', 'lakePond']),
    ).toBeNull();
    // Unnamed and 30 ac: a bay waits, a wetland is refused; the refusal is said, in either order.
    const body = { name: '', surfaceAreaSqM: ac(30) };
    for (const claimed of [
      ['bay', 'wetland'],
      ['wetland', 'bay'],
    ] as WaterBodyClass[][]) {
      expect(classConsequenceLine(body, 'lakePond', claimed)?.cls).toBe('wetland');
    }
  });

  it('is classConsequence’s answer for the class it names, on every body (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(''), fc.constant('Mud Pond')),
        fc.option(fc.double({ min: 0, max: ac(200), noNaN: true }), { nil: null }),
        fc.boolean(),
        fc.constantFrom(...WATER_BODY_CLASSES),
        fc.array(fc.constantFrom(...WATER_BODY_CLASSES), { maxLength: 4 }),
        (name, area, requested, current, claimed) => {
          const body = { name, surfaceAreaSqM: area, includedByRequest: requested };
          const line = classConsequenceLine(body, current, claimed);
          const kinds = claimed
            .filter((c) => c !== current)
            .map((c) => classConsequence(body, c).kind);
          if (line === null) {
            expect(kinds.every((k) => k === 'stays')).toBe(true);
            return;
          }
          expect(line.cls).not.toBe(current);
          expect(claimed).toContain(line.cls);
          expect(classConsequence(body, line.cls).kind).toBe(line.kind);
          if (kinds.includes('leaves')) expect(line.kind).toBe('leaves');
          expect(line.words).not.toMatch(BANNED);
        },
      ),
    );
  });
});

describe('neighborOffset: how far a neighbor lies, and which way', () => {
  const GROTON = { lat: 44.29, lng: -72.282 };

  it('says the board’s figure: a mile and a tenth north', () => {
    const osmore = { lat: GROTON.lat + (1.1 * 1609.344) / 111_195, lng: GROTON.lng };
    const o = neighborOffset(GROTON, osmore);
    expect(o?.meters).toBeCloseTo(1.1 * 1609.344, -1);
    expect(o?.bearingDeg).toBeCloseTo(0, 6);
    // East, south and west.
    expect(
      neighborOffset(GROTON, { lat: GROTON.lat, lng: GROTON.lng + 0.01 })?.bearingDeg,
    ).toBeCloseTo(90, 6);
    expect(
      neighborOffset(GROTON, { lat: GROTON.lat - 0.01, lng: GROTON.lng })?.bearingDeg,
    ).toBeCloseTo(180, 6);
    expect(
      neighborOffset(GROTON, { lat: GROTON.lat, lng: GROTON.lng - 0.01 })?.bearingDeg,
    ).toBeCloseTo(270, 6);
  });

  it('is 0 m and bearing 0 for the same point, and null for a point not finite', () => {
    expect(neighborOffset(GROTON, GROTON)).toEqual({ meters: 0, bearingDeg: 0 });
    expect(neighborOffset(GROTON, { lat: Number.NaN, lng: 0 })).toBeNull();
    expect(neighborOffset({ lat: 0, lng: Number.POSITIVE_INFINITY }, GROTON)).toBeNull();
  });

  // The region's bodies: no antimeridian, no pole.
  const point = fc.record({
    lat: fc.double({ min: 40, max: 48, noNaN: true }),
    lng: fc.double({ min: -80, max: -66, noNaN: true }),
  });
  const near = (p: { lat: number; lng: number }) =>
    fc
      .record({
        dLat: fc.double({ min: -0.03, max: 0.03, noNaN: true }),
        dLng: fc.double({ min: -0.03, max: 0.03, noNaN: true }),
      })
      .map(({ dLat, dLng }) => ({ lat: p.lat + dLat, lng: p.lng + dLng }));

  it('measures the same distance both ways, never negative (fast-check)', () => {
    fc.assert(
      fc.property(point, point, (a, b) => {
        const there = neighborOffset(a, b);
        const back = neighborOffset(b, a);
        expect(there?.meters).toBe(back?.meters);
        expect(there?.meters).toBeGreaterThanOrEqual(0);
        expect(there?.meters).toBe(haversineMeters(a, b));
      }),
    );
  });

  it('keeps every bearing in [0, 360), wrapping at north rather than reaching 360 (fast-check)', () => {
    fc.assert(
      fc.property(
        point,
        fc.double({ min: -1e-7, max: 1e-7, noNaN: true }),
        fc.double({ min: 1e-3, max: 0.05, noNaN: true }),
        (a, dLng, dLat) => {
          // Just either side of due north: 0 or a hair past it, or a hair short of 360 — never 360.
          const b = neighborOffset(a, { lat: a.lat + dLat, lng: a.lng + dLng })?.bearingDeg;
          expect(b).toBeGreaterThanOrEqual(0);
          expect(b).toBeLessThan(360);
          expect(Math.min(b as number, 360 - (b as number))).toBeLessThan(0.01);
        },
      ),
    );
    fc.assert(
      fc.property(point, point, (a, b) => {
        const deg = neighborOffset(a, b)?.bearingDeg as number;
        expect(deg).toBeGreaterThanOrEqual(0);
        expect(deg).toBeLessThan(360);
      }),
    );
  });

  it('turns about at a neighbor: the way back is the opposite way, within a degree (fast-check)', () => {
    fc.assert(
      fc.property(
        point.chain((a) => fc.tuple(fc.constant(a), near(a))),
        ([a, b]) => {
          fc.pre(haversineMeters(a, b) > 10);
          const there = neighborOffset(a, b)?.bearingDeg as number;
          const back = neighborOffset(b, a)?.bearingDeg as number;
          // The angle between `back` and `there + 180`, folded to [0, 180].
          const off = Math.abs(((((back - there - 180) % 360) + 540) % 360) - 180);
          expect(off).toBeLessThan(1);
        },
      ),
    );
  });
});

describe('ringInsidePoint: a point inside a stored neighbor ring', () => {
  it('lands inside a crescent, where its middle would be on land', () => {
    // A C-shaped ring open to the east: its bounding box's middle is the bay of land inside the C.
    const ring = [
      [0, 0],
      [3, 0],
      [3, 1],
      [1, 1],
      [1, 2],
      [3, 2],
      [3, 3],
      [0, 3],
      [0, 0],
    ].map(([x, y]) => [-72 + (x as number) * 0.001, 44 + (y as number) * 0.001]);
    const p = ringInsidePoint(ring);
    expect(p).not.toBeNull();
    expect(pointInPolygon(p as never, { type: 'Polygon', coordinates: [ring] })).toBe(true);
    expect(
      pointInPolygon({ lat: 44.0015, lng: -71.998 }, { type: 'Polygon', coordinates: [ring] }),
    ).toBe(false);
  });

  it('is null for a ring with no inside', () => {
    expect(ringInsidePoint([])).toBeNull();
    expect(
      ringInsidePoint([
        [-72, 44],
        [-72, 44.01],
        [-72, 44],
      ]),
    ).toBeNull();
  });
});

describe('the D3 words test', () => {
  it('catches a word about the ice (the guard guards)', () => {
    for (const bad of [
      'Stays, as safe ice',
      'Skateable all winter',
      'Good to go',
      'Freezes early',
      'Thin ice at the inlet',
    ]) {
      expect(bad).toMatch(BANNED);
    }
  });

  it('holds every consequence on a grid of bodies', () => {
    const out: ClassConsequence[] = [];
    for (const name of ['', 'Mud Pond']) {
      for (const acres of [0.5, 3, 7, 50, 2263]) {
        for (const includedByRequest of [false, true]) {
          for (const cls of WATER_BODY_CLASSES as readonly WaterBodyClass[]) {
            out.push(classConsequence({ name, surfaceAreaSqM: ac(acres), includedByRequest }, cls));
          }
        }
      }
      for (const cls of WATER_BODY_CLASSES)
        out.push(classConsequence({ name, surfaceAreaSqM: null }, cls));
    }
    for (const c of out) expect(c.words).not.toMatch(BANNED);
  });
});
