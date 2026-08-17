import { describe, expect, it } from 'vitest';
import { orderViewportLakes, type ViewportLake } from './viewportLakes';

function lake(over: Partial<ViewportLake> & { _id: string }): ViewportLake {
  return { name: '', type: 'lakePond', ...over };
}

describe('orderViewportLakes', () => {
  it('puts favorites first, however small', () => {
    const { rows } = orderViewportLakes(
      [
        lake({ _id: 'big', name: 'Champlain', surfaceAreaSqM: 1_000_000_000 }),
        lake({ _id: 'mine', name: 'Mill Pond', surfaceAreaSqM: 40_000 }),
      ],
      new Set(['mine']),
    );
    expect(rows.map((r) => r._id)).toEqual(['mine', 'big']);
    expect(rows[0]?.isFavorite).toBe(true);
  });

  it('drops unnamed water and counts it, ranking the rest by area', () => {
    // Eleven identical "Unnamed water" rows are indistinguishable in a list, whatever their size —
    // they stay tappable on the map, where a shape in a place tells them apart.
    const { rows, unnamedCount } = orderViewportLakes([
      lake({ _id: 'u1', surfaceAreaSqM: 900_000 }),
      lake({ _id: 'small', name: 'Small Pond', surfaceAreaSqM: 10_000 }),
      lake({ _id: 'large', name: 'Large Lake', surfaceAreaSqM: 500_000 }),
    ]);
    expect(rows.map((r) => r._id)).toEqual(['large', 'small']);
    expect(unnamedCount).toBe(1);
  });

  it('drops an unnamed body even when it is a favorite', () => {
    // A favorite outranks everything *in the list*; it doesn't earn an unlabelled row a place in one.
    const { rows, unnamedCount } = orderViewportLakes(
      [lake({ _id: 'u1' }), lake({ _id: 'named', name: 'Mill Pond' })],
      new Set(['u1']),
    );
    expect(rows.map((r) => r._id)).toEqual(['named']);
    expect(unnamedCount).toBe(1);
  });

  it('counts the unnamed against the cap not at all, so a cap of 3 still lists 3 lakes', () => {
    // The cap governs *rows*. If unnamed water were filtered after slicing, a viewport that is
    // mostly ponds would render a nearly empty list and claim the rest were "more in view".
    const { rows, hiddenCount, unnamedCount } = orderViewportLakes(
      [
        ...Array.from({ length: 10 }, (_, i) => lake({ _id: `u${i}` })),
        ...Array.from({ length: 4 }, (_, i) =>
          lake({ _id: `n${i}`, name: `Lake ${i}`, surfaceAreaSqM: 100 - i }),
        ),
      ],
      new Set(),
      3,
    );
    expect(rows).toHaveLength(3);
    expect(hiddenCount).toBe(1);
    expect(unnamedCount).toBe(10);
  });

  it('keeps bodies with no recorded area, sorted last among their group', () => {
    const { rows } = orderViewportLakes([
      lake({ _id: 'unknown', name: 'Unknown Size' }),
      lake({ _id: 'known', name: 'Known Size', surfaceAreaSqM: 1 }),
    ]);
    expect(rows.map((r) => r._id)).toEqual(['known', 'unknown']);
  });

  it('breaks ties totally, so a re-render cannot reshuffle equals', () => {
    const equal = [lake({ _id: 'b', name: 'Twin' }), lake({ _id: 'a', name: 'Twin' })];
    expect(orderViewportLakes(equal).rows.map((r) => r._id)).toEqual(['a', 'b']);
    expect(orderViewportLakes([...equal].reverse()).rows.map((r) => r._id)).toEqual(['a', 'b']);
  });

  it('caps the list and reports what it left off', () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      lake({ _id: `b${i}`, name: `Lake ${i}`, surfaceAreaSqM: 1000 - i }),
    );
    const { rows, hiddenCount } = orderViewportLakes(many, new Set(), 3);
    expect(rows).toHaveLength(3);
    expect(hiddenCount).toBe(4);
  });

  it('reports nothing hidden when everything fits', () => {
    expect(orderViewportLakes([lake({ _id: 'a', name: 'A' })]).hiddenCount).toBe(0);
    expect(orderViewportLakes([]).rows).toEqual([]);
    expect(orderViewportLakes([]).unnamedCount).toBe(0);
  });

  it('does not mutate the input', () => {
    const input = [lake({ _id: 'a', name: 'A' }), lake({ _id: 'b', name: 'B' })];
    orderViewportLakes(input, new Set(['b']));
    expect(input.map((r) => r._id)).toEqual(['a', 'b']);
  });

});
