import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { expectNoBlanks } from '@/test/blanksAudit';
import { expectKeyboardOperable } from '@/test/keyboardAudit';
import type { ReadFailure } from '../../reads/consoleReads';
import { stubLayout } from '../list/testLayout';
import type { PersonAction } from './levers';
import { PersonView, type PersonViewProps } from './PersonView';
import {
  HISTORY_CAPPED,
  HISTORY_PENDING,
  IDS,
  NOW,
  no,
  ROB,
  ROB_DELETED,
  ROB_HISTORY,
  ROB_LEAVING,
  ROB_PENDING,
  ROB_TREND,
  ROB_UNRECORDED,
  SARAH_BY_MODERATOR,
  SARAH_DECISIONS,
  SARAH_GRANTED,
  SARAH_HISTORY,
  SARAH_PAGE,
  SARAH_STATS,
  SARAH_TREND,
  SEASON,
  SEASON_EMPTY,
  STATS_UNRECORDED,
  TEAGAN_DECISIONS,
  TEAGAN_HISTORY,
  TEAGAN_PAGE,
  TEAGAN_STATS,
} from './personFixtures';
import { weekBars } from './personModel';

beforeAll(stubLayout);

const failure = (pending = false): ReadFailure => ({ failed: true, pending, retry: vi.fn() });

function draw(over: Partial<PersonViewProps> = {}) {
  const onAct = vi.fn<(a: PersonAction) => Promise<boolean>>(async () => true);
  const onUndo = vi.fn();
  const props: PersonViewProps = {
    person: ROB,
    trend: ROB_TREND,
    history: ROB_HISTORY,
    staffStats: null,
    staffSeason: null,
    decisions: { rows: [], isDone: true, capped: false, continueCursor: '' },
    now: NOW,
    viewerId: IDS.teagan,
    onAct,
    onUndo,
    onReviewRecord: vi.fn(),
    ...over,
  };
  const view = render(<PersonView {...props} />);
  return { ...view, onAct: (props.onAct as typeof onAct) ?? onAct, onUndo };
}

const slot = (name: string) => {
  const el = document.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  if (el === null) throw new Error(`no ${name}`);
  return el;
};
const fact = (name: string) => {
  const el = document.querySelector<HTMLElement>(`[data-fact="${name}"]`);
  if (el === null) throw new Error(`no fact ${name}`);
  return el;
};
const lever = (key: string) => {
  const el = document.querySelector<HTMLElement>(`[data-lever="${key}"]`);
  if (el === null) throw new Error(`no lever ${key}`);
  return el;
};

/** What each press asked for. */
const actions = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls.map((c) => c[0]);

describe('On the record', () => {
  it('Review opens the record sheet; the row shows when only the other lists hold anything', async () => {
    const onReviewRecord = vi.fn();
    const none = { report: 0, post: 0, comment: 0, hazard: 0, accessAlert: 0 };
    draw({
      person: { ...ROB, hidden: { total: 0, capped: false, byKind: none } },
      recordPresence: { deleted: false, reversed: true, pending: [] },
      onReviewRecord,
    });
    expect(lever('record')).toHaveTextContent('0 items');
    await userEvent.click(within(lever('record')).getByRole('button', { name: 'Review' }));
    expect(onReviewRecord).toHaveBeenCalledOnce();
  });

  it('a presence still on its way adds nothing; one that failed is never drawn as nothing', () => {
    const none = { report: 0, post: 0, comment: 0, hazard: 0, accessAlert: 0 };
    const person = { ...ROB, hidden: { total: 0, capped: false, byKind: none } };
    draw({ person, recordPresence: undefined });
    expect(document.querySelector('[data-lever="record"]')).toBeNull();
    cleanup();
    draw({ person, recordPresence: { failed: true, pending: false, retry: () => {} } });
    // The row stands, says what couldn't be read, and Review still opens the sheet (which reads
    // its own lists).
    expect(lever('record')).toHaveTextContent('0 items');
    expect(lever('record')).toHaveTextContent('Deleted and Reversed couldn’t be read');
    expect(within(lever('record')).getByRole('button', { name: 'Review' })).toBeEnabled();
  });
});

describe('board 8.1 — a suspended skater', () => {
  it('draws the head, the status note, the strip, the levers, what is open and the history', () => {
    draw();
    expect(slot('person-name')).toHaveTextContent('Rob Tremblay');
    expect(slot('person-handle')).toHaveTextContent('@rtremblay');
    expect(slot('trust-class')).toHaveTextContent('Trusted');
    const profile = slot('public-profile');
    expect(profile).toHaveAttribute('href', '/u/rtremblay');
    expect(profile).toHaveAttribute('target', '_blank');
    const note = slot('status-note');
    expect(note).toHaveTextContent('Suspended · 1 day left');
    expect(note).toHaveTextContent('Reason: “Second unsafe report in a week; cooling off”');
    expect(note).toHaveTextContent('MattSuspended Sat 10 Oct 19:48');
    expect(slot('status-lifts')).toHaveTextContent('Lifts on its own Thu 15 Oct 19:48');
    expect(fact('contradictions')).toHaveTextContent('3');
    expect(fact('open-flags')).toHaveTextContent('1 on content');
    expect(fact('reports')).toHaveTextContent('2 hidden · 1 edited');
    expect(fact('trust-points')).toHaveTextContent('41');
    expect(fact('report-trend')).toHaveTextContent('Reports · 9 months');
    expect(within(lever('comments')).getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(within(lever('suspension')).getByRole('button', { name: 'Extend' })).toBeInTheDocument();
    expect(within(lever('suspension')).getByRole('button', { name: 'Lift' })).toBeInTheDocument();
    expect(lever('record')).toHaveTextContent('4 items');
    expect(lever('record')).toHaveTextContent('2 reports · 2 comments');
    // The board's Review opens the record sheet.
    const review = within(lever('record')).getByRole('button', { name: 'Review' });
    expect(review).toBeEnabled();
    expect(screen.queryByText(/photo/i)).toBeNull();
    expect(screen.queryByText(/Restore all/)).toBeNull();
    const open = slot('open-about');
    expect(open).toHaveTextContent('Dangerously false ice report flag on a report');
    expect(open).toHaveTextContent('2 days ago');
    expect(
      within(open)
        .getAllByRole('link', { name: /Handle/ })
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/admin/inbox?item=flag%3Aflag1', '/admin/inbox?item=ticket%3Aticket1']);
    const history = slot('person-history');
    expect(history).toHaveTextContent('Suspended Rob Tremblay until 15 Oct');
    expect(history).toHaveTextContent('Reason: “Second unsafe report in a week; cooling off”');
    expect(history).toHaveTextContent('Teagan via seed-bounties');
    expect(slot('history-created')).toHaveTextContent('Account created');
    expect(within(slot('history-created')).queryByRole('button')).toBeNull();
    // A skater's History sits in the right column, under Account.
    expect(slot('person-right')).toContainElement(history);
    // No decision numbers, no "You", nothing about the ice.
    expect(document.body.textContent).not.toMatch(/\bD\d{2,3}\b|§|\bYou\b|safe to|skateable/);
  });

  it('a History row’s Undo goes to the shell’s undo', async () => {
    const { onUndo } = draw();
    const undo = within(slot('person-history')).getAllByRole('button', { name: 'Undo' });
    await userEvent.click(undo[0] as HTMLElement);
    expect(onUndo).toHaveBeenCalledWith(ROB_HISTORY.rows[0]);
    expect(slot('person-history')).toHaveTextContent('Changed since');
  });

  it('no destructive action has a key of its own', () => {
    draw();
    for (const b of screen.getAllByRole('button')) {
      expect(b.getAttribute('aria-keyshortcuts')).toBeNull();
      expect(b.querySelector('[data-slot="kbd"]')).toBeNull();
    }
  });
});

describe('every nullable fact absent, block by block', () => {
  it('head, status note and strip say not recorded where the read has nothing', () => {
    draw({ person: ROB_UNRECORDED });
    expect(document.querySelector('[data-slot="trust-class"]')).toBeNull();
    expect(slot('status-note')).toHaveTextContent('Reason: Not recorded yet');
    expect(slot('status-by')).toHaveTextContent('Who and when: not recorded yet');
    expect(fact('contradictions')).toHaveTextContent('—Not recorded yet');
  });

  it('a status that began before the rows one read walks says so, never "not recorded"', () => {
    const note = ROB_UNRECORDED.statusNote;
    if (note === null) throw new Error('fixture');
    draw({ person: { ...ROB_UNRECORDED, statusNote: { ...note, atCapped: true } } });
    expect(slot('status-by')).toHaveTextContent('Who and when: older than what one read covers');
    expect(slot('status-by')).not.toHaveTextContent('not recorded');
  });

  it('the staff strip says not recorded, and an empty season when its record begins', () => {
    draw({ person: SARAH_PAGE, staffStats: STATS_UNRECORDED, staffSeason: SEASON_EMPTY });
    expect(fact('time-to-decide')).toHaveTextContent('No filed items decided this week');
    expect(fact('staff-since')).toHaveTextContent('Not recorded yet');
    expect(fact('overturned')).toHaveTextContent('Record begins 1 Oct');
    for (const name of ['decisions', 'time-to-decide', 'overturned', 'staff-since']) {
      const value = fact(name).querySelector('[data-slot="value"]');
      expect(value?.textContent).not.toMatch(/^0$|undefined|^$/);
    }
  });

  it('no trust points cell for a viewer the read gives none — no blank, no zero', () => {
    draw({
      person: SARAH_BY_MODERATOR,
      staffStats: SARAH_STATS,
      staffSeason: SEASON,
      trend: SARAH_TREND,
    });
    expect(document.querySelector('[data-fact="trust-points"]')).toBeNull();
    expect(screen.queryByText(/Ledger editing/)).toBeNull();
    // Moderators see the staff figures on an admin's page.
    expect(fact('decisions')).toHaveTextContent('18 this week');
  });

  it('nothing open: no Open block; nothing hidden: no Hidden row; empty history: only its creation', () => {
    draw({
      person: TEAGAN_PAGE,
      history: { rows: [], capped: false, pending: [], createdAt: NOW },
    });
    expect(document.querySelector('[data-slot="open-about"]')).toBeNull();
    expect(document.querySelector('[data-lever="hidden"]')).toBeNull();
    expect(slot('person-history')).toHaveTextContent('Account created');
  });

  it('pending, capped and the history’s own gaps are said', () => {
    draw({ person: ROB_PENDING, history: HISTORY_PENDING });
    expect(fact('open-flags')).toHaveTextContent('Still being prepared');
    expect(fact('open-flags')).not.toHaveTextContent('+');
    expect(slot('open-pending')).toHaveTextContent('still being prepared');
    // The block's own figure rests on the same backfill: words at the rule's end, never a number.
    expect(slot('open-about').querySelector('[data-slot="section-count"]')).toBeNull();
    expect(slot('open-count-pending')).toHaveTextContent('Still being prepared');
    expect(slot('history-pending')).toBeInTheDocument();
  });

  it('nothing open yet while flags are prepared: the words, never a zero', () => {
    draw({ person: { ...ROB_PENDING, open: { ...ROB_PENDING.open, flags: [], appeals: [] } } });
    expect(slot('open-about').querySelector('[data-slot="section-count"]')).toBeNull();
    expect(slot('open-about')).not.toHaveTextContent(/\b0\b/);
  });

  it('a name still being prepared is words, never a face of its initials', () => {
    const unnamed = { userId: IDS.matt, displayName: null, username: null, profileImageUrl: null };
    const note = ROB.statusNote;
    const first = ROB_HISTORY.rows[0];
    if (note === null || first === undefined) throw new Error('board 8.1 has both');
    draw({
      person: { ...ROB, statusNote: { ...note, by: unnamed } },
      history: { ...ROB_HISTORY, rows: [{ ...first, actor: unnamed }] },
    });
    expect(slot('status-by')).toHaveTextContent('Name still being prepared');
    expect(slot('status-by').querySelector('[data-slot="person-lockup"]')).toBeNull();
    const row = slot('person-history').querySelector('[data-slot="feed-row"]') as HTMLElement;
    expect(row).toHaveTextContent('Name still being prepared');
    expect(row.querySelector('[data-slot="person-lockup"]')).toBeNull();
  });

  it('a capped history says more happened before', () => {
    draw({ history: HISTORY_CAPPED });
    expect(slot('history-capped')).toHaveTextContent('More happened before these');
  });
});

describe('an account with no name on it', () => {
  it('is named by its handle in the heading and the dialogs, as the list names it', async () => {
    draw({ person: { ...ROB, displayName: '   ' } });
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('rtremblay');
    await userEvent.click(within(lever('reports')).getByRole('button', { name: 'Restrict' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      'rtremblay won’t be able to post reports',
    );
  });
});

describe('each read states itself', () => {
  it('skeletons while loading', () => {
    draw({ person: undefined });
    expect(slot('person-loading')).toBeInTheDocument();
    expect(slot('person-pane')).toHaveAttribute('aria-busy', 'true');
  });

  it('a failed person read says so with Try again; the History beside it stays up', async () => {
    const f = failure();
    draw({ person: f });
    expect(slot('person-error')).toHaveTextContent('This person couldn’t be read');
    expect(slot('person-history')).toHaveTextContent('Suspended Rob Tremblay');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(f.retry).toHaveBeenCalled();
  });

  it('a history answering null beside a failed person says not recorded, never a bare heading', () => {
    draw({ person: failure(), history: null });
    expect(slot('history-none')).toHaveTextContent('Not recorded yet');
    expect(slot('history-error')).toBeEmptyDOMElement();
  });

  it('a person read that recovers keeps focus in its note, which stays mounted, empty', () => {
    const f = failure();
    const { rerender } = draw({ person: f });
    const note = slot('person-error');
    act(() => screen.getByRole('button', { name: 'Try again' }).focus());
    rerender(
      <PersonView
        person={ROB}
        trend={ROB_TREND}
        history={ROB_HISTORY}
        staffStats={null}
        staffSeason={null}
        decisions={{ rows: [], isDone: true, capped: false, continueCursor: '' }}
        now={NOW}
        viewerId={IDS.teagan}
        onAct={async () => true}
        onUndo={() => {}}
      />,
    );
    expect(slot('person-error')).toBe(note);
    expect(note).toBeEmptyDOMElement();
    expect(note).toHaveFocus();
    expect(slot('person-name')).toHaveTextContent('Rob Tremblay');
  });

  it('a failed trend takes only its cells; a failed history only its block', () => {
    draw({ trend: failure(), history: failure() });
    expect(fact('reports')).toHaveTextContent('Couldn’t be read');
    expect(slot('trend-error')).toHaveTextContent('Their reports couldn’t be read');
    expect(slot('history-error')).toHaveTextContent('The history couldn’t be read');
    expect(fact('contradictions')).toHaveTextContent('3');
    expect(lever('comments')).toBeInTheDocument();
  });

  it('a failed staff read says so under the staff strip, holding Trying again', () => {
    draw({
      person: SARAH_PAGE,
      staffStats: failure(true),
      staffSeason: SEASON,
      decisions: failure(),
    });
    expect(slot('staff-error')).toHaveTextContent('Their staff figures couldn’t be read');
    expect(slot('decisions-error')).toHaveTextContent('The decisions couldn’t be read');
    expect(
      screen.getAllByRole('button', { name: /Trying again|Try again/ }).length,
    ).toBeGreaterThan(0);
  });

  it('a staff read answering null means not staff, never a failure: no strip, nothing to retry', () => {
    // The role moved under the page: one staff read already says they aren't staff.
    for (const over of [
      { staffStats: SARAH_STATS, staffSeason: null },
      { staffStats: null, staffSeason: SEASON },
    ]) {
      const { unmount } = draw({ person: SARAH_PAGE, ...over });
      expect(document.querySelector('[data-slot="staff-strip"]')).toBeNull();
      expect(screen.queryByText('Couldn’t be read')).toBeNull();
      unmount();
    }
  });

  it('a trend answering null is not recorded, not a failure', () => {
    draw({ trend: null });
    expect(fact('reports')).toHaveTextContent('Not recorded yet');
    expect(fact('reports')).not.toHaveTextContent('Couldn’t be read');
    // The trend beside the cells says the same, never that it couldn't be read.
    expect(document.querySelector('[data-fact="report-trend"]')).toHaveTextContent(
      'Not recorded yet',
    );
    expect(screen.queryByText('Couldn’t be read')).toBeNull();
    // The note's region stays mounted (so a failure is announced), empty: nothing failed.
    expect(document.querySelector('[data-slot="trend-error"]')).toBeEmptyDOMElement();
  });

  it('every cell that says it couldn’t be read has Try again beside it', () => {
    draw({ person: SARAH_PAGE, staffStats: SARAH_STATS, staffSeason: failure(), trend: failure() });
    const failed = document.querySelectorAll('[data-state="unrecorded"]');
    expect(
      [...failed].filter((c) => c.textContent?.includes('Couldn’t be read')).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Try again' }).length).toBeGreaterThan(1);
  });

  it('decisions answering null (the server follow-up: not staff) draw no feed and no error', () => {
    draw({ person: SARAH_PAGE, staffStats: SARAH_STATS, staffSeason: SEASON, decisions: null });
    expect(document.querySelector('[data-slot="person-decisions"]')).toBeNull();
    expect(screen.queryByText('The decisions couldn’t be read')).toBeNull();
  });

  it('loading staff and feed reads hold their shapes', () => {
    draw({
      person: SARAH_PAGE,
      staffStats: undefined,
      staffSeason: undefined,
      decisions: undefined,
      history: undefined,
    });
    expect(fact('decisions')).toHaveAttribute('aria-busy', 'true');
    expect(document.querySelectorAll('[data-slot="feed-loading"]').length).toBe(2);
  });

  it('no such person, with the way back', () => {
    draw({ person: null });
    expect(slot('no-such-person')).toHaveTextContent('No such person');
    expect(screen.getByRole('link', { name: /People/ })).toHaveAttribute('href', '/admin/people');
  });

  it('a viewer without the audit read sees no History', () => {
    draw({ history: 'not-shown' });
    expect(document.querySelector('[data-slot="person-history"]')).toBeNull();
  });
});

describe('staff pages', () => {
  it('board 8.2: the staff strip, History on the left, Decisions on the right', () => {
    draw({
      person: SARAH_PAGE,
      trend: SARAH_TREND,
      history: SARAH_HISTORY,
      staffStats: SARAH_STATS,
      staffSeason: SEASON,
      decisions: SARAH_DECISIONS,
    });
    expect(fact('decisions')).toHaveTextContent('2 later undone by others');
    expect(fact('time-to-decide')).toHaveTextContent('41 min');
    expect(fact('overturned')).toHaveTextContent('1');
    expect(fact('staff-since')).toHaveTextContent('Admin since3 MarModerator from 12 Jan');
    expect(fact('decision-weeks')).toHaveTextContent('90 in all');
    expect(slot('person-left')).toContainElement(slot('person-history'));
    expect(slot('person-right')).toContainElement(slot('person-decisions'));
    expect(slot('person-decisions')).toHaveTextContent('18 this week');
    expect(slot('person-decisions')).toHaveTextContent(
      'Declined a request · “Shaker cove”, Mascoma Lake · Reason: “Already named Shaker Bay”',
    );
    expect(slot('person-decisions')).toHaveTextContent('Undone');
    expect(slot('person-history')).toHaveTextContent('Made Sarah Berman a moderator');
    expect(slot('person-history')).not.toHaveTextContent('Promoted');
    expect(within(lever('ledger')).getByRole('button', { name: 'Grant' })).toBeInTheDocument();
    expect(within(lever('flagging')).queryByRole('button')).toBeNull();
  });

  it('Show more asks for more decisions while there are more', async () => {
    const onMoreDecisions = vi.fn();
    draw({
      person: SARAH_PAGE,
      staffStats: SARAH_STATS,
      staffSeason: SEASON,
      decisions: SARAH_DECISIONS,
      onMoreDecisions,
    });
    await userEvent.click(slot('decisions-more'));
    expect(onMoreDecisions).toHaveBeenCalled();
  });

  it('Show more’s focus stays in Decisions when the button goes (the page holds all it may)', async () => {
    const props = {
      person: SARAH_PAGE,
      trend: SARAH_TREND,
      history: SARAH_HISTORY,
      staffStats: SARAH_STATS,
      staffSeason: SEASON,
      decisions: SARAH_DECISIONS,
    };
    const { rerender, onAct, onUndo } = draw({ ...props, onMoreDecisions: vi.fn() });
    act(() => slot('decisions-more').focus());
    rerender(
      <PersonView {...props} now={NOW} viewerId={IDS.teagan} onAct={onAct} onUndo={onUndo} />,
    );
    expect(document.querySelector('[data-slot="decisions-more"]')).toBeNull();
    expect(slot('person-decisions')).toHaveFocus();
  });

  it('a row’s Undo, gone once the row is undone, leaves focus in its feed', () => {
    const props = { person: ROB, trend: ROB_TREND, staffStats: null, staffSeason: null };
    const { rerender, onAct, onUndo } = draw(props);
    const history = slot('person-history');
    const undo = within(history).getAllByRole('button', { name: 'Undo' })[0] as HTMLElement;
    act(() => undo.focus());
    const [first, ...rest] = ROB_HISTORY.rows;
    if (first === undefined) throw new Error('board 8.1 has rows');
    rerender(
      <PersonView
        {...props}
        history={{
          ...ROB_HISTORY,
          rows: [{ ...first, undo: { state: 'undone', byActionId: first.id } }, ...rest],
        }}
        decisions={{ rows: [], isDone: true, capped: false, continueCursor: '' }}
        now={NOW}
        viewerId={IDS.teagan}
        onAct={onAct}
        onUndo={onUndo}
      />,
    );
    expect(undo.isConnected).toBe(false);
    expect(slot('person-history')).toHaveFocus();
  });

  it('never pulls focus back to a feed the operator had already left', async () => {
    const props = { person: ROB, trend: ROB_TREND, staffStats: null, staffSeason: null };
    const { rerender, onAct, onUndo } = draw(props);
    const undo = within(slot('person-history')).getAllByRole('button', {
      name: 'Undo',
    })[0] as HTMLElement;
    act(() => undo.focus());
    // A press on the page's blank ground: focus goes nowhere while the Undo stays.
    act(() => undo.blur());
    await act(async () => {});
    expect(document.body).toHaveFocus();
    const [first, ...rest] = ROB_HISTORY.rows;
    if (first === undefined) throw new Error('board 8.1 has rows');
    // Later the row is undone (someone else's Undo, a reactive read): its button goes.
    rerender(
      <PersonView
        {...props}
        history={{
          ...ROB_HISTORY,
          rows: [{ ...first, undo: { state: 'undone', byActionId: first.id } }, ...rest],
        }}
        decisions={{ rows: [], isDone: true, capped: false, continueCursor: '' }}
        now={NOW}
        viewerId={IDS.teagan}
        onAct={onAct}
        onUndo={onUndo}
      />,
    );
    expect(undo.isConnected).toBe(false);
    expect(document.body).toHaveFocus();
  });

  it('at the most a page holds, it says more happened before', () => {
    draw({
      person: SARAH_PAGE,
      staffStats: SARAH_STATS,
      staffSeason: SEASON,
      decisions: SARAH_DECISIONS,
    });
    expect(slot('decisions-capped')).toHaveTextContent(
      '4 decisions shown · more happened before these',
    );
  });

  it('no decisions on record says so', () => {
    draw({ person: SARAH_PAGE, staffStats: SARAH_STATS, staffSeason: SEASON });
    expect(slot('decisions-none')).toHaveTextContent('No decisions on record');
  });

  it('board 8.6: your own page — no levers on yourself; Step down disabled, with the board’s tooltip', async () => {
    draw({
      person: TEAGAN_PAGE,
      history: TEAGAN_HISTORY,
      staffStats: TEAGAN_STATS,
      staffSeason: SEASON,
      decisions: TEAGAN_DECISIONS,
    });
    const levers = slot('levers-can-do');
    expect(within(levers).queryAllByRole('button')).toEqual([]);
    expect(document.querySelector('[data-lever="suspension"]')).toBeNull();
    expect(document.querySelector('[data-lever="ban"]')).toBeNull();
    expect(within(lever('role')).queryByRole('button')).toBeNull();
    expect(lever('ledger')).toHaveTextContent('On · the only editor');
    const step = within(lever('ledger')).getByRole('button', { name: 'Step down' });
    expect(step).toHaveAttribute('aria-disabled', 'true');
    step.focus();
    expect(step).toHaveFocus();
    await userEvent.hover(step);
    expect(await screen.findByText('Give it to another admin first')).toBeInTheDocument();
    expect(screen.getByText('The ledger always keeps an editor.')).toBeInTheDocument();
    expect(slot('person-history')).toHaveTextContent('System');
    expect(slot('person-history')).toHaveTextContent('Gave Teagan Atwater ledger editing');
    expect(screen.queryByText(/\bYou\b/)).toBeNull();
  });
});

describe('writes', () => {
  it('a give-back acts at once, keeps the button mounted while busy, and keeps focus in the block', async () => {
    let resolve: (landed: boolean) => void = () => {};
    const onAct = vi.fn(() => new Promise<boolean>((r) => (resolve = r)));
    draw({ onAct });
    const restore = within(lever('comments')).getByRole('button', { name: 'Restore' });
    await userEvent.click(restore);
    expect(actions(onAct)).toContainEqual({ kind: 'right', permission: 'comments', allowed: true });
    expect(restore).toHaveAttribute('aria-busy', 'true');
    expect(restore).toHaveFocus();
    await act(async () => resolve(true));
    await waitFor(() => expect(restore).not.toHaveAttribute('aria-busy'));
    expect(slot('levers-can-do').contains(document.activeElement)).toBe(true);
  });

  /** A refusal is the write path's toast (D268): the lever prints nothing, and keeps focus. */
  it('a refusal prints nothing in place, and focus stays in the block', async () => {
    const onAct = vi.fn(async () => false);
    draw({ onAct });
    await userEvent.click(within(lever('suspension')).getByRole('button', { name: 'Lift' }));
    await waitFor(() => expect(onAct).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(within(lever('suspension')).getByRole('button', { name: 'Lift' })).not.toHaveAttribute(
        'aria-busy',
      ),
    );
    expect(within(lever('suspension')).queryByRole('alert')).toBeNull();
    expect(slot('levers-account').contains(document.activeElement)).toBe(true);
  });

  it('a take-away asks a reason first; the action waits for one', async () => {
    const { onAct } = draw();
    await userEvent.click(within(lever('reports')).getByRole('button', { name: 'Restrict' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Restrict reports?');
    const confirm = within(dialog).getByRole('button', { name: /Restrict/ });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox'), '  Spam  ');
    await userEvent.click(confirm);
    expect(actions(onAct)).toContainEqual({
      kind: 'right',
      permission: 'reports',
      allowed: false,
      reason: 'Spam',
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('a refused dialog stays open over its reason, keeps focus, and prints nothing', async () => {
    const onAct = vi.fn(async () => false);
    draw({ onAct });
    await userEvent.click(within(lever('flagging')).getByRole('button', { name: 'Switch off' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Floods the queue');
    await userEvent.click(within(dialog).getByRole('button', { name: /Switch off/ }));
    await waitFor(() => expect(onAct).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: /Switch off/ })).not.toHaveAttribute(
        'aria-busy',
      ),
    );
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(within(dialog).getByRole('textbox')).toHaveValue('Floods the queue');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('a dialog holds while its write is on its way: Esc and Cancel wait; refused, it stays', async () => {
    let settle: (landed: boolean) => void = () => {};
    const onAct = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
    );
    draw({ onAct });
    await userEvent.click(within(lever('reports')).getByRole('button', { name: 'Restrict' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Spam');
    await userEvent.click(within(dialog).getByRole('button', { name: /Restrict/ }));
    await userEvent.keyboard('{Escape}');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    await act(async () => settle(false));
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    expect(within(dialog).getByRole('textbox')).toHaveValue('Spam');
    expect(within(dialog).queryByRole('alert')).toBeNull();
    // Settled, it closes again.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('a ban takes two presses and a reason', async () => {
    const { onAct } = draw();
    await userEvent.click(within(lever('ban')).getByRole('button', { name: 'Ban' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Threats');
    const ban = within(dialog).getByRole('button', { name: /^Ban/ });
    await userEvent.click(ban);
    expect(onAct).not.toHaveBeenCalled();
    expect(ban).toHaveTextContent('again');
    await userEvent.click(ban);
    expect(actions(onAct)).toContainEqual({ kind: 'ban', reason: 'Threats' });
  });

  it('extend adds to the end already set, with a reason', async () => {
    const { onAct } = draw();
    await userEvent.click(within(lever('suspension')).getByRole('button', { name: 'Extend' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Lifts Fri 16 Oct 19:48');
    await userEvent.click(within(dialog).getByRole('radio', { name: /1 week more/ }));
    await userEvent.type(within(dialog).getByRole('textbox'), 'Again');
    await userEvent.click(within(dialog).getByRole('button', { name: /Extend/ }));
    const until = new Date(2026, 9, 15, 19, 48).getTime() + 7 * 86_400_000;
    expect(actions(onAct)).toContainEqual({
      kind: 'suspend',
      until,
      reason: 'Again',
      extend: true,
      shape: 'extend',
    });
  });

  it('an open-ended suspension gets an end, from now, saying when it will lift', async () => {
    const note = ROB.statusNote as NonNullable<typeof ROB.statusNote>;
    const { onAct } = draw({
      person: { ...ROB, statusNote: { ...note, suspendedUntil: null, lapsed: false } },
    });
    await userEvent.click(within(lever('suspension')).getByRole('button', { name: 'Set an end' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('It has no end now');
    await userEvent.click(within(dialog).getByRole('radio', { name: /^3 days/ }));
    // Each duration says when it would lift, counted from now.
    expect(dialog).toHaveTextContent(/3 days\s*Lifts/);
    await userEvent.type(within(dialog).getByRole('textbox'), 'Settled');
    await userEvent.click(within(dialog).getByRole('button', { name: /Set an end/ }));
    expect(actions(onAct)).toContainEqual({
      kind: 'suspend',
      until: NOW + 3 * 86_400_000,
      reason: 'Settled',
      extend: true,
      shape: 'setEnd',
    });
  });

  it('a suspension that ran its course gets a new window from now, its end said first', async () => {
    const note = ROB.statusNote as NonNullable<typeof ROB.statusNote>;
    const { onAct } = draw({
      person: { ...ROB, statusNote: { ...note, suspendedUntil: NOW - 60_000, lapsed: true } },
    });
    await userEvent.click(within(lever('suspension')).getByRole('button', { name: 'Extend' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('The new time runs from now');
    await userEvent.click(within(dialog).getByRole('radio', { name: /^1 week/ }));
    await userEvent.type(within(dialog).getByRole('textbox'), 'Again');
    await userEvent.click(within(dialog).getByRole('button', { name: /Extend/ }));
    expect(actions(onAct)).toContainEqual({
      kind: 'suspend',
      until: NOW + 7 * 86_400_000,
      reason: 'Again',
      extend: true,
      shape: 'renew',
    });
  });

  it('suspend starts from now', async () => {
    const { onAct } = draw({ person: SARAH_PAGE, staffStats: SARAH_STATS, staffSeason: SEASON });
    await userEvent.click(within(lever('suspension')).getByRole('button', { name: 'Suspend' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Cooling off');
    await userEvent.click(within(dialog).getByRole('button', { name: /Suspend/ }));
    expect(actions(onAct)).toContainEqual({
      kind: 'suspend',
      until: NOW + 86_400_000,
      reason: 'Cooling off',
      extend: false,
    });
  });

  it('a bounty limit asks a reason only when it goes down', async () => {
    const { onAct } = draw();
    await userEvent.click(within(lever('bounties')).getByRole('button', { name: 'Set limit' }));
    const dialog = await screen.findByRole('alertdialog');
    // Unchanged: nothing to set.
    expect(within(dialog).getByRole('button', { name: /Set limit/ })).toBeDisabled();
    // Back to the default (3, up from 1): a give-back asks nothing.
    await userEvent.click(within(dialog).getByRole('radio', { name: /The default/ }));
    expect(within(dialog).queryByRole('textbox', { name: /Reason/ })).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: /Set limit/ }));
    expect(actions(onAct)).toContainEqual({ kind: 'bountyLimit', limit: null });
  });

  it('a bounty limit moves only the way the server allows; the other way says its answer', async () => {
    const refused = 'This limit only goes up for now.';
    // Their own limit is 1, the default 3: down to 0 is refused, back to the default is open.
    const { onAct } = draw({ person: { ...ROB, can: { ...ROB.can, bountyLower: no(refused) } } });
    await userEvent.click(within(lever('bounties')).getByRole('button', { name: 'Set limit' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('radio', { name: /A limit of their own/ }));
    const field = within(dialog).getByRole('textbox', { name: /Open bounties/ });
    await userEvent.clear(field);
    await userEvent.type(field, '0');
    await userEvent.tab();
    // Down is refused: no reason asked, nothing to send, and the read's answer said.
    expect(within(dialog).getByRole('button', { name: /Set limit/ })).toBeDisabled();
    expect(within(dialog).queryByRole('textbox', { name: /Reason/ })).toBeNull();
    expect(dialog.querySelector('[data-slot="bounty-refused"]')).toHaveTextContent(refused);
    // Up is open: sent with no reason.
    await userEvent.click(within(dialog).getByRole('radio', { name: /The default/ }));
    expect(dialog.querySelector('[data-slot="bounty-refused"]')).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: /Set limit/ }));
    expect(actions(onAct)).toContainEqual({ kind: 'bountyLimit', limit: null });
  });

  it('Set limit is drawn while either way is open, and not when neither is', () => {
    draw({
      person: {
        ...ROB,
        can: { ...ROB.can, bountyRaise: no('No.'), bountyLower: no('No.') },
      },
    });
    expect(within(lever('bounties')).queryByRole('button', { name: 'Set limit' })).toBeNull();
  });

  it('lowering a bounty limit asks why', async () => {
    const { onAct } = draw({ person: SARAH_PAGE, staffStats: SARAH_STATS, staffSeason: SEASON });
    await userEvent.click(within(lever('bounties')).getByRole('button', { name: 'Set limit' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('radio', { name: /A limit of their own/ }));
    const field = within(dialog).getByRole('textbox', { name: /Open bounties/ });
    await userEvent.type(field, '1');
    await userEvent.tab();
    const reason = await within(dialog).findByRole('textbox', { name: /Reason/ });
    await userEvent.type(reason, 'Asks on lakes they just reported');
    await userEvent.click(within(dialog).getByRole('button', { name: /Set limit/ }));
    expect(actions(onAct)).toContainEqual({
      kind: 'bountyLimit',
      limit: 1,
      reason: 'Asks on lakes they just reported',
    });
  });

  it('board 8.5: the role menu — a promotion asks nothing, a demotion asks why', async () => {
    const { onAct } = draw({ person: SARAH_GRANTED, staffStats: SARAH_STATS, staffSeason: SEASON });
    await userEvent.click(within(lever('role')).getByRole('button', { name: /Change role/ }));
    const menu = await screen.findByRole('menu');
    expect(menu).toHaveTextContent('Admincurrent');
    expect(within(menu).getAllByText('Also revokes ledger editing')).toHaveLength(2);
    await userEvent.click(within(menu).getByRole('menuitem', { name: /Make moderator/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Make Sarah Berman a moderator?');
    expect(dialog).toHaveTextContent('ledger editing with it');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Stepping back');
    await userEvent.click(within(dialog).getByRole('button', { name: /Make moderator/ }));
    expect(actions(onAct)).toContainEqual({
      kind: 'role',
      role: 'moderator',
      reason: 'Stepping back',
    });
  });

  it('a promotion acts from the menu at once', async () => {
    const { onAct } = draw();
    await userEvent.click(within(lever('role')).getByRole('button', { name: /Change role/ }));
    const menu = await screen.findByRole('menu');
    await userEvent.click(within(menu).getByRole('menuitem', { name: /Make moderator/ }));
    expect(actions(onAct)).toContainEqual({ kind: 'role', role: 'moderator' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('making an admin asks a plain confirm first — no reason', async () => {
    const { onAct } = draw();
    await userEvent.click(within(lever('role')).getByRole('button', { name: /Change role/ }));
    await userEvent.click(
      within(await screen.findByRole('menu')).getByRole('menuitem', { name: /Make admin/ }),
    );
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Make Rob Tremblay an admin?');
    expect(dialog).toHaveTextContent('An undo won’t reach what they do in the meantime.');
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(onAct).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: /Make admin/ }));
    expect(actions(onAct)).toContainEqual({ kind: 'role', role: 'admin' });
  });

  it('a ledger grant acts at once', async () => {
    const { onAct } = draw({ person: SARAH_PAGE, staffStats: SARAH_STATS, staffSeason: SEASON });
    await userEvent.click(within(lever('ledger')).getByRole('button', { name: 'Grant' }));
    expect(actions(onAct)).toContainEqual({ kind: 'ledger', grant: true });
  });

  it('a ledger revoke asks why', async () => {
    const { onAct } = draw({ person: SARAH_GRANTED, staffStats: SARAH_STATS, staffSeason: SEASON });
    await userEvent.click(within(lever('ledger')).getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Revoke ledger editing?');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Leaving the books');
    await userEvent.click(within(dialog).getByRole('button', { name: /Revoke/ }));
    expect(actions(onAct)).toContainEqual({
      kind: 'ledger',
      grant: false,
      reason: 'Leaving the books',
    });
  });

  it('a second press while a write is on its way is held back', async () => {
    let resolve: (landed: boolean) => void = () => {};
    const onAct = vi.fn(() => new Promise<boolean>((r) => (resolve = r)));
    draw({ onAct });
    await userEvent.click(within(lever('comments')).getByRole('button', { name: 'Restore' }));
    await userEvent.click(within(lever('suspension')).getByRole('button', { name: 'Lift' }));
    expect(onAct).toHaveBeenCalledTimes(1);
    expect(await within(lever('suspension')).findByRole('alert')).toHaveTextContent(
      'Another change is still on its way',
    );
    await act(async () => resolve(true));
    // Once the first change settles, the note goes.
    await waitFor(() => expect(within(lever('suspension')).queryByRole('alert')).toBeNull());
  });
});

describe('dialogs and plates', () => {
  it('each opening of a dialog starts clean', async () => {
    draw();
    await userEvent.click(within(lever('suspension')).getByRole('button', { name: 'Extend' }));
    let dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('radio', { name: /30 days more/ }));
    await userEvent.type(within(dialog).getByRole('textbox'), 'Half a thought');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await userEvent.click(within(lever('suspension')).getByRole('button', { name: 'Extend' }));
    dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('textbox')).toHaveValue('');
    expect(within(dialog).getByRole('radio', { name: /1 day more/ })).toBeChecked();
  });

  it('a suspension replacing a ban says so', async () => {
    draw({ person: { ...ROB, status: 'banned', statusNote: null } });
    await userEvent.click(within(lever('suspension')).getByRole('button', { name: 'Suspend' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('This replaces the ban');
  });

  it('a demotion to skater asks why, naming the role it takes', async () => {
    const { onAct } = draw({ person: SARAH_PAGE, staffStats: SARAH_STATS, staffSeason: SEASON });
    await userEvent.click(within(lever('role')).getByRole('button', { name: /Change role/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Make skater/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Make Sarah Berman a skater?');
    expect(dialog).toHaveTextContent('They lose what the admin role gives.');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Done for the season');
    await userEvent.click(within(dialog).getByRole('button', { name: /Make skater/ }));
    expect(actions(onAct)).toContainEqual({
      kind: 'role',
      role: 'member',
      reason: 'Done for the season',
    });
  });

  it('the trends read a month and a week at a time from the keyboard', async () => {
    draw({ person: SARAH_PAGE, trend: ROB_TREND, staffStats: SARAH_STATS, staffSeason: SEASON });
    const [months, weeks] = screen.getAllByRole('slider');
    (months as HTMLElement).focus();
    await userEvent.keyboard('{End}');
    const plate = await screen.findByText('Oct 2026');
    expect(plate.parentElement).toHaveTextContent('Kept3Hidden1');
    (weeks as HTMLElement).focus();
    await userEvent.keyboard('{End}');
    await waitFor(() =>
      expect(
        fact('decision-weeks').querySelector('[data-slot="sparkbar-set-plate"]'),
      ).toHaveTextContent(`${weekBars(SARAH_STATS, NOW)[8]?.title}Decisions18`),
    );
  });
});

describe('accounts on their way out', () => {
  it('leaving: a note with the day the account goes', () => {
    draw({ person: ROB_LEAVING, history: ROB_HISTORY });
    expect(slot('status-note')).toHaveTextContent(
      'Leaving · The account is deleted Mon 2 Nov 12:00',
    );
    expect(document.querySelector('[data-lever="suspension"]')).toBeNull();
  });

  it('deleted: a note, no trust class, no profile link, no levers', () => {
    draw({ person: ROB_DELETED });
    expect(slot('status-note')).toHaveTextContent('Deleted · 3 Oct');
    expect(document.querySelector('[data-slot="public-profile"]')).toBeNull();
    expect(within(slot('levers-can-do')).queryAllByRole('button')).toEqual([]);
    expect(within(slot('levers-account')).queryAllByRole('button')).toEqual([]);
  });

  it('the profile link is the profile read’s own answer for this viewer', () => {
    const at = (publicProfile: (typeof ROB)['publicProfile']) =>
      draw({ person: { ...ROB, publicProfile } });
    // Public, by the server's path.
    at({ opens: true, private: false, path: '/u/someone' });
    expect(slot('public-profile')).toHaveAttribute('href', '/u/someone');
    expect(slot('public-profile')).toHaveTextContent('Public profile');
    cleanup();
    // Private: it opens to their name and picture only, and says so.
    at({ opens: true, private: true, path: '/u/someone' });
    expect(slot('public-profile')).toHaveTextContent('Private profile');
    expect(slot('public-profile')).toHaveAttribute('data-private');
    cleanup();
    // Closed to this viewer (blocked, leaving, gone): no link, whatever its visibility says.
    at({ opens: false, private: false, path: '/u/someone' });
    expect(document.querySelector('[data-slot="public-profile"]')).toBeNull();
  });
});

describe('the house audits', () => {
  it.each([
    ['a suspended skater', {}],
    [
      'an admin, with the staff rows',
      {
        person: SARAH_PAGE,
        trend: SARAH_TREND,
        history: SARAH_HISTORY,
        staffStats: SARAH_STATS,
        staffSeason: SEASON,
        decisions: SARAH_DECISIONS,
        onMoreDecisions: vi.fn(),
      },
    ],
    [
      'every figure not ready, not recorded or capped',
      {
        person: ROB_PENDING,
        history: HISTORY_PENDING,
      },
    ],
  ] as const)(
    '%s: every clickable thing answers the keyboard, and nothing is a blank',
    (_name, over) => {
      const { container } = draw(over as Partial<PersonViewProps>);
      expect(expectKeyboardOperable(container).length).toBeGreaterThan(0);
      expectNoBlanks(container);
    },
  );
});
