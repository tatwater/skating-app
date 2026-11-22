import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { dialogWords, writeOf } from './FlagActions';
import {
  ALERT_ITEM,
  AROUND,
  BOARD_NOW,
  CAN_ALL,
  COMMENT_ITEM,
  DOWN_ITEM,
  GONE_ITEM,
  HAZARD_AUTO_ITEM,
  PERSON_ITEM,
  POST_ITEM,
  REFUSED_ITEM,
  ROB_REPORT,
  SAFETY_ITEM,
  SAFETY_MANY,
  SAFETY_WITH_CLOSED,
  SARAH,
  UNPINNED_ALERT_ITEM,
  WEATHER,
  WEATHER_GAPS,
  WEATHER_NONE,
} from './flagFixtures';
import {
  allows,
  appRuleOf,
  claimChips,
  type FlagVerb,
  flagHead,
  flagsInOrder,
  hasAnyVerb,
  historyLinkOf,
  isDown,
  liveFlags,
  occurrenceLine,
  reasonsOf,
  reportKicker,
  standingMeta,
  subjectOf,
  targetNoun,
  thumbsOf,
  verbGroups,
  weatherCells,
} from './flagModel';
import type { FlagItem } from './flagTypes';
import { closedWords } from './useFlagWrites';

const VERBS: FlagVerb[] = ['dismiss', 'hide', 'remove', 'restore', 'pin', 'unpin', 'retract'];

describe('can is the law', () => {
  test('only an explicit null allows a verb', () => {
    expect(allows({ dismiss: null }, 'dismiss')).toBe(true);
    expect(allows({ dismiss: 'No' }, 'dismiss')).toBe(false);
    expect(allows({}, 'dismiss')).toBe(false);
  });
  test('the boards: 2.1 Flag then Report; 2.6 Alert then Flag', () => {
    expect(verbGroups(SAFETY_ITEM)).toEqual([
      { id: 'flag', label: 'Flag', verbs: ['dismiss'] },
      { id: 'content', label: 'Report', verbs: ['hide', 'remove'] },
    ]);
    expect(verbGroups(ALERT_ITEM)).toEqual([
      { id: 'content', label: 'Alert', verbs: ['unpin', 'retract'] },
      { id: 'flag', label: 'Flag', verbs: ['dismiss'] },
    ]);
  });
  test('an alert: Pin, Unpin and Retract as `can` allows them, Pin first', () => {
    expect(verbGroups({ ...ALERT_ITEM, can: CAN_ALL })[0]?.verbs).toEqual([
      'pin',
      'unpin',
      'retract',
    ]);
    expect(verbGroups(UNPINNED_ALERT_ITEM)[0]?.verbs).toEqual(['pin', 'retract']);
    expect(verbGroups(ALERT_ITEM)[0]?.verbs).toEqual(['unpin', 'retract']);
  });
  test('down content offers Restore, never Hide or Remove', () => {
    expect(verbGroups({ ...DOWN_ITEM, can: CAN_ALL }).flatMap((g) => g.verbs)).toEqual([
      'dismiss',
      'restore',
    ]);
  });
  test('a person, a body and gone content have no content levers', () => {
    expect(verbGroups({ ...PERSON_ITEM, can: CAN_ALL }).flatMap((g) => g.verbs)).toEqual([
      'dismiss',
    ]);
    expect(verbGroups({ ...GONE_ITEM, can: CAN_ALL }).flatMap((g) => g.verbs)).toEqual(['dismiss']);
    const body = {
      ...PERSON_ITEM,
      can: CAN_ALL,
      target: {
        targetType: 'waterbody',
        targetId: 'wb',
        exists: true,
        summary: 'x',
        moderationStatus: null,
        body: ROB_REPORT.body,
      },
    } as FlagItem;
    expect(verbGroups(body).flatMap((g) => g.verbs)).toEqual(['dismiss']);
  });
  test('every verb refused: no group, no bar', () => {
    expect(verbGroups(REFUSED_ITEM)).toEqual([]);
    expect(hasAnyVerb(REFUSED_ITEM)).toBe(false);
  });
  test('property: a verb is drawn exactly when can answers null for it', () => {
    const answer = fc.option(fc.constantFrom('Not yours to decide', 'Decided already'), {
      nil: undefined,
    });
    fc.assert(
      fc.property(
        fc.record({
          dismiss: answer,
          hide: answer,
          remove: answer,
          restore: answer,
          pin: answer,
          unpin: answer,
          retract: answer,
        }),
        fc.constantFrom(SAFETY_ITEM, ALERT_ITEM, DOWN_ITEM, PERSON_ITEM, POST_ITEM),
        fc.array(fc.constantFrom(...VERBS)),
        (refusals, item, allowed) => {
          const can: Record<string, string | null> = {};
          for (const v of VERBS) {
            if (allowed.includes(v)) can[v] = null;
            else if (refusals[v] !== undefined) can[v] = refusals[v];
          }
          const drawn = verbGroups({ ...item, can }).flatMap((g) => g.verbs);
          for (const v of drawn) expect(can[v]).toBeNull();
        },
      ),
    );
  });
});

describe('the head', () => {
  test('2.1: the reason, the age written out, Reports', () => {
    expect(flagHead(SAFETY_ITEM, BOARD_NOW)).toEqual({
      title: 'Flagged as unsafe',
      safety: true,
      sub: '3 days ago',
      link: { kind: 'reports' },
    });
  });
  test('2.6: a content flag names its target and its reason; the body console', () => {
    expect(flagHead(ALERT_ITEM, BOARD_NOW)).toEqual({
      title: 'Flag on an access alert',
      safety: false,
      sub: 'Other · 6 hours ago',
      link: { kind: 'body', waterBodyId: 'wb_morey' },
    });
  });
  test('a person: People', () => {
    expect(flagHead(PERSON_ITEM, BOARD_NOW)).toMatchObject({
      title: 'Flag on a person',
      link: { kind: 'people', userId: 'p_rob' },
    });
  });
  test('two reasons, oldest first', () => {
    expect(reasonsOf(POST_ITEM.flags)).toEqual(['spam', 'harassment']);
    expect(flagHead(POST_ITEM, BOARD_NOW).sub).toBe('Spam · Harassment · 1 day ago');
  });
  test('gone: a report-like target still names Reports; an alert names nothing', () => {
    expect(historyLinkOf(GONE_ITEM.target, GONE_ITEM.author)).toEqual({ kind: 'reports' });
    expect(
      historyLinkOf({ targetType: 'accessAlert', targetId: 'a', exists: false }, null),
    ).toBeNull();
    expect(historyLinkOf({ targetType: 'user', targetId: 'u', exists: false }, null)).toBeNull();
    expect(
      historyLinkOf({ targetType: 'user', targetId: 'u', exists: false }, SAFETY_ITEM.author),
    ).toEqual({ kind: 'people', userId: 'p_rob' });
  });
});

describe('the report', () => {
  test('the claims, in the skater’s words; the measured claim marked only in Safety', () => {
    const report =
      SAFETY_ITEM.target.exists && SAFETY_ITEM.target.targetType === 'report'
        ? SAFETY_ITEM.target.report
        : null;
    expect(claimChips(report?.claims ?? ROB_REPORT.claims, true)).toEqual([
      { key: 't0', label: '3.5″ measured', flagged: true },
      { key: 'i0', label: 'black ice', flagged: false },
      { key: 's0', label: 'glass', flagged: false },
      { key: 'w0', label: 'still open, south end', flagged: false },
      { key: 'q', label: 'good · experienced only', flagged: false },
    ]);
    expect(claimChips(ROB_REPORT.claims, false).some((c) => c.flagged)).toBe(false);
  });
  test('snow and an estimate: named for what they are, never marked', () => {
    const chips = claimChips(
      {
        ...ROB_REPORT.claims,
        iceThickness: { readings: [{ valueCm: 10, method: 'estimated' }] },
        snow: { coverage: 'patchy' as never },
        skateQuality: null,
        suitability: null,
      },
      true,
    );
    expect(chips[0]).toEqual({ key: 't0', label: '3.9″ estimated', flagged: false });
    expect(chips.at(-1)?.key).toBe('n');
  });
  test('the kicker: place, span, vantage', () => {
    expect(reportKicker(ROB_REPORT)).toBe('Report · Enfield, NH · 10 Oct 15:40–17:05 · on the ice');
    expect(reportKicker({ ...ROB_REPORT, place: null, observedFrom: null })).toBe(
      'Report · Enfield, NH · 10 Oct 15:40–17:05',
    );
  });
  test('thumbs: up then down, amber only when down leads', () => {
    expect(thumbsOf({ up: 0, down: 2 })).toEqual({ up: '0 up', down: '2 down', downLeads: true });
    expect(thumbsOf({ up: 3, down: 3 })?.downLeads).toBe(false);
    expect(thumbsOf(null)).toBeNull();
  });
});

describe('That night, at the body — context, never a verdict', () => {
  test('the board', () => {
    expect(weatherCells(WEATHER).map((c) => [c.label, c.value, c.unit])).toEqual([
      ['Low · 9 Oct', '24', '°F'],
      ['Freezing nights', '2', 'in a row'],
      ['Freezing degree-days', '31', '°F·days since 1 Oct'],
      ['Stefan thickness estimate', '~1.1', 'in'],
    ]);
  });
  test('no weather recorded: the nights and the degree-days say so, never zero', () => {
    const cells = weatherCells(WEATHER_NONE);
    expect(cells[1]).toMatchObject({ value: null, missing: 'Not recorded' });
    expect(cells[2]).toMatchObject({ value: null, missing: 'Not recorded' });
    expect(cells.some((c) => c.value === '0')).toBe(false);
  });
  test('a season with gaps says how many days the sum covers; a full one says none', () => {
    const gapped = weatherCells({
      ...WEATHER,
      freezingDegreeDaysC: { ...WEATHER.freezingDegreeDaysC, days: 5 },
    })[2];
    expect(gapped).toMatchObject({ value: '31', unit: '°F·days' });
    expect(gapped?.note).toBe('From 5 of the 9 days since 1 Oct; the rest weren’t recorded');
    expect(weatherCells(WEATHER)[2]?.note).toBeUndefined();
  });
  test('missing inputs say what is missing', () => {
    const cells = weatherCells(WEATHER_GAPS);
    expect(cells[0]).toMatchObject({ value: null, missing: 'Not recorded' });
    expect(cells[1]).toMatchObject({ value: '1', unit: 'in a row, then a gap' });
    expect(cells[3]).toMatchObject({ value: null, missing: 'Not enough cold yet for an estimate' });
    for (const declined of ['thaw', 'no_weather'] as const) {
      expect(weatherCells({ ...WEATHER, stefan: { declined } })[3]?.missing).toMatch(/\w/);
    }
  });
  test('property: no cell says a word of judgment, and no figure is negative', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -40, max: 10, noNaN: true }),
        fc.integer({ min: -2, max: 40 }),
        fc.double({ min: -5, max: 900, noNaN: true }),
        fc.option(fc.double({ min: 0, max: 40, noNaN: true }), { nil: null }),
        (low, run, fdd, inches) => {
          const cells = weatherCells({
            ...WEATHER,
            lowC: low,
            freezingNights: { run, gapAfter: false },
            freezingDegreeDaysC: { ...WEATHER.freezingDegreeDaysC, value: fdd },
            stefan:
              inches === null
                ? { declined: 'thaw' }
                : { thicknessIn: inches, freezingDegreeDays: fdd, alpha: 0.7, windowDays: 60 },
          });
          const text = cells.map((c) => `${c.label} ${c.value} ${c.unit} ${c.missing}`).join(' ');
          expect(text).not.toMatch(
            /\b(safe|unsafe|solid|enough|thick enough|good to go|wrong|right|verdict)\b/i,
          );
          expect(Number(cells[1]?.value)).toBeGreaterThanOrEqual(0);
          expect(Number(cells[2]?.value)).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});

describe('the flags', () => {
  test('a byline’s standing: class and points', () => {
    expect(standingMeta(SARAH)).toBe('Trusted · 58 pts');
    expect(standingMeta({ ...SARAH, trustClass: null })).toBe('58 pts');
    expect(standingMeta(null)).toBeNull();
  });
  test('an app flag says its rule', () => {
    // The rule names the verdict in core's words for the hazard's type, as its votes do.
    expect(appRuleOf('unsafe_false_report', 'hazard', null, 'open_water')).toBe(
      'The app files this when 2 people vote “Nothing here — never was”',
    );
    expect(appRuleOf('unsafe_false_report', 'hazard', null, 'ridge_crossing')).toMatch(
      /“No crossing here”/,
    );
    expect(appRuleOf('unsafe_false_report', 'user')).toMatch(
      /some of their recent reports differed/,
    );
    expect(appRuleOf('unsafe_false_report', 'user', { count: 50, capped: true })).toBe(
      'The contradiction check filed this: 50+ of their recent reports differed from the weather records',
    );
    expect(appRuleOf('auto_low_quality', 'report')).toMatch(/unhelpful/);
    expect(appRuleOf('spam', 'report')).toMatch(/rule/);
  });
  test('its occurrences and the last verdict', () => {
    const [flag] = HAZARD_AUTO_ITEM.flags;
    expect(flag && occurrenceLine(flag, BOARD_NOW)).toBe('4th occurrence · last dismissed 6 d ago');
    expect(
      occurrenceLine({ ...SAFETY_ITEM.flags[0], occurrences: 1, prior: null } as never, BOARD_NOW),
    ).toBeNull();
    expect(
      occurrenceLine(
        {
          ...SAFETY_ITEM.flags[0],
          occurrences: 1,
          prior: { resolvedAt: 0, resolution: 'open' },
        } as never,
        BOARD_NOW,
      ),
    ).toBeNull();
  });
  test('the pane counts and acts on open flags; a decided item shows its record', () => {
    expect(liveFlags(SAFETY_WITH_CLOSED.flags).map((f) => f.flagId)).toEqual([
      'f_sarah',
      'f_kate_safety',
    ]);
    const allClosed = SAFETY_WITH_CLOSED.flags.map((f) => ({ ...f, status: 'closed' as const }));
    expect(liveFlags(allClosed)).toHaveLength(3);
    expect(closedWords(SAFETY_WITH_CLOSED, 2)).toBe('Closes 2 flags');
  });
  test('open first, oldest first', () => {
    const closed = {
      ...SAFETY_MANY.flags[0],
      status: 'closed',
    } as (typeof SAFETY_MANY.flags)[number];
    const second = SAFETY_MANY.flags[1] as (typeof SAFETY_MANY.flags)[number];
    expect(flagsInOrder([closed, second]).map((f) => f.flagId)).toEqual([
      second.flagId,
      closed.flagId,
    ]);
    expect(flagsInOrder(SAFETY_MANY.flags).map((f) => f.flagId)).toEqual([
      'f_sarah',
      'f_kate_safety',
    ]);
  });
});

describe('small words', () => {
  test('nouns and subjects', () => {
    expect(targetNoun(POST_ITEM.target)).toBe('Post');
    expect(targetNoun(SAFETY_ITEM.target)).toBe('report');
    expect(subjectOf(SAFETY_ITEM)).toBe('Mascoma Lake');
    expect(subjectOf(ALERT_ITEM)).toBe('Lake Morey');
    expect(subjectOf(PERSON_ITEM)).toBe('Rob Tremblay');
    expect(subjectOf(POST_ITEM)).toBe('Mascoma Lake');
    expect(subjectOf(HAZARD_AUTO_ITEM)).toBe('Mascoma Lake');
    expect(subjectOf(COMMENT_ITEM)).toBe('Dana Whitlock');
    expect(subjectOf(GONE_ITEM)).toBe('Dana Whitlock');
    expect(subjectOf({ ...GONE_ITEM, author: null })).toBe('');
  });
  test('isDown', () => {
    expect(isDown(DOWN_ITEM.target)).toBe('hidden');
    expect(isDown(SAFETY_ITEM.target)).toBeNull();
    expect(isDown(GONE_ITEM.target)).toBeNull();
  });
});

describe('the dialogs', () => {
  test('which flags each closes, said in its words', () => {
    expect(dialogWords('dismiss', 'report', 1).body).toMatch(
      /this flag only.*other lanes stay open/,
    );
    expect(dialogWords('dismiss', 'report', 3).body).toMatch(/these 3 flags only/);
    expect(dialogWords('hide', 'report', 1)).toEqual({
      title: 'Hide this report?',
      body: expect.stringMatching(/every open flag on it, in every lane/),
    });
    expect(dialogWords('remove', 'Post', 1).title).toBe('Remove this Post?');
    expect(dialogWords('unpin', '', 1).title).toBe('Unpin this alert?');
    expect(dialogWords('retract', '', 1).body).toMatch(/author is told/);
    // Withdrawn: a takedown keeps the decision and brings nothing back — no Undo promise of return.
    const kept = dialogWords('hide', 'report', 1, true).body;
    expect(kept).toMatch(/keeps the decision on their record/);
    expect(kept).toMatch(/every lane/);
    expect(kept).not.toMatch(/brings it back/);
  });
  test('the write each sends', () => {
    expect(writeOf('dismiss', '')).toEqual({ kind: 'dismiss' });
    expect(writeOf('dismiss', 'a joke')).toEqual({ kind: 'dismiss', reason: 'a joke' });
    expect(writeOf('hide', 'why')).toEqual({ kind: 'takeDown', status: 'hidden', reason: 'why' });
    expect(writeOf('remove', 'why')).toEqual({
      kind: 'takeDown',
      status: 'removed',
      reason: 'why',
    });
    expect(writeOf('unpin', 'why')).toEqual({ kind: 'alert', verb: 'unpin', reason: 'why' });
    expect(writeOf('pin', 'why')).toEqual({ kind: 'alert', verb: 'pin', reason: 'why' });
    // A pin decides the item: its words say every flag is dismissed, every lane's, each told once.
    expect(dialogWords('pin', '', 1)).toEqual({
      title: 'Pin this alert as official?',
      body: expect.stringMatching(/every open flag on it, in every lane, is dismissed.*told once/),
    });
    expect(writeOf('retract', 'why')).toEqual({ kind: 'alert', verb: 'retract', reason: 'why' });
  });
  test('the fixtures the stories read are the boards’', () => {
    expect(AROUND.reports).toHaveLength(3);
  });
});
