import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { dropIndex, moveId } from './kit-candidates/sortable-rows';
import { BODY_NOW, MASCOMA, SMALL_POND } from './linksFixtures';
import { INTERIOR_POINT_ID, linksMapScene } from './linksMap';
import { coordWords, derivedRows, inKeyOrder, keyedLinks } from './linksModel';

describe('derivedRows', () => {
  it('draws the board: Windy, Copernicus and the NH group, each with what it is built from', () => {
    expect(derivedRows(MASCOMA, BODY_NOW).map((r) => [r.label, r.sub, r.offered])).toEqual([
      ['Wind and weather on Windy', 'The interior point, zoomed out to the region', true],
      [
        'Recent satellite passes on Copernicus Browser',
        'The interior point, the last 14 days',
        true,
      ],
      [
        'Search NHNordicSkating for Mascoma Lake',
        'Find mentions in New Hampshire’s Google Group',
        true,
      ],
    ]);
  });

  it('a pond under the floor keeps its Copernicus row, withheld; a Facebook group opens its page', () => {
    const rows = derivedRows(SMALL_POND, BODY_NOW);
    expect(rows.find((r) => r.id === 'copernicus')?.offered).toBe(false);
    expect(rows.find((r) => r.id === 'community')?.sub).toBe(
      'Opens Maine and NH Skating and Ice Report',
    );
  });

  it('a body with no point and no community has nothing built from it', () => {
    expect(derivedRows({ name: 'X' }, BODY_NOW)).toEqual([]);
  });

  it('the derived links never include the staff ones', () => {
    expect(derivedRows(MASCOMA, BODY_NOW).map((r) => r.id)).toEqual([
      'windy',
      'copernicus',
      'community',
    ]);
  });
});

describe('the staff links’ keys', () => {
  it('survive a reorder and tell repeats apart', () => {
    const a = { label: 'A', url: 'https://a.org' };
    const keyed = keyedLinks([a, { label: 'B', url: 'https://b.org' }, a]);
    expect(new Set(keyed.map((k) => k.key)).size).toBe(3);
    const reversed = [...keyed].reverse().map((k) => k.key);
    expect(inKeyOrder(keyed, reversed).map((l) => l.label)).toEqual(['A', 'B', 'A']);
    expect(inKeyOrder(keyed, [keyed[1]?.key as string])).toEqual([
      { label: 'B', url: 'https://b.org' },
      a,
      a,
    ]);
    expect(inKeyOrder(keyed, ['missing']).map((l) => l.label)).toEqual(['A', 'B', 'A']);
  });

  it('a reorder by keys is a permutation of the list', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ label: fc.string(), url: fc.string() }), { maxLength: 8 }),
        fc.nat(),
        fc.nat(),
        (links, from, to) => {
          const keyed = keyedLinks(links);
          const keys = keyed.map((k) => k.key);
          const moved = moveId(keys, from % Math.max(1, keys.length), to % (keys.length + 1));
          const out = inKeyOrder(keyed, moved);
          expect(out).toHaveLength(links.length);
          const sort = (xs: { label: string; url: string }[]) =>
            xs.map((x) => JSON.stringify([x.label, x.url])).sort();
          expect(sort(out)).toEqual(sort(links));
        },
      ),
    );
  });
});

describe('moveId and dropIndex', () => {
  it('moveId keeps every id once and puts the moved one where it was sent', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string(), { maxLength: 10 }),
        fc.nat(),
        fc.integer(),
        (ids, f, t) => {
          const from = ids.length === 0 ? 0 : f % ids.length;
          const out = moveId(ids, from, t);
          expect([...out].sort()).toEqual([...ids].sort());
          if (ids.length > 0) {
            const to = Math.max(0, Math.min(ids.length - 1, t));
            expect(out[to]).toBe(ids[from]);
          }
        },
      ),
    );
    expect(moveId(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
  });

  it('dropIndex counts the midpoints above the pointer', () => {
    expect(dropIndex(5, [10, 30, 50])).toBe(0);
    expect(dropIndex(31, [10, 30, 50])).toBe(2);
    expect(dropIndex(99, [10, 30, 50])).toBe(3);
  });
});

describe('the map', () => {
  it('lights the interior point with its plate, on the samples layer', () => {
    expect(linksMapScene(MASCOMA, null)).toEqual({
      items: [
        {
          kind: 'point',
          id: 'interior:point',
          layer: 'samples',
          at: [-72.136, 43.6174],
          mark: 'sample',
          hoverKicker: 'Interior point',
          name: '43.6174°N 72.1360°W',
          caption: 'Windy and Copernicus open here',
        },
      ],
      lit: 'interior:point',
    });
    expect(linksMapScene({}, null)).toEqual({ items: [] });
    expect(linksMapScene(null, 'interior:point')).toEqual({ items: [] });
    // The address is one the frame's `?lit=` accepts.
    expect(/^[a-z][a-zA-Z]{0,31}:[A-Za-z0-9_.-]{1,128}$/.test(INTERIOR_POINT_ID)).toBe(true);
  });

  it('writes either hemisphere', () => {
    expect(coordWords({ lat: -33.5, lng: 151.25 })).toBe('33.5000°S 151.2500°E');
  });
});
