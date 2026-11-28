import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  attemptMachineMs,
  CUT_LOG_HEAD_LINES,
  CUT_LOG_LINE_MAX,
  CUT_LOG_MAX_LINES,
  CUT_LOG_TAIL_LINES,
  type CutExit,
  type CutLogLine,
  type CutterLogLine,
  cutLogKey,
  exitLineText,
  type FlyLogLine,
  formatCutLogLine,
  type MergeCutLogInput,
  mergeCutLog,
  type PumpLogLine,
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

// ─── The merge ────────────────────────────────────────────────────────────────────────────────────

const T0 = 1_764_201_600_000;
const at = fc.integer({ min: T0, max: T0 + 600_000 });
const text = fc.string({ maxLength: 40 });
const cutterLine = fc.record<CutterLogLine>({ loggedAt: at, text });
const flyLine = fc.record<FlyLogLine>({
  loggedAt: at,
  text,
  source: fc.constantFrom('app' as const, 'runner' as const),
});
const pumpLine = fc.record<PumpLogLine>({ loggedAt: at, text });
const exitArb: fc.Arbitrary<CutExit | null> = fc.option(
  fc.record<CutExit>({
    exitCode: fc.option(fc.integer({ min: 0, max: 255 })),
    oomKilled: fc.option(fc.boolean()),
    exitedAt: fc.option(at),
  }),
);
/** A cutter log in time order, as the tee writes it. */
const sortedCutter = (max: number) =>
  fc.array(cutterLine, { maxLength: max }).map((ls) => ls.sort((a, b) => a.loggedAt - b.loggedAt));
const inputs = (cutterMax: number, flyMax: number): fc.Arbitrary<MergeCutLogInput> =>
  fc.record({
    cutter: sortedCutter(cutterMax),
    fly: fc.array(flyLine, { maxLength: flyMax }),
    exit: exitArb,
    pump: fc.array(pumpLine, { maxLength: 4 }),
  });
/** Inputs big enough to cross the cap often. */
const big = inputs(2_600, 200);
const small = inputs(60, 30);

const isExitLine = (l: CutLogLine, exit: CutExit | null) =>
  l.origin === 'fly' && exit !== null && l.text === exitLineText(exit);

describe('mergeCutLog', () => {
  it('orders by time, the cutter first on a tie, then Fly, then the pump (under the cap)', () => {
    fc.assert(
      fc.property(small, (input) => {
        const { lines, dropped } = mergeCutLog(input);
        expect(dropped).toBe(0);
        const rank = { cutter: 0, fly: 1, pump: 2 };
        for (let i = 1; i < lines.length; i++) {
          const a = lines[i - 1] as CutLogLine;
          const b = lines[i] as CutLogLine;
          expect(
            a.loggedAt < b.loggedAt ||
              (a.loggedAt === b.loggedAt && rank[a.origin] <= rank[b.origin]),
          ).toBe(true);
        }
      }),
    );
  });

  it('is never above the cap, and says how many it left out', () => {
    fc.assert(
      fc.property(big, (input) => {
        const { lines, dropped } = mergeCutLog(input);
        expect(lines.length).toBeLessThanOrEqual(CUT_LOG_MAX_LINES);
        if (dropped > 0) {
          expect(lines).toHaveLength(CUT_LOG_MAX_LINES);
          const warn = lines[CUT_LOG_HEAD_LINES] as CutLogLine;
          expect(warn).toMatchObject({ origin: 'pump', kind: 'warn' });
          expect(warn.text).toContain(String(dropped));
        }
      }),
      { numRuns: 60 },
    );
  });

  it('always keeps the exit line and the cutter’s last line, whatever the cap drops', () => {
    fc.assert(
      fc.property(big, (input) => {
        const { lines } = mergeCutLog(input);
        const exitText = input.exit === null ? null : exitLineText(input.exit);
        if (exitText !== null) {
          expect(lines.filter((l) => isExitLine(l, input.exit))).toHaveLength(1);
        }
        const last = input.cutter.at(-1);
        if (last !== undefined) {
          expect(
            lines.some(
              (l) =>
                l.origin === 'cutter' &&
                l.loggedAt === last.loggedAt &&
                l.text === last.text.slice(0, CUT_LOG_LINE_MAX),
            ),
          ).toBe(true);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('keeps an exit line and a cutter end that fall in the middle, still at the cap', () => {
    // 2,500 cutter lines, then 1,800 runner lines after the exit: the exit and the cutter's last
    // line sit in what the cap drops.
    const cutter = Array.from({ length: 2_500 }, (_, i) => ({ loggedAt: T0 + i, text: `c${i}` }));
    const fly = Array.from({ length: 1_800 }, (_, i) => ({
      loggedAt: T0 + 10_000 + i,
      text: `r${i}`,
      source: 'runner' as const,
    }));
    const exit = { exitCode: 137, oomKilled: true, exitedAt: T0 + 5_000 };
    const { lines, dropped } = mergeCutLog({ cutter, fly, exit, pump: [] });
    expect(lines).toHaveLength(CUT_LOG_MAX_LINES);
    expect(dropped).toBe(2_500 + 1_800 + 1 - (CUT_LOG_MAX_LINES - 1));
    expect(lines.some((l) => l.text === 'exit 137 · out of memory' && l.kind === 'fail')).toBe(
      true,
    );
    expect(lines.some((l) => l.text === 'c2499')).toBe(true);
    // Still in time order around the kept middle.
    const times = lines.filter((l) => l.origin !== 'pump').map((l) => l.loggedAt);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('never doubles an app line the upload already holds', () => {
    fc.assert(
      fc.property(small, (input) => {
        const { lines } = mergeCutLog(input);
        const end = Math.max(Number.NEGATIVE_INFINITY, ...input.cutter.map((l) => l.loggedAt));
        const apps = input.fly.filter((l) => l.source === 'app');
        const keptFly = lines.filter((l) => l.origin === 'fly' && !isExitLine(l, input.exit));
        // Every runner line is kept; an app line only when later than the cutter's end.
        const expected = input.fly.filter((l) => l.source === 'runner' || l.loggedAt > end).length;
        expect(keptFly).toHaveLength(expected);
        for (const l of keptFly) {
          const app = apps.find((a) => a.text === l.text && a.loggedAt === l.loggedAt);
          if (
            app &&
            !input.fly.some(
              (r) => r.source === 'runner' && r.text === l.text && r.loggedAt === l.loggedAt,
            )
          ) {
            expect(l.loggedAt).toBeGreaterThan(end);
          }
        }
      }),
    );
  });

  it('drops an app line stamped at the upload’s last millisecond, keeps the one after', () => {
    const { lines } = mergeCutLog({
      cutter: [{ loggedAt: T0 + 5, text: 'warping' }],
      fly: [
        { loggedAt: T0 + 5, text: 'warping', source: 'app' },
        { loggedAt: T0 + 6, text: 'uploading', source: 'app' },
      ],
      exit: null,
      pump: [],
    });
    expect(lines.map((l) => l.text)).toEqual(['warping', 'uploading']);
  });

  it('is idempotent on its own output (under the cap)', () => {
    fc.assert(
      fc.property(small, (input) => {
        const once = mergeCutLog(input).lines;
        // The output fed back as its sources: the cutter's as the upload, Fly's (the exit line
        // included) as runner lines, the pump's as the pump's.
        const again = mergeCutLog({
          cutter: once
            .filter((l) => l.origin === 'cutter')
            .map(({ loggedAt, text }) => ({ loggedAt, text })),
          fly: once
            .filter((l) => l.origin === 'fly')
            .map(({ loggedAt, text }) => ({ loggedAt, text, source: 'runner' as const })),
          exit: null,
          pump: once
            .filter((l) => l.origin === 'pump')
            .map(({ loggedAt, text, kind }) => ({ loggedAt, text, kind })),
        }).lines;
        expect(again.map((l) => [l.origin, l.loggedAt, l.text])).toEqual(
          once.map((l) => [l.origin, l.loggedAt, l.text]),
        );
      }),
    );
  });

  it('trims every text, and tones the lines', () => {
    const { lines } = mergeCutLog({
      cutter: [
        { loggedAt: T0, text: 'x'.repeat(900) },
        { loggedAt: T0 + 1, text: 'exit 1' },
      ],
      fly: [
        {
          loggedAt: T0 + 2,
          text: 'Out of memory: Killed process 412 (gdalwarp)',
          source: 'runner',
        },
        { loggedAt: T0 + 3, text: 'machine stopped', source: 'runner' },
      ],
      exit: { exitCode: 0, oomKilled: false, exitedAt: T0 + 4 },
      pump: [{ loggedAt: T0 - 1, text: 'spawned on shared-cpu-4x · 2 GB' }],
    });
    expect(
      lines.map((l) => [l.origin, l.kind, l.text.length > 100 ? l.text.length : l.text]),
    ).toEqual([
      ['pump', 'stage', 'spawned on shared-cpu-4x · 2 GB'],
      ['cutter', 'line', CUT_LOG_LINE_MAX],
      ['cutter', 'fail', 'exit 1'],
      ['fly', 'fail', 'Out of memory: Killed process 412 (gdalwarp)'],
      ['fly', 'warn', 'machine stopped'],
      ['fly', 'line', 'exit 0'],
    ]);
  });

  it('words the exit event, and sends nothing for an empty one', () => {
    expect(exitLineText({ exitCode: 137, oomKilled: true, exitedAt: 1 })).toBe(
      'exit 137 · out of memory',
    );
    expect(exitLineText({ exitCode: null, oomKilled: true, exitedAt: null })).toBe(
      'exit (no code) · out of memory',
    );
    expect(exitLineText({ exitCode: 2, oomKilled: null, exitedAt: null })).toBe('exit 2');
    expect(exitLineText({ exitCode: null, oomKilled: null, exitedAt: null })).toBeNull();
    expect(
      mergeCutLog({
        cutter: [],
        fly: [],
        exit: { exitCode: null, oomKilled: null, exitedAt: null },
        pump: [],
      }).lines,
    ).toEqual([]);
  });

  it('stamps an exit with no time at the latest line', () => {
    const { lines } = mergeCutLog({
      cutter: [{ loggedAt: T0 + 9, text: 'last' }],
      fly: [],
      exit: { exitCode: 1, oomKilled: null, exitedAt: null },
      pump: [],
    });
    expect(lines.at(-1)).toEqual({ origin: 'fly', kind: 'fail', loggedAt: T0 + 9, text: 'exit 1' });
  });
});

describe('attemptMachineMs', () => {
  const base = {
    startedAt: null,
    exitedAt: null,
    cutter: [],
    spawnedAt: T0,
    settledAt: T0 + 180_000,
    ran: true,
  };
  it('takes Fly’s start and exit first, then the cutter’s stamps, then the settle', () => {
    expect(attemptMachineMs({ ...base, startedAt: T0 + 5, exitedAt: T0 + 65 })).toEqual({
      ms: 60,
      from: 'fly',
    });
    expect(
      attemptMachineMs({
        ...base,
        cutter: [
          { loggedAt: T0 + 100, text: 'a' },
          { loggedAt: 0, text: 'loose' },
          { loggedAt: T0 + 40, text: 'b' },
        ],
      }),
    ).toEqual({ ms: 60, from: 'cutter' });
    expect(attemptMachineMs({ ...base, cutter: [{ loggedAt: T0, text: 'one' }] })).toEqual({
      ms: 180_000,
      from: 'settle',
    });
    // An exit before its start (clock skew) is not a measure.
    expect(attemptMachineMs({ ...base, startedAt: T0 + 9, exitedAt: T0 + 1 })).toEqual({
      ms: 180_000,
      from: 'settle',
    });
    expect(attemptMachineMs({ ...base, ran: false })).toBeNull();
  });

  it('is never negative', () => {
    fc.assert(
      fc.property(
        fc.option(at),
        fc.option(at),
        fc.array(cutterLine, { maxLength: 5 }),
        at,
        at,
        (startedAt, exitedAt, cutter, spawnedAt, settledAt) => {
          const r = attemptMachineMs({
            startedAt,
            exitedAt,
            cutter,
            spawnedAt,
            settledAt,
            ran: true,
          });
          expect(r?.ms).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});
