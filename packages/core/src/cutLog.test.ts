import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CUT_LOG_HEAD_LINES,
  CUT_LOG_MAX_LINES,
  CUT_LOG_TAIL_LINES,
  cutLogKey,
  formatCutLogLine,
  parseCutterLog,
} from './cutLog';

describe('the cut log contract', () => {
  it('keys an attempt under logs/, outside frames/ and cuts/', () => {
    const key = cutLogKey('2026-27', 'S2B_18TXP_20261204_0_L2A', 2);
    expect(key).toBe('logs/cuts/2026-27/S2B_18TXP_20261204_0_L2A/a2.log');
    expect(key.startsWith('frames/')).toBe(false);
    expect(key.startsWith('cuts/')).toBe(false);
  });

  it('caps at head + tail + the one warn line', () => {
    expect(CUT_LOG_HEAD_LINES + CUT_LOG_TAIL_LINES + 1).toBe(CUT_LOG_MAX_LINES);
  });

  it('parses stamped lines and keeps an unstamped one with the stamp before it', () => {
    const text = [
      formatCutLogLine(1764201600123, 'start S2B_18TXP'),
      '0...10...20',
      '',
      formatCutLogLine(1764201601000.9, 'exit 0'),
    ].join('\n');
    expect(parseCutterLog(text)).toEqual([
      { loggedAt: 1764201600123, text: 'start S2B_18TXP' },
      { loggedAt: 1764201600123, text: '0...10...20' },
      { loggedAt: 1764201601000, text: 'exit 0' },
    ]);
  });

  it('stamps an unstamped first line 0, and reads CRLF', () => {
    expect(parseCutterLog('loose\r\n1764201600123 x\r\n')).toEqual([
      { loggedAt: 0, text: 'loose' },
      { loggedAt: 1764201600123, text: 'x' },
    ]);
  });

  it('round-trips any line it formats', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_000_000_000_000, max: 9_999_999_999_999 }),
        fc.string().filter((s) => !/[\r\n]/.test(s) && s.trim() !== ''),
        (at, text) => {
          expect(parseCutterLog(formatCutLogLine(at, text))).toEqual([{ loggedAt: at, text }]);
        },
      ),
    );
  });
});
