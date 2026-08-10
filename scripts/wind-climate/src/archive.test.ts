import { describe, expect, it } from 'vitest';

import {
  estimateFetchMinutes,
  formatBytes,
  manifestPath,
  missingResponses,
  redactApiKey,
  responsePath,
  WTK_MEASURED_LATENCY_MS,
} from './archive';
import { WTK_REQUEST_DELAY_MS, WTK_YEARS, wtkUrl } from './wtk';

describe('redactApiKey', () => {
  it('strips the key out of a resolved URL', () => {
    // The manifest is the field most likely to be shared — mirrored to R2, pasted into a handoff —
    // and the resolved URL is the most useful thing in it. Those two facts collide exactly here.
    const url = wtkUrl({ lat: 44.75, lng: -72.06 }, 2012, 'SECRET-KEY', 'a@b.c');
    const safe = redactApiKey(url);
    expect(safe).not.toContain('SECRET-KEY');
    expect(safe).toContain('api_key=REDACTED');
    // Everything else has to survive, or the field stops being useful.
    expect(new URL(safe).searchParams.get('wkt')).toBe('POINT(-72.06 44.75)');
    expect(new URL(safe).searchParams.get('names')).toBe('2012');
  });

  it('leaves a URL with no key alone', () => {
    expect(redactApiKey('https://example.test/x?a=1')).toBe('https://example.test/x?a=1');
  });

  it('does not eat the parameter after it', () => {
    expect(redactApiKey('https://x.test/?api_key=abc&email=a@b.c')).toBe(
      'https://x.test/?api_key=REDACTED&email=a@b.c',
    );
  });
});

describe('archive paths', () => {
  it('files one response per cell-year', () => {
    expect(responsePath('44.7500,-72.0540', 2012)).toBe('44.7500,-72.0540/2012.csv.gz');
    expect(manifestPath('44.7500,-72.0540')).toBe('44.7500,-72.0540/manifest.json');
  });
});

describe('missingResponses — the whole incremental story', () => {
  it('returns everything against an empty archive', () => {
    expect(missingResponses(['a', 'b'], [2010, 2011], new Set())).toEqual([
      { gridKey: 'a', year: 2010 },
      { gridKey: 'a', year: 2011 },
      { gridKey: 'b', year: 2010 },
      { gridKey: 'b', year: 2011 },
    ]);
  });

  it('returns nothing when the archive is complete — a second run costs nothing', () => {
    // This is what makes 7.7 hours a one-time cost rather than a recurring one, and what lets a
    // killed run resume by re-running the same command.
    const have = new Set(['a/2010.csv.gz', 'a/2011.csv.gz']);
    expect(missingResponses(['a'], [2010, 2011], have)).toEqual([]);
  });

  it('returns only the difference after a partial fetch', () => {
    const have = new Set(['a/2010.csv.gz', 'b/2010.csv.gz']);
    expect(missingResponses(['a', 'b'], [2010, 2011], have)).toEqual([
      { gridKey: 'a', year: 2011 },
      { gridKey: 'b', year: 2011 },
    ]);
  });

  it('asks for a new cell without re-asking for the old ones', () => {
    // The corpus grows; the archive should only ever pay for the delta.
    const have = new Set(WTK_YEARS.map((y) => `old/${y}.csv.gz`));
    const wanted = missingResponses(['old', 'new'], WTK_YEARS, have);
    expect(wanted).toHaveLength(WTK_YEARS.length);
    expect(wanted.every((w) => w.gridKey === 'new')).toBe(true);
  });
});

describe('estimateFetchMinutes', () => {
  it('counts response latency, not just the pacing delay', () => {
    // ⚠ The reason this function exists. The old loader printed "~96 min at 1/s" for a job that
    // takes 7.7 hours, because it counted only the deliberate pause and ignored the 5.3 s response.
    // An estimate wrong by 5× is worse than none, because somebody plans around it.
    // The handoff hand-computed **7.7 h** for 5,225 requests, independently and a week earlier.
    // Landing on the same figure from a measured latency is the cross-check worth having here.
    const requests = 5225;
    const honest = estimateFetchMinutes(requests, WTK_MEASURED_LATENCY_MS, WTK_REQUEST_DELAY_MS);
    const pacingOnly = estimateFetchMinutes(requests, 0, WTK_REQUEST_DELAY_MS);
    expect(honest / 60).toBeGreaterThan(7);
    expect(honest / 60).toBeLessThan(8.5);
    // 4.03 s of latency against 1.10 s of pacing — the delay is under a quarter of the truth, which
    // is why counting only the delay was wrong by 5×.
    expect(honest).toBeGreaterThan(pacingOnly * 3.5);
  });

  it('is zero for nothing to fetch', () => {
    expect(estimateFetchMinutes(0, WTK_MEASURED_LATENCY_MS, WTK_REQUEST_DELAY_MS)).toBe(0);
  });

  it('is traceable to a measurement rather than a feeling', () => {
    // 5,910 responses over 8.55 h on 2026-08-09: median gap 5.13 s less 1.10 s of pacing. The
    // previous value (5,300 ms) came from ONE request and was 31% pessimistic — it still produced a
    // usable estimate, which is the argument for measuring at all.
    expect(WTK_MEASURED_LATENCY_MS).toBe(4030);
  });

  it('would have estimated the real run to within a quarter', () => {
    // The actual snapshot: 5,907 requests, 8.55 h. An estimate that lands here is doing its job;
    // the failure this function replaced was off by 5×.
    const hours = estimateFetchMinutes(5907, WTK_MEASURED_LATENCY_MS, WTK_REQUEST_DELAY_MS) / 60;
    expect(hours).toBeGreaterThan(7);
    expect(hours).toBeLessThan(10.7);
  });
});

describe('formatBytes', () => {
  it('scales so the log line tells somebody whether to worry about disk', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 ** 2)).toBe('5.0 MB');
    // The full archive is ~0.37 GB gzipped — which lands in MB here, because the switch to GB is
    // at a full GiB. Worth pinning: the number a log line prints is what somebody compares against
    // R2's 10 GB free tier, and "379 MB" and "0.37 GB" are the same fact wearing different units.
    expect(formatBytes(0.37 * 1024 ** 3)).toBe('378.9 MB');
    expect(formatBytes(2.5 * 1024 ** 3)).toBe('2.50 GB');
  });
});
