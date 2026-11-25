import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CLAIM_SOURCES, REVIEW_REASONS, type ReviewReason } from './confidence';
import {
  EVIDENCE_MAX_BYTES,
  type EvidenceRecord,
  reviewEvidence,
  spellingKey,
  UNRECORDED_EVIDENCE,
} from './reviewEvidence';
import { WATER_BODY_CLASSES } from './types';

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe('reviewEvidence — a name conflict', () => {
  const basin: EvidenceRecord = {
    nameClaims: [
      { source: 'nhd', value: 'The Basin' },
      { source: 'osm', value: 'Lake Auburn' },
    ],
  };

  it('is the distinct catalog spellings, keyed and sorted', () => {
    expect(reviewEvidence('name-conflict', basin)).toBe('names:["lake auburn","the basin"]');
  });

  it('ignores a moderator’s own claim: it is the decision, not what raised the question', () => {
    const picked: EvidenceRecord = {
      nameClaims: [{ source: 'user', value: 'Lake Auburn' }, ...(basin.nameClaims ?? [])],
    };
    expect(reviewEvidence('name-conflict', picked)).toBe(reviewEvidence('name-conflict', basin));
  });

  it('ignores which catalogs publish a spelling, so the campaign that first records them asks nothing', () => {
    const recorded: EvidenceRecord = {
      nameClaims: [
        { source: 'gnis', value: 'The Basin', sources: ['gnis', 'nhd', '3dhp'] },
        { source: 'osm', value: 'Lake Auburn', sources: ['osm'] },
      ],
    };
    expect(reviewEvidence('name-conflict', recorded)).toBe(reviewEvidence('name-conflict', basin));
  });

  it('treats case, spacing and repeats as one spelling', () => {
    const respaced: EvidenceRecord = {
      nameClaims: [
        { source: 'gnis', value: '  the   BASIN ' },
        { source: 'nhd', value: 'The Basin' },
        { source: 'osm', value: 'Lake Auburn' },
      ],
    };
    expect(reviewEvidence('name-conflict', respaced)).toBe(reviewEvidence('name-conflict', basin));
  });

  it('changes when a spelling is added or withdrawn', () => {
    const added: EvidenceRecord = {
      nameClaims: [...(basin.nameClaims ?? []), { source: '3dhp', value: 'Auburn Reservoir' }],
    };
    const withdrawn: EvidenceRecord = { nameClaims: [{ source: 'nhd', value: 'The Basin' }] };
    const base = reviewEvidence('name-conflict', basin);
    expect(reviewEvidence('name-conflict', added)).not.toBe(base);
    expect(reviewEvidence('name-conflict', withdrawn)).not.toBe(base);
  });

  it('is unrecorded with no catalog claim stored, a user claim alone, or only blanks', () => {
    expect(reviewEvidence('name-conflict', {})).toBe(UNRECORDED_EVIDENCE);
    expect(reviewEvidence('name-conflict', { nameClaims: [] })).toBe(UNRECORDED_EVIDENCE);
    expect(
      reviewEvidence('name-conflict', { nameClaims: [{ source: 'user', value: 'Mine' }] }),
    ).toBe(UNRECORDED_EVIDENCE);
    expect(reviewEvidence('name-conflict', { nameClaims: [{ source: 'osm', value: '  ' }] })).toBe(
      UNRECORDED_EVIDENCE,
    );
  });

  it('ignores the class claims', () => {
    expect(
      reviewEvidence('name-conflict', {
        ...basin,
        classClaims: [{ source: 'nhd', value: 'wetland', token: 'nhd:fcode=46600' }],
      }),
    ).toBe(reviewEvidence('name-conflict', basin));
  });
});

describe('reviewEvidence — a class conflict', () => {
  const bog: EvidenceRecord = {
    classClaims: [
      { source: 'nhd', value: 'wetland', token: 'nhd:fcode=46600' },
      { source: 'osm', value: 'lakePond', token: 'osm:water=pond' },
    ],
  };

  it('is each catalog’s class with its token, sorted', () => {
    expect(reviewEvidence('class-conflict', bog)).toBe(
      'classes:[["nhd","wetland","nhd:fcode=46600"],["osm","lakePond","osm:water=pond"]]',
    );
  });

  it('changes when a class, a token or a catalog changes', () => {
    const base = reviewEvidence('class-conflict', bog);
    const reclassed: EvidenceRecord = {
      classClaims: [
        { source: 'nhd', value: 'lakePond', token: 'nhd:fcode=46600' },
        { source: 'osm', value: 'lakePond', token: 'osm:water=pond' },
      ],
    };
    const retokened: EvidenceRecord = {
      classClaims: [
        { source: 'nhd', value: 'wetland', token: 'nhd:fcode=46602' },
        { source: 'osm', value: 'lakePond', token: 'osm:water=pond' },
      ],
    };
    const added: EvidenceRecord = {
      classClaims: [...(bog.classClaims ?? []), { source: '3dhp', value: 'wetland' }],
    };
    for (const changed of [reclassed, retokened, added]) {
      expect(reviewEvidence('class-conflict', changed)).not.toBe(base);
    }
  });

  it('differs once tokens arrive, so a settle made before the campaign that carries them is asked again', () => {
    const untokened: EvidenceRecord = {
      classClaims: [
        { source: 'nhd', value: 'wetland' },
        { source: 'osm', value: 'lakePond' },
      ],
    };
    expect(reviewEvidence('class-conflict', untokened)).not.toBe(
      reviewEvidence('class-conflict', bog),
    );
  });

  it('is unrecorded with no class claim stored', () => {
    expect(reviewEvidence('class-conflict', {})).toBe(UNRECORDED_EVIDENCE);
    expect(reviewEvidence('class-conflict', { classClaims: [] })).toBe(UNRECORDED_EVIDENCE);
  });

  it('ignores the name claims', () => {
    expect(
      reviewEvidence('class-conflict', { ...bog, nameClaims: [{ source: 'osm', value: 'Bog' }] }),
    ).toBe(reviewEvidence('class-conflict', bog));
  });
});

describe('reviewEvidence — the reasons 6a does not settle', () => {
  it('is null for every other reason, class-dissent included', () => {
    const settled: readonly ReviewReason[] = ['name-conflict', 'class-conflict'];
    for (const reason of REVIEW_REASONS) {
      if (settled.includes(reason)) continue;
      expect(reviewEvidence(reason, { nameClaims: [{ source: 'osm', value: 'X' }] })).toBeNull();
    }
  });
});

describe('reviewEvidence — its size', () => {
  it('stays within 1 KiB, as a digest that still tells unequal evidence apart', () => {
    const many = (suffix: string): EvidenceRecord => ({
      nameClaims: Array.from({ length: 60 }, (_, i) => ({
        source: 'osm',
        value: `A very long name for a lake, number ${i}${suffix}`,
      })),
    });
    const a = reviewEvidence('name-conflict', many('')) ?? '';
    const b = reviewEvidence('name-conflict', many('!')) ?? '';
    expect(bytes(a)).toBeLessThanOrEqual(EVIDENCE_MAX_BYTES);
    expect(a).toMatch(/^names#[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
    expect(reviewEvidence('name-conflict', many(''))).toBe(a);
  });

  it('keys a spelling by case, spacing and Unicode form', () => {
    expect(spellingKey('  Lac  \u00c9cho ')).toBe(spellingKey('lac E\u0301cho'));
  });
});

// ── The properties (D40: fast-check for what a settle is held to) ───────────────────────────────────────────

const CATALOGS = CLAIM_SOURCES.filter((s) => s !== 'user');
const spelling = fc.constantFrom(
  'The Basin',
  'Lake Auburn',
  'Bear Pond',
  'Bean Pond',
  'Mud Pond',
  'Lac Écho',
  'Grand Lake',
  'East Grand Lake',
);
const nameClaim = fc.record(
  {
    source: fc.constantFrom(...CATALOGS),
    value: spelling,
    sources: fc.uniqueArray(fc.constantFrom(...CATALOGS), { maxLength: 4 }),
  },
  { requiredKeys: ['source', 'value'] },
);
const userClaim = fc.record({ source: fc.constant('user'), value: spelling });
const classClaim = fc.record(
  {
    source: fc.constantFrom(...CATALOGS),
    value: fc.constantFrom(...WATER_BODY_CLASSES),
    token: fc.constantFrom(
      'nhd:fcode=46600',
      'nhd:fcode=39004',
      'osm:water=pond',
      'osm:natural=water',
    ),
  },
  { requiredKeys: ['source', 'value'] },
);
const RUNS = { numRuns: 2_000 };

function keysOf(claims: readonly { source: string; value: string }[]): Set<string> {
  return new Set(claims.filter((c) => c.source !== 'user').map((c) => spellingKey(c.value)));
}

describe('reviewEvidence — properties', () => {
  it('a name conflict’s is independent of claim order, user claims and each claim’s sources', () => {
    fc.assert(
      fc.property(
        fc.array(nameClaim, { maxLength: 6 }),
        fc.array(userClaim, { maxLength: 3 }),
        fc.integer(),
        (claims, users, seed) => {
          const base = reviewEvidence('name-conflict', { nameClaims: claims });
          const shuffled = shuffle([...claims, ...users], seed).map((c) =>
            'sources' in c ? { source: c.source, value: c.value } : c,
          );
          expect(reviewEvidence('name-conflict', { nameClaims: shuffled })).toBe(base);
        },
      ),
      RUNS,
    );
  });

  it('a name conflict’s changes exactly when the set of catalog spellings does', () => {
    fc.assert(
      fc.property(
        fc.array(nameClaim, { maxLength: 6 }),
        fc.array(nameClaim, { maxLength: 6 }),
        (a, b) => {
          const same = sameSet(keysOf(a), keysOf(b));
          const ea = reviewEvidence('name-conflict', { nameClaims: a });
          const eb = reviewEvidence('name-conflict', { nameClaims: b });
          expect(ea === eb).toBe(same);
        },
      ),
      RUNS,
    );
  });

  it('a name conflict’s changes when a new catalog spelling is added', () => {
    fc.assert(
      fc.property(fc.array(nameClaim, { maxLength: 6 }), nameClaim, (claims, added) => {
        fc.pre(!keysOf(claims).has(spellingKey(added.value)));
        expect(reviewEvidence('name-conflict', { nameClaims: [...claims, added] })).not.toBe(
          reviewEvidence('name-conflict', { nameClaims: claims }),
        );
      }),
      RUNS,
    );
  });

  it('a class conflict’s is independent of claim order and user claims, and changes with any claim', () => {
    fc.assert(
      fc.property(
        fc.array(classClaim, { maxLength: 6 }),
        fc.integer(),
        fc.constantFrom(...WATER_BODY_CLASSES),
        (claims, seed, cls) => {
          const base = reviewEvidence('class-conflict', { classClaims: claims });
          const withUser = shuffle([...claims, { source: 'user', value: cls }], seed);
          expect(reviewEvidence('class-conflict', { classClaims: withUser })).toBe(base);
          const entry = (c: { source: string; value: string; token?: string }) =>
            JSON.stringify([c.source, c.value, c.token ?? null]);
          const present = new Set(claims.map(entry));
          const changed = { source: 'nhd', value: cls, token: 'nhd:fcode=99999' };
          fc.pre(!present.has(entry(changed)));
          expect(reviewEvidence('class-conflict', { classClaims: [...claims, changed] })).not.toBe(
            base,
          );
        },
      ),
      RUNS,
    );
  });

  it('is deterministic and never past 1 KiB, for every reason', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...REVIEW_REASONS),
        fc.array(
          fc.record({ source: fc.constantFrom(...CATALOGS), value: fc.string({ maxLength: 80 }) }),
          { maxLength: 40 },
        ),
        fc.array(classClaim, { maxLength: 8 }),
        (reason, names, classes) => {
          const record = { nameClaims: names, classClaims: classes };
          const e = reviewEvidence(reason, record);
          expect(reviewEvidence(reason, record)).toBe(e);
          if (e !== null) expect(bytes(e)).toBeLessThanOrEqual(EVIDENCE_MAX_BYTES);
        },
      ),
      RUNS,
    );
  });
});

function sameSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/** A deterministic shuffle from a seed (fast-check's own shrinking keeps the seed). */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
