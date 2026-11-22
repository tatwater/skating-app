import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConvexError } from 'convex/values';
import { type ReactElement, useRef } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { Toaster } from '@/components/kit/toast';
import { stubJsdomAnimations } from '../../../body/tabs/jsdomStubs';
import { UndoProvider, type UndoServer } from '../../../shell/undo';
import { DrawnActions, DrawnBody, type DrawnHandlerProps, DrawnHead } from './DrawnHandlerView';
import {
  BELOW_THRESHOLD,
  DRAWER_GONE,
  DRAWN_BY_VIEWER,
  DRAWN_NOW,
  MODERATOR_VIEW,
  NEW_WATER,
  OVER_CASPIAN,
} from './drawnFixtures';
import type { DrawnItem } from './drawnModel';
import { type DrawnServer, useDrawnWrites } from './useDrawnWrites';

/**
 * The drawn handler's slots and its writes: the board's blocks, the bar drawn only where `can`
 * allows, Merge saying *Coming soon* and never writing, A acting only while the pane has focus,
 * Reject asking the drawer's reason, a refusal said in a toast and never in place, a landed decision
 * announced with Undo on the body the write answered with, one write at a time.
 */

beforeAll(() => {
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

/** A decision's answer, as the server writes it: its own row and this viewer's undo offer. */
const ANSWER = { actionId: 'ma_drawn', undoable: true as const, undoNeedsReason: false };

const undoServer = (): UndoServer & { latestOwn: ReturnType<typeof vi.fn> } => ({
  latestOwn: vi.fn(async () => null),
  run: vi.fn(async () => {}),
});

function Pane({
  item,
  onApprove = vi.fn(async () => true),
  onReject = vi.fn(async () => true),
  pending = null,
}: {
  item: DrawnItem;
  onApprove?: DrawnHandlerProps['onApprove'];
  onReject?: DrawnHandlerProps['onReject'];
  pending?: DrawnHandlerProps['pending'];
}) {
  const pane = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={pane} tabIndex={-1} data-testid="pane">
      <DrawnHead item={item} now={DRAWN_NOW} bodyLink={<a href="/admin/body/wb">x</a>} />
      <DrawnBody
        item={item}
        map={null}
        editorLink={<a href="/admin/water/wb">x</a>}
        timeZone="America/New_York"
      />
      <DrawnActions
        item={item}
        onApprove={onApprove}
        onReject={onReject}
        pending={pending}
        pane={pane}
      />
    </div>
  );
}

const inShell = (ui: ReactElement, s: UndoServer = undoServer()) =>
  render(
    <Toaster>
      <UndoProvider server={s}>{ui}</UndoProvider>
    </Toaster>,
  );

describe('the slots', () => {
  it('draws the board: the head, the gauge, the report, what a merge does', () => {
    inShell(<Pane item={OVER_CASPIAN} />);
    expect(screen.getByText('Drawn body', { selector: 'h2' })).toBeInTheDocument();
    expect(screen.getByText('From a recorded skate · 2 hours ago')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open in Body/ })).toHaveAttribute(
      'href',
      '/admin/body/wb',
    );
    expect(screen.getByRole('meter', { name: 'Of the drawing is Caspian Lake' })).toHaveAttribute(
      'aria-valuenow',
      '92',
    );
    expect(screen.getByText('Merge suggested from 80 %')).toHaveAttribute('data-reached');
    const report = screen.getByRole('region', { name: 'The report it came from' });
    expect(within(report).getByText('Kate Donovan')).toBeInTheDocument();
    expect(within(report).getByText('Trusted · 41 pts')).toBeInTheDocument();
    expect(within(report).getByText('11 Oct')).toBeInTheDocument();
    const merged = screen.getByRole('region', { name: 'If merged into Caspian Lake' });
    expect(merged).toHaveTextContent('Re-homed · stays visible');
    expect(merged).toHaveTextContent('Coming soon · the old editor merges it');
    // The old editor opens in a new tab: a page outside the console.
    expect(within(merged).getByRole('link', { name: /Old editor/ })).toHaveAttribute(
      'target',
      '_blank',
    );
  });

  it('says a drawing over no body plainly, with no gauge and no merge block', () => {
    inShell(<Pane item={NEW_WATER} />);
    expect(screen.queryByRole('meter')).toBeNull();
    expect(screen.getByText('It overlaps no body on the map')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /If merged into/ })).toBeNull();
    expect(screen.getByText('No report is linked to this drawing')).toBeInTheDocument();
    expect(screen.getByText('Drawn by a skater · 2 hours ago')).toBeInTheDocument();
  });

  it('keeps the threshold label quiet short of it', () => {
    inShell(<Pane item={BELOW_THRESHOLD} />);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '41');
    expect(screen.getByText('Merge suggested from 80 %')).not.toHaveAttribute('data-reached');
  });

  it('names no departed drawer', () => {
    inShell(<Pane item={DRAWER_GONE} />);
    expect(screen.getByText('A former skater')).toBeInTheDocument();
    expect(screen.queryByText('Deleted user')).toBeNull();
  });

  it('says the refusal once when nothing can be drawn, never as a button', () => {
    inShell(<Pane item={DRAWN_BY_VIEWER} />);
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(screen.getByRole('note')).toHaveTextContent(
      'You filed this, so another staff member decides it.',
    );
  });
});

describe('the bar', () => {
  it('draws Merge (Coming soon, no key), Approve as new (A), Reject (R)', () => {
    inShell(<Pane item={OVER_CASPIAN} />);
    const merge = screen.getByRole('button', { name: /Merge into Caspian Lake/ });
    expect(merge).toHaveAttribute('aria-disabled', 'true');
    expect(merge).toHaveAttribute('data-unavailable-title', 'Coming soon');
    expect(merge).not.toHaveAttribute('aria-keyshortcuts');
    expect(screen.getByRole('button', { name: 'Approve as new' })).toHaveAttribute(
      'aria-keyshortcuts',
      'A',
    );
    expect(screen.getByRole('button', { name: 'Reject' })).toHaveAttribute(
      'aria-keyshortcuts',
      'R',
    );
  });

  it('draws no merge for a viewer the server refuses it', () => {
    inShell(<Pane item={MODERATOR_VIEW} />);
    expect(screen.queryByRole('button', { name: /Merge/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve as new' })).toBeInTheDocument();
  });

  it('Merge says Coming soon on a press and writes nothing; M is no key of it', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn(async () => true);
    const onReject = vi.fn(async () => true);
    inShell(<Pane item={OVER_CASPIAN} onApprove={onApprove} onReject={onReject} />);
    screen.getByTestId('pane').focus();
    await user.keyboard('m');
    expect(screen.queryByText('Coming soon')).toBeNull();
    await user.click(screen.getByRole('button', { name: /Merge into Caspian Lake/ }));
    await waitFor(() => expect(screen.getAllByText('Coming soon').length).toBeGreaterThan(0));
    expect(onApprove).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
  });

  it('A acts only while the pane has focus', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn(async () => true);
    inShell(<Pane item={OVER_CASPIAN} onApprove={onApprove} />);
    await user.keyboard('a');
    expect(onApprove).not.toHaveBeenCalled();
    screen.getByTestId('pane').focus();
    await user.keyboard('a');
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
  });

  it('R asks the reason the drawer reads, and sends it', async () => {
    const user = userEvent.setup();
    const onReject = vi.fn(async () => true);
    inShell(<Pane item={OVER_CASPIAN} onReject={onReject} />);
    screen.getByTestId('pane').focus();
    await user.keyboard('r');
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Reason · the drawer reads it')).toBeInTheDocument();
    const box = within(dialog).getByRole('textbox');
    // Core's cap on a note an asker reads.
    expect(box).toHaveAttribute('maxlength', '280');
    await user.type(box, 'Already on the map as Caspian Lake');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(onReject).toHaveBeenCalledWith('Already on the map as Caspian Lake'),
    );
  });
});

describe('the writes', () => {
  function Harness({ item, server }: { item: DrawnItem; server: DrawnServer }) {
    const { approve, reject, pending } = useDrawnWrites(item, server);
    return (
      <>
        <button type="button" onClick={() => void approve()}>
          go-approve
        </button>
        <button type="button" onClick={() => void reject('  Not water  ')}>
          go-reject
        </button>
        <span data-testid="pending">{pending ?? 'none'}</span>
      </>
    );
  }

  it('approves with the item’s body, and announces with Undo from the write’s own answer', async () => {
    const user = userEvent.setup();
    const u = undoServer();
    const server: DrawnServer = {
      approve: vi.fn(async ({ waterBodyId }) => ({ waterBodyId, ...ANSWER })),
      reject: vi.fn(async ({ waterBodyId }) => ({ waterBodyId, ...ANSWER })),
    };
    inShell(<Harness item={OVER_CASPIAN} server={server} />, u);
    await user.click(screen.getByRole('button', { name: 'go-approve' }));
    await waitFor(() =>
      expect(server.approve).toHaveBeenCalledWith({ waterBodyId: OVER_CASPIAN.body.waterBodyId }),
    );
    expect(await screen.findByText(/Approved as new/)).toBeInTheDocument();
    expect(screen.getByText('Lists it on the map · tells the drawer')).toBeInTheDocument();
    // Undo is the answer's row: nothing is looked up.
    expect((await screen.findAllByRole('button', { name: /Undo/ })).length).toBeGreaterThan(0);
    expect(u.latestOwn).not.toHaveBeenCalled();
  });

  it('rejects with the reason trimmed', async () => {
    const user = userEvent.setup();
    const server: DrawnServer = {
      approve: vi.fn(async ({ waterBodyId }) => ({ waterBodyId, ...ANSWER })),
      reject: vi.fn(async ({ waterBodyId }) => ({ waterBodyId, ...ANSWER })),
    };
    inShell(<Harness item={OVER_CASPIAN} server={server} />);
    await user.click(screen.getByRole('button', { name: 'go-reject' }));
    await waitFor(() =>
      expect(server.reject).toHaveBeenCalledWith({
        waterBodyId: OVER_CASPIAN.body.waterBodyId,
        reason: 'Not water',
      }),
    );
  });

  it('says a refusal in a toast with the server’s words, and announces nothing', async () => {
    const user = userEvent.setup();
    const u = undoServer();
    const server: DrawnServer = {
      approve: vi.fn(async () => {
        throw new ConvexError('This has already been decided.');
      }),
      reject: vi.fn(),
    };
    inShell(<Harness item={OVER_CASPIAN} server={server} />, u);
    await user.click(screen.getByRole('button', { name: 'go-approve' }));
    // The toast, and its live region's copy.
    expect(
      (await screen.findAllByText(`Not saved · ${OVER_CASPIAN.body.name}`)).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText('The decision: This has already been decided.').length,
    ).toBeGreaterThan(0);
    expect(u.latestOwn).not.toHaveBeenCalled();
  });

  it('runs one write at a time', async () => {
    const user = userEvent.setup();
    let release: (v: string) => void = () => {};
    const server: DrawnServer = {
      approve: vi.fn(
        () =>
          new Promise((r) => {
            release = r as (v: string) => void;
          }),
      ) as DrawnServer['approve'],
      reject: vi.fn(async ({ waterBodyId }) => ({ waterBodyId, ...ANSWER })),
    };
    inShell(<Harness item={OVER_CASPIAN} server={server} />);
    await user.click(screen.getByRole('button', { name: 'go-approve' }));
    expect(screen.getByTestId('pending')).toHaveTextContent('approve');
    await user.click(screen.getByRole('button', { name: 'go-reject' }));
    expect(server.reject).not.toHaveBeenCalled();
    await act(async () => release(OVER_CASPIAN.body.waterBodyId));
    await waitFor(() => expect(screen.getByTestId('pending')).toHaveTextContent('none'));
  });
});
