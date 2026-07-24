import { describe, expect, it } from 'vitest';
import {
  bucketIndex,
  bucketLabels,
  COUNTER_METRIC_KEYS,
  countBy,
  HOUR_BUCKETS,
  histogram,
  hoursBetween,
  METRIC_KEYS,
  METRICS,
  metricDay,
  metricDayRange,
  metricDayStart,
  REPUTATION_POINT_BUCKETS,
  rate,
} from './metrics';
import { CONTRADICTION_FLAG_THRESHOLD, TRUST_CLASS_THRESHOLDS } from './reputationConfig';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('metricDay', () => {
  it('keys a timestamp to its UTC calendar day', () => {
    expect(metricDay(Date.parse('2026-01-15T13:45:00Z'))).toBe('2026-01-15');
  });

  it('keeps the whole UTC day in one bucket, edge to edge', () => {
    expect(metricDay(Date.parse('2026-01-15T00:00:00.000Z'))).toBe('2026-01-15');
    expect(metricDay(Date.parse('2026-01-15T23:59:59.999Z'))).toBe('2026-01-15');
  });

  it('round-trips through metricDayStart', () => {
    const ms = Date.parse('2026-03-02T09:12:00Z');
    expect(metricDay(metricDayStart(metricDay(ms)))).toBe(metricDay(ms));
  });

  it('sorts lexicographically in chronological order (the index-range guarantee)', () => {
    const days = [
      metricDay(Date.parse('2026-01-09T00:00:00Z')),
      metricDay(Date.parse('2025-12-31T00:00:00Z')),
      metricDay(Date.parse('2026-01-10T00:00:00Z')),
    ];
    expect([...days].sort()).toEqual(['2025-12-31', '2026-01-09', '2026-01-10']);
  });
});

describe('metricDayRange', () => {
  it('returns `count` consecutive days, oldest first, ending today', () => {
    const end = Date.parse('2026-01-15T13:00:00Z');
    expect(metricDayRange(end, 3)).toEqual(['2026-01-13', '2026-01-14', '2026-01-15']);
  });

  it('crosses a month boundary', () => {
    expect(metricDayRange(Date.parse('2026-03-01T05:00:00Z'), 2)).toEqual([
      '2026-02-28',
      '2026-03-01',
    ]);
  });

  it('is empty for a zero-length window', () => {
    expect(metricDayRange(Date.now(), 0)).toEqual([]);
  });
});

describe('bucketIndex', () => {
  const edges = [0, 10, 20, 50] as const;

  it('places a value in the bucket its lower edge owns', () => {
    expect(bucketIndex(0, edges)).toBe(0);
    expect(bucketIndex(9, edges)).toBe(0);
    expect(bucketIndex(10, edges)).toBe(1);
    expect(bucketIndex(49, edges)).toBe(2);
  });

  it('puts everything past the last edge in the open-ended overflow bucket', () => {
    expect(bucketIndex(50, edges)).toBe(3);
    expect(bucketIndex(1e9, edges)).toBe(3);
  });

  it('never drops a value below the first edge — it lands in bucket 0, not nowhere', () => {
    expect(bucketIndex(-5, edges)).toBe(0);
  });
});

describe('histogram', () => {
  it('produces one count per edge and conserves the input total', () => {
    const values = [0, 3, 12, 18, 25, 60, 999];
    const counts = histogram(values, [0, 10, 20, 50]);
    expect(counts).toEqual([2, 2, 1, 2]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(values.length);
  });

  it('is all zeroes for no values', () => {
    expect(histogram([], HOUR_BUCKETS)).toEqual(HOUR_BUCKETS.map(() => 0));
  });
});

describe('bucketLabels', () => {
  it('renders ranges, singletons, and an open-ended tail', () => {
    expect(bucketLabels([0, 1, 2, 3, 5, 10])).toEqual(['0', '1', '2', '3–4', '5–9', '10+']);
  });
});

describe('bucket edge choices', () => {
  it('makes every trust-class cutoff a reputation-histogram boundary', () => {
    // The chart exists to show whether a cutoff bunches people; a cutoff mid-bucket would hide that.
    for (const threshold of Object.values(TRUST_CLASS_THRESHOLDS)) {
      expect(REPUTATION_POINT_BUCKETS).toContain(threshold);
    }
  });

  it('hinges the contradiction histogram on the flag threshold', () => {
    const spec = METRICS.contradiction_count_hist;
    expect(spec.edges).toContain(CONTRADICTION_FLAG_THRESHOLD);
  });

  it('keeps every bucket-edge array strictly ascending', () => {
    for (const key of METRIC_KEYS) {
      const edges = METRICS[key].edges;
      if (!edges) continue;
      for (let i = 1; i < edges.length; i++) {
        expect(edges[i]).toBeGreaterThan(edges[i - 1] as number);
      }
    }
  });
});

describe('the metric vocabulary', () => {
  it('gives every bucketed metric its edges, and no other metric any', () => {
    for (const key of METRIC_KEYS) {
      const spec = METRICS[key];
      expect(spec.shape === 'buckets').toBe(spec.edges !== undefined);
    }
  });

  it('describes every metric — the control-room renders the description, so a blank one is a bug', () => {
    for (const key of METRIC_KEYS) {
      expect(METRICS[key].label.length).toBeGreaterThan(0);
      expect(METRICS[key].description.length).toBeGreaterThan(20);
    }
  });

  it('splits the keys into exactly the counter and rollup families', () => {
    expect(COUNTER_METRIC_KEYS.length).toBeGreaterThan(0);
    expect(COUNTER_METRIC_KEYS.every((k) => METRICS[k].kind === 'counter')).toBe(true);
    const rollups = METRIC_KEYS.filter((k) => !COUNTER_METRIC_KEYS.includes(k));
    expect(rollups.every((k) => METRICS[k].kind === 'rollup')).toBe(true);
    expect(COUNTER_METRIC_KEYS.length + rollups.length).toBe(METRIC_KEYS.length);
  });
});

describe('countBy', () => {
  it('tallies occurrences and omits absent keys', () => {
    expect(countBy(['a', 'b', 'a', 'a'])).toEqual({ a: 3, b: 1 });
    expect(countBy([])).toEqual({});
  });
});

describe('rate', () => {
  it('is the share of the total', () => {
    expect(rate(1, 4)).toBe(0.25);
  });

  it('reads a zero denominator as no-attempts, never NaN on an axis', () => {
    expect(rate(0, 0)).toBe(0);
  });
});

describe('hoursBetween', () => {
  it('measures elapsed hours', () => {
    expect(hoursBetween(0, DAY_MS)).toBe(24);
  });

  it('floors clock skew at zero rather than charting a negative age', () => {
    expect(hoursBetween(DAY_MS, 0)).toBe(0);
  });
});
