import { describe, expect, it } from 'vitest';
import { parseConvexOutput } from './parseOutput';

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
