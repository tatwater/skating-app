import { describe, expect, it } from 'vitest';

import {
  BAY_DRAWN,
  BAY_UNDRAWN,
  FIRST_LANDMARK_ASK,
  LANDMARK_ALONE,
  LANDMARK_ANSWERED,
  LANDMARK_PROPOSAL,
  MANY_LANDMARK_ASKS,
  NARROWS,
  PLACE_BY_VIEWER,
  PLACE_DECIDED,
  PLACE_FIXTURES,
  PLACE_NOW,
  UNCOUNTED_ASKER,
} from './placeFixtures';
import {
  askerStanding,
  bodyLine,
  compareRows,
  fromReport,
  hasBar,
  headAge,
  headTitle,
  ifApproved,
  ifDeclined,
  ifSamePlace,
  landmarkHistory,
  landmarkLookalike,
  lookalikeHead,
  matchChips,
  type PlaceBar,
  type PlaceItem,
  placeBar,
  pointText,
  refusalSaid,
  sameName,
} from './placeModel';

/** Board 2.4 as data: the bar from `can` alone, the compare table, the futures. */

describe('the bar, from the item’s can alone', () => {
  type Drawn = Omit<PlaceBar, 'samePlace'> & { samePlace: boolean };
  const expected: Record<keyof typeof PLACE_FIXTURES, Drawn> = {
    NARROWS: { samePlace: true, approve: false, draw: true, decline: true },
    LANDMARK_ALONE: { samePlace: false, approve: false, draw: true, decline: true },
    LANDMARK_PROPOSAL: { samePlace: false, approve: false, draw: true, decline: true },
    LANDMARK_ANSWERED: { samePlace: false, approve: true, draw: false, decline: true },
    BAY_UNDRAWN: { samePlace: false, approve: false, draw: true, decline: true },
    BAY_DRAWN: { samePlace: false, approve: true, draw: false, decline: true },
    PLACE_BY_VIEWER: { samePlace: false, approve: false, draw: false, decline: false },
    PLACE_DECIDED: { samePlace: false, approve: false, draw: false, decline: false },
  };
  for (const [name, item] of Object.entries(PLACE_FIXTURES)) {
    it(`${name}: draws what its can allows, and nothing it refuses`, () => {
      const bar = placeBar(item);
      expect({ ...bar, samePlace: bar.samePlace !== null }).toEqual(
        expected[name as keyof typeof PLACE_FIXTURES],
      );
      // Whatever the fixture: a refused verb is never drawn.
      if (item.can.sameAs !== null) expect(bar.samePlace).toBeNull();
      if (item.can.approve !== null) expect(bar.approve).toBe(false);
      if (item.can.decline !== null) expect(bar.decline).toBe(false);
    });
  }

  it('Same place answers with the landmark lookalike, never a proposal', () => {
    expect(placeBar(NARROWS).samePlace?.landmarkId).toBe(landmarkLookalike(NARROWS)?.landmarkId);
    expect(
      placeBar({ ...LANDMARK_PROPOSAL, can: { ...LANDMARK_PROPOSAL.can, sameAs: null } }).samePlace,
    ).toBeNull();
  });

  it('draws Approve wherever can allows it: the server, not the page, decides the bay is there', () => {
    const allowed = placeBar({
      ...BAY_UNDRAWN,
      can: { approve: null, decline: null },
      canCode: {},
    });
    expect(allowed.approve).toBe(true);
    // And no Draw in Body beside an Approve the server allows.
    expect(allowed.draw).toBe(false);
  });

  it('draws Draw in Body exactly where the server’s code says Approve waits on a drawing', () => {
    expect(placeBar(BAY_UNDRAWN).draw).toBe(true);
    expect(placeBar(NARROWS).draw).toBe(true);
    // Refused for another reason: no code, no Draw in Body.
    expect(
      placeBar({
        ...BAY_DRAWN,
        can: { approve: 'This has already been decided.', decline: null },
        canCode: {},
      }).draw,
    ).toBe(false);
    // A code not yet served (the field optional until the server serves it): nothing drawn.
    const { canCode: _, ...unserved } = BAY_UNDRAWN;
    expect(placeBar(unserved).draw).toBe(false);
  });

  it('follows the code, never the drawing facts the item also serves', () => {
    // Nothing drawn answers the ask by the facts, but the server's refusal carries no code (a
    // refusal of another kind): no Draw in Body.
    expect(
      placeBar({
        ...BAY_UNDRAWN,
        can: { approve: 'Approving needs body.names.', decline: null },
        canCode: {},
      }).draw,
    ).toBe(false);
    // The facts say a bay is drawn, yet the server says Approve waits on a drawing (the bay it
    // found isn't the one asked for): the code wins.
    expect(
      placeBar({
        ...BAY_DRAWN,
        can: { approve: 'No sub-area called that yet.', decline: null },
        canCode: { approve: 'awaitsDrawing' },
      }).draw,
    ).toBe(true);
    // And on a viewer's own landmark ask with the facts undrawn: no code, no Draw.
    expect(placeBar(PLACE_BY_VIEWER).draw).toBe(false);
  });

  it('draws nothing for a verb absent from can', () => {
    expect(hasBar(placeBar({ ...NARROWS, can: {}, canCode: {} }))).toBe(false);
  });

  it('draws no Same place on a bay ask', () => {
    const bay = { ...BAY_UNDRAWN, lookalikes: NARROWS.lookalikes, can: { sameAs: null } };
    expect(placeBar(bay as PlaceItem).samePlace).toBeNull();
  });

  it('says the refusal once when nothing is drawn, and never otherwise', () => {
    expect(refusalSaid(PLACE_BY_VIEWER)).toBe(
      'You filed this, so another staff member decides it.',
    );
    expect(refusalSaid(NARROWS)).toBeNull();
    expect(refusalSaid(PLACE_DECIDED)).toBeNull();
    expect(refusalSaid({ ...NARROWS, can: {}, canCode: {} })).toBeNull();
  });
});

describe('the head and the body line', () => {
  it('names the kind, its age, and where it came from', () => {
    expect(headTitle(NARROWS)).toBe('Name a landmark');
    expect(headTitle(BAY_UNDRAWN)).toBe('Name a bay');
    expect(headAge(NARROWS, PLACE_NOW)).toBe('5 hours ago');
    expect(fromReport(NARROWS)).toBe(true);
    expect(fromReport(BAY_UNDRAWN)).toBe(false);
    expect(bodyLine(NARROWS.body)).toBe('Newfound Lake · Bristol, NH');
    expect(bodyLine({ ...NARROWS.body, place: null })).toBe('Newfound Lake');
  });

  it('writes a point to four places with a true minus', () => {
    expect(pointText({ lat: 43.6702, lng: -71.7588 })).toBe('43.6702 −71.7588');
  });
});

describe('Same place?', () => {
  const ask = NARROWS.asks[0] as PlaceItem['asks'][number];
  const l = landmarkLookalike(NARROWS) as NonNullable<ReturnType<typeof landmarkLookalike>>;

  it('reads one name by the landmark rule: a leading “the” and case aside', () => {
    expect(sameName('the Narrows', 'The Narrows')).toBe(true);
    expect(sameName('Narrows', 'the narrows')).toBe(true);
    expect(sameName('the Gut', 'The Narrows')).toBe(false);
    expect(sameName('', '')).toBe(false);
  });

  it('draws the board’s rows', () => {
    expect(lookalikeHead(l)).toBe('The Narrows · OpenStreetMap');
    expect(compareRows(ask, l).map((r) => [r.label, r.cells[0].value, r.cells[1].value])).toEqual([
      ['Name', '“the Narrows”', 'The Narrows'],
      ['Kind', 'Landmark', 'Narrows'],
      ['Point', '43.6702 −71.7588', '43.6760 −71.7571'],
      ['Also called', 'Nothing yet', 'No aliases'],
      ['Used by', '1 report', 'No reports yet'],
    ]);
    expect(compareRows(ask, l)[0]?.cells.every((c) => c.same)).toBe(true);
  });

  it('says what it can’t know rather than a zero', () => {
    const rows = compareRows(ask, { ...l, usedByReports: null, aliases: ['Narrows Point'] });
    expect(rows[3]?.cells[1].value).toBe('Narrows Point');
    expect(rows[4]?.cells[1].value).toBe('Not recorded');
    expect(compareRows(ask, { ...l, usedByReports: 3 })[4]?.cells[1].value).toBe('3 reports');
  });

  it('chips “same name” only when it is one, and the distance always', () => {
    expect(matchChips(ask, l)).toEqual([
      { text: 'same name', tone: 'lit' },
      { text: '0.4 mi apart', tone: 'warn' },
    ]);
    expect(matchChips({ ...ask, name: 'the Gut' }, l).map((c) => c.text)).toEqual(['0.4 mi apart']);
  });
});

describe('the futures', () => {
  it('says what Same place does, the report row only for an ask from a report', () => {
    const ask = NARROWS.asks[0] as PlaceItem['asks'][number];
    expect(ifSamePlace(ask).map((r) => r.value)).toEqual([
      'Gains the alias “the Narrows”',
      'Its where snaps to the landmark',
      'Credited and told',
    ]);
    expect(ifSamePlace({ ...ask, fromReport: null }).map((r) => r.label)).toEqual([
      'Landmark',
      'Asker',
    ]);
  });

  it('says what answers an approved ask, and what a decline closes', () => {
    expect(ifApproved(BAY_DRAWN)[0]?.value).toBe('The bay already drawn');
    expect(ifApproved(LANDMARK_ANSWERED)[0]?.value).toBe('The landmark already there');
    expect(ifDeclined(BAY_UNDRAWN)[0]?.value).toBe('All 3 asks');
    expect(ifDeclined(LANDMARK_ALONE)[0]?.value).toBe('The ask');
    expect(ifDeclined({ memberCount: 500, memberCountIsFloor: true })[0]?.value).toBe('500+ asks');
  });
});

describe('the asker’s landmark history', () => {
  const ask = (item: PlaceItem) => item.asks[0] as PlaceItem['asks'][number];

  it('counts asks added of asks made, beside the standing', () => {
    expect(landmarkHistory(ask(NARROWS).landmarkAsks)).toBe('2 of 3 landmark asks added');
    expect(askerStanding(ask(NARROWS), 'Trusted · 63 pts')).toBe(
      'Trusted · 63 pts · 2 of 3 landmark asks added',
    );
  });

  it('says a first ask as such, and a cut count as floors', () => {
    expect(landmarkHistory(ask(FIRST_LANDMARK_ASK).landmarkAsks)).toBe('first landmark ask');
    expect(landmarkHistory(ask(MANY_LANDMARK_ASKS).landmarkAsks)).toBe(
      '31+ of 50+ landmark asks added',
    );
    // A capped count is never a first ask, however small.
    expect(landmarkHistory({ asked: 1, added: 0, capped: true })).toBe(
      '0+ of 1+ landmark asks added',
    );
  });

  it('adds nothing when the history isn’t served, or the asker is gone', () => {
    expect(landmarkHistory(null)).toBeNull();
    expect(askerStanding(ask(UNCOUNTED_ASKER), 'Trusted · 63 pts')).toBe('Trusted · 63 pts');
    const gone = { ...ask(NARROWS), asker: null };
    expect(askerStanding(gone, 'Not shown for a former skater')).toBe(
      'Not shown for a former skater',
    );
  });
});
