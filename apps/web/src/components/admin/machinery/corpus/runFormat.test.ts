import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { at, ZONE } from './runFixtures';
import {
  clock,
  clockSeconds,
  count,
  coverageLedger,
  elapsedParts,
  everyWords,
  formatBytes,
  groupCounts,
  groupStages,
  headlineCounts,
  humanize,
  isoDay,
  quietPart,
  quietWords,
  stripPrefix,
  tookWords,
} from './runFormat';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('clock words', () => {
  test('a time in the reader zone, 24-hour', () => {
    expect(clock(at(12, 58), ZONE)).toBe('12:58');
    expect(clockSeconds(at(13, 26, 4), ZONE)).toBe('13:26:04');
    expect(clock(at(12, 58), 'UTC')).toBe('16:58');
    expect(isoDay(Date.UTC(2026, 9, 11, 12), ZONE)).toBe('2026-10-11');
  });

  test('counts read with thousands commas', () => {
    expect(count(9412)).toBe('9,412');
  });
});

describe('durations', () => {
  test('elapsed in the board parts', () => {
    expect(elapsedParts(42_900)).toEqual([{ value: '42', unit: 's' }]);
    expect(elapsedParts(14 * MIN + 59_000)).toEqual([{ value: '14', unit: 'm' }]);
    expect(elapsedParts(HOUR + 14 * MIN)).toEqual([
      { value: '1', unit: 'h' },
      { value: '14', unit: 'm' },
    ]);
    expect(elapsedParts(-5)).toEqual([{ value: '0', unit: 's' }]);
    expect(elapsedParts(Number.NaN)).toEqual([{ value: '0', unit: 's' }]);
  });

  test('took, as the passes table writes it', () => {
    expect(tookWords(42_000)).toBe('42 s');
    expect(tookWords(4 * MIN + 10_000)).toBe('4 m 10');
    expect(tookWords(22 * MIN + 41_000)).toBe('22 m 41');
    expect(tookWords(HOUR + 3 * MIN)).toBe('1 h 03');
  });

  test('quiet: seconds, then minutes under 100, then hours', () => {
    expect(quietPart(18_400)).toEqual({ value: '18', unit: 's' });
    expect(quietPart(41 * MIN)).toEqual({ value: '41', unit: 'min' });
    expect(quietPart(99 * MIN + 59_000)).toEqual({ value: '99', unit: 'min' });
    expect(quietPart(100 * MIN)).toEqual({ value: '1', unit: 'h' });
    expect(quietWords(41 * MIN)).toBe('41 min');
  });

  test('an expected gap', () => {
    expect(everyWords(3 * MIN)).toBe('3 min');
    expect(everyWords(90_000)).toBe('90 s');
    expect(everyWords(2 * HOUR)).toBe('2 h');
  });

  // Every age a page shows is never negative, and never moves back as time goes on.
  test('ages never negative, and monotone in time (property)', () => {
    const minutes = (p: { value: string; unit: string }) =>
      Number(p.value) * (p.unit === 'h' ? 60 : p.unit === 'min' || p.unit === 'm' ? 1 : 1 / 60);
    fc.assert(
      fc.property(
        fc.integer({ min: -HOUR, max: 72 * HOUR }),
        fc.integer({ min: 0, max: 72 * HOUR }),
        (a, d) => {
          const q1 = quietPart(a);
          const q2 = quietPart(a + d);
          expect(Number(q1.value)).toBeGreaterThanOrEqual(0);
          // The quiet is rounded down within its unit, so a later read is never smaller.
          expect(minutes(q2) + (q2.unit === 'h' ? 60 : 1)).toBeGreaterThan(minutes(q1));
          const e1 = elapsedParts(a).reduce((s, p) => s + minutes(p), 0);
          const e2 = elapsedParts(a + d).reduce((s, p) => s + minutes(p), 0);
          expect(e1).toBeGreaterThanOrEqual(0);
          expect(e2 + 1).toBeGreaterThan(e1);
          expect(tookWords(a)).not.toMatch(/-/);
        },
      ),
    );
  });

  test('quiet never reads more than the time that passed (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 72 * HOUR }), (ms) => {
        const p = quietPart(ms);
        const unitMs = p.unit === 'h' ? HOUR : p.unit === 'min' ? MIN : 1_000;
        expect(Number(p.value) * unitMs).toBeLessThanOrEqual(ms);
        expect((Number(p.value) + 1) * unitMs).toBeGreaterThan(ms);
      }),
    );
  });
});

describe('names and sizes', () => {
  test('humanize', () => {
    expect(humanize('droppedByAreaFloor')).toBe('Dropped by area floor');
    expect(humanize('osm.dropped.below-hard-floor')).toBe('Osm · dropped · below hard floor');
    expect(humanize('NHD_ids')).toBe('NHD ids');
    expect(stripPrefix('refused.no-class')).toBe('no-class');
    expect(stripPrefix('inserted')).toBe('inserted');
  });

  test('bytes', () => {
    expect(formatBytes(412)).toBe('412 B');
    expect(formatBytes(318 * 1024 ** 2)).toBe('318 MB');
    expect(formatBytes(1.9 * 1024 ** 3)).toBe('1.9 GB');
    expect(formatBytes(5 * 1024 ** 5)).toBe('5120 TB');
  });
});

describe('the record, grouped', () => {
  test('counts file under their prefix, totals first in the loader order, the rest biggest first', () => {
    const groups = groupCounts([
      { name: 'refused.no-class', value: 3 },
      { name: 'groups', value: 10 },
      { name: 'refused.over-silence', value: 9 },
      { name: 'emitted', value: 7 },
      { name: 'weird.x', value: 1 },
    ]);
    expect(groups.map((g) => g.title)).toEqual(['Totals', 'Refused', 'Weird']);
    expect(groups[0]?.counts.map((c) => c.name)).toEqual(['groups', 'emitted']);
    expect(groups[1]?.counts.map((c) => c.value)).toEqual([9, 3]);
  });

  test('stages group by family, consecutively', () => {
    const families = groupStages([
      { name: 'osm · vt' },
      { name: 'osm · nh' },
      { name: 'merge' },
      { name: 'osm · me' },
    ]);
    expect(families.map((f) => [f.key, f.stages.length])).toEqual([
      ['osm', 2],
      ['merge', 1],
      ['osm', 1],
    ]);
  });

  test('coverage: the unexplained remainder is computed, never trusted', () => {
    const l = coverageLedger({
      unit: 'bodies',
      eligible: 100,
      covered: 60,
      omissions: [
        { reason: 'small', count: 10 },
        { reason: 'big', count: 20 },
      ],
    });
    expect(l.pct).toBe(60);
    expect(l.unexplained).toBe(10);
    expect(l.omissions.map((o) => o.reason)).toEqual(['big', 'small']);
    expect(l.widest).toBe(20);
    expect(coverageLedger({ unit: 'x', eligible: 0, covered: 0, omissions: [] }).pct).toBe(0);
  });

  test('headline: the last stage first, then the known names, then the unprefixed', () => {
    expect(
      headlineCounts({ stages: [{ name: 'load', counts: [{ name: 'a', value: 1 }] }], counts: [] }),
    ).toEqual([{ name: 'a', value: 1 }]);
    expect(
      headlineCounts({
        stages: [],
        counts: [
          { name: 'x', value: 1 },
          { name: 'updated', value: 2 },
        ],
      }),
    ).toEqual([{ name: 'updated', value: 2 }]);
    expect(
      headlineCounts({
        stages: [{ name: 's' }],
        counts: [
          { name: 'p.q', value: 1 },
          { name: 'x', value: 2 },
        ],
      }),
    ).toEqual([{ name: 'x', value: 2 }]);
  });
});
