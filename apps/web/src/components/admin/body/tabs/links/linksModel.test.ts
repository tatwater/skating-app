import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { dropIndex, moveId } from '@/components/kit/sortable-rows';
import { BODY_NOW, MASCOMA, SMALL_POND } from './linksFixtures';
import { INTERIOR_POINT_ID, linksMapScene } from './linksMap';
import {
  carryIds,
  coordWords,
  derivedRows,
  googleMapsRow,
  googleMapsUrl,
  type KeyedLink,
  linkChanges,
  mapsZoom,
} from './linksModel';

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

/** A reorder by keys, as the record stores it (no keys). */
const inKeyOrder = (keyed: readonly KeyedLink[], keys: readonly string[]) =>
  (linkChanges.order(keys)(keyed) ?? []).map(({ label, url }) => ({ label, url }));

describe('the staff links’ keys', () => {
  it('survive a reorder and tell repeats apart', () => {
    const a = { label: 'A', url: 'https://a.org' };
    let n = 0;
    const keyed = carryIds([], [a, { label: 'B', url: 'https://b.org' }, a], () => `id${++n}`);
    expect(new Set(keyed.map((k) => k.key)).size).toBe(3);
    const reversed = [...keyed].reverse().map((k) => k.key);
    expect(inKeyOrder(keyed, reversed).map((l) => l.label)).toEqual(['A', 'B', 'A']);
    expect(inKeyOrder(keyed, [keyed[1]?.key as string])).toEqual([
      { label: 'B', url: 'https://b.org' },
      a,
      a,
    ]);
    // An order naming a link the list no longer has is refused (`null`).
    expect(linkChanges.order(['missing'])(keyed)).toBeNull();
  });

  it('a reorder by keys is a permutation of the list', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ label: fc.string(), url: fc.string() }), { maxLength: 8 }),
        fc.nat(),
        fc.nat(),
        (links, from, to) => {
          let n = 0;
          const keyed = carryIds([], links, () => `id${++n}`);
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

describe('carryIds — a link keeps its id while it is the same link', () => {
  it('an edit that makes a link read like another never takes the other’s id', () => {
    let n = 0;
    const fresh = () => `id${++n}`;
    const a = { label: 'A', url: 'https://a.org' };
    const b = { label: 'B', url: 'https://b.org' };
    // Twins: the first is edited; the second, untouched, keeps its own id.
    const twins = carryIds([], [a, a], fresh);
    const firstEdited = carryIds(twins, [{ ...a, label: 'A2' }, a], fresh);
    // The edited one is a new link (its id never inferred from its place); its twin keeps its own.
    expect(firstEdited[1]?.key).toBe(twins[1]?.key);
    expect(twins.map((l) => l.key)).not.toContain(firstEdited[0]?.key);
    // The first is edited to read like the second: the second keeps its id, the first is new.
    const pair = carryIds([], [a, b], fresh);
    const nowTwins = carryIds(pair, [b, b], fresh);
    expect(nowTwins[1]?.key).toBe(pair[1]?.key);
    expect(pair.map((l) => l.key)).not.toContain(nowTwins[0]?.key);
  });

  const link = fc.record({
    label: fc.constantFrom('A', 'B', 'C', 'D'),
    url: fc.constantFrom('https://a.org', 'https://b.org'),
  });

  it('an edited link is new; a reorder keeps every id; an add is new', () => {
    let n = 0;
    const fresh = () => `id${++n}`;
    const first = carryIds(
      [],
      [
        { label: 'A', url: 'https://a.org' },
        { label: 'B', url: 'https://b.org' },
      ],
      fresh,
    );
    const edited = carryIds(
      first,
      [
        { label: 'A', url: 'https://a.org' },
        { label: 'B2', url: 'https://b.org' },
      ],
      fresh,
    );
    expect(edited[0]?.key).toBe(first[0]?.key);
    expect(edited[1]?.key).toBe('id3');
    const swapped = carryIds(edited, [edited[1] as never, edited[0] as never], fresh);
    expect(swapped.map((l) => l.key)).toEqual([edited[1]?.key, edited[0]?.key]);
    const added = carryIds(swapped, [...swapped, { label: 'C', url: 'https://a.org' }], fresh);
    expect(added[2]?.key).toBe('id4');
  });

  it('ids are unique, and a link whose words didn’t change keeps its id (fast-check)', () => {
    fc.assert(
      fc.property(fc.array(link, { maxLength: 6 }), fc.array(link, { maxLength: 6 }), (a, b) => {
        let n = 0;
        const fresh = () => `id${++n}`;
        const before = carryIds([], a, fresh);
        const after = carryIds(before, b, fresh);
        expect(new Set(after.map((l) => l.key)).size).toBe(after.length);
        expect(after.map(({ label, url }) => ({ label, url }))).toEqual(b);
        // A link in both lists with the same words keeps one of the ids its words had.
        for (const l of after) {
          const had = before
            .filter((p) => p.label === l.label && p.url === l.url)
            .map((p) => p.key);
          if (
            had.length > 0 &&
            b.filter((x) => x.label === l.label && x.url === l.url).length <= had.length
          ) {
            expect(had).toContain(l.key);
          }
        }
      }),
    );
  });
});

describe('carryIds — a key carries only to the same link, never to whatever stands in its place', () => {
  it('Greptile’s case: A replaced by C before a retry — C is a new link, never A by its place', () => {
    let n = 0;
    const fresh = () => `new${++n}`;
    const a = { label: 'A', url: 'https://a.org', key: 'kA' };
    const b = { label: 'B', url: 'https://b.org', key: 'kB' };
    const rebuilt = carryIds([a, b], [{ label: 'C', url: 'https://c.org' }, b], fresh);
    expect(rebuilt.map((l) => l.key)).toEqual(['new1', 'kB']);
    // An edit aimed at A finds no A to change: refused, never re-aimed at C.
    expect(linkChanges.edit('kA', { label: 'A2', url: 'https://a.org' })(rebuilt)).toBeNull();
  });

  const link = fc.record({
    label: fc.constantFrom('A', 'B', 'C'),
    url: fc.constantFrom('https://a.org', 'https://b.org'),
  });

  it('every carried key names a link with exactly the words it had (fast-check)', () => {
    fc.assert(
      fc.property(fc.array(link, { maxLength: 6 }), fc.array(link, { maxLength: 6 }), (a, b) => {
        let n = 0;
        const fresh = () => `new${++n}`;
        const before = carryIds([], a, fresh);
        const after = carryIds(before, b, fresh);
        for (const l of after) {
          const was = before.find((p) => p.key === l.key);
          if (was !== undefined) expect([was.label, was.url]).toEqual([l.label, l.url]);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('linkChanges — a change whose links moved is refused, never re-aimed', () => {
  const a = { label: 'A', url: 'https://a.org', key: 'kA' };
  const b = { label: 'B', url: 'https://b.org', key: 'kB' };
  const c = { label: 'C', url: 'https://c.org', key: 'kC' };
  const d = { label: 'D', url: 'https://d.org', key: 'kD' };

  it('a remove whose link is gone finds nothing to remove', () => {
    expect(linkChanges.remove('kA')([c, b])).toBeNull();
    expect(linkChanges.remove('kA')([a, b])).toEqual([b]);
  });

  it('a reorder of links that are no longer the list’s is refused, never moving a replacement', () => {
    // I put D first over [A, B, D]; another moderator replaced A with C meanwhile.
    expect(linkChanges.order(['kD', 'kA', 'kB'])([c, b, d])).toBeNull();
    // A link added since doesn't stop the order: it keeps its place after the ones I ordered.
    expect(linkChanges.order(['kD', 'kA', 'kB'])([a, b, d, c])).toEqual([d, a, b, c]);
  });
});

describe('the lake on Google Maps (staff only)', () => {
  const MASCOMA_BOX = { minLng: -72.2079, minLat: 43.5999, maxLng: -72.1188, maxLat: 43.6671 };

  it('opens at the interior point — never the shoreline point — framed on the whole lake', () => {
    const row = googleMapsRow({
      ...MASCOMA,
      // A centroid on the shore, as `centroid` / `representativePoint` are on a curved lake.
      centroid: { lat: 43.6671, lng: -72.2079 },
      representativePoint: { lat: 43.6671, lng: -72.2079 },
      bbox: MASCOMA_BOX,
    });
    expect(row?.id).toBe('googleMaps');
    const url = new URL(row?.url ?? '');
    expect(url.origin + url.pathname).toBe('https://www.google.com/maps/@');
    expect(url.searchParams.get('api')).toBe('1');
    expect(url.searchParams.get('map_action')).toBe('map');
    expect(url.searchParams.get('center')).toBe('43.61740,-72.13600');
    expect(url.searchParams.get('zoom')).toBe('12');
    // Nothing else: no key, nothing about the viewer.
    expect([...url.searchParams.keys()].sort()).toEqual(['api', 'center', 'map_action', 'zoom']);
  });

  it('without an interior point, the box’s middle; with neither, no row', () => {
    const row = googleMapsRow({ name: 'X', centroid: { lat: 1, lng: 1 }, bbox: MASCOMA_BOX });
    expect(new URL(row?.url ?? '').searchParams.get('center')).toBe('43.63350,-72.16335');
    expect(googleMapsRow({ name: 'X', centroid: { lat: 1, lng: 1 } })).toBeNull();
  });

  it('with a point and no box, a pond’s zoom', () => {
    const row = googleMapsRow({ interiorPoint: { lat: 44.5, lng: -70.2 } });
    expect(new URL(row?.url ?? '').searchParams.get('zoom')).toBe('14');
  });

  it('says what it is and that skaters never read it', () => {
    const row = googleMapsRow({ ...MASCOMA, bbox: MASCOMA_BOX });
    expect(row?.label).toBe('The lake on Google Maps');
    expect(row?.sub).toMatch(/Staff only/);
    expect(row?.sub).not.toMatch(/safe|skateable|good to go/i);
    expect(googleMapsUrl({ lat: 43.6, lng: -72.1 }, 12)).toContain('zoom=12');
  });

  it('frames every lake whole around its interior point, as close as that allows (property)', () => {
    const mercY = (lat: number) => {
      const s = Math.sin((lat * Math.PI) / 180);
      return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    };
    fc.assert(
      fc.property(
        fc.double({ min: 25, max: 49, noNaN: true }),
        fc.double({ min: -124, max: -67, noNaN: true }),
        fc.double({ min: 0.0005, max: 1.5, noNaN: true }),
        fc.double({ min: 0.0005, max: 1, noNaN: true }),
        fc.double({ min: 0.05, max: 0.95, noNaN: true }),
        fc.double({ min: 0.05, max: 0.95, noNaN: true }),
        (lat, lng, w, h, fx, fy) => {
          const box = { minLng: lng, maxLng: lng + w, minLat: lat, maxLat: lat + h };
          const center = { lng: lng + w * fx, lat: lat + h * fy };
          const z = mapsZoom(center, box);
          expect(Number.isInteger(z)).toBe(true);
          expect(z).toBeGreaterThanOrEqual(3);
          expect(z).toBeLessThanOrEqual(18);
          // In pixels at that zoom, the box's far side both ways fits the 1000 × 600 view.
          const world = 256 * 2 ** z;
          const halfX = (Math.max(center.lng - box.minLng, box.maxLng - center.lng) / 360) * world;
          const cy = mercY(center.lat);
          const halfY =
            Math.max(Math.abs(mercY(box.maxLat) - cy), Math.abs(mercY(box.minLat) - cy)) * world;
          if (z > 3) {
            expect(halfX).toBeLessThanOrEqual(500 + 1e-6);
            expect(halfY).toBeLessThanOrEqual(300 + 1e-6);
          }
          // One step closer would cut the lake (unless the closest zoom is reached).
          if (z < 18) expect(halfX * 2 > 500 || halfY * 2 > 300).toBe(true);
        },
      ),
    );
  });
});
