import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConvexError } from 'convex/values';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The person page as the app mounts it: its reads (mocked at the Convex hooks) asked at once and
 * keyed on values, an id of the wrong shape never asked about, and every write through the one
 * action hook — to its server write, then the shell's undo toast with the person as its target, or
 * the server's refusal back in place. Never a fixture.
 */

const mocks = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  calls: new Map<string, unknown>(),
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
  toast: vi.fn(),
  denied: new Set<string>(),
  announce: vi.fn(async () => {}),
  undo: vi.fn(),
  viewer: 'teagan'.padEnd(32, '0'),
}));

vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  return {
    useQueries: (queries: Record<string, { query: never; args: unknown }>) =>
      Object.fromEntries(
        Object.entries(queries).map(([key, { query, args }]) => {
          const name = getFunctionName(query);
          mocks.calls.set(name, args);
          return [key, mocks.results.get(name)];
        }),
      ),
    useMutation: (ref: never) => {
      const name = getFunctionName(ref);
      let fn = mocks.mutations.get(name);
      if (fn === undefined) {
        fn = vi.fn(async () => null);
        mocks.mutations.set(name, fn);
      }
      return fn;
    },
  };
});
vi.mock('@tanstack/react-router', () => ({
  // A link names its search apart from its path; the href puts them back together.
  Link: ({
    to,
    search,
    children,
    ...props
  }: {
    to: string;
    search?: Record<string, string>;
    children?: ReactNode;
  }) => (
    <a href={search === undefined ? to : `${to}?${new URLSearchParams(search)}`} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/useRole', () => ({
  useRole: () => ({ can: (c: string) => !mocks.denied.has(c), userId: mocks.viewer }),
}));
vi.mock('../../shell/undo', () => ({
  useUndo: () => ({ announce: mocks.announce, undo: mocks.undo }),
}));
vi.mock('@/components/kit/toast', async (original) => ({
  ...(await original<typeof import('@/components/kit/toast')>()),
  toast: mocks.toast,
}));

import { resetConsoleReads } from '../../reads/consoleReads';
import { PersonPane } from './PersonPane';
import { NOW, ROB, ROB_HISTORY, ROB_TREND, SARAH_STATS, SEASON } from './personFixtures';
import {
  actionIdOf,
  changedOf,
  undoableOf,
  undoNeedsReasonOf,
  usePersonWrites,
} from './usePersonWrites';

const ROB_ID = ROB.userId;

beforeAll(() => {
  for (const [name, value] of [
    ['animate', () => ({ cancel: () => {}, finished: Promise.resolve() })],
    ['getAnimations', () => []],
  ] as const) {
    if (!(name in Element.prototype)) {
      Object.defineProperty(Element.prototype, name, { configurable: true, value });
    }
  }
  if (!('fonts' in document)) {
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
  }
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  resetConsoleReads();
  mocks.results.clear();
  mocks.calls.clear();
  mocks.mutations.clear();
  mocks.denied.clear();
  mocks.announce.mockClear();
  mocks.undo.mockClear();
  mocks.toast.mockClear();
});
afterEach(() => vi.useRealTimers());

function answer(over: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = {
    'people:person': ROB,
    'people:reportTrend': ROB_TREND,
    'people:history': ROB_HISTORY,
    'people:staffStats': null,
    'people:staffSeason': null,
    'people:decisions': { rows: [], isDone: true, capped: false, continueCursor: '' },
    ...over,
  };
  for (const [k, v] of Object.entries(all)) mocks.results.set(k, v);
}

describe('the reads', () => {
  it('asks every read at once, at the minute the page opened', () => {
    answer();
    render(<PersonPane userId={ROB_ID} />);
    expect(mocks.calls.get('people:person')).toEqual({ userId: ROB_ID, now: NOW });
    expect(mocks.calls.get('people:reportTrend')).toEqual({ userId: ROB_ID, now: NOW });
    expect(mocks.calls.get('people:history')).toEqual({ userId: ROB_ID, limit: 50 });
    expect(mocks.calls.get('people:staffStats')).toEqual({ userId: ROB_ID, now: NOW });
    expect(mocks.calls.get('people:staffSeason')).toEqual({ userId: ROB_ID, now: NOW });
    expect(mocks.calls.get('people:decisions')).toEqual({ userId: ROB_ID, limit: 25 });
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Rob Tremblay');
  });

  it('an id of the wrong shape asks nothing and is no such person, with the way back', () => {
    answer();
    render(<PersonPane userId="not-an-id" returnTo="/admin/people?lane=suspended" />);
    expect(mocks.calls.size).toBe(0);
    expect(screen.getByText('No such person')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /People/ })).toHaveAttribute(
      'href',
      '/admin/people?lane=suspended',
    );
  });

  it('a new person is read at the minute it opened', () => {
    answer();
    const { rerender } = render(<PersonPane userId={ROB_ID} />);
    vi.setSystemTime(NOW + 5 * 60_000);
    const other = 'other'.padEnd(32, '0');
    rerender(<PersonPane userId={other} />);
    expect(mocks.calls.get('people:person')).toEqual({ userId: other, now: NOW + 5 * 60_000 });
  });

  it('an id with no account is no such person', () => {
    answer({ 'people:person': null, 'people:reportTrend': null, 'people:history': null });
    render(<PersonPane userId={ROB_ID} />);
    expect(screen.getByText('No such person')).toBeInTheDocument();
  });

  it('without the audit read, no History and no staff reads', () => {
    mocks.denied.add('audit.read');
    answer();
    render(<PersonPane userId={ROB_ID} />);
    expect(mocks.calls.has('people:history')).toBe(false);
    expect(mocks.calls.has('people:decisions')).toBe(false);
    expect(screen.queryByRole('heading', { name: 'History' })).toBeNull();
  });

  it('without the audit read, a staff page draws no staff strip and no Decisions', () => {
    mocks.denied.add('audit.read');
    answer({ 'people:person': { ...ROB, role: 'moderator' as const } });
    render(<PersonPane userId={ROB_ID} />);
    expect(mocks.calls.has('people:staffStats')).toBe(false);
    expect(document.querySelector('[data-slot="staff-strip"]')).toBeNull();
    expect(document.querySelector('[data-slot="person-decisions"]')).toBeNull();
  });

  it('a failed read says so in its block', () => {
    answer({ 'people:history': new Error('boom') });
    render(<PersonPane userId={ROB_ID} />);
    expect(screen.getByText('The history couldn’t be read')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Rob Tremblay');
  });

  it('a staff page asks for more decisions, doubling to the most a page holds', async () => {
    const staff = { ...ROB, role: 'moderator' as const };
    answer({
      'people:person': staff,
      'people:staffStats': SARAH_STATS,
      'people:staffSeason': SEASON,
      'people:decisions': { rows: ROB_HISTORY.rows, isDone: false, continueCursor: 'c' },
    });
    render(<PersonPane userId={ROB_ID} />);
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(mocks.calls.get('people:decisions')).toEqual({ userId: ROB_ID, limit: 50 });
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(mocks.calls.get('people:decisions')).toEqual({ userId: ROB_ID, limit: 100 });
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });
});

describe('the record', () => {
  it('asks only whether the record’s lists hold anything with the page; its counts wait for the sheet', async () => {
    answer({
      'contentRecord:recordPresence': { deleted: false, reversed: false, pending: [] },
      'contentRecord:personVerdicts': { page: [], isDone: true, continueCursor: '', pending: [] },
    });
    render(<PersonPane userId={ROB_ID} />);
    expect(mocks.calls.get('contentRecord:recordPresence')).toEqual({ userId: ROB_ID });
    // Nothing of the sheet is asked until it opens — its counts neither.
    expect(mocks.calls.has('contentRecord:personVerdicts')).toBe(false);
    expect(mocks.calls.has('contentRecord:recordCounts')).toBe(false);
    const row = document.querySelector('[data-lever="record"]') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Review' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('On the record')).toBeInTheDocument();
    expect(mocks.calls.get('contentRecord:personVerdicts')).toEqual({
      userId: ROB_ID,
      cursor: null,
    });
    expect(within(sheet).getByText('Nothing on the record')).toBeInTheDocument();
    expect(mocks.calls.get('contentRecord:recordCounts')).toEqual({ userId: ROB_ID });
  });

  it('an open sheet stays open through a blink of the person read', async () => {
    answer({
      'contentRecord:recordPresence': { deleted: false, reversed: false, pending: [] },
      'contentRecord:personVerdicts': { page: [], isDone: true, continueCursor: '', pending: [] },
    });
    const { rerender } = render(<PersonPane userId={ROB_ID} />);
    const row = document.querySelector('[data-lever="record"]') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Review' }));
    await screen.findByRole('dialog');
    // The person read drops back to loading (a retry, a failure): the sitting holds.
    mocks.results.set('people:person', undefined);
    rerender(<PersonPane userId={ROB_ID} />);
    expect(screen.getByRole('dialog')).toHaveTextContent('Nothing on the record');
  });
});

describe('one person at a time', () => {
  it('Show more keeps the rows drawn, and its focus, while the larger page loads', async () => {
    answer({
      'people:person': { ...ROB, role: 'moderator' as const },
      'people:staffStats': SARAH_STATS,
      'people:staffSeason': SEASON,
      'people:decisions': { rows: ROB_HISTORY.rows, isDone: false, continueCursor: 'c' },
    });
    render(<PersonPane userId={ROB_ID} />);
    const user = userEvent.setup({ advanceTimers: () => {} });
    const rows = () =>
      document.querySelectorAll('[data-slot="person-decisions"] [data-slot="feed-row"]');
    expect(rows()).toHaveLength(ROB_HISTORY.rows.length);
    // The larger page is on its way.
    mocks.results.delete('people:decisions');
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(mocks.calls.get('people:decisions')).toEqual({ userId: ROB_ID, limit: 50 });
    expect(rows()).toHaveLength(ROB_HISTORY.rows.length);
    expect(screen.getByRole('button', { name: 'Show more' })).toHaveFocus();
  });

  it('a refusal is its toast, and the decisions asked for stay with the person they were for', async () => {
    answer({
      'people:person': { ...ROB, role: 'moderator' as const },
      'people:staffStats': SARAH_STATS,
      'people:staffSeason': SEASON,
      'people:decisions': { rows: ROB_HISTORY.rows, isDone: false, continueCursor: 'c' },
    });
    mocks.mutations.set(
      'moderation:unbanUser',
      vi.fn(async () => {
        throw new ConvexError('Refused for this one');
      }),
    );
    const { rerender } = render(<PersonPane userId={ROB_ID} />);
    const user = userEvent.setup({ advanceTimers: () => {} });
    const suspension = () => {
      const el = document.querySelector<HTMLElement>('[data-lever="suspension"]');
      if (el === null) throw new Error('suspension');
      return el;
    };
    await user.click(within(suspension()).getByRole('button', { name: 'Lift' }));
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Not changed · Rob Tremblay',
          description: 'Refused for this one',
        }),
      ),
    );
    expect(within(suspension()).queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    const other = 'other'.padEnd(32, '0');
    rerender(<PersonPane userId={other} />);
    expect(within(suspension()).queryByRole('alert')).toBeNull();
    expect(mocks.calls.get('people:decisions')).toEqual({ userId: other, limit: 25 });
  });
});

describe('the writes', () => {
  const lever = (key: string) => {
    const el = document.querySelector<HTMLElement>(`[data-lever="${key}"]`);
    if (el === null) throw new Error(key);
    return el;
  };

  it('a restore goes to its write, then the undo toast names the person', async () => {
    answer();
    render(<PersonPane userId={ROB_ID} />);
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.click(within(lever('comments')).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(mocks.announce).toHaveBeenCalled());
    expect(mocks.mutations.get('moderation:setPostingPermission')).toHaveBeenCalledWith({
      userId: ROB_ID,
      permission: 'comments',
      allowed: true,
    });
    expect(mocks.announce).toHaveBeenCalledWith({
      title: 'Rob Tremblay can comment again',
      target: { targetType: 'user', targetId: ROB_ID },
    });
  });

  it('a Restore refused after another admin promoted the person — its row’s buttons gone — is one toast naming them', async () => {
    answer();
    let refuse: () => void = () => {};
    mocks.mutations.set(
      'moderation:setPostingPermission',
      vi.fn(
        () =>
          new Promise((_, reject) => {
            refuse = () => reject(new ConvexError('Staff can’t be restricted.'));
          }),
      ),
    );
    const view = render(<PersonPane userId={ROB_ID} />);
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.click(within(lever('comments')).getByRole('button', { name: 'Restore' }));
    // Another admin makes them a moderator while the Restore is out: the new read takes the row's
    // buttons away, and the block that holds the row stays drawn.
    mocks.results.set('people:person', {
      ...ROB,
      role: 'moderator',
      // The server's every give-back answers as its restriction does: staff can't be restricted.
      can: {
        ...ROB.can,
        restrict: { ok: false, why: 'Staff can’t be restricted.' },
        restore: {
          reports: { ok: false, why: 'Staff can’t be restricted.' },
          hazards: { ok: false, why: 'Staff can’t be restricted.' },
          comments: { ok: false, why: 'Staff can’t be restricted.' },
        },
      },
    });
    view.rerender(<PersonPane userId={ROB_ID} />);
    expect(within(lever('comments')).queryByRole('button')).toBeNull();
    await act(async () => {
      refuse();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Not changed · Rob Tremblay',
          description: 'Staff can’t be restricted.',
        }),
      ),
    );
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it('a refusal is one toast in the server’s own words, naming the person — never printed in place', async () => {
    answer();
    mocks.mutations.set(
      'moderation:unbanUser',
      vi.fn(async () => {
        throw new ConvexError(
          'This account is being deleted, so its suspension or ban can’t be lifted.',
        );
      }),
    );
    render(<PersonPane userId={ROB_ID} />);
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.click(within(lever('suspension')).getByRole('button', { name: 'Lift' }));
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith({
        title: 'Not changed · Rob Tremblay',
        description: 'This account is being deleted, so its suspension or ban can’t be lifted.',
        tone: 'bad',
        timeout: 0,
      }),
    );
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/This account is being deleted/)).toBeNull();
    expect(mocks.announce).not.toHaveBeenCalled();
  });

  it('a refusal that comes after the person’s page has gone is said once, in a toast naming them', async () => {
    answer();
    let refuse: () => void = () => {};
    mocks.mutations.set(
      'moderation:unbanUser',
      vi.fn(
        () =>
          new Promise((_, reject) => {
            refuse = () => reject(new ConvexError('This account is being deleted.'));
          }),
      ),
    );
    const view = render(<PersonPane userId={ROB_ID} />);
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.click(within(lever('suspension')).getByRole('button', { name: 'Lift' }));
    // The moderator goes on to another section before the server answers.
    view.unmount();
    await act(async () => {
      refuse();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith({
        title: 'Not changed · Rob Tremblay',
        description: 'This account is being deleted.',
        tone: 'bad',
        timeout: 0,
      }),
    );
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it('a refusal that comes once the levers aren’t drawn — the page still mounted, its read failing — is a toast', async () => {
    answer();
    let refuse: () => void = () => {};
    mocks.mutations.set(
      'moderation:unbanUser',
      vi.fn(
        () =>
          new Promise((_, reject) => {
            refuse = () => reject(new ConvexError('This account is being deleted.'));
          }),
      ),
    );
    const view = render(<PersonPane userId={ROB_ID} />);
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.click(within(lever('suspension')).getByRole('button', { name: 'Lift' }));
    // The person read goes (no such account now): the page draws no levers, and stays mounted.
    mocks.results.set('people:person', null);
    view.rerender(<PersonPane userId={ROB_ID} />);
    expect(document.querySelector('[data-lever="suspension"]')).toBeNull();
    await act(async () => {
      refuse();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'This account is being deleted.' }),
      ),
    );
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['nothing changed', { landed: { userId: ROB_ID, changed: false } }],
    [
      'refused as their own content',
      { refused: 'This is yours, so another moderator decides on it.' },
    ],
  ] as const)(
    'an answer after the page has gone — %s — is said once, naming the person',
    async (_, how) => {
      answer();
      let settle: () => void = () => {};
      mocks.mutations.set(
        'moderation:unbanUser',
        vi.fn(
          () =>
            new Promise((resolve, reject) => {
              settle = () =>
                'refused' in how ? reject(new ConvexError(how.refused)) : resolve(how.landed);
            }),
        ),
      );
      const view = render(<PersonPane userId={ROB_ID} />);
      const user = userEvent.setup({ advanceTimers: () => {} });
      await user.click(within(lever('suspension')).getByRole('button', { name: 'Lift' }));
      view.unmount();
      await act(async () => {
        settle();
        await Promise.resolve();
      });
      if ('refused' in how) {
        // A refusal like any other: a toast, in the server's words, naming the person.
        await waitFor(() =>
          expect(mocks.toast).toHaveBeenCalledWith(
            expect.objectContaining({
              title: 'Not changed · Rob Tremblay',
              description: how.refused,
            }),
          ),
        );
        expect(mocks.toast).toHaveBeenCalledTimes(1);
        expect(mocks.announce).not.toHaveBeenCalled();
      } else {
        // Said as a landed write is: its receipt, wherever the moderator has gone, with no Undo.
        await waitFor(() =>
          expect(mocks.announce).toHaveBeenCalledWith(
            expect.objectContaining({
              title: 'Nothing changed — Rob Tremblay was already set that way',
              undoable: false,
            }),
          ),
        );
        expect(mocks.toast).not.toHaveBeenCalled();
      }
    },
  );

  it('each lever reaches its own write with its own arguments', async () => {
    answer();
    render(<PersonPane userId={ROB_ID} />);
    const user = userEvent.setup({ advanceTimers: () => {} });
    // A promotion from the role menu.
    await user.click(within(lever('role')).getByRole('button', { name: /Change role/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Make admin/ }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: /Make admin/ }),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() =>
      expect(mocks.mutations.get('admin:grantRole')).toHaveBeenCalledWith({
        userId: ROB_ID,
        role: 'admin',
      }),
    );
    // A ban, with its reason.
    await user.click(within(lever('ban')).getByRole('button', { name: 'Ban' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'Threats');
    const ban = within(dialog).getByRole('button', { name: /^Ban/ });
    await user.click(ban);
    await user.click(ban);
    await waitFor(() =>
      expect(mocks.mutations.get('moderation:banUser')).toHaveBeenCalledWith({
        userId: ROB_ID,
        reason: 'Threats',
      }),
    );
    expect(mocks.announce).toHaveBeenLastCalledWith({
      title: 'Rob Tremblay is banned',
      description: 'The account is kept for an appeal',
      target: { targetType: 'user', targetId: ROB_ID },
    });
  });

  it('a History row’s Undo is the shell’s, asking a reason only where the server says', async () => {
    answer();
    render(<PersonPane userId={ROB_ID} />);
    const user = userEvent.setup({ advanceTimers: () => {} });
    const undo = screen.getAllByRole('button', { name: 'Undo' });
    await user.click(undo[0] as HTMLElement);
    expect(mocks.undo).toHaveBeenCalledWith({
      actionId: ROB_HISTORY.rows[0]?.id,
      needsReason: false,
      what: 'Suspended an account',
    });
  });
});

describe('the write hook', () => {
  const person = { userId: ROB_ID, displayName: 'Rob Tremblay', defaultBountyLimit: 3 };
  const hook = () => renderHook(() => usePersonWrites(person, NOW)).result.current;
  const called = (name: string) => mocks.mutations.get(name);

  it('maps every action to its server write', async () => {
    const run = hook();
    await run({ kind: 'bountyLimit', limit: 1, reason: 'Too many asks' });
    expect(called('moderation:setBountyPostLimit')).toHaveBeenLastCalledWith({
      userId: ROB_ID,
      limit: 1,
      reason: 'Too many asks',
    });
    await run({ kind: 'bountyLimit', limit: null });
    expect(called('moderation:setBountyPostLimit')).toHaveBeenLastCalledWith({ userId: ROB_ID });
    await run({ kind: 'suspend', until: NOW + 1, reason: 'Cool off', extend: false });
    expect(called('moderation:suspendUser')).toHaveBeenLastCalledWith({
      userId: ROB_ID,
      reason: 'Cool off',
      suspendedUntil: NOW + 1,
    });
    await run({ kind: 'role', role: 'member', reason: 'Stepping back' });
    expect(called('admin:revokeRole')).toHaveBeenLastCalledWith({
      userId: ROB_ID,
      reason: 'Stepping back',
    });
    await run({ kind: 'role', role: 'moderator' });
    expect(called('admin:grantRole')).toHaveBeenLastCalledWith({
      userId: ROB_ID,
      role: 'moderator',
    });
    await run({ kind: 'ledger', grant: true });
    expect(called('ledger:grantEditor')).toHaveBeenLastCalledWith({ userId: ROB_ID });
    await run({ kind: 'ledger', grant: false, reason: 'Done' });
    expect(called('ledger:revokeEditor')).toHaveBeenLastCalledWith({
      userId: ROB_ID,
      reason: 'Done',
    });
    await run({ kind: 'right', permission: 'flagging', allowed: false, reason: 'Floods' });
    expect(called('moderation:setPostingPermission')).toHaveBeenLastCalledWith({
      userId: ROB_ID,
      permission: 'flagging',
      allowed: false,
      reason: 'Floods',
    });
    expect(mocks.announce).toHaveBeenCalledTimes(8);
  });

  it('reports success as soon as the server answers — the toast never holds it up', async () => {
    let lookup: () => void = () => {};
    mocks.announce.mockImplementationOnce(() => new Promise<void>((r) => (lookup = r)));
    const result = await hook()({ kind: 'lift' });
    expect(result).toBe(true);
    expect(mocks.announce).toHaveBeenCalledTimes(1);
    lookup();
  });

  it('a toast that fails is absorbed; the write still landed', async () => {
    mocks.announce.mockImplementationOnce(async () => {
      throw new Error('lookup failed');
    });
    expect(await hook()({ kind: 'lift' })).toBe(true);
  });

  it('carries the audit row a write answers with, when it does', async () => {
    mocks.mutations.set(
      'moderation:unbanUser',
      vi.fn(async () => ({ actionId: 'row1' })),
    );
    await hook()({ kind: 'lift' });
    expect(mocks.announce).toHaveBeenLastCalledWith(expect.objectContaining({ actionId: 'row1' }));
    expect(actionIdOf(ROB_ID)).toBeNull();
    expect(actionIdOf(null)).toBeNull();
    expect(actionIdOf({ actionId: 3 })).toBeNull();
    // Without what its undo asks, the toast looks it up.
    expect(mocks.announce).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ undoNeedsReason: expect.anything() }),
    );
  });

  it('reads the follow-up’s answer — the person, the row and what undoing asks — into the toast', async () => {
    mocks.mutations.set(
      'moderation:unbanUser',
      vi.fn(async () => ({ userId: ROB_ID, actionId: 'row2', undoNeedsReason: false })),
    );
    await hook()({ kind: 'lift' });
    expect(mocks.announce).toHaveBeenLastCalledWith(
      expect.objectContaining({ actionId: 'row2', undoNeedsReason: false }),
    );
  });

  it('carries what undoing the write asks, when the write says', async () => {
    mocks.mutations.set(
      'moderation:unbanUser',
      vi.fn(async () => ({ actionId: 'row1', undoNeedsReason: true })),
    );
    await hook()({ kind: 'lift' });
    expect(mocks.announce).toHaveBeenLastCalledWith(
      expect.objectContaining({ actionId: 'row1', undoNeedsReason: true }),
    );
    expect(undoNeedsReasonOf({ undoNeedsReason: 'yes' })).toBeNull();
    expect(undoNeedsReasonOf(null)).toBeNull();
  });

  it('a write that changed something but can’t be undone now: its receipt, no Undo, nothing looked up', async () => {
    mocks.mutations.set(
      'moderation:unbanUser',
      vi.fn(async () => ({ userId: ROB_ID, changed: true, undoable: false })),
    );
    expect(await hook()({ kind: 'lift' })).toBe(true);
    const receipt = (
      mocks.announce.mock.lastCall as unknown as [{ title?: string }] | undefined
    )?.[0];
    expect(receipt).toMatchObject({
      target: { targetType: 'user', targetId: ROB_ID },
      undoable: false,
    });
    expect(receipt).not.toHaveProperty('actionId');
    expect(receipt?.title).not.toBe('Nothing changed — Rob Tremblay was already set that way');
    expect(undoableOf({ undoable: true })).toBe(true);
    expect(undoableOf({ undoable: 'no' })).toBeNull();
    expect(undoableOf(null)).toBeNull();
  });

  it('a write that changed nothing says so — no Undo, nothing looked up', async () => {
    mocks.mutations.set(
      'moderation:banUser',
      vi.fn(async () => ({ userId: ROB_ID, changed: false, undoable: false })),
    );
    expect(await hook()({ kind: 'ban', reason: 'Spam' })).toBe(true);
    expect(mocks.announce).toHaveBeenLastCalledWith({
      title: 'Nothing changed — Rob Tremblay was already set that way',
      target: { targetType: 'user', targetId: ROB_ID },
      undoable: false,
    });
    expect(changedOf({ changed: true })).toBe(true);
    expect(changedOf({ changed: 'no' })).toBeNull();
    expect(changedOf(null)).toBeNull();
  });

  it('says so in a toast when there is no person to write to, and when the network fails', async () => {
    const none = renderHook(() => usePersonWrites(null, NOW)).result.current;
    expect(await none({ kind: 'lift' })).toBe(false);
    expect(mocks.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: 'Not changed',
        description: 'This person couldn’t be read',
      }),
    );
    mocks.mutations.set(
      'moderation:unbanUser',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(await hook()({ kind: 'lift' })).toBe(false);
    expect(mocks.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: 'Not changed · Rob Tremblay',
        description: 'Something went wrong — check your connection and try again.',
      }),
    );
    expect(mocks.toast).toHaveBeenCalledTimes(2);
  });
});
