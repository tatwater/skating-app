import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getFunctionName } from 'convex/server';
import { ConvexError } from 'convex/values';
import { type ReactElement, useRef } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { Toaster } from '@/components/kit/toast';
import { stubJsdomAnimations } from '../../../body/tabs/jsdomStubs';
import { UndoProvider, type UndoServer } from '../../../shell/undo';
import {
  AccessActions,
  AccessBody,
  type AccessHandlerProps,
  AccessHead,
} from './AccessHandlerView';
import {
  ACCESS_NOW,
  AFTER_NO_ACCESS,
  CUT,
  DISPUTE,
  FIRST_REPORT,
  READ_ONLY,
} from './accessHandlerFixtures';
import type { AccessAct, AccessItem } from './accessModel';
import { type AccessWriteFn, type RuleAccessResult, useAccessRunner } from './useAccessWrites';

/**
 * The access handler's slots and its write path: the bar drawn only where `can` allows, N opening
 * the reason dialog and C acting only while the inspector pane has focus, a refusal said in a toast
 * and never in place, a landed ruling announced for undo, one write at a time.
 */

beforeAll(() => {
  // The toast's time bar asks for a whole Animation (play, pause), not only the kit's stub.
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: () =>
      ({
        cancel() {},
        pause() {},
        play() {},
        currentTime: 0,
        finished: Promise.resolve(),
      }) as unknown as Animation,
  });
  stubJsdomAnimations();
});

/** A toolbar button stays focusable while disabled: Base UI marks it, it doesn't set `disabled`. */
const expectHeld = (el: HTMLElement) =>
  expect(el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true').toBe(true);

const server = (): UndoServer & { latestOwn: ReturnType<typeof vi.fn> } => ({
  latestOwn: vi.fn(async () => null),
  run: vi.fn(async () => {}),
});

/** The inspector stand-in: a focusable pane holding the body and the bar. */
function Pane({
  item,
  onRule,
  pending = null,
}: {
  item: AccessItem;
  onRule: AccessHandlerProps['onRule'];
  pending?: AccessAct | null;
}) {
  const pane = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={pane} tabIndex={-1} data-testid="pane">
      <AccessHead item={item} bodyLink={<a href="/admin/body/wb">x</a>} />
      <AccessBody item={item} now={ACCESS_NOW} map={null} timeZone="America/New_York" />
      <AccessActions item={item} onRule={onRule} pending={pending} pane={pane} />
    </div>
  );
}

const inShell = (ui: ReactElement, s: UndoServer = server()) =>
  render(
    <Toaster>
      <UndoProvider server={s}>{ui}</UndoProvider>
    </Toaster>,
  );

describe('the slots', () => {
  it('draws the board: the head, the stats, the timeline, the two futures', () => {
    inShell(<Pane item={DISPUTE} onRule={vi.fn(async () => true)} />);
    expect(screen.getByText('Access reports')).toBeInTheDocument();
    // One in the head, one the body shows only when the head has no room (a container query).
    expect(screen.getAllByText('Disputes a ruling').map((b) => b.dataset.slot)).toEqual([
      'access-head-badge',
      'access-body-badge',
    ]);
    expect(screen.getByRole('link', { name: /Open in Body/ })).toHaveAttribute(
      'href',
      '/admin/body/wb',
    );
    expect(screen.getByRole('heading', { name: 'Tomhannock Reservoir' })).toBeInTheDocument();
    expect(screen.getByText('Reservoir · Troy, NY · 1,650 ac')).toBeInTheDocument();
    const events = screen
      .getAllByRole('listitem')
      .filter((li) => li.dataset.slot === 'item-timeline-event');
    expect(events.map((e) => e.dataset.mark)).toEqual(['bad', 'bad', 'bright', 'quiet']);
    expect(within(events[2] as HTMLElement).getByText('Standing ruling')).toBeInTheDocument();
    expect(within(events[2] as HTMLElement).getByText('Teagan Atwater')).toBeInTheDocument();
    expect(
      within(events[2] as HTMLElement).getByText('Source: The town clerk, by email'),
    ).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'If no public access' })).toHaveTextContent(
      'Replaces 12 Sep’s',
    );
  });

  it('draws the three buttons, Clear with no key', () => {
    inShell(<Pane item={DISPUTE} onRule={vi.fn(async () => true)} />);
    expect(screen.getByRole('button', { name: 'No public access' })).toHaveAttribute(
      'aria-keyshortcuts',
      'N',
    );
    expect(screen.getByRole('button', { name: 'Confirm accessible' })).toHaveAttribute(
      'aria-keyshortcuts',
      'C',
    );
    expect(screen.getByRole('button', { name: 'Clear the accessible ruling' })).not.toHaveAttribute(
      'aria-keyshortcuts',
    );
  });

  it('draws no bar for a viewer refused every verb, and no Clear with nothing to clear', () => {
    const { unmount } = inShell(<Pane item={READ_ONLY} onRule={vi.fn(async () => true)} />);
    expect(screen.queryByRole('toolbar')).toBeNull();
    unmount();
    inShell(<Pane item={FIRST_REPORT} onRule={vi.fn(async () => true)} />);
    expect(screen.queryByRole('button', { name: /Clear/ })).toBeNull();
    expect(screen.queryByText('Disputes a ruling')).toBeNull();
  });

  it('words Clear for the ruling it clears', () => {
    inShell(<Pane item={AFTER_NO_ACCESS} onRule={vi.fn(async () => true)} />);
    expect(screen.getByRole('button', { name: 'Clear the no-access ruling' })).toBeInTheDocument();
  });
});

describe('a list served short of the item’s count', () => {
  it('says how many of how many, and counts nothing on the page as the whole', () => {
    inShell(<Pane item={CUT} onRule={vi.fn(async () => true)} />);
    // The shared line, as the ask and flag lists say it.
    expect(screen.getByText('Showing 6 of 500+ reports')).toBeInTheDocument();
    // The reporters counted on the page are a floor; the ruling's dismissals too.
    expect(screen.getByText('6+')).toBeInTheDocument();
    expect(screen.getByText('2+ reports · dismissed by that ruling')).toBeInTheDocument();
    // A ruling closes every open report the item counts, not the page served.
    expect(screen.getByRole('region', { name: 'If no public access' })).toHaveTextContent(
      'All 500+ closed',
    );
  });

  it('draws no line while the list is whole', () => {
    inShell(<Pane item={DISPUTE} onRule={vi.fn(async () => true)} />);
    expect(screen.queryByText(/^Showing/)).toBeNull();
  });
});

describe('the keys', () => {
  it('C confirms accessible only while the inspector pane has focus', async () => {
    const user = userEvent.setup();
    const onRule = vi.fn(async () => true);
    inShell(<Pane item={DISPUTE} onRule={onRule} />);
    await user.keyboard('c');
    expect(onRule).not.toHaveBeenCalled();
    act(() => screen.getByTestId('pane').focus());
    await user.keyboard('c');
    expect(onRule).toHaveBeenCalledWith('open');
  });

  it('N opens the reason dialog; Esc leaves it; ⌘⏎ sends the reason', async () => {
    const user = userEvent.setup();
    const onRule = vi.fn(async () => true);
    inShell(<Pane item={DISPUTE} onRule={onRule} />);
    act(() => screen.getByTestId('pane').focus());
    await user.keyboard('n');
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('No public access · Tomhannock Reservoir');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(onRule).not.toHaveBeenCalled();

    act(() => screen.getByTestId('pane').focus());
    await user.keyboard('n');
    const reason = await screen.findByRole('textbox');
    await user.type(reason, 'Posted by the water department');
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() =>
      expect(onRule).toHaveBeenCalledWith('none', 'Posted by the water department'),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('keeps the dialog open over its reason when the ruling is refused', async () => {
    const user = userEvent.setup();
    const onRule = vi.fn(async () => false);
    inShell(<Pane item={DISPUTE} onRule={onRule} />);
    await user.click(screen.getByRole('button', { name: 'No public access' }));
    await user.type(await screen.findByRole('textbox'), 'Gated');
    await user.click(screen.getByRole('button', { name: /^No public access/, hidden: false }));
    await waitFor(() => expect(onRule).toHaveBeenCalled());
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('Gated');
  });

  it('shows a ruling in flight on its button and holds every other', () => {
    inShell(<Pane item={DISPUTE} onRule={vi.fn(async () => true)} pending="open" />);
    expectHeld(screen.getByRole('button', { name: 'No public access' }));
    expectHeld(screen.getByRole('button', { name: 'Clear the accessible ruling' }));
    expect(screen.getByRole('button', { name: 'Confirm accessible' })).toHaveAttribute('aria-busy');
  });
});

describe('the write path', () => {
  const subject = {
    itemId: DISPUTE.itemId,
    waterBodyId: DISPUTE.body.waterBodyId,
    name: DISPUTE.body.name,
  };
  /** `ruleAccess`'s answer: the ruling's row, the reports it closed, its undo. */
  const ruled = (
    verdict: 'none' | 'open' | null,
    flagsClosed: number,
    undo: { undoable: true; undoNeedsReason: boolean } | { undoable: false } = {
      undoable: true,
      undoNeedsReason: false,
    },
  ): RuleAccessResult => ({
    itemId: DISPUTE.itemId,
    actionId: 'a_ruling' as RuleAccessResult['actionId'],
    flagsClosed,
    verdict,
    ...undo,
  });

  function Runner({
    write,
    onDone,
    on = subject,
  }: {
    write: AccessWriteFn;
    onDone: (landed: boolean) => void;
    on?: typeof subject;
  }) {
    const { run, pending } = useAccessRunner(on, write);
    return (
      <>
        <button type="button" onClick={() => void run('open').then(onDone)}>
          Rule
        </button>
        <button type="button" onClick={() => void run('none', 'Gated').then(onDone)}>
          Rule closed
        </button>
        <button type="button" onClick={() => void run('clear').then(onDone)}>
          Clear
        </button>
        <output data-testid="pending">{pending ?? ''}</output>
      </>
    );
  }

  it('rules through the item, and announces the ruling’s own row for undo', async () => {
    const user = userEvent.setup();
    const s = server();
    const write = vi.fn<AccessWriteFn>(async () => ruled('open', 2));
    const onDone = vi.fn();
    inShell(<Runner write={write} onDone={onDone} />, s);
    await user.click(screen.getByRole('button', { name: 'Rule' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(true));
    // The item, never the body: the Inbox's rule is asked first.
    expect(write).toHaveBeenCalledWith({ itemId: DISPUTE.itemId, verdict: 'open' });
    expect((await screen.findAllByText(/Ruled accessible/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText('2 reports dismissed · reporters told').length).toBeGreaterThan(0);
    // The answer named the row, so nothing is looked up; its Undo is offered.
    expect(s.latestOwn).not.toHaveBeenCalled();
    expect(screen.getAllByRole('button', { name: /Undo/ }).length).toBeGreaterThan(0);
  });

  it('sends the reason with No public access', async () => {
    const user = userEvent.setup();
    const write = vi.fn<AccessWriteFn>(async () => ruled('none', 2));
    inShell(<Runner write={write} onDone={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Rule closed' }));
    await waitFor(() =>
      expect(write).toHaveBeenCalledWith({
        itemId: DISPUTE.itemId,
        verdict: 'none',
        reason: 'Gated',
      }),
    );
    expect(
      (await screen.findAllByText('2 reports closed · reporters told')).length,
    ).toBeGreaterThan(0);
  });

  it('says a clear truthfully: no report closed, the item stays in its lane', async () => {
    const user = userEvent.setup();
    const write = vi.fn<AccessWriteFn>(async () => ruled(null, 0));
    inShell(<Runner write={write} onDone={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(write).toHaveBeenCalledWith({ itemId: DISPUTE.itemId, verdict: null }),
    );
    expect((await screen.findAllByText(/Cleared the ruling/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText('The reports stay open, in the lane').length).toBeGreaterThan(0);
    expect(screen.queryByText(/closed · reporters told/)).toBeNull();
  });

  it('offers no Undo when the server says the ruling can’t be undone now', async () => {
    const user = userEvent.setup();
    const s = server();
    const write = vi.fn<AccessWriteFn>(async () => ruled('open', 1, { undoable: false }));
    inShell(<Runner write={write} onDone={vi.fn()} />, s);
    await user.click(screen.getByRole('button', { name: 'Rule' }));
    expect(
      (await screen.findAllByText('1 report dismissed · the reporter told')).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
    expect(s.latestOwn).not.toHaveBeenCalled();
  });

  it.each([
    'Requires moderator role',
    'No such item.',
    'This item is not an access question.',
    'You filed this, so another staff member decides it.',
    'There is no ruling to clear.',
    'A reason is required',
  ])('says the server’s refusal “%s” once, in a toast naming the body', async (sentence) => {
    const user = userEvent.setup();
    const s = server();
    const onDone = vi.fn();
    const write = vi.fn<AccessWriteFn>(async () => {
      throw new ConvexError(sentence);
    });
    const { container } = inShell(<Runner write={write} onDone={onDone} />, s);
    await user.click(screen.getByRole('button', { name: 'Rule' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(false));
    expect((await screen.findAllByText(`The ruling: ${sentence}`)).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Not saved · Tomhannock Reservoir').length).toBeGreaterThan(0);
    // Never in place: the runner's own markup holds no word of it.
    expect(container.querySelector('output')?.textContent).toBe('');
    expect(s.latestOwn).not.toHaveBeenCalled();
  });

  it('never shows a ruling’s receipt over the next item, nor after the handler has gone', async () => {
    const user = userEvent.setup();
    let answer: (v: RuleAccessResult) => void = () => {};
    const write = vi.fn<AccessWriteFn>(() => new Promise((r) => (answer = r)));
    const s = server();
    const shell = (ui: ReactElement | null) => (
      <Toaster>
        <UndoProvider server={s}>{ui}</UndoProvider>
      </Toaster>
    );
    const onDone = vi.fn();
    const next = { ...subject, itemId: 'it_next' as typeof subject.itemId };
    const { rerender } = render(shell(<Runner write={write} onDone={onDone} />));
    await user.click(screen.getByRole('button', { name: 'Rule' }));
    // The moderator moves on to the next item while the ruling is out.
    rerender(shell(<Runner write={write} onDone={onDone} on={next} />));
    await act(async () => answer(ruled('open', 2)));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(true));
    expect(screen.queryByText(/Ruled accessible/)).toBeNull();

    // And again with the handler gone altogether (the inspector closed).
    rerender(shell(<Runner write={write} onDone={onDone} />));
    await user.click(screen.getByRole('button', { name: 'Rule' }));
    rerender(shell(null));
    await act(async () => answer(ruled('open', 2)));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Ruled accessible/)).toBeNull();

    // Still on the same item: the receipt shows.
    rerender(shell(<Runner write={write} onDone={onDone} />));
    await user.click(screen.getByRole('button', { name: 'Rule' }));
    await act(async () => answer(ruled('open', 2)));
    expect((await screen.findAllByText(/Ruled accessible/)).length).toBeGreaterThan(0);
  });

  it('sends one ruling at a time, and shows it pending until answered', async () => {
    const user = userEvent.setup();
    let answer: (v: RuleAccessResult) => void = () => {};
    const write = vi.fn<AccessWriteFn>(() => new Promise((r) => (answer = r)));
    const onDone = vi.fn();
    inShell(<Runner write={write} onDone={onDone} />);
    await user.click(screen.getByRole('button', { name: 'Rule' }));
    expect(screen.getByTestId('pending')).toHaveTextContent('open');
    await user.click(screen.getByRole('button', { name: 'Rule closed' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(false));
    expect(write).toHaveBeenCalledTimes(1);
    await act(async () => answer(ruled('open', 2)));
    await waitFor(() => expect(screen.getByTestId('pending')).toHaveTextContent(''));
    expect(onDone).toHaveBeenLastCalledWith(true);
  });
});

describe('useAccessWrites', () => {
  it('rules through the Inbox’s own write, never the Body console’s lever', async () => {
    vi.resetModules();
    const refs: unknown[] = [];
    vi.doMock('convex/react', () => ({
      useMutation: (ref: unknown) => {
        refs.push(ref);
        return vi.fn();
      },
    }));
    const { api } = await import('@skating/convex/api');
    const { useAccessWrites, RULE_ACCESS } = await import('./useAccessWrites');
    const { UndoProvider: FreshUndo } = await import('../../../shell/undo');
    function Probe() {
      useAccessWrites({
        itemId: DISPUTE.itemId,
        waterBodyId: DISPUTE.body.waterBodyId,
        name: DISPUTE.body.name,
      });
      return null;
    }
    render(
      <FreshUndo server={server()}>
        <Probe />
      </FreshUndo>,
    );
    // Convex's references are proxies: compared by the function they name.
    const names = refs.map((r) => getFunctionName(r as never));
    expect(getFunctionName(RULE_ACCESS)).toBe(getFunctionName(api.inboxWrites.ruleAccess));
    expect(names).toContain('inboxWrites:ruleAccess');
    expect(names.every((n) => n === 'inboxWrites:ruleAccess')).toBe(true);
    expect(names).not.toContain('waterBodies:setPublicAccess');
    vi.doUnmock('convex/react');
  });
});

describe('the registered handler', () => {
  it('is the access key’s, and draws the item inside the frame with its bar', async () => {
    vi.resetModules();
    vi.doMock('@tanstack/react-router', () => ({
      Link: ({
        params,
        search,
      }: {
        params: { id: string };
        search: { tab: string; from: string };
      }) => (
        <a
          href={`/admin/body/${params.id}?tab=${search.tab}&from=${encodeURIComponent(search.from)}`}
        >
          x
        </a>
      ),
      useRouterState: () => '/admin/inbox?lane=accessReports&item=access:wb_tomhannock',
    }));
    vi.doMock('convex/react', () => ({ useMutation: () => vi.fn(async () => 'wb') }));
    vi.doMock('@/components/theme-provider', () => ({
      useTheme: () => ({ resolvedTheme: 'dark' }),
    }));
    vi.doMock('../../map/ItemMap', () => ({ ItemMap: () => <div data-slot="item-map-slot" /> }));
    const { registration } = await import('./register');
    // After the reset the handler reads the fresh modules' context: mount their provider.
    const { UndoProvider: FreshUndo } = await import('../../../shell/undo');
    const mount = (ui: ReactElement) =>
      render(
        <Toaster>
          <FreshUndo server={server()}>{ui}</FreshUndo>
        </Toaster>,
      );
    const { registeredHandler, buildRegistry } = await import('../../inspector/handlerRegistry');
    expect(registration.keys).toEqual(['access']);
    const registry = buildRegistry({ './Access/register.tsx': { registration } });
    const Handler = registeredHandler(DISPUTE, registry);
    expect(Handler).toBe(registration.Handler);
    if (Handler === undefined) return;
    const { unmount } = mount(<Handler item={DISPUTE} locked={null} now={ACCESS_NOW} />);
    expect(screen.getByRole('heading', { name: 'Access reports' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /x/ })).toHaveAttribute(
      'href',
      `/admin/body/wb_tomhannock?tab=access&from=${encodeURIComponent('/admin/inbox?lane=accessReports&item=access:wb_tomhannock')}`,
    );
    expect(screen.getByRole('toolbar')).toBeInTheDocument();
    // The map slot is the item map's.
    expect(
      document.querySelector('[data-slot="access-map"] [data-slot="item-map-slot"]'),
    ).not.toBeNull();
    unmount();
    // Decided: the frame drops the bar.
    mount(
      <Handler
        item={DISPUTE}
        locked={{
          by: 'Sarah',
          at: ACCESS_NOW,
          decision: 'ruled_accessible',
          byMe: false,
          actionId: 'a',
        }}
        now={ACCESS_NOW}
      />,
    );
    expect(screen.queryByRole('toolbar')).toBeNull();
    vi.doUnmock('@tanstack/react-router');
    vi.doUnmock('convex/react');
    vi.doUnmock('@/components/theme-provider');
    vi.doUnmock('../../map/ItemMap');
    vi.doUnmock('../../map/ItemMap');
  });
});
