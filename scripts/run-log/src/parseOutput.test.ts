import { describe, expect, it } from 'vitest';
import { failureReason, MAX_FAILURE_REASON_CHARS, parseConvexOutput } from './parseOutput';

/**
 * The array case is why this is tested at all: it shipped broken, and the failure mode of the fix
 * being wrong is not an exception but a *plausible* wrong answer — one element of a list handed
 * back as though it were the whole list.
 */
describe('parseConvexOutput', () => {
  // pnpm's own warning, as the seed's first dev run met it: JSON inside a line of text.
  const WARN =
    '[WARN] Unsupported engine for /repo/apps/web: wanted: {"node":"26.x"} (current: {"node":"24.19.0"})';
  const RESULT = { done: false, ready: [{ key: 'r1', args: { a: [1, 2] } }], counts: { n: 2 } };
  const PRETTY = JSON.stringify(RESULT, null, 2);

  it('takes the result, not the JSON inside a warning before it', () => {
    expect(parseConvexOutput(`${WARN}\n${PRETTY}\n`)).toEqual(RESULT);
  });

  it('takes the result with the warning after it, and on both sides', () => {
    expect(parseConvexOutput(`${PRETTY}\n${WARN}\n`)).toEqual(RESULT);
    expect(parseConvexOutput(`${WARN}\n${PRETTY}\n${WARN}\n`)).toEqual(RESULT);
  });

  it('strips ANSI codes and carriage returns', () => {
    const colored = `\x1b[33m${WARN}\x1b[39m\r\n\x1b[1m${PRETTY.replace(/\n/g, '\r\n')}\x1b[22m\r\n`;
    expect(parseConvexOutput(colored)).toEqual(RESULT);
  });

  it('takes a multi-line array whole, never one of its one-line elements', () => {
    const list = JSON.stringify(['a', 'b', 'c'], null, 2);
    expect(parseConvexOutput(`${WARN}\n${list}`)).toEqual(['a', 'b', 'c']);
  });

  it('takes a one-line string, number or null beside a warning', () => {
    expect(parseConvexOutput(`${WARN}\n"j57abc"\n`)).toBe('j57abc');
    expect(parseConvexOutput(`${WARN}\n42`)).toBe(42);
    expect(parseConvexOutput(`${WARN}\nnull\n${WARN}`)).toBeNull();
  });

  it('refuses output that holds JSON only inside lines of text', () => {
    expect(() => parseConvexOutput(`${WARN}\n`)).toThrow(/unparseable/);
  });

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
