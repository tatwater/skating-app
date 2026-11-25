import { CHORD_MESSAGES, type ChordResult, type SubAreaMouth } from '@skating/core';
import { describe, expect, it } from 'vitest';

import {
  aliasList,
  type BayTarget,
  bayModeBar,
  saveBlocker,
  savedTitle,
  startDraft,
  waysFor,
  withChord,
  withPaste,
  withRing,
  withWay,
} from './bayDraft';

const RING: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-72.16, 43.63],
      [-72.15, 43.63],
      [-72.15, 43.64],
      [-72.16, 43.63],
    ],
  ],
};
const MOUTH: SubAreaMouth = {
  a: { lat: 43.6312, lng: -72.1575 },
  b: { lat: 43.6329, lng: -72.1559 },
  side: { lat: 43.631, lng: -72.156 },
  sagittaM: 38,
};
const BBOX = { minLat: 43.63, minLng: -72.16, maxLat: 43.64, maxLng: -72.15 };
const REDRAW: BayTarget = {
  kind: 'redraw',
  subAreaId: 's1',
  name: 'Shaker cove',
  polygon: RING,
  bbox: BBOX,
};
const MOVE: BayTarget = {
  kind: 'mouth',
  subAreaId: 's1',
  name: 'Shaker cove',
  mouth: MOUTH,
  bbox: BBOX,
};
const cut = (polygon: GeoJSON.Polygon): ChordResult => ({ ok: true, polygon }) as ChordResult;

describe('a bay draft — its start', () => {
  it('offers each target only the ways that make sense for it', () => {
    expect(waysFor({ kind: 'new' })).toEqual(['chord', 'freehand', 'paste']);
    // A redraw replaces an outline: a chord would cut a new one from the shore, which the mouth does.
    expect(waysFor(REDRAW)).toEqual(['freehand', 'paste']);
    expect(waysFor(MOVE)).toEqual(['chord']);
  });

  it('starts on the way asked for, or the target’s first when that way does not fit', () => {
    expect(startDraft({ kind: 'new' }, { way: 'paste' }).way).toBe('paste');
    expect(startDraft(REDRAW, { way: 'chord' }).way).toBe('freehand');
    expect(startDraft({ kind: 'new' }).way).toBe('chord');
  });

  it('fills an ask’s name and spellings, a landmark’s name, a redraw’s bay', () => {
    const ask = startDraft(
      { kind: 'new', request: { requestId: 'r1', asks: 3 } },
      {
        name: 'Shaker cove',
        aliases: ['The cove', 'Shaker Bridge cove'],
        focus: { point: MOUTH.a },
      },
    );
    expect(ask).toMatchObject({ name: 'Shaker cove', aliases: 'The cove, Shaker Bridge cove' });
    expect(ask.focus).toEqual({ point: MOUTH.a });
    expect(
      startDraft({ kind: 'new', promote: { landmarkId: 'l1', name: 'Black Point' } }).name,
    ).toBe('Black Point');
    // A bay already drawn frames itself.
    expect(startDraft(REDRAW).focus).toEqual({ bbox: BBOX });
  });

  it('gives every draft its own session, so the map starts each drawing over', () => {
    const a = startDraft({ kind: 'new' });
    const b = startDraft({ kind: 'new' });
    expect(b.session).not.toBe(a.session);
    const switched = withWay(a, 'freehand');
    expect(switched.session).not.toBe(a.session);
    // The same way, or one the target doesn't take, is no change at all.
    expect(withWay(a, 'chord')).toBe(a);
    expect(withWay(startDraft(MOVE), 'paste').way).toBe('chord');
  });
});

describe('a bay draft — the shape', () => {
  it('takes a chord’s derivation as the shape, and its refusal in the server’s words', () => {
    const d = startDraft({ kind: 'new' }, { name: 'Shaker cove' });
    const done = withChord(d, { step: 'done', ...MOUTH }, MOUTH, cut(RING));
    expect(done).toMatchObject({ mouth: MOUTH, shape: RING, refusal: null });
    expect(saveBlocker(done)).toBeNull();
    const refused = withChord(d, { step: 'done', ...MOUTH }, MOUTH, {
      ok: false,
      reason: 'crosses_shore',
    } as ChordResult);
    expect(refused.shape).toBeNull();
    expect(refused.refusal).toBe(CHORD_MESSAGES.crosses_shore);
    // A refused pick (two points on different rings) is said while the gesture waits.
    const picked = withChord(d, { step: 'b', sagittaM: 0, refusal: 'different_rings' }, null, null);
    expect(picked.refusal).toBe(CHORD_MESSAGES.different_rings);
    // The reason comes first, never "not drawn yet".
    expect(saveBlocker(picked)).toBe(CHORD_MESSAGES.different_rings);
    expect(saveBlocker(withChord(d, { step: 'b', sagittaM: 0 }, null, null))).toBe(
      'The mouth isn’t drawn yet',
    );
  });

  it('switching the way starts the shape over and keeps the fields', () => {
    const d = withChord(
      startDraft({ kind: 'new' }, { name: 'Shaker cove', aliases: ['The cove'] }),
      { step: 'done', ...MOUTH },
      MOUTH,
      cut(RING),
    );
    const next = withWay(d, 'paste');
    expect(next).toMatchObject({
      name: 'Shaker cove',
      aliases: 'The cove',
      shape: null,
      mouth: null,
    });
    expect(next.chord).toBeNull();
  });

  it('takes a traced ring, and forgets it once removed', () => {
    const d = withRing(startDraft(REDRAW), RING);
    expect(d.shape).toBe(RING);
    expect(saveBlocker(d)).toBeNull();
    expect(saveBlocker(withRing(d, null))).toBe('Nothing drawn yet');
  });

  it('parses a paste as it is typed: a polygon, or why it isn’t one', () => {
    const d = startDraft({ kind: 'new' }, { way: 'paste', name: 'Shaker cove' });
    expect(saveBlocker(d)).toBe('Nothing pasted yet');
    const good = withPaste(d, JSON.stringify({ type: 'Feature', geometry: RING, properties: {} }));
    expect(good.shape).toEqual(RING);
    expect(saveBlocker(good)).toBeNull();
    const line = withPaste(d, JSON.stringify({ type: 'LineString', coordinates: [] }));
    expect(line.shape).toBeNull();
    expect(line.refusal).toMatch(/not a LineString/);
    expect(saveBlocker(line)).toMatch(/not a LineString/);
    expect(withPaste(d, '{').refusal).toBe("That isn't valid JSON.");
    expect(withPaste(good, '   ')).toMatchObject({ shape: null, refusal: null });
  });
});

describe('a bay draft — saving it', () => {
  it('needs a name for a new bay, and nothing more of a redraw or a mouth', () => {
    const shaped = withRing(startDraft({ kind: 'new' }, { way: 'freehand' }), RING);
    expect(saveBlocker(shaped)).toBe('A bay needs a name');
    expect(saveBlocker({ ...shaped, name: '   ' })).toBe('A bay needs a name');
    expect(saveBlocker({ ...shaped, name: 'Shaker cove' })).toBeNull();
    expect(saveBlocker(withRing(startDraft(REDRAW), RING))).toBeNull();
  });

  it('sends the spellings trimmed, none empty', () => {
    expect(
      aliasList({ ...startDraft({ kind: 'new' }), aliases: ' The cove, ,Shaker cove ,' }),
    ).toEqual(['The cove', 'Shaker cove']);
  });

  it('names what was done in the receipt', () => {
    expect(savedTitle({ ...startDraft({ kind: 'new' }), name: ' Shaker cove ' })).toBe(
      'Bay drawn · Shaker cove',
    );
    expect(savedTitle(startDraft(REDRAW))).toBe('Bay redrawn · Shaker cove');
    expect(savedTitle(startDraft(MOVE))).toBe('Mouth set · Shaker cove');
  });
});

describe('a bay draft — the mode bar', () => {
  it('walks the chord’s four steps in its own words', () => {
    const d = startDraft({ kind: 'new' });
    expect(bayModeBar(d)).toMatchObject({ mode: 'Bay mode', step: 'Step 1 of 4' });
    const done = withChord(d, { step: 'done', ...MOUTH }, MOUTH, cut(RING));
    expect(bayModeBar(done).step).toBe('Step 4 of 4');
    expect(bayModeBar(done).line).toMatch(/Drag the handle/);
    expect(bayModeBar(startDraft(MOVE)).mode).toBe('Mouth');
  });

  it('says how to trace, how to edit once traced, and what to do when the tool won’t load', () => {
    const d = startDraft(REDRAW);
    expect(bayModeBar(d)).toMatchObject({ mode: 'Redraw' });
    expect(bayModeBar(d).line).toMatch(/click the first point again/);
    expect(bayModeBar(withRing(d, RING)).line).toMatch(/Drag a point/);
    expect(bayModeBar({ ...d, ringUnavailable: true }).line).toMatch(/Paste the outline/);
    expect(bayModeBar(startDraft({ kind: 'new' }, { way: 'paste' })).line).toMatch(
      /Paste a polygon/,
    );
  });
});
