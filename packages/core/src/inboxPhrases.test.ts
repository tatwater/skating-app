import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AROUND_IT_PHRASE_KEYS,
  type AroundItReport,
  aroundItPhrases,
  measuredMeanCm,
} from './inbox';

const reading = fc.record({
  valueCm: fc.option(fc.double({ min: 0, max: 40, noNaN: true }), { nil: undefined }),
  minCm: fc.option(fc.double({ min: 0, max: 40, noNaN: true }), { nil: undefined }),
  maxCm: fc.option(fc.double({ min: 0, max: 40, noNaN: true }), { nil: undefined }),
  method: fc.constantFrom('measured', 'estimated', 'poke'),
});
const chips = (keys: string[]) =>
  fc.array(fc.record({ type: fc.constantFrom(...keys) }), { maxLength: 3 });
const report: fc.Arbitrary<AroundItReport> = fc.record({
  iceThickness: fc.option(fc.record({ readings: fc.array(reading, { maxLength: 3 }) }), {
    nil: null,
  }),
  sightings: chips(['open', 'skim', 'frozen', 'snow_covered']),
  suitability: fc.constantFrom('dont_go', 'experienced_only', 'beginner_friendly', null),
  surfaceTags: chips(['glass', 'wet', 'slushy', 'overflow', 'rough']),
});

/** A recount of each phrase by its field rule, written apart from the function. */
function recount(flagged: AroundItReport, others: AroundItReport[]) {
  const mine = measuredMeanCm(flagged);
  const n = (pred: (r: AroundItReport) => boolean) => others.filter(pred).length;
  const mean = (r: AroundItReport) => measuredMeanCm(r);
  return {
    measured_less: n((r) => mine !== null && mean(r) !== null && (mean(r) as number) < mine - 0.5),
    measured_more: n((r) => mine !== null && mean(r) !== null && (mean(r) as number) > mine + 0.5),
    open_water: n((r) => (r.sightings ?? []).some((s) => s.type === 'open')),
    skim_ice: n((r) => (r.sightings ?? []).some((s) => s.type === 'skim')),
    dont_go: n((r) => r.suitability === 'dont_go'),
    wet_or_slushy: n((r) =>
      (r.surfaceTags ?? []).some((s) => ['wet', 'slushy', 'overflow'].includes(s.type)),
    ),
  };
}

describe('aroundItPhrases', () => {
  it('every phrase’s count is a recount of the rows by its field rule, in order, none zero', () => {
    fc.assert(
      fc.property(report, fc.array(report, { maxLength: 12 }), (flagged, others) => {
        const phrases = aroundItPhrases(flagged, others);
        const want = recount(flagged, others);
        expect(phrases).toEqual(
          AROUND_IT_PHRASE_KEYS.filter((k) => want[k] > 0).map((k) => ({ key: k, count: want[k] })),
        );
      }),
      { numRuns: 500 },
    );
  });

  it('an estimate never counts as measured, nor does a lower bound', () => {
    const flagged = { iceThickness: { readings: [{ valueCm: 9, method: 'measured' }] } };
    const est = { iceThickness: { readings: [{ valueCm: 2, method: 'estimated' }] } };
    const bound = { iceThickness: { readings: [{ minCm: 2, method: 'measured' }] } };
    expect(aroundItPhrases(flagged, [est, bound])).toEqual([]);
    expect(
      aroundItPhrases(flagged, [
        { iceThickness: { readings: [{ minCm: 1, maxCm: 3, method: 'measured' }] } },
      ]),
    ).toEqual([{ key: 'measured_less', count: 1 }]);
  });

  it('nothing measured on the flagged report: no measured phrase at all', () => {
    const other = { iceThickness: { readings: [{ valueCm: 2, method: 'measured' }] } };
    expect(aroundItPhrases({}, [other])).toEqual([]);
  });
});
