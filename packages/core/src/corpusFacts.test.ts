import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { CLAIM_SOURCES, type ClaimSource } from './confidence';
import { splitOfNames } from './corpusFacets';
import {
  type ClassConsequence,
  classConsequence,
  NAME_SPLIT_WORDS,
  nameRankWords,
  nameSplit,
} from './corpusFacts';
import { CORPUS_TASK_FACETS } from './corpusTasks';
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
    });
    expect(classConsequence(body, 'reservoir')).toEqual({
      kind: 'stays',
      words: 'Stays, as a reservoir',
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
