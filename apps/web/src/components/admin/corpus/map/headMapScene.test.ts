import { describe, expect, it } from 'vitest';

import { embedBodyOf, headMapState, outlineLabelOf } from './CorpusHeadMap';
import { GROTON_UNNAMED, OSMORE_POND, TAYLOR_POND, THE_BASIN } from './corpusMapFixtures';
import { embedOutline, HEAD_MAP_GROW, headMapScene } from './headMapScene';

const BASIN = { id: 'wbbasin', name: 'The Basin', outline: THE_BASIN };
const TAYLOR = { id: 'wbtaylor', name: 'Taylor Pond', outline: TAYLOR_POND };

describe('the head map’s scene', () => {
  it('frames the body with a fifth of its size round it, the neighbors only in reach', () => {
    const view = headMapScene({ body: BASIN, neighbors: [TAYLOR] });
    expect(HEAD_MAP_GROW).toBe(0.2);
    // The Basin's box is about 0.0493° of longitude wide; a fifth more each side.
    const width = view.frame.maxLng - view.frame.minLng;
    expect(width).toBeGreaterThan(0.0493 * 1.39);
    expect(width).toBeLessThan(0.0493 * 1.41);
    // Taylor Pond lies south of the frame: inside the reach, outside the frame.
    expect(view.frame.minLat).toBeGreaterThan(44.11);
    expect(view.reach?.minLat).toBeLessThan(44.1);
    expect(view.legend).toEqual([]);
    expect(view.caption).toBeNull();
  });

  it('draws the neighbor under the body, named at its shore nearest the body', () => {
    const { scene } = headMapScene({ body: BASIN, neighbors: [TAYLOR] });
    expect(scene.items.map((i) => i.id)).toEqual([
      'neighbor:wbtaylor',
      'body:wbbasin',
      'neighbor:wbtaylor:name',
    ]);
    const label = scene.items[2] as unknown as { at: [number, number]; text: string };
    expect(label.text).toBe('Taylor Pond');
    // Taylor Pond's head, its northernmost shore.
    expect(label.at[1]).toBeGreaterThan(44.12);
  });

  it('names no unnamed neighbor, and frames on the body alone without one', () => {
    const view = headMapScene({ body: BASIN, neighbors: [{ ...TAYLOR, name: ' ' }] });
    expect(view.scene.items.map((i) => i.id)).toEqual(['neighbor:wbtaylor', 'body:wbbasin']);
    expect(headMapScene({ body: BASIN }).reach).toBeNull();
  });

  it('draws a legend plate only when the outline is named, and passes a caption', () => {
    const view = headMapScene({
      body: { id: 'g', name: '', outline: GROTON_UNNAMED },
      outlineLabel: 'The outline · OSM',
      caption: 'x',
    });
    expect(view.legend).toEqual([
      { label: 'The outline · OSM', stroke: { kind: 'outline', style: 'body' } },
    ]);
    expect(view.caption).toBe('x');
  });

  it('refuses a body with nothing to frame on', () => {
    expect(() =>
      headMapScene({ body: { id: 'x', name: '', outline: { type: 'Polygon', coordinates: [] } } }),
    ).toThrow();
  });
});

describe('a stored outline, as the embed takes it', () => {
  it('takes a polygon or a multipolygon with points, nothing else', () => {
    expect(embedOutline(THE_BASIN)).toBe(THE_BASIN);
    const multi = { type: 'MultiPolygon', coordinates: [THE_BASIN.coordinates] };
    expect(embedOutline(multi)).toBe(multi);
    expect(embedOutline({ type: 'Polygon', coordinates: [] })).toBeNull();
    expect(embedOutline({ type: 'Polygon' })).toBeNull();
    expect(embedOutline({ type: 'Point', coordinates: [0, 0] })).toBeNull();
    expect(embedOutline(null)).toBeNull();
    expect(embedOutline(undefined)).toBeNull();
  });
});

describe('the reads, as the head map’s state', () => {
  const doc = (id: string, name: string, polygon: unknown, geometrySource?: string) =>
    ({ available: true, body: { _id: id, name, polygon, geometrySource } }) as never;
  const failed = { failed: true, pending: false, retry: () => {} } as never;

  it('waits on the body, says its failure, and draws nothing for a body gone or outline-less', () => {
    expect(headMapState(undefined, [], false)).toBeUndefined();
    expect(headMapState(failed, [], false)).toBe(failed);
    expect(headMapState({ available: false } as never, [], false)).toBeNull();
    expect(headMapState(null as never, [], false)).toBeNull();
    expect(headMapState(doc('b', 'B', null), [], false)).toBeNull();
  });

  it('adds each neighbor that loaded with an outline; the rest are simply not drawn', () => {
    const state = headMapState(
      doc('g', '', GROTON_UNNAMED, 'osm'),
      [
        doc('o', 'Osmore Pond', OSMORE_POND),
        undefined,
        failed,
        { available: false } as never,
        doc('n', 'No outline', null),
      ],
      true,
    );
    expect(state).toEqual({
      body: { id: 'g', name: '', outline: GROTON_UNNAMED },
      neighbors: [{ id: 'o', name: 'Osmore Pond', outline: OSMORE_POND }],
      outlineLabel: 'The outline · OSM',
    });
  });

  it('names whose drawing the outline is, or none on file', () => {
    expect(outlineLabelOf({ geometrySource: 'nhd' } as never)).toBe('The outline · NHD');
    expect(outlineLabelOf({} as never)).toBe('The outline');
    expect(embedBodyOf({ _id: 'x', name: 'X', polygon: undefined } as never)).toBeNull();
  });
});
