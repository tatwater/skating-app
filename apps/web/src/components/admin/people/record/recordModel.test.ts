import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { assertSeeded } from '@/test/seeded';

import {
  at,
  CHOICES,
  COUNTS,
  DELETED,
  HIDDEN,
  HIDDEN_CAPPED,
  HIDDEN_NONE,
  ITEM_DELETED,
  ITEM_ERASED,
  ITEM_HIDDEN,
  ITEM_LEAVING,
  ITEM_POST,
  ITEM_RESTORED,
  ITEM_UNDO_GONE,
  ITEM_WITHDRAWN,
  LEAVING,
  NOW,
  PRESENCE,
  PRESENCE_NONE,
  REVERSED,
  STANDING,
  SUBJECT,
} from './recordFixtures';
import {
  ACTION_ORDER,
  chooserMembers,
  deletedRowView,
  endingUndoOf,
  endingUndoWhat,
  erasureOf,
  erasureWords,
  headCount,
  type ItemRead,
  itemView,
  kindOptions,
  kindsLine,
  leverOf,
  listEnd,
  nextRestored,
  type RecordAction,
  type RecordLevers,
  type Restored,
  receiptWords,
  recordRowShows,
  restoredRowView,
  reversedRowView,
  spanWords,
  standingRowView,
  standingWords,
  tabCounts,
  titleOf,
  withRestored,
} from './recordModel';
import { kindCount, RECORD_WORDS } from './recordWords';

const row = (i: number) => STANDING[i] as (typeof STANDING)[number];
const lines = (v: { lines: Array<{ text: string; quote?: string }> }) =>
  v.lines.map((l) => (l.quote === undefined ? l.text : `${l.text}“${l.quote}”`));

describe('leverOf — the one lever, exactly as the server answered', () => {
  it('draws the lever that lets them act, with its reason and choice', () => {
    expect(leverOf({ restore: { ok: true, needsReason: false } })).toEqual({
      action: 'restore',
      ok: true,
      needsReason: false,
      needsChoice: false,
    });
    expect(leverOf({ restore: { ok: true, needsReason: false, needsChoice: true } })).toMatchObject(
      {
        needsChoice: true,
      },
    );
    expect(leverOf({ keep: { ok: true, needsReason: true } })).toMatchObject({
      action: 'keep',
      needsReason: true,
    });
  });

  it('a refusal is the server’s sentence, never a button', () => {
    expect(leverOf({ restore: { ok: false, why: LEAVING } })).toEqual({
      action: 'restore',
      ok: false,
      why: LEAVING,
    });
  });

  it('nothing to offer is nothing', () => {
    expect(leverOf({})).toBeNull();
    expect(leverOf(null)).toBeNull();
    expect(leverOf(undefined)).toBeNull();
  });

  it('should the server ever send two, the one that lets them act wins, then the fixed order', () => {
    expect(
      leverOf({ restore: { ok: false, why: 'no' }, overturn: { ok: true, needsReason: false } }),
    ).toMatchObject({ action: 'overturn', ok: true });
    expect(
      leverOf({ keep: { ok: false, why: 'a' }, overturn: { ok: false, why: 'b' } }),
    ).toMatchObject({ action: 'overturn', why: 'b' });
  });

  const answer = fc.oneof(
    fc.record(
      {
        ok: fc.constant(true as const),
        needsReason: fc.boolean(),
        needsChoice: fc.boolean(),
      },
      { requiredKeys: ['ok', 'needsReason'] },
    ),
    fc.record({ ok: fc.constant(false as const), why: fc.string({ minLength: 1 }) }),
  );
  const levers = fc.record(
    Object.fromEntries(ACTION_ORDER.map((a) => [a, answer])) as Record<RecordAction, typeof answer>,
    { requiredKeys: [] },
  ) as fc.Arbitrary<RecordLevers>;

  it('for any `can`, never an action the server refused, and always one it offered', () => {
    assertSeeded(
      fc.property(levers, (can) => {
        const lever = leverOf(can);
        const keys = ACTION_ORDER.filter((a) => can[a] !== undefined);
        const open = keys.filter((a) => can[a]?.ok === true);
        if (keys.length === 0) return lever === null;
        if (lever === null) return false;
        const said = can[lever.action];
        if (said === undefined) return false;
        if (lever.ok) {
          // Drawn as a button: the server offered exactly this, with its own terms.
          return (
            said.ok === true &&
            lever.needsReason === said.needsReason &&
            lever.needsChoice === (said.needsChoice === true)
          );
        }
        // Drawn as words: only when nothing was offered, and the server's sentence as written.
        return open.length === 0 && said.ok === false && lever.why === said.why;
      }),
      { numRuns: 200 },
    );
  });

  it('a `can` of one answer draws exactly that answer', () => {
    assertSeeded(
      fc.property(fc.constantFrom(...ACTION_ORDER), answer, (action, said) => {
        const lever = leverOf({ [action]: said } as RecordLevers);
        return lever !== null && lever.action === action && lever.ok === said.ok;
      }),
      { numRuns: 100 },
    );
  });
});

describe('titles', () => {
  it('quotes words as written and says what stands in for none', () => {
    expect(titleOf('comment', { at: 0, text: 'Hi' })).toEqual({
      text: 'Hi',
      quoted: true,
      gone: false,
    });
    expect(titleOf('report', null)).toMatchObject({ text: 'The words were erased', gone: true });
    expect(titleOf('report', { at: 0, text: '  ' })).toMatchObject({
      text: 'Nothing written',
      gone: true,
    });
    expect(titleOf('post', { at: 0, title: 'Opening', text: 'body' })).toMatchObject({
      text: 'Opening',
    });
    expect(titleOf('post', { at: 0, title: null, text: 'body' })).toMatchObject({ text: 'body' });
  });

  it('names a hazard or an alert by its type when nothing was written', () => {
    expect(titleOf('hazard', { at: 0, title: 'open_water', text: null })).toMatchObject({
      quoted: false,
      gone: false,
    });
    expect(titleOf('hazard', { at: 0, title: 'open_water', text: 'By the dam' })).toMatchObject({
      text: 'By the dam',
      quoted: true,
    });
    expect(titleOf('accessAlert', { at: 0, title: 'gate_locked', text: null }).quoted).toBe(false);
    expect(titleOf('accessAlert', { at: 0, title: 'no_such_reason', text: null }).text).toBe(
      'no_such_reason',
    );
  });
});

describe('rows', () => {
  it('Standing, as the board writes it', () => {
    const v = standingRowView(row(0), NOW);
    expect(v.chips.map((c) => c.label)).toEqual(['report', 'hidden']);
    expect(v.title).toMatchObject({ quoted: true });
    expect(lines(v)).toEqual([
      'Mascoma Lake · 4 Oct · hidden 10 Oct',
      'Reason: “Second unsafe claim this week”',
    ]);
    expect(v.meta).toBe('3 d');
    expect(v.key).toBe('report:r4oct');
  });

  it('a decision on something already deleted reads kept; one before the deletion reads deleted', () => {
    expect(standingRowView(row(1), NOW).chips.map((c) => c.label)).toEqual([
      'access alert',
      'retracted',
      'kept',
    ]);
    expect(lines(standingRowView(row(1), NOW))[0]).toBe('Mascoma Lake · 30 Sep · kept 2 Oct');
    expect(standingRowView(row(4), NOW).chips.map((c) => c.label)).toEqual([
      'comment',
      'hidden',
      'deleted',
    ]);
  });

  it('a comment names whose report it is on; a Post its reports', () => {
    expect(lines(standingRowView(row(2), NOW))[0]).toBe(
      'On Kate Donovan’s report · Crystal Lake · 1 Oct · hidden 2 Oct',
    );
    expect(lines(standingRowView(row(3), NOW))[0]).toBe('Mascoma Lake · 3 reports · hidden 26 Sep');
    const nameless = { ...row(2), reportAuthor: null, waterBodyName: null };
    expect(lines(standingRowView(nameless, NOW))[0]).toBe('On a report · 1 Oct · hidden 2 Oct');
  });

  it('a reason not on record says so, never a blank', () => {
    expect(lines(standingRowView({ ...row(0), reason: null }, NOW))[1]).toBe(
      'Reason: not recorded yet',
    );
  });

  it('Deleted says when, and when it is erased — or that the date is not recorded', () => {
    const [stop, inlet] = DELETED.map((r) => deletedRowView(r, NOW));
    expect(stop?.chips.map((c) => c.label)).toEqual(['comment', 'deleted']);
    expect(stop && lines(stop)).toEqual([
      'On Jamie Moreau’s report · Lake Morey · 9 Oct',
      'Deleted 9 Oct · erased 8 Nov unless kept',
    ]);
    expect(inlet && lines(inlet)[1]).toBe('Deleted 3 Oct · when it’s erased: not recorded yet');
    expect(stop?.meta).toBe('4 d');
    // An alert its author took back was retracted, as its chip says — never "deleted".
    const alert = deletedRowView(
      {
        ...(DELETED[0] as (typeof DELETED)[number]),
        targetType: 'accessAlert',
        content: { at: NOW, title: 'gate_locked', text: null },
      },
      NOW,
    );
    expect(alert.chips.map((c) => c.label)).toEqual(['access alert', 'retracted']);
    expect(lines(alert)[1]).toBe('Retracted 9 Oct · erased 8 Nov unless kept');
  });

  it('Reversed says how it ended and who, or that its words were erased', () => {
    const [guess, erased] = REVERSED.map((r) => reversedRowView(r, NOW));
    expect(guess?.chips).toEqual([{ label: 'comment' }, { label: 'restored', lit: true }]);
    expect(guess && lines(guess)).toEqual([
      'On Jamie Moreau’s report · hidden 26 Sep · restored 28 Sep',
      'Ben restored it',
    ]);
    expect(erased?.chips.map((c) => c.label)).toEqual(['report', 'overturned', 'erased']);
    expect(erased?.title).toMatchObject({ text: 'The words were erased', gone: true });
    expect(erased && lines(erased)).toEqual([
      'Mascoma Lake · removed 3 Feb · overturned 6 Feb',
      'Erased 6 Mar',
    ]);
  });

  it('a reversal whose ender is not on record says so', () => {
    const r = { ...REVERSED[0], endedBy: null } as (typeof REVERSED)[number];
    expect(lines(reversedRowView(r, NOW))[1]).toBe('Who ended it: not recorded yet');
    const undone = { ...REVERSED[0], endedHow: 'undo' } as (typeof REVERSED)[number];
    expect(lines(reversedRowView(undone, NOW))[1]).toBe('Ben undid it');
    const none = { ...REVERSED[0], endedHow: 'superseded' } as (typeof REVERSED)[number];
    expect(reversedRowView(none, NOW).chips.map((c) => c.label)).toEqual(['comment']);
  });
});

describe('a row restored in this sitting', () => {
  const restored: Restored = {
    row: row(0),
    at: at(10, 14, 11, 52),
    actionId: 'a1',
    actorId: 'me',
    undo: { needsReason: true },
  };

  it('is lit with who restored it, what it was hidden for, and the time', () => {
    const v = restoredRowView(restored, 'Dana', NOW);
    expect(v.chips).toEqual([{ label: 'report' }, { label: 'Restored · Dana', lit: true }]);
    expect(lines(v)).toEqual([
      'Mascoma Lake · 4 Oct',
      'Was hidden: “Second unsafe claim this week”',
    ]);
    expect(v.meta).toBe('11:52');
    expect(
      lines(restoredRowView({ ...restored, row: { ...row(5), reason: null } }, 'Dana', NOW))[1],
    ).toBe('Was removed: not recorded yet');
  });

  it('keeps its place in Standing until the server holds it again', () => {
    const rest = STANDING.filter((_, i) => i !== 0);
    const merged = withRestored(rest, [restored]);
    expect(merged.restoredCount).toBe(1);
    expect(merged.rows[0]?.restored).toBe(restored);
    expect(merged.rows.map((r) => r.row.targetId)).toEqual(STANDING.map((r) => r.targetId));
    // Hidden again, or its restore undone: the server's row is the one shown.
    const back = withRestored(STANDING, [restored]);
    expect(back.restoredCount).toBe(0);
    expect(back.rows.every((r) => r.restored === null)).toBe(true);
    // Older than every row on the page: at the end.
    const old = { ...restored, row: { ...row(0), at: 0, targetId: 'old' } };
    expect(withRestored(rest, [old]).rows.at(-1)?.restored).toBe(old);
  });
});

describe('a list’s end — three answers, never a zero', () => {
  const base = { tab: 'standing' as const, kind: null, rows: 6, restored: 0, pending: false };

  it('the whole list: All N, and the restored ones beside', () => {
    expect(listEnd({ ...base, status: 'done' })).toEqual({ kind: 'end', label: 'All 6' });
    expect(listEnd({ ...base, status: 'done', rows: 6, restored: 1 })).toEqual({
      kind: 'end',
      label: 'All 5 · 1 restored',
    });
  });

  it('more to come: a skeleton row, never an end tab', () => {
    expect(listEnd({ ...base, status: 'more' })).toEqual({ kind: 'more' });
    expect(listEnd({ ...base, status: 'fetching' })).toEqual({ kind: 'more' });
    expect(listEnd({ ...base, status: 'loading' })).toEqual({ kind: 'none' });
    expect(listEnd({ ...base, status: 'error' })).toEqual({ kind: 'none' });
  });

  it('still being prepared: so far, never all', () => {
    expect(listEnd({ ...base, status: 'done', rows: 2, pending: true })).toEqual({
      kind: 'end',
      label: '2 so far',
    });
    expect(listEnd({ ...base, status: 'done', rows: 0, pending: true }).kind).toBe('end');
  });

  it('empty says what is empty', () => {
    expect(listEnd({ ...base, status: 'done', rows: 0 })).toEqual({
      kind: 'end',
      label: 'Nothing on the record',
    });
    expect(listEnd({ ...base, tab: 'reversed', status: 'done', rows: 0 })).toMatchObject({
      label: 'Nothing reversed',
    });
    expect(listEnd({ ...base, kind: 'comment', status: 'done', rows: 0 })).toMatchObject({
      label: 'No comments here',
    });
  });
});

describe('counts', () => {
  it('the head counts what stands: a number, a floor, or not yet', () => {
    expect(headCount(HIDDEN, false)).toBe('6 items');
    expect(headCount(HIDDEN_NONE, false)).toBe('0 items');
    expect(headCount({ ...HIDDEN, total: 1 }, false)).toBe('1 item');
    expect(headCount(HIDDEN_CAPPED, false)).toBe('500+ items');
    expect(headCount(HIDDEN, true)).toBe('Still being prepared');
    expect(headCount(null, false)).toBeNull();
    // A floor that read none says so in words, never "0+" — the person page's row says the same.
    expect(headCount({ ...HIDDEN_NONE, capped: true }, false)).toBe('More than one read covers');
    expect(standingWords({ ...HIDDEN_NONE, capped: true }, false)).toBe(
      'More than one read covers',
    );
    expect(standingWords(HIDDEN, true)).toBe('Still being prepared');
  });

  it('each tab counts from its own read', () => {
    expect(tabCounts('standing', HIDDEN, COUNTS)?.byKind.report).toBe(2);
    expect(tabCounts('deleted', HIDDEN, COUNTS)?.byKind.comment).toBe(1);
    expect(tabCounts('reversed', HIDDEN, COUNTS)?.capped).toBe(false);
    expect(tabCounts('standing', null, COUNTS)).toBeNull();
    expect(tabCounts('deleted', HIDDEN, null)).toBeNull();
  });

  it('the filter keeps a count only where it is exact', () => {
    const exact = kindOptions(tabCounts('standing', HIDDEN, null), false);
    expect(exact.map((o) => [o.label, o.count])).toEqual([
      ['Reports', 2],
      ['Posts', 1],
      ['Comments', 2],
      ['Hazards', 0],
      ['Access alerts', 1],
    ]);
    expect(kindOptions(tabCounts('standing', HIDDEN_CAPPED, null), false)[0]).not.toHaveProperty(
      'count',
    );
    expect(kindOptions(tabCounts('standing', HIDDEN, null), true)[0]).not.toHaveProperty('count');
    expect(kindOptions(null, false)[0]).not.toHaveProperty('count');
  });

  it('a kind’s count is a floor under a cap', () => {
    expect(kindsLine(HIDDEN.byKind, false)).toBe(
      '2 reports · 1 post · 2 comments · 1 access alert',
    );
    expect(kindsLine(HIDDEN_CAPPED.byKind, true)).toBe('412+ reports · 88+ comments');
    expect(kindCount('report', 1, false)).toBe('1 report');
    expect(kindCount('report', 1, true)).toBe('1+ reports');
  });

  it('the person page’s row shows for anything on any list, a floor, or not yet — never on a guess', () => {
    expect(recordRowShows(HIDDEN, null, false)).toBe(true);
    expect(recordRowShows(HIDDEN_NONE, null, true)).toBe(true);
    expect(recordRowShows(HIDDEN_NONE, null, false)).toBe(false);
    expect(recordRowShows(HIDDEN_NONE, PRESENCE, false)).toBe(true);
    expect(recordRowShows(HIDDEN_NONE, { ...PRESENCE_NONE, deleted: true }, false)).toBe(true);
    expect(recordRowShows(HIDDEN_NONE, { ...PRESENCE_NONE, reversed: true }, false)).toBe(true);
    expect(recordRowShows(HIDDEN_NONE, { ...PRESENCE_NONE, pending: ['verdicts'] }, false)).toBe(
      true,
    );
    expect(recordRowShows(HIDDEN_NONE, PRESENCE_NONE, false)).toBe(false);
    expect(recordRowShows({ ...HIDDEN_NONE, capped: true }, null, false)).toBe(true);
  });
});

describe('the item', () => {
  const view = (item: typeof ITEM_HIDDEN) => itemView(item, SUBJECT, NOW);

  it('a hidden report: its decision, its words as published, its life, and Restore', () => {
    const v = view(ITEM_HIDDEN);
    expect(v.kicker).toBe('Report · Winter 2026–27');
    expect(v.badges).toEqual([{ label: 'Hidden', tone: 'dim' }]);
    expect(v.reason).toBe('Second unsafe claim this week');
    expect(v.byLines.map((b) => b.did)).toEqual(['Hid it Sat 10 Oct 19:48']);
    expect(v.byLines[0]?.reason).toBeNull();
    expect(v.plate).toMatchObject({
      kind: 'words',
      heading: 'As it was published',
      kicker: 'Mascoma Lake · Sun 4 Oct 16:40',
    });
    expect(v.life?.stations.map((s) => [s.when, s.title, s.mark, s.next ?? null])).toEqual([
      ['Sun 4 Oct', 'Posted', 'dot', 'heavy'],
      ['Sat 10 Oct', 'Hidden', 'hollow', 'thin'],
      ['14 Oct · today', 'Still hidden', 'now', 'dashed'],
      ['If restored', 'Back on Mascoma Lake', 'end', null],
    ]);
    expect(v.life?.stations[0]?.lasted).toBe('6 days');
    expect(v.life?.stations[2]?.sub).toBe('3 days out of sight');
    expect(v.life?.ifLabel).toBe('If restored');
    expect(v.lever).toMatchObject({ action: 'restore', ok: true, needsReason: false });
    expect(v.would).toBeNull();
  });

  it('just restored: lit, who restored it, on the lake again, Hide again', () => {
    const v = view(ITEM_RESTORED);
    expect(v.badges).toEqual([{ label: 'Restored', tone: 'lit' }]);
    expect(v.reason).toBeNull();
    expect(v.byLines.map((b) => [b.did, b.reason])).toEqual([
      ['Hid it Sat 10 Oct 19:48', 'Second unsafe claim this week'],
      ['Restored it Wed 14 Oct 11:52', null],
    ]);
    expect(v.plate).toMatchObject({ heading: 'On Mascoma Lake again' });
    // Restored today: that station is today's, with its time, and nothing after it.
    expect(v.life?.stations.map((s) => [s.when, s.title, s.mark])).toEqual([
      ['Sun 4 Oct', 'Posted', 'dot'],
      ['Sat 10 Oct', 'Hidden', 'hollow'],
      ['14 Oct · 11:52', 'Restored', 'now'],
    ]);
    expect(v.life?.ifLabel).toBeNull();
    expect(v.lever).toMatchObject({ action: 'hideAgain', needsReason: true });
  });

  it('hidden, then deleted by its author: kept as evidence, and what an overturn would do', () => {
    const v = view(ITEM_DELETED);
    expect(v.kicker).toBe('Comment · Winter 2026–27');
    expect(v.badges).toEqual([
      { label: 'Hidden', tone: 'dim' },
      { label: 'Deleted by Rob', tone: 'out' },
    ]);
    expect(v.byLines.map((b) => [b.did, b.note])).toEqual([
      ['Hid it Wed 23 Sep 21:10', null],
      ['Deleted it Fri 25 Sep 08:02', 'kept while the decision stands'],
    ]);
    expect(v.plate).toMatchObject({
      heading: 'As it was written',
      kicker: 'On Luc Pelletier’s report · Lake Morey · Tue 22 Sep 19:44',
    });
    expect(v.life?.stations.map((s) => [s.title, s.sub ?? null])).toEqual([
      ['Posted', 'On Luc Pelletier’s report'],
      ['Hidden', 'By Ana'],
      ['Deleted by Rob', 'Kept as evidence'],
      ['On the record', '20 days out of sight'],
      ['Erased Sun 25 Oct', '30 days after Rob deleted it'],
    ]);
    expect(v.would).toEqual({
      title: 'If overturned',
      rows: [
        { label: 'Record', text: 'The decision comes off Rob’s record' },
        { label: 'Comment', text: 'Stays deleted · it never comes back' },
        { label: 'Erased', text: 'Sun 25 Oct · 30 days after Rob deleted it' },
      ],
    });
  });

  it('deleted and held by nothing: erased on its date unless kept, and what keeping does', () => {
    const v = view(ITEM_WITHDRAWN);
    expect(v.badges).toEqual([{ label: 'Deleted by Rob', tone: 'out' }]);
    expect(v.byLines.map((b) => b.note)).toEqual(['erased Sun 8 Nov 22:15 unless it’s kept']);
    expect(v.would?.title).toBe('If kept');
    expect(v.lever).toMatchObject({ action: 'keep', needsReason: true });
    // Nobody decided on it: no life drawn (the board's 8.9 frame).
    expect(v.life).toBeNull();
  });

  it('overturned, then erased: the words gone, the decision kept, no lever', () => {
    const v = view(ITEM_ERASED);
    expect(v.kicker).toBe('Report · Winter 2025–26');
    expect(v.badges).toEqual([
      { label: 'Overturned', tone: 'out' },
      { label: 'Erased', tone: 'out' },
    ]);
    expect(v.reason).toBe('Claimed 6 inches over open water');
    expect(v.byLines.map((b) => [b.did, b.reason])).toEqual([
      ['Removed it Tue 3 Feb 10:05', null],
      ['Overturned it Fri 6 Feb 16:20', 'Appeal upheld: wrong lake in the photo'],
    ]);
    expect(v.plate).toEqual({
      kind: 'erased',
      heading: 'As it was published',
      title: 'The words were erased Fri 6 Mar',
      sub: 'Who decided what, and why, stays here.',
    });
    expect(v.lever).toBeNull();
    // Its words are gone: its decisions stand above, and no life is drawn.
    expect(v.life).toBeNull();
  });

  it('an erased comment says how long after its author deleted it', () => {
    const v = view({
      ...ITEM_DELETED,
      published: null,
      content: null,
      erasedAt: at(10, 25, 8, 2),
      decisions: [],
      can: {},
    });
    expect(v.plate).toMatchObject({
      heading: 'As it was written',
      sub: '30 days after Rob deleted it. Who decided what, and why, stays here.',
    });
    expect(view({ ...ITEM_ERASED, erasedAt: null }).plate).toMatchObject({
      title: 'The words were erased',
    });
  });

  it('a Post needing a choice says so; a leaving viewer gets the server’s sentence', () => {
    expect(view(ITEM_POST).lever).toMatchObject({ action: 'restore', needsChoice: true });
    expect(view(ITEM_POST).plate).toMatchObject({ display: 'Opening weekend on Mascoma' });
    expect(view(ITEM_LEAVING).lever).toEqual({ action: 'restore', ok: false, why: LEAVING });
  });

  it('restored, then deleted: the restore stays, the deletion after it', () => {
    const v = view(ITEM_UNDO_GONE);
    expect(v.badges).toEqual([
      { label: 'Restored', tone: 'lit' },
      { label: 'Deleted by Rob', tone: 'out' },
    ]);
    expect(v.byLines.map((b) => b.did)).toEqual([
      'Hid it Sat 26 Sep 18:30',
      'Restored it Mon 28 Sep 10:12',
      'Deleted it Tue 29 Sep 07:45',
    ]);
    expect(v.plate).toMatchObject({ heading: 'As it was written' });
    // Up after the restore, out of sight once deleted — never up after.
    expect(v.life?.stations.map((s) => s.next ?? null)).toEqual([
      'heavy',
      'thin',
      'heavy',
      'thin',
      'dashed',
      null,
    ]);
  });

  it('a kept alert reads kept, and its retraction is the author’s', () => {
    const alert = itemView(
      {
        ...ITEM_WITHDRAWN,
        targetType: 'accessAlert',
        published: {
          createdAt: at(9, 30, 7, 12),
          reason: 'gate_locked',
          note: 'Gate locked at the north launch.',
        } as unknown as typeof ITEM_WITHDRAWN.published,
        content: {
          at: at(9, 30, 7, 12),
          title: 'gate_locked',
          text: 'Gate locked at the north launch.',
        },
        authorDeletedAt: at(10, 1, 18, 40),
        eraseAt: null,
        decisions: [
          {
            kind: 'retracted',
            at: at(10, 2, 9, 30),
            standing: true,
            decidedBy: null,
            reason: 'Third false gate claim this month',
            endedAt: null,
            endedBy: null,
            endedHow: null,
            endedReason: null,
          },
        ],
        can: { overturn: { ok: true, needsReason: false } },
      },
      SUBJECT,
      NOW,
    );
    expect(alert.badges).toEqual([
      { label: 'Retracted by Rob', tone: 'out' },
      { label: 'Kept', tone: 'dim' },
    ]);
    expect(alert.byLines.map((b) => b.did)).toEqual([
      'Retracted it Thu 1 Oct 18:40',
      'Kept it Fri 2 Oct 09:30',
    ]);
    expect(alert.byLines[1]?.who).toBeNull();
    expect(alert.plate).toMatchObject({ heading: 'As skaters saw it', text: { quoted: true } });
    expect(alert.life?.stations[1]?.title).toBe('Retracted by Rob');
  });
});

describe('the words an item holds', () => {
  it('a hazard’s plate names its type, and two rows restored in one sitting keep their order', () => {
    const v = itemView(
      {
        ...ITEM_HIDDEN,
        targetType: 'hazard',
        published: { firstReportedAt: at(10, 4), type: 'open_water' } as never,
        content: { at: at(10, 4), title: 'open_water', text: null },
      },
      SUBJECT,
      NOW,
    );
    expect(v.plate).toMatchObject({ kind: 'words', text: null });
    expect((v.plate as { display: string }).display).not.toBe('open_water');
    const r = (i: number): Restored => ({
      row: STANDING[i] as (typeof STANDING)[number],
      at: NOW,
      actionId: `a${i}`,
      actorId: 'me',
      undo: null,
    });
    const merged = withRestored(STANDING.slice(2), [r(1), r(0)]);
    expect(merged.rows.map((m) => m.row.targetId).slice(0, 3)).toEqual(['r4oct', 'alert', 'ckate']);
  });
});

describe('what an overturn would leave', () => {
  it('a day, at once, or held by something else — as the server read it', () => {
    const deleted = at(9, 25, 8, 2);
    expect(erasureOf(at(10, 25, 8, 2), deleted, NOW)).toEqual({
      kind: 'on',
      day: 'Sun 25 Oct',
      days: 30,
    });
    // Not ahead of the moment it was read: the 30 days are past.
    expect(erasureOf(NOW - 60_000, at(8, 1), NOW)).toEqual({ kind: 'atOnce', days: 74 });
    // The server read it a moment after this minute-old clock: its own now, still at once — never
    // today's date as if the clock were running.
    expect(erasureOf(NOW + 30_000, at(8, 1), NOW)).toEqual({ kind: 'atOnce', days: 74 });
    expect(erasureOf(null, deleted, NOW)).toEqual({ kind: 'held' });
    // No deletion time to count from (a Post its Reports' deletions withdrew): no date recorded.
    expect(erasureOf(null, null, NOW)).toEqual({ kind: 'unrecorded' });
    expect(erasureWords({ kind: 'unrecorded' }, 'Rob')).toBe('Not recorded yet');
    expect(erasureOf(at(10, 25), null, NOW)).toMatchObject({ kind: 'on', days: null });
    expect(erasureWords({ kind: 'atOnce', days: 74 }, 'Rob')).toBe(
      'At once · 74 days after Rob deleted it',
    );
    expect(erasureWords({ kind: 'atOnce', days: null }, 'Rob')).toBe('At once');
    expect(erasureWords({ kind: 'on', day: 'Sun 25 Oct', days: null }, 'Rob')).toBe('Sun 25 Oct');
    expect(erasureWords({ kind: 'held' }, 'Rob')).toBe('Not erased while anything else holds it');
    expect(erasureWords({ kind: 'erased' }, 'Rob')).toBe('The words were erased');
  });

  it('an erased shell’s overturn says its words are already gone, never that they wait', () => {
    const shell = itemView(
      {
        ...ITEM_DELETED,
        published: null,
        content: null,
        erasedAt: at(10, 26, 8, 2),
        eraseAtIfReleased: null,
      },
      SUBJECT,
      NOW,
    );
    expect(shell.lever).toMatchObject({ action: 'overturn', ok: true });
    expect(shell.erasure).toEqual({ kind: 'erased' });
    expect(shell.would?.rows.at(-1)).toEqual({ label: 'Erased', text: 'The words were erased' });
    expect(RECORD_WORDS.overturnBody('Rob Tremblay', 'comment', 'already')).toBe(
      'It comes off Rob Tremblay’s record. The comment stays deleted; its words were already erased.',
    );
  });

  it('the pane says so in its life and its rows', () => {
    const held = itemView({ ...ITEM_DELETED, eraseAtIfReleased: null }, SUBJECT, NOW);
    expect(held.erasure).toEqual({ kind: 'held' });
    expect(held.would?.rows.at(-1)).toEqual({
      label: 'Erased',
      text: 'Not erased while anything else holds it',
    });
    expect(held.life?.stations.at(-1)).toMatchObject({
      title: 'The decision comes off Rob’s record',
      sub: 'Not erased while anything else holds it',
    });
    const unstamped = itemView(
      { ...ITEM_DELETED, authorDeletedAt: null, eraseAtIfReleased: null },
      SUBJECT,
      NOW,
    );
    expect(unstamped.erasure).toEqual({ kind: 'unrecorded' });
    expect(unstamped.life?.stations.at(-1)).toEqual({
      when: 'If overturned',
      title: 'The decision comes off Rob’s record',
      mark: 'end',
    });
    const now = itemView({ ...ITEM_DELETED, eraseAtIfReleased: NOW }, SUBJECT, NOW);
    expect(now.life?.stations.at(-1)?.title).toBe('Erased at once');
    // No overturn offered: no erasure to say.
    expect(itemView(ITEM_HIDDEN, SUBJECT, NOW).erasure).toBeNull();
  });
});

describe('what comes back with a report', () => {
  it('a restore would bring back its comments and thumbs; one restored brought them', () => {
    expect(itemView(ITEM_HIDDEN, SUBJECT, NOW).comesBack).toEqual({
      title: 'Comes back with it',
      rows: [
        { label: 'Comments', text: '1 comment' },
        { label: 'Thumbs', text: '2 thumbs' },
      ],
    });
    expect(itemView(ITEM_RESTORED, SUBJECT, NOW).comesBack?.title).toBe('Came back with it');
    const floors = {
      ...ITEM_HIDDEN,
      comesBack: { comments: { count: 50, capped: true }, ratings: { count: 0, capped: false } },
    };
    expect(itemView(floors, SUBJECT, NOW).comesBack?.rows.map((r) => r.text)).toEqual([
      '50+ comments',
      'None',
    ]);
    // Not a Report, or nothing to bring back (a refused restore, a deleted one): none.
    expect(itemView(ITEM_DELETED, SUBJECT, NOW).comesBack).toBeNull();
    expect(itemView(ITEM_LEAVING, SUBJECT, NOW).comesBack).toBeNull();
  });

  it('the restore’s receipt says what came back, only what there was', () => {
    const about = { kind: 'report' as const, place: 'Mascoma Lake', subject: SUBJECT };
    expect(
      receiptWords({ kind: 'restore' }, { ...about, comesBack: ITEM_HIDDEN.comesBack }, {}, NOW),
    ).toEqual({
      title: 'The report is back on Mascoma Lake',
      description: 'Its 1 comment and 2 thumbs came back with it',
    });
    const none = { comments: { count: 0, capped: false }, ratings: { count: 0, capped: false } };
    expect(receiptWords({ kind: 'restore' }, { ...about, comesBack: none }, {}, NOW)).toEqual({
      title: 'The report is back on Mascoma Lake',
    });
    const floor = { comments: { count: 0, capped: false }, ratings: { count: 200, capped: true } };
    expect(
      receiptWords({ kind: 'restore' }, { ...about, comesBack: floor }, {}, NOW).description,
    ).toBe('Its 200+ thumbs came back with it');
  });
});

describe('receipts', () => {
  const about = { kind: 'report' as const, place: 'Mascoma Lake', subject: SUBJECT };

  it('say what happened, from the operator’s side', () => {
    expect(receiptWords({ kind: 'restore' }, about, {}, NOW)).toEqual({
      title: 'The report is back on Mascoma Lake',
    });
    expect(
      receiptWords(
        { kind: 'restore', withReportIds: ['a', 'b'] },
        { ...about, kind: 'post' },
        {},
        NOW,
      ),
    ).toEqual({
      title: 'The post is back on Mascoma Lake',
      description: '2 reports came back with it',
    });
    expect(receiptWords({ kind: 'restore' }, { ...about, place: null }, {}, NOW).title).toBe(
      'The report is back up',
    );
    expect(receiptWords({ kind: 'hideAgain', reason: 'x' }, about, {}, NOW).title).toBe(
      'The report is hidden again',
    );
    expect(receiptWords({ kind: 'keep', reason: 'x' }, about, {}, NOW)).toEqual({
      title: 'The report is on Rob Tremblay’s record',
      description: 'Kept until the decision is overturned',
    });
  });

  it('an overturn says when it is erased only with the server’s date', () => {
    expect(receiptWords({ kind: 'overturn' }, about, { eraseAt: at(10, 25) }, NOW)).toEqual({
      title: 'The decision is off Rob Tremblay’s record',
      description: 'The report stays deleted · erased 25 Oct',
    });
    expect(receiptWords({ kind: 'overturn' }, about, { eraseAt: null }, NOW).description).toBe(
      'The report stays deleted',
    );
  });

  it('a late refusal names the person after its title, and only a name it has', () => {
    expect(RECORD_WORDS.refusalOf('Rob Tremblay')).toBe('Not changed · Rob Tremblay');
    expect(RECORD_WORDS.refusalOf('')).toBe('Not changed');
  });
});

describe('the Post’s chooser', () => {
  it('says why each report is down; an author-deleted one is shown, never choosable', () => {
    const m = chooserMembers(CHOICES, NOW);
    expect(m.map((x) => [x.title, x.choosable])).toEqual([
      ['Mascoma Lake · Sat 26 Sep', true],
      ['Mascoma Lake · Sun 27 Sep', true],
      ['Mascoma Lake · Sun 27 Sep', false],
    ]);
    expect(m[0]?.sub).toEqual({
      text: 'Hidden by Ana · Reason: ',
      quote: 'Same 4 inches as the others',
    });
    expect(m[1]?.sub.text).toBe('Removed by Ben · Reason: ');
    expect(m[2]?.sub.text).toBe(
      'Deleted by its author 28 Sep, so it can’t come back with the post',
    );
    // Its date not on record: said without one.
    const undated = chooserMembers(
      {
        ...CHOICES,
        members: [{ ...CHOICES.members[2], authorDeletedAt: null }] as typeof CHOICES.members,
      },
      NOW,
    );
    expect(undated[0]?.sub.text).toBe('Deleted by its author, so it can’t come back with the post');
  });

  it('a member up, coming back, or down without a row says so', () => {
    const members = [
      { ...CHOICES.members[0], standing: 'visible' },
      { ...CHOICES.members[0], standing: 'returns' },
      { ...CHOICES.members[0], down: undefined },
      {
        ...CHOICES.members[0],
        waterBodyName: null,
        down: { ...CHOICES.members[0]?.down, by: null, action: 'other' },
      },
    ] as typeof CHOICES.members;
    const m = chooserMembers({ ...CHOICES, members }, NOW);
    expect(m.map((x) => [x.sub.text, x.choosable])).toEqual([
      ['Already up', false],
      ['Comes back with the post', false],
      ['Taken down', true],
      ['Taken down by someone not recorded yet · Reason: ', true],
    ]);
    expect(m[3]?.title).toBe('Sat 26 Sep');
  });
});

describe('spans', () => {
  it('writes how long out', () => {
    expect(spanWords(2 * 86_400_000)).toBe('2 days');
    expect(spanWords(86_400_000)).toBe('1 day');
    expect(spanWords(3_600_000)).toBe('1 hour');
    expect(spanWords(5 * 3_600_000)).toBe('5 hours');
    expect(spanWords(60_000)).toBe('Under an hour');
  });
});

describe('a restore kept for the sitting never outlives the server’s answer', () => {
  const row = STANDING[0] as (typeof STANDING)[number];
  const mine = (actionId: string): Restored => ({
    row,
    at: NOW,
    actionId,
    actorId: 'me',
    undo: { needsReason: true },
  });
  const shown = (kept: readonly Restored[], rows: readonly (typeof STANDING)[number][]) =>
    withRestored(rows, kept).rows.flatMap((r) => (r.restored === null ? [] : [r.restored]));

  it('restore, undo, then another moderator’s restore: the old row never comes back', () => {
    // I restore it: the server lists it no longer; the sheet keeps its row.
    let kept = nextRestored([], { kind: 'kept', restored: mine('a1') });
    expect(shown(kept, [])).toEqual([mine('a1')]);
    // My restore is undone (from the toast): the server lists it again.
    kept = nextRestored(kept, { kind: 'listed', rows: [row] });
    expect(shown(kept, [row])).toEqual([]);
    // Another moderator restores it: the server lists it no longer — and nothing of mine returns.
    kept = nextRestored(kept, { kind: 'listed', rows: [] });
    expect(shown(kept, [])).toEqual([]);
    expect(kept).toEqual([]);
  });

  it('restore, someone hides it, someone else restores it: the row is never mine again', () => {
    // The sequence the property below found against the first build.
    let kept = nextRestored([], { kind: 'kept', restored: { ...mine('a1'), undo: null } });
    kept = nextRestored(kept, { kind: 'listed', rows: [row] });
    kept = nextRestored(kept, { kind: 'listed', rows: [] });
    expect(shown(kept, [])).toEqual([]);
  });

  it('a list still on its way judges nothing', () => {
    let kept = nextRestored([], { kind: 'kept', restored: mine('a1') });
    kept = nextRestored(kept, { kind: 'listed', rows: null });
    expect(kept).toEqual([mine('a1')]);
    // A restore again replaces the earlier one, never beside it.
    kept = nextRestored(kept, { kind: 'kept', restored: mine('a2') });
    expect(kept).toEqual([mine('a2')]);
  });

  it('the open item’s read drops it once another decision holds it, or another hand restored it', () => {
    const kept = nextRestored([], { kind: 'kept', restored: mine('a1') });
    expect(nextRestored(kept, { kind: 'item', item: ITEM_HIDDEN })).toEqual([]);
    expect(nextRestored(kept, { kind: 'item', item: ITEM_RESTORED })).toEqual([]);
    const byMe = {
      ...ITEM_RESTORED,
      decisions: ITEM_RESTORED.decisions.map((d) => ({
        ...d,
        endedBy: d.endedBy === null ? null : { ...d.endedBy, userId: 'me' as never },
      })),
    };
    expect(nextRestored(kept, { kind: 'item', item: byMe })).toEqual(kept);
    // Who restored it not known — a name past the read's budget, or the viewer not read yet — is
    // not another hand: the row stays until the list says otherwise.
    const unnamed = {
      ...ITEM_RESTORED,
      decisions: ITEM_RESTORED.decisions.map((d) => ({ ...d, endedBy: null })),
    };
    expect(nextRestored(kept, { kind: 'item', item: unnamed })).toEqual(kept);
    const unknownViewer = nextRestored([], {
      kind: 'kept',
      restored: { ...mine('a1'), actorId: null },
    });
    expect(nextRestored(unknownViewer, { kind: 'item', item: ITEM_RESTORED })).toEqual(
      unknownViewer,
    );
    // Overturned since: another decision's end, whoever it was.
    const overturned = {
      ...byMe,
      decisions: byMe.decisions.map((d) => ({ ...d, endedHow: 'overturn' as const })),
    };
    expect(nextRestored(kept, { kind: 'item', item: overturned })).toEqual([]);
    // Another item's read says nothing of this one.
    expect(nextRestored(kept, { kind: 'item', item: ITEM_DELETED })).toEqual(kept);
  });

  it('Reports restored with their Post keep their rows beside it, and go when the Post’s does', () => {
    const post = { ...row, targetType: 'post' as const, targetId: 'post' };
    const m1 = { ...row, targetType: 'report' as const, targetId: 'm1' };
    const m2 = { ...row, targetType: 'report' as const, targetId: 'm2' };
    const by = (r: typeof row, cameWith?: { targetType: 'post'; targetId: string }) => ({
      ...mine('p1'),
      row: r,
      ...(cameWith !== undefined && { cameWith }),
    });
    const target = { targetType: 'post' as const, targetId: 'post' };
    let kept: readonly Restored[] = [];
    for (const r of [by(post), by(m1, target), by(m2, target)])
      kept = nextRestored(kept, { kind: 'kept', restored: r });
    // The server lists none of the three now: all three rows are the sitting's.
    expect(shown(kept, [])).toHaveLength(3);
    // One Report hidden again on its own: only its row goes; the server lists it.
    kept = nextRestored(kept, { kind: 'listed', rows: [m1] });
    expect(kept.map((r) => r.row.targetId)).toEqual(['post', 'm2']);
    // The Post hidden again (its hide takes its Reports down without a decision of their own, so
    // the server lists the Post only): the Report kept with it goes too.
    kept = nextRestored(kept, { kind: 'listed', rows: [m1, post] });
    expect(kept).toEqual([]);
    // A Report whose Post kept no row of its own (the Post not on Standing) stands alone.
    const alone = nextRestored([], { kind: 'kept', restored: by(m1, target) });
    expect(nextRestored(alone, { kind: 'listed', rows: [] })).toBe(alone);
    // Another write's Post row going doesn't take it.
    const other = nextRestored(alone, { kind: 'kept', restored: { ...by(post), actionId: 'p0' } });
    expect(nextRestored(other, { kind: 'listed', rows: [post] })).toEqual(alone);
  });

  it('an answer that supersedes nothing hands back the same array, so nothing redraws', () => {
    const kept = nextRestored([], { kind: 'kept', restored: mine('a1') });
    expect(nextRestored(kept, { kind: 'listed', rows: null })).toBe(kept);
    expect(nextRestored(kept, { kind: 'listed', rows: STANDING.slice(1) })).toBe(kept);
    expect(nextRestored(kept, { kind: 'item', item: ITEM_DELETED })).toBe(kept);
    // One that does, a new one.
    expect(nextRestored(kept, { kind: 'listed', rows: [row] })).not.toBe(kept);
  });

  /**
   * Restore, undo (from the row or the toast), another moderator's restore, a hide again, and list
   * reloads, in any order, over two items: a row lit *Restored · <name>* names only the latest
   * restore — the viewer's own, still standing — with its own action and time, and offers Undo only
   * when that write said `undoable`.
   */
  it('over any order of restores, undos, other hands and reloads', () => {
    type Server = { up: boolean; latest: { by: 'me' | 'other'; id: string; undo: boolean } | null };
    const ROWS = [STANDING[0], STANDING[2]] as (typeof STANDING)[number][];
    const step = fc.oneof(
      fc.record({ kind: fc.constant('myRestore' as const), t: fc.nat(1), undo: fc.boolean() }),
      fc.record({ kind: fc.constant('rowUndo' as const), t: fc.nat(1) }),
      fc.record({ kind: fc.constant('toastUndo' as const), t: fc.nat(1) }),
      fc.record({ kind: fc.constant('otherRestore' as const), t: fc.nat(1) }),
      fc.record({ kind: fc.constant('hide' as const), t: fc.nat(1) }),
      fc.record({ kind: fc.constant('reload' as const), t: fc.nat(1) }),
    );
    assertSeeded(
      fc.property(fc.array(step, { maxLength: 24 }), (steps) => {
        const server: Server[] = [
          { up: false, latest: null },
          { up: false, latest: null },
        ];
        let kept: readonly Restored[] = [];
        let n = 0;
        const listed = () => ROWS.filter((_, i) => !(server[i] as Server).up);
        for (const s of steps) {
          const srv = server[s.t] as Server;
          const row = ROWS[s.t] as (typeof STANDING)[number];
          switch (s.kind) {
            case 'myRestore':
              if (srv.up) continue;
              n++;
              srv.up = true;
              srv.latest = { by: 'me', id: `a${n}`, undo: s.undo };
              kept = nextRestored(kept, {
                kind: 'kept',
                restored: {
                  row,
                  at: n,
                  actionId: `a${n}`,
                  actorId: 'me',
                  undo: s.undo ? { needsReason: true } : null,
                },
              });
              break;
            case 'rowUndo': {
              const r = kept.find((k) => k.row.targetId === row.targetId);
              if (r === undefined || r.undo === null) continue;
              // Its Undo, pressed on the row: the server lists it again.
              srv.up = false;
              break;
            }
            case 'toastUndo':
              if (!srv.up || srv.latest?.by !== 'me' || !srv.latest.undo) continue;
              srv.up = false;
              break;
            case 'otherRestore':
              if (srv.up) continue;
              n++;
              srv.up = true;
              srv.latest = { by: 'other', id: `o${n}`, undo: false };
              break;
            case 'hide':
              if (!srv.up) continue;
              srv.up = false;
              break;
            case 'reload':
              // The list on its way again, then its answer.
              kept = nextRestored(kept, { kind: 'listed', rows: null });
              break;
          }
          // The live list answers after every change.
          kept = nextRestored(kept, { kind: 'listed', rows: listed() });
          for (const r of shown(kept, listed())) {
            const i = ROWS.findIndex((x) => x.targetId === r.row.targetId);
            const truth = server[i] as Server;
            if (!truth.up || truth.latest?.by !== 'me' || truth.latest.id !== r.actionId)
              return false;
            if ((r.undo !== null) !== truth.latest.undo) return false;
            if (r.at !== Number(r.actionId.slice(1))) return false;
          }
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });
});

describe('the undo of the write that ended the newest decision (`endingUndoOf`)', () => {
  type D = ItemRead['decisions'][number];
  const undoArb: fc.Arbitrary<NonNullable<D['undo']>> = fc.oneof(
    fc.record({ state: fc.constant('available' as const), needsReason: fc.boolean() }),
    fc.record({ state: fc.constant('unavailable' as const), why: fc.constant('No.') }),
    fc.record({ state: fc.constant('undone' as const), byActionId: fc.constant('u' as never) }),
    fc.record({ state: fc.constant('overtaken' as const), byActionId: fc.constant('o' as never) }),
  );
  const decisionArb: fc.Arbitrary<D> = fc
    .record({
      endedHow: fc.constantFrom(null, 'restore', 'undo', 'overturn', 'superseded') as fc.Arbitrary<
        D['endedHow']
      >,
      endActionId: fc.option(fc.constantFrom('e1', 'e2'), { nil: undefined }),
      undo: fc.option(undoArb, { nil: undefined }),
    })
    .map((o) => ({
      ...(ITEM_UNDO_GONE.decisions[0] as D),
      endedHow: o.endedHow,
      endActionId: o.endActionId as D['endActionId'],
      undo: o.undo,
    }));

  it('offers exactly what the server says, on the one decision it says it on', () => {
    assertSeeded(
      fc.property(fc.array(decisionArb, { maxLength: 4 }), (decisions) => {
        const item = { ...ITEM_UNDO_GONE, decisions } as ItemRead;
        const got = endingUndoOf(item);
        const told = decisions.find((d) => d.undo !== undefined && d.endActionId !== undefined);
        if (got === null) {
          // Never withheld while the server offers it on an ending it names.
          expect(
            told?.undo?.state === 'available' &&
              told.endedHow !== null &&
              told.endedHow !== 'superseded',
          ).toBe(false);
          return;
        }
        expect(told).toBeDefined();
        expect(got.actionId).toBe(told?.endActionId);
        expect(got.undo).toEqual(told?.undo);
        // Pressable only while available; drawn off only for a restore's or an undo's that ran out.
        if (got.undo.state === 'unavailable') expect(got.endedHow).not.toBe('overturn');
        expect(['available', 'unavailable']).toContain(got.undo.state);
      }),
    );
  });

  it('the dialog says what is being undone', () => {
    const item = ITEM_UNDO_GONE;
    const undo = { state: 'available' as const, needsReason: true };
    expect(endingUndoWhat({ actionId: 'e', endedHow: 'restore', undo }, item, SUBJECT, NOW)).toBe(
      'The comment is back on Jamie Moreau’s report',
    );
    expect(endingUndoWhat({ actionId: 'e', endedHow: 'undo', undo }, item, SUBJECT, NOW)).toBe(
      'The decision on this comment was undone',
    );
    expect(endingUndoWhat({ actionId: 'e', endedHow: 'overturn', undo }, item, SUBJECT, NOW)).toBe(
      'The decision on this comment was overturned',
    );
  });
});
