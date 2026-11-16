import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MAX_MODERATOR_ALIASES,
  MAX_MODERATOR_TOWNS,
  type MergeListSide,
  mergedModeratorLists,
} from './mergeLists';
import { MAX_REFERENCE_LINKS } from './referenceLinks';

const SEEDS = [1, 42, 2026];
function check<T>(arb: fc.Arbitrary<T>, pred: (v: T) => void, numRuns = 100): void {
  for (const seed of SEEDS) fc.assert(fc.property(arb, pred), { seed, numRuns });
  fc.assert(fc.property(arb, pred), { numRuns });
}

const side = fc.record({
  name: fc.constantFrom('Mirror Lake', 'Long Pond', ''),
  moderatorTownKeys: fc.uniqueArray(
    fc.integer({ min: 0, max: 15 }).map((n) => `tiger/50007${String(n).padStart(5, '0')}`),
    { maxLength: MAX_MODERATOR_TOWNS },
  ),
  moderatorAliases: fc.uniqueArray(
    fc.integer({ min: 0, max: 30 }).map((n) => `Alias ${n}`),
    { maxLength: MAX_MODERATOR_ALIASES },
  ),
  referenceLinks: fc.uniqueArray(
    fc
      .integer({ min: 0, max: 12 })
      .map((n) => ({ label: `L${n}`, url: `https://example.org/${n}` })),
    { maxLength: 8, selector: (l) => l.url },
  ),
});

describe('mergedModeratorLists', () => {
  it('a merge that can happen holds the union of both bodies’ lists; one that can’t hold it is refused', () => {
    check(fc.tuple(side, side), ([s, l]: [MergeListSide, MergeListSide]) => {
      const m = mergedModeratorLists(s, [l]);
      const pins = new Set([...(s.moderatorTownKeys ?? []), ...(l.moderatorTownKeys ?? [])]);
      const aliases = new Set(
        [...(s.moderatorAliases ?? []), ...(l.moderatorAliases ?? [])]
          .map((a) => a.toLowerCase())
          .filter((a) => a !== s.name.toLowerCase()),
      );
      const links = new Set(
        [...(s.referenceLinks ?? []), ...(l.referenceLinks ?? [])].map((x) => x.url),
      );
      const fits =
        pins.size <= MAX_MODERATOR_TOWNS &&
        aliases.size <= MAX_MODERATOR_ALIASES &&
        links.size <= MAX_REFERENCE_LINKS;
      expect(m.refusal === null).toBe(fits);
      if (fits) {
        expect(new Set(m.pins)).toEqual(pins);
        expect(new Set(m.aliases.map((a) => a.toLowerCase()))).toEqual(aliases);
        expect(new Set(m.links.map((x) => x.url))).toEqual(links);
      }
    });
  });

  it('keeps the survivor’s own first, and says which list is over and by how much', () => {
    const s = {
      name: 'Mirror Lake',
      moderatorTownKeys: ['tiger/5000700001'],
      moderatorAliases: ['The Mirror'],
    };
    const l = {
      name: 'Other',
      moderatorTownKeys: ['tiger/5000700002', 'tiger/5000700001'],
      moderatorAliases: ['mirror lake', 'Glass'],
    };
    expect(mergedModeratorLists(s, [l])).toMatchObject({
      pins: ['tiger/5000700001', 'tiger/5000700002'],
      aliases: ['The Mirror', 'Glass'],
      refusal: null,
    });
    const many = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => `tiger/50007${String(from + i).padStart(5, '0')}`);
    expect(
      mergedModeratorLists({ name: 'Mirror Lake', moderatorTownKeys: many(0, 6) }, [
        { name: 'B', moderatorTownKeys: many(6, 4) },
      ]).refusal,
    ).toBe(
      "Can't merge into “Mirror Lake”: together the bodies hold 10 pinned towns, more than the 8 one body can. Clear some first.",
    );
    expect(
      mergedModeratorLists({ name: '' }, [
        {
          name: 'B',
          referenceLinks: Array.from({ length: 9 }, (_, i) => ({ label: `${i}`, url: `u${i}` })),
        },
      ]).refusal,
    ).toMatch(/“\(unnamed\)”.*9 reference links, more than the 8/);
    expect(
      mergedModeratorLists(
        { name: 'A', moderatorAliases: Array.from({ length: 21 }, (_, i) => `x${i}`) },
        [],
      ).refusal,
    ).toMatch(/21 moderator aliases/);
  });

  it('keeps the survivor’s own lists exactly as they stand: two links to one URL both stay', () => {
    const m = mergedModeratorLists(
      {
        name: ' Mirror Lake ',
        moderatorAliases: ['Glass'],
        referenceLinks: [
          { label: 'Association', url: 'https://example.org/a' },
          { label: 'Association (events)', url: 'https://example.org/a' },
        ],
      },
      [
        {
          name: 'Other',
          moderatorAliases: ['mirror lake', 'glass', 'Still'],
          referenceLinks: [
            { label: 'Same', url: 'https://example.org/a' },
            { label: 'Town page', url: 'https://example.org/b' },
          ],
        },
      ],
    );
    expect(m).toEqual({
      pins: [],
      // The survivor's name is matched trimmed, as the alias writer matches it.
      aliases: ['Glass', 'Still'],
      links: [
        { label: 'Association', url: 'https://example.org/a' },
        { label: 'Association (events)', url: 'https://example.org/a' },
        { label: 'Town page', url: 'https://example.org/b' },
      ],
      refusal: null,
    });
  });
});
