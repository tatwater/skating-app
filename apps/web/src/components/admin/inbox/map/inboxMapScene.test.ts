import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { BBoxLike } from '@/lib/mapSurface';
import type { LngLat, MapItem, MapLabel, MapLine, MapPoint } from '../../body/map/mapDescriptors';
import { formatDistance } from '../../body/tabs/places/placesModel';
import {
  ACCESS,
  ADMIT,
  ADMIT_NO_MATCH,
  ALERT,
  CASPIAN_DRAWING,
  CASPIAN_LAKE,
  DRAWN,
  LOOKALIKE,
  MASCOMA,
  REPORT_POINT,
  RICKER_POND,
  UNNAMED_POND,
} from './inboxMapFixtures';
import { metersBetween, outlineCoords } from './inboxMapFrame';
import {
  accessScene,
  admitScene,
  alertScene,
  drawnScene,
  type InboxMapView,
  lookalikeScene,
  reportPointScene,
} from './inboxMapScene';

const byId = (v: InboxMapView, id: string) => v.scene.items.find((i) => i.id === id);
const point = (v: InboxMapView, id: string) => byId(v, id) as MapPoint;
const marks = (v: InboxMapView) =>
  v.scene.items.filter((i): i is MapPoint => i.kind === 'point').map((p) => p.mark);
const inside = (b: BBoxLike, [lng, lat]: LngLat) =>
  lng >= b.minLng && lng <= b.maxLng && lat >= b.minLat && lat <= b.maxLat;

/** Every item's layer is switched on: an embed has no rack to turn one on. */
function expectAllLayersOn(v: InboxMapView) {
  for (const i of v.scene.items) expect(v.scene.layers?.[i.layer]).toBe(true);
}

describe('2.1 — a flagged report’s point', () => {
  it('draws the body and the report point in the hazard red for a safety item', () => {
    const v = reportPointScene(REPORT_POINT);
    expect(v.scene.items.map((i) => i.id)).toEqual(['body:mascoma', 'report:r1']);
    expect(point(v, 'report:r1')).toMatchObject({
      mark: 'reticle',
      at: REPORT_POINT.report.at,
      name: 'Town beach',
      hoverKicker: 'Report point',
    });
    expect(v.caption).toBe('Report point · town beach');
    expect(v.legend).toEqual([]);
    expectAllLayersOn(v);
  });

  it('is red only for a safety item — any other report point is the bright reticle', () => {
    expect(marks(reportPointScene({ ...REPORT_POINT, safety: false }))).toEqual(['asked']);
  });

  it('frames the whole body with the point, and a point on no body alone', () => {
    const v = reportPointScene(REPORT_POINT);
    for (const c of outlineCoords(MASCOMA.outline)) expect(inside(v.frame, c)).toBe(true);
    const lone = reportPointScene({ body: null, report: { id: 'x', at: [-72, 44] }, safety: true });
    expect(lone.scene.items).toHaveLength(1);
    expect(point(lone, 'report:x').name).toBe('Report point');
    expect(inside(lone.frame, [-72, 44])).toBe(true);
    expect(lone.caption).toBeNull();
  });

  it('names a report point by its body when it has no place of its own', () => {
    const v = reportPointScene({ ...REPORT_POINT, report: { id: 'r', at: [-72.15, 43.63] } });
    expect(point(v, 'report:r').name).toBe('Mascoma Lake');
  });
});

describe('2.2 — a body and its access points', () => {
  it('draws the body, its put-ins and lots and their walks, framed on all of them', () => {
    const lot = { id: 'l', kind: 'lot' as const, at: [-73.5, 42.9] as LngLat };
    const v = accessScene({
      ...ACCESS,
      access: [...ACCESS.access, lot],
      approaches: [{ id: 'w', path: [lot.at, ACCESS.access[0]?.at as LngLat] }],
    });
    expect(v.scene.items.map((i) => i.id)).toEqual([
      'body:tomhannock',
      'walk:w',
      'putIn:dam-road',
      'lot:l',
    ]);
    expect(point(v, 'putIn:dam-road')).toMatchObject({ mark: 'putIn', hoverKicker: 'Put-in' });
    expect(point(v, 'lot:l')).toMatchObject({ mark: 'lot', hoverKicker: 'Lot' });
    expect(point(v, 'lot:l').name).toBeUndefined();
    expect((byId(v, 'walk:w') as MapLine).style).toBe('approach');
    // A lot off the shore still frames: the access points are the item's subject.
    expect(inside(v.frame, lot.at)).toBe(true);
    expectAllLayersOn(v);
  });
});

describe('2.3 — a catalog candidate', () => {
  const v = admitScene(ADMIT);

  it('draws ours quiet, the candidate dashed over it, the skate, and the rule between', () => {
    expect(v.scene.items.map((i) => i.id)).toEqual([
      'body:ricker',
      'candidate:yq4k2',
      'track:kd',
      'gap:nearest:ricker',
      'gap:nearest:ricker:length',
    ]);
    expect(byId(v, 'body:ricker')).toMatchObject({ style: 'neighbor' });
    expect(byId(v, 'candidate:yq4k2')).toMatchObject({ style: 'candidate' });
    expect(byId(v, 'track:kd')).toMatchObject({ style: 'track', layer: 'tracks' });
    // With a candidate, the asks' points add nothing to it.
    expect(marks(v)).toEqual([]);
    expectAllLayersOn(v);
  });

  it('runs the rule shore to shore, and its measure says the distance the server served', () => {
    const gap = byId(v, 'gap:nearest:ricker') as MapLine;
    const [from, to] = gap.path as [LngLat, LngLat];
    expect(outlineCoords(UNNAMED_POND.outline)).toContainEqual(from);
    expect(outlineCoords(RICKER_POND.outline)).toContainEqual(to);
    const label = byId(v, 'gap:nearest:ricker:length') as MapLabel;
    // The row beside the map says the served distance; the rule says the same, never its own.
    expect(label).toMatchObject({ style: 'measure', text: formatDistance(1_300) });
    expect(formatDistance(metersBetween(from, to))).not.toBe(label.text);
  });

  it('frames the candidate, the skate and the rule — not the whole of ours', () => {
    for (const c of outlineCoords(UNNAMED_POND.outline)) expect(inside(v.frame, c)).toBe(true);
    for (const c of ADMIT.tracks?.[0]?.path ?? []) expect(inside(v.frame, c)).toBe(true);
    // Ricker Pond runs off the board's left edge, as drawn.
    expect(outlineCoords(RICKER_POND.outline).every((c) => inside(v.frame, c))).toBe(false);
  });

  it('keys the legend in the board’s order, a row only for a label given and a line drawn', () => {
    expect(v.legend).toEqual([
      {
        label: 'Catalog outline · not ours yet',
        stroke: { kind: 'outline', style: 'candidate' },
      },
      { label: 'Kate Donovan’s skate', stroke: { kind: 'line', style: 'track' } },
      { label: 'Ours', stroke: { kind: 'outline', style: 'neighbor' } },
    ]);
    expect(admitScene({ ...ADMIT, legend: { track: 'Skate' }, tracks: [] }).legend).toEqual([]);
  });

  it('letters the catalog’s fact in the corner caption, after the handler’s own', () => {
    expect(v.caption).toBe('Unnamed · 41 ac');
    expect(admitScene({ ...ADMIT, caption: 'Asked twice' }).caption).toBe(
      'Asked twice · Unnamed · 41 ac',
    );
    // No candidate, no fact about it; no fact and no caption, no caption.
    expect(admitScene({ ...ADMIT, candidate: null }).caption).toBeNull();
    expect(admitScene({ ...ADMIT, candidateFact: undefined }).caption).toBeNull();
  });

  it('draws an admitted body’s pass under everything, when the handler has one', () => {
    expect(v.scene.items.some((i) => i.kind === 'raster')).toBe(false);
    const pass = DRAWN.aerial as NonNullable<typeof DRAWN.aerial>;
    const withPass = admitScene({ ...ADMIT, aerial: pass });
    expect(withPass.scene.items[0]).toMatchObject({
      kind: 'raster',
      id: `aerial:${pass.granuleId}`,
      layer: 'aerial',
      key: pass.key,
    });
    expect(withPass.scene.layers?.aerial).toBe(true);
  });

  it('with no catalog match, draws the asked points and frames on them', () => {
    const none = admitScene(ADMIT_NO_MATCH);
    expect(none.scene.items).toEqual([
      expect.objectContaining({ id: 'ask:jm', mark: 'asked', name: 'Jamie Moreau' }),
    ]);
    expect(inside(none.frame, ADMIT_NO_MATCH.asks[0]?.at as LngLat)).toBe(true);
    expect(none.caption).toBe('Asked here · no catalog feature');
    const unnamed = admitScene({ candidate: null, asks: [{ id: 'a', at: [-72, 44] }] });
    expect(point(unnamed, 'ask:a').name).toBeUndefined();
  });

  it('with no match but a nearest body, runs the rule from the asked point', () => {
    const v2 = admitScene({ ...ADMIT, candidate: null });
    const gap = byId(v2, 'gap:nearest:ricker') as MapLine;
    expect(ADMIT.asks.map((a) => a.at)).toContainEqual(gap.path[0]);
  });
});

describe('2.4 — an asked point and its lookalike', () => {
  const v = lookalikeScene(LOOKALIKE);

  it('draws the body, the rule, the lookalike and the asked point over it', () => {
    expect(v.scene.items.map((i) => i.id)).toEqual([
      'body:newfound',
      'gap:lookalike:osm-narrows',
      'gap:lookalike:osm-narrows:length',
      'lookalike:osm-narrows',
      'ask:narrows',
    ]);
    expect(marks(v)).toEqual(['lookalike', 'asked']);
    // The board's 0.4 mi.
    expect((byId(v, 'gap:lookalike:osm-narrows:length') as MapLabel).text).toBe('0.4 mi');
    expectAllLayersOn(v);
  });

  it('pans over the whole body: its reach holds the outline and the frame', () => {
    const reach = v.reach as BBoxLike;
    for (const c of outlineCoords(LOOKALIKE.body?.outline as GeoJSON.Polygon))
      expect(inside(reach, c)).toBe(true);
    for (const c of [
      [v.frame.minLng, v.frame.minLat],
      [v.frame.maxLng, v.frame.maxLat],
    ] as LngLat[])
      expect(inside(reach, c)).toBe(true);
    expect(lookalikeScene({ ...LOOKALIKE, body: null }).reach).toBeNull();
  });

  it('frames the two points in its middle third, not the whole body', () => {
    const lat = [LOOKALIKE.asked.at[1], LOOKALIKE.lookalikes[0]?.at[1] as number];
    const span = Math.max(...lat) - Math.min(...lat);
    // Taller than the minimum span alone would make it: the points have room around them.
    expect(v.frame.maxLat - v.frame.minLat).toBeGreaterThanOrEqual(span * 3 - 1e-9);
    expect(inside(v.frame, LOOKALIKE.asked.at)).toBe(true);
    expect(inside(v.frame, LOOKALIKE.lookalikes[0]?.at as LngLat)).toBe(true);
    expect(
      outlineCoords(LOOKALIKE.body?.outline as GeoJSON.Polygon).every((c) => inside(v.frame, c)),
    ).toBe(false);
  });

  it('rules to the nearest lookalike whatever order they come in, and measures it truly', () => {
    const lookalikes = fc.array(
      fc.record({
        id: fc.uuid(),
        at: fc.tuple(
          fc.double({ min: -71.8, max: -71.7, noNaN: true }),
          fc.double({ min: 43.6, max: 43.7, noNaN: true }),
        ),
      }),
      { minLength: 1, maxLength: 6 },
    );
    fc.assert(
      fc.property(lookalikes, (ls) => {
        const out = lookalikeScene({ body: null, asked: LOOKALIKE.asked, lookalikes: ls });
        const gap = out.scene.items.find((i): i is MapLine => i.kind === 'line') as MapLine;
        const to = gap.path[1] as LngLat;
        const d = metersBetween(LOOKALIKE.asked.at, to);
        for (const l of ls) expect(d).toBeLessThanOrEqual(metersBetween(LOOKALIKE.asked.at, l.at));
        const label = out.scene.items.find((i): i is MapLabel => i.kind === 'label') as MapLabel;
        expect(label.text).toBe(formatDistance(d));
        // Every lookalike is drawn; the asked point draws last, over them.
        expect(marks(out)).toEqual([...ls.map(() => 'lookalike'), 'asked']);
      }),
    );
  });

  it('with no lookalike, draws the asked point alone, unnamed if it has no name', () => {
    const lone = lookalikeScene({
      body: null,
      asked: { id: 'a', at: [-71.7, 43.6] },
      lookalikes: [],
    });
    expect(lone.scene.items.map((i) => i.id)).toEqual(['ask:a']);
    expect(point(lone, 'ask:a').name).toBeUndefined();
    const unnamed = lookalikeScene({
      body: null,
      asked: LOOKALIKE.asked,
      lookalikes: [{ id: 'l', at: [-71.75, 43.67] }],
    });
    expect(point(unnamed, 'lookalike:l').name).toBeUndefined();
  });
});

describe('2.5 — a drawing over a known body', () => {
  const v = drawnScene(DRAWN);

  it('draws ours, the drawing dashed over it, and the skate', () => {
    expect(v.scene.items.map((i) => i.id)).toEqual([
      'aerial:S2C_CASPIAN',
      'body:caspian',
      'drawn:drawn-kd',
      'track:kd-11oct',
    ]);
    expect(byId(v, 'drawn:drawn-kd')).toMatchObject({ style: 'candidate' });
    expect(v.legend.map((r) => r.label)).toEqual([
      'Caspian Lake · ours · 789 ac',
      'Drawn 12 Oct · Kate Donovan',
      'The recorded skate · 11 Oct',
    ]);
    expect(v.reach).toBeNull();
    expect(v.caption).toBe('8 % on the shore');
    expectAllLayersOn(v);
  });

  it('frames both outlines', () => {
    for (const c of [
      ...outlineCoords(CASPIAN_LAKE.outline),
      ...outlineCoords(CASPIAN_DRAWING.outline),
    ])
      expect(inside(v.frame, c)).toBe(true);
  });

  it('over open land, draws the drawing alone and keys only what is drawn', () => {
    const open = drawnScene({
      ...DRAWN,
      body: null,
      track: null,
      aerial: null,
      drawingFact: undefined,
    });
    expect(open.scene.items.map((i) => i.id)).toEqual(['drawn:drawn-kd']);
    expect(open.legend.map((r) => r.label)).toEqual(['Drawn 12 Oct · Kate Donovan']);
    expect(drawnScene({ body: null, drawing: CASPIAN_DRAWING }).legend).toEqual([]);
    expect(drawnScene({ ...DRAWN, caption: 'Drawn on a skate' }).caption).toBe(
      'Drawn on a skate · 8 % on the shore',
    );
  });
});

describe('2.6 — an access alert’s put-in or lot', () => {
  it('lights the alert’s put-in among the body’s others, the corner naming it', () => {
    const v = alertScene(ALERT);
    expect(v.scene.items.map((i) => i.id)).toEqual([
      'body:morey',
      'putIn:bonnie-oaks',
      'putIn:fairlee',
    ]);
    expect(v.scene.lit).toBe('putIn:fairlee');
    expect(point(v, 'putIn:fairlee').hoverKicker).toBe('Put-in · this alert');
    // Unnamed on the map: a lit, named mark keeps a plate up, and it runs off a 300 px embed.
    expect(point(v, 'putIn:fairlee').name).toBeUndefined();
    expect(v.caption).toBe('Fairlee town launch');
    // A caption of the handler's (or the map's own note) follows the name; never replaces it.
    expect(alertScene({ ...ALERT, caption: 'Outline simplified' }).caption).toBe(
      'Fairlee town launch · Outline simplified',
    );
    const { name: _, ...nameless } = ALERT.target;
    expect(alertScene({ ...ALERT, target: nameless, caption: 'Outline simplified' }).caption).toBe(
      'Outline simplified',
    );
    expect(alertScene({ ...ALERT, target: nameless }).caption).toBeNull();
    expect(point(v, 'putIn:bonnie-oaks').hoverKicker).toBe('Put-in');
    expectAllLayersOn(v);
  });

  it('never draws the target twice when the others include it, and says a lot is a lot', () => {
    const lot = { id: 'p', kind: 'lot' as const, at: [-72.16, 43.9] as LngLat, name: 'Town lot' };
    const v = alertScene({
      body: null,
      target: lot,
      others: [lot, { ...lot, kind: 'putIn' }],
    });
    expect(v.scene.items.map((i: MapItem) => i.id)).toEqual(['putIn:p', 'lot:p']);
    expect(point(v, 'lot:p').hoverKicker).toBe('Lot · this alert');
    expect(inside(v.frame, lot.at)).toBe(true);
    expect(alertScene({ body: null, target: lot }).scene.items).toHaveLength(1);
  });
});
