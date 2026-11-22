import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ACCESS_NOW,
  AFTER_NO_ACCESS,
  DISPUTE,
  FIRST_REPORT,
  JAMIE,
  LUC,
  MANY,
  READ_ONLY,
} from './accessHandlerFixtures';
import {
  accessBar,
  accessStats,
  accessTimeline,
  bodyKicker,
  daysBetween,
  hasBar,
  headBadge,
  ifBlocks,
  receiptDetail,
  receiptTitle,
  reporterCount,
  standingLine,
  verdictWords,
} from './accessModel';

const TZ = 'America/New_York';
const rows = (r: { label: string; value: string }[]) =>
  Object.fromEntries(r.map((x) => [x.label, x.value]));

describe('the words of a ruling', () => {
  it('says accessible, never open', () => {
    expect(verdictWords('open')).toBe('Ruled accessible');
    expect(verdictWords('none')).toBe('Ruled no public access');
    for (const t of [
      ...accessStats(DISPUTE, ACCESS_NOW).map((s) => s.label),
      ...Object.values(rows(ifBlocks(DISPUTE, TZ).accessible)),
      receiptTitle('open'),
    ])
      expect(t).not.toMatch(/\bopen\b/i);
  });

  it('says what a ruling did to the reports, and that a clear closed none', () => {
    expect(receiptDetail('none', 2)).toBe('2 reports closed · reporters told');
    expect(receiptDetail('open', 1204)).toBe('1,204 reports dismissed · reporters told');
    // One report: one reporter told.
    expect(receiptDetail('none', 1)).toBe('1 report closed · the reporter told');
    expect(receiptDetail('open', 1)).toBe('1 report dismissed · the reporter told');
    // None closed: nobody was told, and the line never says they were.
    expect(receiptDetail('none', 0)).toBe('No report was open to close');
    expect(receiptDetail('open', 0)).toBe('No report was open to dismiss');
    for (const n of [0, 1, 2, 7]) {
      expect(receiptDetail('none', n).includes('told')).toBe(n > 0);
      expect(receiptDetail('open', n).includes('told')).toBe(n > 0);
    }
    // Whatever count a clear came back with, it never claims a report closed.
    for (const n of [0, 3])
      expect(receiptDetail('clear', n)).toBe('The reports stay open, in the lane');
  });

  it('names each receipt for what landed', () => {
    expect(receiptTitle('none')).toBe('Ruled no public access');
    expect(receiptTitle('clear')).toBe('Cleared the ruling');
  });
});

describe('the head', () => {
  it('reads a dispute of an accessible ruling in red, a report after a no-access one in gray', () => {
    expect(headBadge(DISPUTE)).toEqual({ text: 'Disputes a ruling', tone: 'bad' });
    expect(headBadge(AFTER_NO_ACCESS)).toEqual({
      text: 'After a no-access ruling',
      tone: 'default',
    });
    expect(headBadge(FIRST_REPORT)).toBeNull();
  });

  it('writes the body’s line as the board does', () => {
    expect(bodyKicker(DISPUTE.body)).toBe('Reservoir · Troy, NY · 1,650 ac');
    expect(bodyKicker({ ...DISPUTE.body, place: null, areaSqM: null })).toBe('Reservoir');
  });
});

describe('the stats', () => {
  it('counts the contest-access asks only under a no-access ruling, where they can exist', () => {
    const stats = accessStats(AFTER_NO_ACCESS, ACCESS_NOW);
    expect(stats.map((x) => x.id)).toEqual(['noAccess', 'contest', 'ruling']);
    expect(stats[1]).toEqual({
      id: 'contest',
      label: 'Ask for access back',
      value: '2',
      unit: 'skaters',
      sub: 'Contesting the ruling',
    });
    const one = { ...AFTER_NO_ACCESS, contestAsks: { count: 1, capped: false } };
    expect(accessStats(one, ACCESS_NOW)[1]).toMatchObject({ value: '1', unit: 'skater' });
    const many = { ...AFTER_NO_ACCESS, contestAsks: { count: 200, capped: true } };
    expect(accessStats(many, ACCESS_NOW)[1]).toMatchObject({ value: '200+', unit: 'skaters' });
    // Under an accessible ruling, or none, nobody can have asked: no figure, rather than a "0".
    expect(accessStats(DISPUTE, ACCESS_NOW).map((x) => x.id)).toEqual(['noAccess', 'ruling']);
    expect(accessStats(FIRST_REPORT, ACCESS_NOW).map((x) => x.id)).toEqual(['noAccess', 'ruling']);
  });

  it('counts the reporters since the ruling, in red while they dispute it, and the ruling’s age', () => {
    expect(accessStats(DISPUTE, ACCESS_NOW)).toEqual([
      {
        id: 'noAccess',
        label: 'Say no access',
        value: '2',
        unit: 'skaters',
        tone: 'bad',
        sub: 'Since the ruling',
      },
      {
        id: 'ruling',
        label: 'Ruled accessible',
        value: '32',
        unit: 'days ago',
        sub: 'By Teagan Atwater',
      },
    ]);
  });

  it('says there is no ruling yet, and the count in no tone, on a first report', () => {
    const [say, ruling] = accessStats(FIRST_REPORT, ACCESS_NOW);
    expect(say).toEqual({ id: 'noAccess', label: 'Say no access', value: '1', unit: 'skater' });
    expect(ruling).toEqual({
      id: 'ruling',
      label: 'Ruling',
      value: 'No ruling yet',
      sub: 'First reports on this body',
    });
  });

  it('says one day, and names a ruler who is gone', () => {
    const r = {
      ...DISPUTE,
      ruling: {
        ...(DISPUTE.ruling as NonNullable<typeof DISPUTE.ruling>),
        by: null,
        ruledAt: ACCESS_NOW - 86_400_000,
      },
    };
    expect(accessStats(r, ACCESS_NOW)[1]).toMatchObject({
      value: '1',
      unit: 'day ago',
      sub: 'By A former moderator',
    });
    expect(accessStats(AFTER_NO_ACCESS, ACCESS_NOW)[0]).not.toHaveProperty('tone');
  });

  it('counts people, not flags; a flag the app filed counts once on its own', () => {
    expect(reporterCount(MANY)).toBe(6);
    const twice = {
      ...DISPUTE,
      reports: [
        ...DISPUTE.reports,
        { ...(DISPUTE.reports[0] as (typeof DISPUTE.reports)[0]), flagId: 'x' as never },
      ],
    };
    expect(reporterCount(twice)).toBe(2);
  });

  it('never reads a negative age (a clock a little behind)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2e12 }),
        fc.integer({ min: -1e9, max: 1e11 }),
        (from, d) => {
          const days = daysBetween(from, from + d);
          expect(days).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(days)).toBe(true);
          if (d >= 0) expect(days).toBe(Math.floor(d / 86_400_000));
        },
      ),
    );
  });
});

describe('the timeline', () => {
  it('runs newest first: the two reports, the ruling, the reports it dismissed', () => {
    const t = accessTimeline(DISPUTE);
    expect(t.map((e) => e.kind)).toEqual(['report', 'report', 'ruling', 'dismissed']);
    expect(t[0]).toMatchObject({ filer: LUC });
    expect(t[1]).toMatchObject({ filer: JAMIE });
    expect(t[2]).toMatchObject({
      verdict: 'open',
      note: 'The town says the dam-road launch is public.',
      reason: 'The town clerk, by email',
    });
    // A blank citation is none.
    const blank = {
      ...DISPUTE,
      ruling: { ...(DISPUTE.ruling as NonNullable<typeof DISPUTE.ruling>), reason: '  ' },
    };
    expect(accessTimeline(blank)[2]).toMatchObject({ reason: null });
    // Two reporters saying the same words read once; both are named.
    expect(t[3]).toMatchObject({ count: 2, notes: ['Gate across the dam road'] });
    expect(t[3]?.kind === 'dismissed' && t[3].filers.map((f) => f.displayName)).toEqual([
      'Kate Donovan',
      'Pat Lavoie',
    ]);
  });

  it('holds only the reports when there is no ruling', () => {
    expect(accessTimeline(FIRST_REPORT).map((e) => e.kind)).toEqual(['report']);
  });

  it('is ordered newest first whatever order the read hands it, ties in their order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1e6 }), { minLength: 1, maxLength: 8 }),
        (ats) => {
          const item = {
            ...FIRST_REPORT,
            reports: ats.map((at, i) => ({
              ...(FIRST_REPORT.reports[0] as (typeof FIRST_REPORT.reports)[0]),
              flagId: `f${i}` as never,
              filedAt: at,
            })),
          };
          const t = accessTimeline(item);
          for (let i = 1; i < t.length; i++)
            expect((t[i - 1]?.at ?? 0) >= (t[i]?.at ?? 0)).toBe(true);
          expect(t).toHaveLength(ats.length);
        },
      ),
    );
  });

  it('drops a dismissed report’s byline when its filer is gone, and skips an empty note', () => {
    const item = {
      ...DISPUTE,
      dismissedByRuling: DISPUTE.dismissedByRuling.map((d, i) => ({
        ...d,
        filer: i ? d.filer : null,
        note: null,
      })),
    };
    const last = accessTimeline(item).at(-1);
    expect(last).toMatchObject({ kind: 'dismissed', notes: [], count: 2 });
    expect(last?.kind === 'dismissed' && last.filers).toHaveLength(1);
  });

  it('writes a reporter’s standing as a byline does, and none for someone gone', () => {
    expect(standingLine(LUC)).toBe('Trusted · 22 pts');
    expect(standingLine({ ...LUC, trustClass: null })).toBeNull();
  });
});

describe('the two futures', () => {
  it('says what each ruling does against a standing accessible ruling (the board)', () => {
    const { noAccess, accessible } = ifBlocks(DISPUTE, TZ);
    expect(rows(noAccess)).toEqual({
      Body: 'Dimmed, off the active map',
      Reports: 'Both closed · reporters told',
      Ruling: 'Replaces 12 Sep’s',
      Reason: 'Asked for when you choose it',
    });
    expect(rows(accessible)).toEqual({
      Body: 'Unchanged',
      Reports: 'Dismissed · reporters told',
      Ruling: 'Re-dated today',
    });
  });

  it('after a no-access ruling, and with none at all', () => {
    expect(rows(ifBlocks(AFTER_NO_ACCESS, TZ).noAccess)).toMatchObject({
      Body: 'Unchanged',
      Reports: 'The report closed · the reporter told',
      Ruling: 'Re-dated today',
    });
    expect(rows(ifBlocks(AFTER_NO_ACCESS, TZ).accessible)).toMatchObject({
      Body: 'Back on the active map',
      Reports: 'Dismissed · the reporter told',
      Ruling: 'Replaces 20 Sep’s',
    });
    expect(rows(ifBlocks(FIRST_REPORT, TZ).noAccess).Ruling).toBe('The first on this body');
    expect(rows(ifBlocks(MANY, TZ).noAccess).Reports).toBe('All 6 closed · reporters told');
  });
});

describe('the bar', () => {
  it('draws each verb only where the item’s can allows it', () => {
    expect(accessBar(DISPUTE)).toEqual({
      noAccess: true,
      accessible: true,
      clear: 'Clear the accessible ruling',
    });
    expect(accessBar(AFTER_NO_ACCESS).clear).toBe('Clear the no-access ruling');
    // A refusal's sentence is not drawn; nor is a ruling to clear when there is none.
    expect(accessBar(FIRST_REPORT).clear).toBeNull();
    expect(accessBar({ ...DISPUTE, ruling: null }).clear).toBeNull();
    expect(accessBar({ ...DISPUTE, can: {} })).toEqual({
      noAccess: false,
      accessible: false,
      clear: null,
    });
  });

  it('draws no bar for a viewer refused every verb', () => {
    expect(hasBar(accessBar(READ_ONLY))).toBe(false);
    expect(hasBar(accessBar(DISPUTE))).toBe(true);
    expect(hasBar({ noAccess: false, accessible: false, clear: 'x' })).toBe(true);
  });
});
