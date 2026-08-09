import { describe, expect, it } from 'vitest';
import { failureReason, MAX_FAILURE_REASON_CHARS, parseConvexOutput } from './parseOutput';

/**
 * The array case is why this is tested at all: it shipped broken, and the failure mode of the fix
 * being wrong is not an exception but a *plausible* wrong answer — one element of a list handed
 * back as though it were the whole list.
 */
describe('parseConvexOutput', () => {
  it('parses an array return without mistaking an element for the whole', () => {
    const rows = [
      { kind: 'raw_archive', label: 'VT', startedAt: 1 },
      { kind: 'raw_archive', label: 'NH', startedAt: 2 },
    ];
    expect(parseConvexOutput(JSON.stringify(rows))).toEqual(rows);
  });

  it('still finds an array when something else reached stdout first', () => {
    expect(parseConvexOutput('some cli noise\n[{"a":1},{"a":2}]\n')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('prefers the array over an object nested inside it', () => {
    // The exact shape of the original bug: the object pattern also matches here.
    const out = parseConvexOutput<unknown[]>('noise\n[{"a":1},{"a":2}]');
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(2);
  });

  it('parses objects, ids, numbers and booleans', () => {
    expect(parseConvexOutput('{"inserted":3}')).toEqual({ inserted: 3 });
    expect(parseConvexOutput('"run_abc123"')).toBe('run_abc123');
    expect(parseConvexOutput('42')).toBe(42);
    expect(parseConvexOutput('true')).toBe(true);
    expect(parseConvexOutput('null')).toBeNull();
  });

  it('treats empty output as undefined rather than throwing', () => {
    expect(parseConvexOutput('   \n')).toBeUndefined();
  });

  it('throws on output with nothing JSON-shaped in it', () => {
    expect(() => parseConvexOutput('command not found')).toThrow(/unparseable/);
  });
});

describe('failureReason — a failure record that cannot be stored is a failure nobody sees', () => {
  it('drops the command echo, which is the payload and the least informative part', () => {
    // Measured 2026-08-08: 19 failed loader batches each recorded their whole argv — 150 bodies of
    // GeoJSON apiece — and the run row hit 1.65 MiB, so `importRuns:progress` threw
    // `Value is too large` and the failure record was lost entirely.
    const message = [
      `Command failed: pnpm exec convex run waterBodies:importCanonical {"bodies":[${'x'.repeat(400_000)}]}`,
      '✖ Failed to run function "waterBodies:importCanonical":',
      'ArgumentValidationError: Value does not match validator.',
      'Path: .bodies[116].reviewReasons[0]',
      'Value: "class-dissent"',
    ].join('\n');
    const reason = failureReason(message);
    expect(reason).not.toContain('xxxx');
    expect(reason).toContain('ArgumentValidationError');
    expect(reason).toContain('.bodies[116].reviewReasons[0]');
    expect(reason.length).toBeLessThanOrEqual(MAX_FAILURE_REASON_CHARS);
  });

  it('keeps a short message exactly as it was', () => {
    expect(failureReason('ENOENT: no such file')).toBe('ENOENT: no such file');
  });

  it('marks a truncation rather than trimming silently', () => {
    // A reason that has been cut and does not say so reads as a complete message that ends oddly.
    const reason = failureReason(`${'y'.repeat(900)}`, 100);
    expect(reason).toMatch(/… \[truncated 800 chars\]$/);
  });

  it('keeps a bounded head when the whole message was the command echo', () => {
    // "It failed and we saved nothing" is worse than a truncated argv.
    const reason = failureReason(`Command failed: ${'z'.repeat(5000)}`, 80);
    expect(reason.length).toBeGreaterThan(0);
    expect(reason).toContain('Command failed');
  });
});
