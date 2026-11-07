import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { downsample, GPX_MAX_POINTS, planGpxFile, planGpxIngest } from './gpxParse';

/** A GPX document of `n` timed points, a second apart, wandering a little each step. */
function gpx(n: number): string {
  const start = Date.now() - 2 * 60 * 60_000;
  const pts = Array.from({ length: n }, (_, i) => {
    const lat = 43.62 + (i % 97) * 0.00005 + i * 0.000001;
    const lng = -72.15 + (i % 89) * 0.00005;
    const t = new Date(start + i * 1000).toISOString();
    return `<trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"><time>${t}</time></trkpt>`;
  }).join('');
  return `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>${pts}</trkseg></trk></gpx>`;
}

describe('downsample', () => {
  it('never returns more than the cap, for any input', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer(), { maxLength: 3000 }),
        fc.integer({ min: 2, max: 500 }),
        (xs, max) => {
          expect(downsample(xs, max).length).toBeLessThanOrEqual(max);
        },
      ),
    );
  });

  it('keeps both endpoints and the order — a subsequence of the input', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4000 }), fc.integer({ min: 2, max: 300 }), (n, max) => {
        const xs = Array.from({ length: n }, (_, i) => i);
        const out = downsample(xs, max);
        expect(out[0]).toBe(0);
        expect(out[out.length - 1]).toBe(n - 1);
        for (let i = 1; i < out.length; i += 1) {
          expect(out[i] as number).toBeGreaterThan(out[i - 1] as number);
        }
        // Under the cap, nothing is thrown away.
        if (n <= max) expect(out).toEqual(xs);
        else expect(out).toHaveLength(max);
      }),
    );
  });

  it('keeps timestamps monotone wherever the input’s were', () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 10_000 }), { minLength: 1, maxLength: 3000 }),
        fc.integer({ min: 2, max: 400 }),
        (gaps, max) => {
          let t = 0;
          const points = gaps.map((g) => {
            t += g;
            return { t };
          });
          const out = downsample(points, max);
          for (let i = 1; i < out.length; i += 1) {
            expect((out[i] as { t: number }).t).toBeGreaterThanOrEqual(
              (out[i - 1] as { t: number }).t,
            );
          }
        },
      ),
    );
  });

  it('treats a cap under two as two, so a track keeps both its ends', () => {
    expect(downsample([1, 2, 3, 4], 1)).toEqual([1, 4]);
    expect(downsample([], 10)).toEqual([]);
  });
});

describe('planGpxIngest', () => {
  it('thins a long file to what the server stores and buckets the size it read', () => {
    const plan = planGpxIngest(gpx(9000), 'report-1');
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.path.coordinates.length).toBeLessThanOrEqual(GPX_MAX_POINTS);
    expect(plan.pointCount).toBeGreaterThan(GPX_MAX_POINTS);
    expect(plan.idempotencyKey.startsWith('gpx:report-1:')).toBe(true);
    expect(plan.endTime).toBeGreaterThan(plan.startTime);
  });

  it('leaves a short file whole', () => {
    const plan = planGpxIngest(gpx(50), 'r');
    expect(plan.ok && plan.path.coordinates.length === plan.pointCount).toBe(true);
  });

  it('hands back core’s sentence for a file that is not a track', () => {
    expect(planGpxIngest('<html></html>', 'r')).toEqual({
      ok: false,
      message: "That file isn't a GPX track with times in it.",
    });
  });
});

describe('planGpxFile', () => {
  it('refuses a file too big to be one skate before reading it', async () => {
    const file = new File(['x'], 'huge.gpx');
    Object.defineProperty(file, 'size', { value: 50 * 1024 * 1024 });
    await expect(planGpxFile(file, 'r')).resolves.toEqual({
      ok: false,
      message: "That file is too big to be one skate's track.",
    });
  });

  it('reads and plans a file that fits', async () => {
    const plan = await planGpxFile(new File([gpx(20)], 'skate.gpx'), 'r');
    expect(plan.ok).toBe(true);
  });
});
