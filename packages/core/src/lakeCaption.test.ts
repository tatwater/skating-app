import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type CaptionBasis,
  type CaptionInput,
  fetchForWind,
  formatShoreline,
  lakeCaption,
  mostExposedBearing,
  spokenDirection,
} from './lakeCaption';
import { FETCH_BEARING_COUNT } from './lakeGeometry';
import { computeDeciles } from './regionStats';

/** A Vermont-ish basis: skewed depth and elevation populations, so ranks mean something. */
const BASIS: CaptionBasis = {
  maxDepthM:
    computeDeciles(Array.from({ length: 400 }, (_, i) => 1 + (i / 400) ** 3 * 90)) ?? undefined,
  elevationM:
    computeDeciles(Array.from({ length: 400 }, (_, i) => 30 + (i / 400) ** 2 * 500)) ?? undefined,
};

const WILLOUGHBY: CaptionInput = {
  surfaceAreaSqM: 7_032_294,
  shorelineM: 18_100,
  longAxisM: 7_650,
  shortAxisM: 1_980,
  longAxisBearingDeg: 161.7,
  fetchProfileM: [
    1900, 500, 300, 200, 200, 200, 400, 4500, 1900, 1300, 1100, 1000, 1200, 1100, 1300, 3000,
  ],
  maxDepthM: 97,
  maxDepthSource: 'state_agency',
  elevationM: 357,
  stateName: 'Vermont',
  basis: BASIS,
};

describe('lakeCaption', () => {
  it('renders nothing at all for a body we know nothing about', () => {
    // The clients must show no section, not an empty one, and above all not hedged filler. A lake
    // we know nothing about should look like a lake we know nothing about.
    expect(lakeCaption({})).toBeNull();
    expect(lakeCaption({ stateName: 'Vermont', basis: BASIS })).toBeNull();
  });

  it('renders a one-clause caption for a body with only an area', () => {
    // Most of the 116,070 land here, and that is the correct outcome rather than a coverage gap.
    expect(lakeCaption({ surfaceAreaSqM: 12_000 })).toBe('3 acres.');
  });

  it('assembles every clause for a fully-populated lake', () => {
    const caption = lakeCaption(WILLOUGHBY) ?? '';
    expect(caption).toContain('1,738 acres');
    expect(caption).toContain('about 4.8 × 1.2 miles');
    expect(caption).toContain('about 11 miles of shoreline');
    expect(caption).toContain('among the deepest in Vermont');
    expect(caption).toContain('NNW–SSE');
  });

  describe('every sentence is complete (the fragment regression)', () => {
    // An earlier version only introduced a subject when a decile rank was present, so every
    // un-ranked lake — most of the corpus — read "At a measured 43 ft maximum depth — deep water
    // holds heat". Fixtures did not catch it; previewing real lakes did.
    const cases: Array<[string, CaptionInput]> = [
      ['no basis at all', { ...WILLOUGHBY, basis: undefined, stateName: undefined }],
      [
        'mid-depth, unranked',
        { maxDepthM: 13, maxDepthSource: 'lagos_us', stateName: 'Vermont', basis: BASIS },
      ],
      ['depth only, no source', { maxDepthM: 40 }],
      ['mean depth only', { meanDepthM: 4, meanDepthSource: 'hydrolakes_reported' }],
      ['fetch but no axis bearing', { fetchProfileM: WILLOUGHBY.fetchProfileM }],
      ['area only', { surfaceAreaSqM: 500_000 }],
    ];

    for (const [name, input] of cases) {
      it(name, () => {
        const caption = lakeCaption(input);
        expect(caption).not.toBeNull();
        const text = caption as string;
        expect(text.endsWith('.')).toBe(true);
        // No dangling connector left where a clause was omitted.
        expect(text).not.toMatch(/—\s*$/);
        expect(text).not.toMatch(/,\s*\./);
        expect(text).not.toMatch(/\s\s/);
        // Every sentence starts with a capital and has a subject-ish opening word.
        for (const sentence of text.split('. ')) {
          expect(sentence.trim().length).toBeGreaterThan(0);
          expect(sentence.trim()[0]).toBe(sentence.trim()[0]?.toUpperCase());
        }
      });
    }
  });

  describe('provenance framing (rule 4 / D68)', () => {
    it('a measured depth reads plainly', () => {
      expect(lakeCaption({ maxDepthM: 30, maxDepthSource: 'state_agency' })).toContain(
        'measured maximum depth',
      );
    });

    it('a modelled depth reads as an estimate', () => {
      // A 90 m-DEM guess must not sound like a depth-sounder transect.
      for (const source of ['globathy', 'hydrolakes_modeled'] as const) {
        expect(lakeCaption({ maxDepthM: 30, maxDepthSource: source })).toContain(
          'estimated maximum depth',
        );
      }
    });

    it('an unattributed depth is treated as an estimate, not as measured', () => {
      // Failing open toward "measured" would let an unlabelled number borrow authority it lacks.
      expect(lakeCaption({ maxDepthM: 30 })).toContain('estimated');
    });
  });

  describe('never predicts (rule 2 / D3)', () => {
    const forbidden = [
      /will (be )?(freeze|frozen|thaw|melt)/i,
      /\bby (mid-|early |late )?(january|february|december)/i,
      /\b(safe|unsafe|dangerous)\b/i,
      /\bis (currently |now )?(frozen|skateable|unskateable)\b/i,
      /\bthis (winter|year|season)\b/i,
      /\btoday\b/i,
    ];

    it('says nothing about this year, this ice, or safety', () => {
      // The caption is about the CLASS of lake in the present tense. The temptation to write the
      // predictive sentence is strongest here, because it is the sentence a skater is thinking.
      const inputs: CaptionInput[] = [
        WILLOUGHBY,
        { ...WILLOUGHBY, maxDepthM: 2, maxDepthSource: 'globathy' },
        { ...WILLOUGHBY, elevationM: 520 },
        { ...WILLOUGHBY, elevationM: 31 },
      ];
      for (const input of inputs) {
        const caption = lakeCaption(input) ?? '';
        for (const pattern of forbidden) expect(caption).not.toMatch(pattern);
      }
    });

    it('states tendencies about the class of lake, hedged', () => {
      expect(lakeCaption({ maxDepthM: 2, maxDepthSource: 'globathy' })).toContain('tend to');
    });
  });

  describe('depth physics only when the lake is clearly one or the other', () => {
    it('calls a shallow pond shallow from the number alone', () => {
      // An absolute physical claim the number supports without a corpus.
      expect(lakeCaption({ maxDepthM: 2 })).toContain('Shallow water gives up its heat');
    });

    it('waits for a top-decile rank before calling a lake deep', () => {
      // isShallowDepth is D69's DECAY threshold; everything over 7 m falls in its "not shallow"
      // half, which had a 43 ft pond being told "deep water holds heat".
      const midDepth = {
        maxDepthM: 13,
        maxDepthSource: 'lagos_us' as const,
        stateName: 'Vermont',
        basis: BASIS,
      };
      expect(lakeCaption(midDepth)).not.toContain('Deep water holds heat');
      expect(lakeCaption({ ...midDepth, maxDepthM: 97 })).toContain('Deep water holds heat');
    });

    it('says nothing comparative with no basis to compare against', () => {
      // decileRankOf returns null without a basis, and null must read as "say nothing".
      const caption = lakeCaption({ maxDepthM: 97, maxDepthSource: 'state_agency' }) ?? '';
      expect(caption).not.toContain('among the deepest');
      expect(caption).not.toContain('Deep water holds heat');
      expect(caption).toContain('318 ft');
    });
  });

  describe('elevation earns a clause only when it is comparative', () => {
    it('says nothing for a middling elevation', () => {
      expect(lakeCaption({ elevationM: 150, stateName: 'Vermont', basis: BASIS })).toBeNull();
    });

    it('names high and low against the state', () => {
      expect(lakeCaption({ elevationM: 520, stateName: 'Vermont', basis: BASIS })).toContain(
        'sits high for Vermont',
      );
      expect(lakeCaption({ elevationM: 31, stateName: 'Vermont', basis: BASIS })).toContain(
        'sits low for Vermont',
      );
    });
  });

  describe('thresholds that keep small bodies honest', () => {
    it('omits the dimension line on a farm pond', () => {
      // "0.3 × 0.1 miles" is false precision dressed as a fact.
      const caption = lakeCaption({ surfaceAreaSqM: 40_000, longAxisM: 300, shortAxisM: 120 });
      expect(caption).not.toContain('×');
    });

    it('omits the wind clause when there is no open water to speak of', () => {
      const caption = lakeCaption({
        surfaceAreaSqM: 40_000,
        fetchProfileM: Array.from({ length: FETCH_BEARING_COUNT }, () => 120),
      });
      expect(caption).not.toContain('wind');
    });
  });
});

describe('formatShoreline', () => {
  it('rounds to the nearest whole mile, never up (D85)', () => {
    // Rounding up systematically overstates a figure a skater may use to judge a lap.
    expect(formatShoreline(18_100)).toBe('about 11 miles of shoreline');
    expect(formatShoreline(2_500)).toBe('about 2 miles of shoreline');
  });

  it('drops the decimal entirely under a mile', () => {
    expect(formatShoreline(430)).toBe('under a mile of shoreline');
    expect(formatShoreline(1_608)).toBe('under a mile of shoreline');
  });

  it('separates thousands on a big lake', () => {
    expect(formatShoreline(2_500_000)).toContain('1,553');
  });
});

describe('mostExposedBearing', () => {
  it('finds the longest run and names its compass point', () => {
    const profile = Array.from({ length: FETCH_BEARING_COUNT }, (_, i) => (i === 4 ? 9000 : 100));
    expect(mostExposedBearing(profile)).toEqual({ point: 'E', fetchM: 9000 });
  });

  it('returns null for a missing, wrong-length or all-zero profile', () => {
    expect(mostExposedBearing(undefined)).toBeNull();
    expect(mostExposedBearing([1, 2, 3])).toBeNull();
    expect(mostExposedBearing(Array.from({ length: FETCH_BEARING_COUNT }, () => 0))).toBeNull();
  });
});

describe('fetchForWind', () => {
  const profile = Array.from({ length: FETCH_BEARING_COUNT }, (_, i) => (i + 1) * 100);

  it('reads the profile by the direction wind blows FROM', () => {
    // The convention the whole feature hangs on: reversed, it returns the LEE side's fetch, which
    // is a plausible number and exactly wrong.
    expect(fetchForWind(profile, 0)).toEqual({ point: 'N', fetchM: 100 });
    expect(fetchForWind(profile, 90)).toEqual({ point: 'E', fetchM: 500 });
    expect(fetchForWind(profile, 315)).toEqual({ point: 'NW', fetchM: 1500 });
  });

  it('wraps and rounds to the nearest compass point', () => {
    expect(fetchForWind(profile, 360)).toEqual({ point: 'N', fetchM: 100 });
    expect(fetchForWind(profile, -22.5)).toEqual({ point: 'NNW', fetchM: 1600 });
    expect(fetchForWind(profile, 350)).toEqual({ point: 'N', fetchM: 100 });
  });

  it('returns null without a usable wind direction or profile', () => {
    expect(fetchForWind(profile, undefined)).toBeNull();
    expect(fetchForWind(profile, Number.NaN)).toBeNull();
    expect(fetchForWind(undefined, 90)).toBeNull();
  });

  it('never throws for any finite bearing', () => {
    fc.assert(
      fc.property(fc.double({ min: -1e5, max: 1e5, noNaN: true }), (deg) => {
        expect(() => fetchForWind(profile, deg)).not.toThrow();
      }),
    );
  });
});

describe('spokenDirection', () => {
  it('reads as prose, not as a label', () => {
    expect(spokenDirection('NW')).toBe('the northwest');
    expect(spokenDirection('SSE')).toBe('the south-southeast');
  });
});
