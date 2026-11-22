import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ACCESS_ROW,
  ACTIVATE_ROW,
  ADMIT_NO_MATCH_ROW,
  ADMIT_ROW,
  ALERT_ROW,
  ALL_OPEN_ROWS,
  AUTO_ROW,
  BAY_ROW,
  DRAWN_ROW,
  decidedRow,
  MATT,
  NOW,
  PHOTO_ROW,
  PLACE_ROW,
  SAFETY_ROW,
  TICKET_ROW,
  WITHDRAWN_ROW,
} from './inboxFixtures';
import { acres, decidedSince, flowEntries, miles, percent, rowAge, rowView } from './inboxModel';
import type { InboxRowView } from './inboxTypes';

const H = 3_600_000;
const D = 24 * H;
const labels = (row: InboxRowView) => rowView(row, NOW).chips.map((c) => c.label);

describe('a row, as the boards draw it', () => {
  it('2.1: the safety flag — red reason, the report, who wrote and flagged it', () => {
    const v = rowView(SAFETY_ROW, NOW);
    expect(v.chips).toEqual([
      { label: 'unsafe', tone: 'bad' },
      { label: 'report', tone: 'default' },
    ]);
    expect(v.title).toBe('“Black ice, 3½" at the beach, held fine”');
    expect(v.sub).toBe('Mascoma Lake · by Rob Tremblay · flagged by Sarah Berman');
    expect(v.age).toBe('4 d');
    expect(v.done).toBe(false);
  });

  it('2.2: access reports — the dispute in red, then how many reported', () => {
    const v = rowView(ACCESS_ROW, NOW);
    expect(v.chips).toEqual([
      { label: 'disputes 12 Sep', tone: 'bad' },
      { label: '2 reports', tone: 'default' },
    ]);
    expect(v.title).toBe('Tomhannock Reservoir');
    expect(v.sub).toBe('Troy, NY · “gated at the dam road, no shoulder”');
  });

  it('2.3: an admit with a catalog match, and one with none', () => {
    expect(labels(ADMIT_ROW)).toEqual(['catalog match · 41 ac', 'admission']);
    expect(rowView(ADMIT_ROW, NOW).title).toBe('Unnamed pond near Groton, VT');
    expect(rowView(ADMIT_ROW, NOW).sub).toBe('Asked by 2 · “the one behind the state forest lot”');
    const none = rowView(ADMIT_NO_MATCH_ROW, NOW);
    expect(none.chips[0]).toEqual({ label: 'no candidate', tone: 'warn' });
    expect(none.sub).toBe('No 3DHP feature within 150 m');
    expect(rowView(ACTIVATE_ROW, NOW).sub).toBe('Piermont, NH · Asked by 2');
  });

  it('2.4: a landmark ask with its lookalike, and a bay ask with its askers', () => {
    expect(rowView(PLACE_ROW, NOW).chips[0]).toEqual({ label: 'lookalike 0.4 mi', tone: 'warn' });
    expect(rowView(PLACE_ROW, NOW).title).toBe('“the Narrows” · Newfound Lake');
    expect(rowView(PLACE_ROW, NOW).sub).toBe('From a report’s where · Luc Pelletier');
    expect(labels(BAY_ROW)).toEqual(['bay name']);
    expect(rowView(BAY_ROW, NOW).sub).toBe('Asked by 3 · Luc Pelletier and 2 more');
  });

  it('2.5: a drawn body over a known one', () => {
    const v = rowView(DRAWN_ROW, NOW);
    expect(v.chips.map((c) => c.label)).toEqual(['drawn body', '92 % overlap']);
    expect(v.title).toBe('User-drawn body over Caspian Lake');
    expect(v.sub).toBe('From a recorded skate · Kate Donovan');
    expect(v.age).toBe('2 h');
  });

  it('2.6, 2.7: content flags on an alert and a photo', () => {
    expect(labels(ALERT_ROW)).toEqual(['other', 'access alert']);
    expect(rowView(ALERT_ROW, NOW).sub).toBe(
      'Lake Morey · by Rob Tremblay · flagged by Kate Donovan',
    );
    expect(labels(PHOTO_ROW)).toEqual(['inappropriate', 'photo']);
  });

  it('an app’s own flag names its occurrence and no flagger; content already down says so', () => {
    const v = rowView(AUTO_ROW, NOW);
    expect(v.chips.map((c) => c.label)).toEqual([
      'rated unhelpful',
      'report',
      'hidden',
      'filed by the app',
    ]);
    expect(v.sub).toBe('Mascoma Lake · by Rob Tremblay · Filed by the app · 4th occurrence');
  });

  it('a flag on content that is gone reads as its kind, marked deleted', () => {
    const gone = {
      ...SAFETY_ROW,
      target: { targetType: 'comment', exists: false, summary: '', moderationStatus: null },
    } as InboxRowView;
    const v = rowView(gone, NOW);
    expect(v.title).toBe('A comment');
    expect(v.chips.map((c) => c.label)).toContain('deleted');
  });

  it('a flag on content its author withdrew says so first, and never reads as live', () => {
    const v = rowView(WITHDRAWN_ROW, NOW);
    expect(v.withdrawn).toBe(true);
    // Withdrawn wins over the status the row still carries (visible).
    expect(v.chips.map((c) => c.label)).toEqual(['harassment', 'comment', 'withdrawn']);
    expect(v.sub).toBe(
      'Withdrawn by its author · Lake Morey · by Rob Tremblay · flagged by Kate Donovan',
    );
    expect(rowView(SAFETY_ROW, NOW).withdrawn).toBe(false);
    // Decided, it stays withdrawn in the quieter ink.
    expect(rowView(decidedRow(WITHDRAWN_ROW, MATT, D, 'dismissed'), NOW).withdrawn).toBe(true);
  });

  it('2.8: a ticket', () => {
    const v = rowView(TICKET_ROW, NOW);
    expect(v.chips).toEqual([{ label: 'account', tone: 'default' }]);
    expect(v.title).toBe('“Appeal: my suspension”');
    expect(v.sub).toBe('Rob Tremblay');
  });

  it('a decided row leads with its decision, names who decided, and ages from the decision', () => {
    const v = rowView(decidedRow(SAFETY_ROW, MATT, 3 * D, 'hidden'), NOW);
    expect(v.done).toBe(true);
    // Never red once decided: the decision is the news.
    expect(v.chips).toEqual([
      { label: 'unsafe', tone: 'default' },
      { label: 'hidden', tone: 'default' },
    ]);
    // Where and whose, then who decided it (the board's "Mascoma Lake · by Rob Tremblay · Matt …").
    expect(v.sub).toBe('Mascoma Lake · by Rob Tremblay · Matt Steinberg');
    expect(v.age).toBe('3 d');
  });

  it('a decided row whose decider is gone says a staff member', () => {
    const row = decidedRow(TICKET_ROW, MATT, D, 'resolved');
    const gone = { ...row, decided: { ...row.decided, by: null } } as InboxRowView;
    expect(rowView(gone, NOW).sub).toBe('A staff member');
  });

  it('type-ahead matches the title without its opening quote', () => {
    expect(rowView(SAFETY_ROW, NOW).name.startsWith('Black ice')).toBe(true);
  });
});

describe('the units', () => {
  it('writes acres and miles as the boards do', () => {
    expect(acres(165_924)).toBe('41 ac');
    expect(acres(6_677_000)).toBe('1,650 ac');
    expect(acres(20_000)).toBe('4.9 ac');
    expect(miles(640)).toBe('0.4 mi');
    expect(miles(25_000)).toBe('16 mi');
  });

  it('holds a share to 0–100', () => {
    expect(percent(0.92)).toBe(92);
    expect(percent(1.4)).toBe(100);
    expect(percent(-0.1)).toBe(0);
  });
});

describe('a row’s age (fast-check)', () => {
  const ageArb = fc.integer({ min: -10 * D, max: 400 * D });

  it('is never negative, and always one of the short forms', () => {
    fc.assert(
      fc.property(ageArb, (ago) => {
        const age = rowAge({ filedAt: NOW - ago, decided: null }, NOW);
        expect(age).toMatch(/^(\d+ min|\d+ h|\d+(\.\d)? d)$/);
        expect(age.startsWith('-')).toBe(false);
      }),
    );
  });

  it('never goes down as an item waits longer', () => {
    const toMs = (age: string) => {
      const [n, unit] = age.split(' ') as [string, string];
      return Number(n) * (unit === 'min' ? 60_000 : unit === 'h' ? H : D);
    };
    fc.assert(
      fc.property(ageArb, fc.nat(30 * D), (ago, more) => {
        const a = toMs(rowAge({ filedAt: NOW - ago, decided: null }, NOW));
        const b = toMs(rowAge({ filedAt: NOW - ago - more, decided: null }, NOW));
        expect(b).toBeGreaterThanOrEqual(a);
      }),
    );
  });

  it('reads whole days past two, a tenth under two', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2 * D, max: 400 * D }), (ago) => {
        const age = rowAge({ filedAt: NOW - ago, decided: null }, NOW);
        expect(age).toBe(`${Math.floor(ago / D)} d`);
      }),
    );
    expect(rowAge({ filedAt: NOW - 1.55 * D, decided: null }, NOW)).toBe('1.5 d');
  });

  it('counts from the decision when there is one', () => {
    fc.assert(
      fc.property(fc.nat(100 * D), fc.nat(100 * D), (filedAgo, decidedAgo) => {
        const row = decidedRow(SAFETY_ROW, MATT, decidedAgo, 'dismissed');
        const shifted = { ...row, filedAt: NOW - filedAgo - decidedAgo };
        expect(rowAge(shifted, NOW)).toBe(
          rowAge({ filedAt: NOW - decidedAgo, decided: null }, NOW),
        );
      }),
    );
  });
});

describe('All open’s flow-through', () => {
  const views = ALL_OPEN_ROWS.map((r) => rowView(r, NOW));

  it('draws each lane’s boundary where the lane changes, the first included', () => {
    const entries = flowEntries(views, 'all');
    const boundaries = entries.filter((e) => e.type === 'boundary').map((e) => e.label);
    expect(boundaries).toEqual([
      'Safety',
      'Access reports',
      'Requests',
      'Places asked',
      'Drawn bodies',
      'Content flags',
      'Support',
    ]);
    expect(entries[0]).toMatchObject({ type: 'boundary', lane: 'safety' });
  });

  it('keeps the server’s order and numbers every row once', () => {
    const rows = flowEntries(views, 'all').flatMap((e) => (e.type === 'row' ? [e] : []));
    expect(rows.map((r) => r.row.id)).toEqual(views.map((v) => v.id));
    expect(rows.map((r) => r.index)).toEqual(views.map((_, i) => i));
  });

  it('every row sits under its own lane’s boundary, whatever the lanes (fast-check)', () => {
    const lanes = ['safety', 'accessReports', 'requests', 'support'] as const;
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...lanes), { maxLength: 40 }), (seq) => {
        const rows = seq.map(
          (lane, i) => ({ ...views[0], id: `r${i}`, lane }) as (typeof views)[0],
        );
        let under: string | null = null;
        for (const e of flowEntries(rows, 'all')) {
          if (e.type === 'boundary') under = e.lane;
          else expect(e.row.lane).toBe(under);
        }
      }),
    );
  });

  it('draws no boundary in a lane’s own list', () => {
    expect(flowEntries(views, 'safety').every((e) => e.type === 'row')).toBe(true);
  });
});

describe('decided today', () => {
  it('keeps the rows decided since midnight, newest first', () => {
    const rows = [
      decidedRow(SAFETY_ROW, MATT, 2 * H, 'actioned'),
      decidedRow(ACCESS_ROW, MATT, 30 * H, 'ruled_closed'),
      decidedRow(TICKET_ROW, MATT, 1 * H, 'resolved'),
      SAFETY_ROW,
    ];
    const kept = decidedSince(rows, NOW - 12 * H);
    expect(kept.map((r) => r.lane)).toEqual(['support', 'safety']);
  });
});
