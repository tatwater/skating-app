import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { callerNow } from './callerClock';

const SLACK = 5 * 60_000;
const SERVER = Date.UTC(2026, 10, 13, 12);

describe('callerNow — the page’s clock, held near the server’s', () => {
  it('reads the server’s clock when the caller sends none, or nonsense', () => {
    expect(callerNow(undefined, SERVER, SLACK)).toBe(SERVER);
    expect(callerNow(Number.NaN, SERVER, SLACK)).toBe(SERVER);
    expect(callerNow(Number.POSITIVE_INFINITY, SERVER, SLACK)).toBe(SERVER);
  });

  it('takes a clock within the slack as it is, and pulls one past it back to the edge', () => {
    expect(callerNow(SERVER - 60_000, SERVER, SLACK)).toBe(SERVER - 60_000);
    expect(callerNow(SERVER - 12 * 3_600_000, SERVER, SLACK)).toBe(SERVER - SLACK);
    expect(callerNow(SERVER + 3 * 86_400_000, SERVER, SLACK)).toBe(SERVER + SLACK);
  });

  it('never strays past the slack, whatever the caller sends', () => {
    fc.assert(
      fc.property(fc.double(), fc.integer({ min: 0, max: 2e12 }), (asked, server) => {
        const now = callerNow(asked, server, SLACK);
        expect(Math.abs(now - server)).toBeLessThanOrEqual(SLACK);
        if (Number.isFinite(asked) && Math.abs(asked - server) <= SLACK) expect(now).toBe(asked);
      }),
    );
  });
});
