import { describe, expect, it } from 'vitest';
import { emptySheet, type SheetAction, sheetReducer, toReportInput } from './reportSheet';
import { deselectEveryPlace, whereCardsFor, whereMarkText } from './whereCards';

describe('whereCardsFor — the where cards both sheets render (Greptile P2 on #82)', () => {
  it('one card per place, numbered by type; another place is one more card; deselect takes them all', () => {
    let state = sheetReducer(emptySheet(0, 'wb1'), {
      type: 'select',
      field: 'sightings',
      key: 'open',
      value: { type: 'open' },
    });
    const dispatch = (a: SheetAction) => {
      state = sheetReducer(state, a);
    };
    const words = {
      label: (t: string) => (t === 'open' ? 'Still open' : t),
      question: () => 'Where?',
    };
    let cards = whereCardsFor(state, 'sightings', dispatch, words);
    cards[0]?.onChange({ sector: 'S' });
    const added = whereCardsFor(state, 'sightings', dispatch, words)[0]?.onAnotherPlace();
    expect(added).toBe('sightings:open#2');
    cards = whereCardsFor(state, 'sightings', dispatch, words);
    expect(cards.map((c) => [c.id, c.label, c.question])).toEqual([
      ['sightings:open', 'Still open', 'Where?'],
      ['sightings:open#2', 'Still open (2)', 'Where?'],
    ]);
    cards[1]?.onChange({ sector: 'N' });
    expect(whereMarkText(state, 'sightings', 'open')).toBe('◆ S +1');
    expect(toReportInput(state).sightings).toEqual([
      { type: 'open', where: { sector: 'S' } },
      { type: 'open', where: { sector: 'N' } },
    ]);
    cards[0]?.onChange(undefined);
    expect(whereMarkText(state, 'sightings', 'open')).toBe('◇ +1');
    deselectEveryPlace(state, 'sightings', 'open', dispatch);
    expect(whereCardsFor(state, 'sightings', dispatch, words)).toEqual([]);
  });
});
