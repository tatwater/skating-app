import { AUDIT_REASON_MAX } from '@skating/core';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConvexError } from 'convex/values';
import { type ReactElement, useRef } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { Toaster } from '@/components/kit/toast';
import { stubJsdomAnimations } from '../../../body/tabs/jsdomStubs';
import { UndoProvider, type UndoServer } from '../../../shell/undo';
import { must } from '../../testing/routeHarness';
import { DrawnActions, DrawnBody, type DrawnHandlerProps, DrawnHead } from './DrawnHandlerView';
import {
  BARE_SKATE,
  BELOW_THRESHOLD,
  DRAWER_GONE,
  DRAWN_BY_VIEWER,
  DRAWN_MERGED,
  DRAWN_NOW,
  LONG_REPORT,
  MODERATOR_VIEW,
  NEW_WATER,
  OVER_CASPIAN,
  OVER_MOREY,
  REPORT_WITHHELD,
} from './drawnFixtures';
import type { DrawnItem } from './drawnModel';
import { type DrawnServer, useDrawnWrites } from './useDrawnWrites';

/**
 * The drawn handler's slots and its writes: the board's blocks, the bar drawn only where `can`
 * allows, Merge sending the item and the survivor it shows, M and A acting only while the pane has
 * focus, Reject asking the drawer's reason, a refusal said in a toast and never in place, a landed
 * decision announced with Undo from the write's own answer, one write at a time.
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
  onMerge = vi.fn(async () => true),
  onApprove = vi.fn(async () => true),
  onReject = vi.fn(async () => true),
  pending = null,
}: {
  item: DrawnItem;
  onMerge?: DrawnHandlerProps['onMerge'];
  onApprove?: DrawnHandlerProps['onApprove'];
  onReject?: DrawnHandlerProps['onReject'];
  pending?: DrawnHandlerProps['pending'];
}) {
  const pane = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={pane} tabIndex={-1} data-testid="pane">
      <DrawnHead item={item} now={DRAWN_NOW} bodyLink={<a href="/admin/body/wb">x</a>} />
      <DrawnBody item={item} map={null} timeZone="America/New_York" />
      <DrawnActions
        item={item}
        onMerge={onMerge}
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
    expect(within(report).getByText('Trusted · 41 pts · 14 reports')).toBeInTheDocument();
    expect(within(report).getByText('1h 36m · 11 Oct 09:00–11:00')).toBeInTheDocument();
    expect(
      within(report).getByText('“Skated the east arm all morning with the club.”'),
    ).toBeInTheDocument();
    // The report lives in Reports, which isn't built.
    expect(within(report).getByRole('button', { name: /Open in Reports/ })).toHaveAttribute(
      'data-unavailable-title',
      'Coming soon',
    );
    const merged = screen.getByRole('region', { name: 'If merged into Caspian Lake' });
    expect(merged).toHaveTextContent('Re-homed · stays visible');
    expect(merged).toHaveTextContent('Kept · moves with it');
    expect(merged).toHaveTextContent('Told it was merged');
    expect(merged).toHaveTextContent('Points at Caspian Lake');
    // The lever is live now: no stub, no page elsewhere named for it.
    expect(merged.textContent).not.toMatch(/Coming soon|editor|elsewhere/i);
  });

  it('withholds a hidden report’s words, saying so; draws a long one as the server cut it', () => {
    const { unmount } = inShell(<Pane item={REPORT_WITHHELD} />);
    const report = () => screen.getByRole('region', { name: 'The report it came from' });
    expect(within(report()).queryByRole('blockquote')).toBeNull();
    expect(
      within(report()).getByText('Its words aren’t shown: the report is hidden or withdrawn'),
    ).toBeInTheDocument();
    unmount();
    inShell(<Pane item={LONG_REPORT} />);
    const quote = within(report()).getByRole('blockquote');
    // As served: the server's cut and its ellipsis, nothing added, nothing whole.
    expect(quote.textContent).toBe(`“${LONG_REPORT.fromReport?.excerpt}”`);
    expect(quote.textContent?.endsWith('…”')).toBe(true);
  });

  it('draws a bare skate from its start, no report and no count it wasn’t given', () => {
    inShell(<Pane item={BARE_SKATE} />);
    const report = screen.getByRole('region', { name: 'The report it came from' });
    expect(within(report).getByText('No report is linked to this drawing')).toBeInTheDocument();
    expect(within(report).queryByRole('button', { name: /Open in Reports/ })).toBeNull();
    expect(within(report).getByText('Trusted · 41 pts')).toBeInTheDocument();
    expect(within(report).getByText('11 Oct 09:00')).toBeInTheDocument();
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
  it('draws Merge into ‹the survivor› (M), Approve as new (A), Reject (R)', () => {
    inShell(<Pane item={OVER_CASPIAN} />);
    const merge = screen.getByRole('button', { name: 'Merge into Caspian Lake' });
    expect(merge).not.toHaveAttribute('aria-disabled', 'true');
    expect(merge).not.toHaveAttribute('data-unavailable-title');
    expect(merge).toHaveAttribute('aria-keyshortcuts', 'M');
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

  it('M merges into the survivor the bar shows, only while the pane has focus; one press', async () => {
    const user = userEvent.setup();
    const onMerge = vi.fn(async () => true);
    const onApprove = vi.fn(async () => true);
    inShell(<Pane item={OVER_MOREY} onMerge={onMerge} onApprove={onApprove} />);
    await user.keyboard('m');
    expect(onMerge).not.toHaveBeenCalled();
    screen.getByTestId('pane').focus();
    await user.keyboard('m');
    await waitFor(() => expect(onMerge).toHaveBeenCalledTimes(1));
    // The server's survivor for this item (its overlap), never the drawing nor another item's.
    expect(onMerge).toHaveBeenCalledWith({
      waterBodyId: OVER_MOREY.overlap?.body.waterBodyId,
      name: 'Lake Morey',
    });
    await user.click(screen.getByRole('button', { name: 'Merge into Lake Morey' }));
    expect(onMerge).toHaveBeenCalledTimes(2);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('draws no merge, and no bar, once merged by a colleague', () => {
    inShell(<Pane item={DRAWN_MERGED} />);
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(screen.queryByRole('button', { name: /Merge/ })).toBeNull();
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

  it('R asks the reason kept in the audit log (the drawer is never sent it), and sends it', async () => {
    const user = userEvent.setup();
    const onReject = vi.fn(async () => true);
    inShell(<Pane item={OVER_CASPIAN} onReject={onReject} />);
    screen.getByTestId('pane').focus();
    await user.keyboard('r');
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Reason · kept in the audit log')).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent(/reads it/);
    const box = within(dialog).getByRole('textbox');
    // The audit log's cap: the reason is the audit row's.
    expect(box).toHaveAttribute('maxlength', String(AUDIT_REASON_MAX));
    await user.type(box, 'Already on the map as Caspian Lake');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(onReject).toHaveBeenCalledWith('Already on the map as Caspian Lake'),
    );
  });
});

describe('the writes', () => {
  function Harness({ item, server }: { item: DrawnItem; server: DrawnServer }) {
    const { merge, approve, reject, pending } = useDrawnWrites(item, server);
    return (
      <>
        <button
          type="button"
          onClick={() =>
            item.overlap !== null &&
            void merge({ waterBodyId: item.overlap.body.waterBodyId, name: item.overlap.body.name })
          }
        >
          go-merge
        </button>
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
      mergeDrawn: vi.fn(async ({ itemId }) => ({ itemId, flagsClosed: 0, ...ANSWER })),
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

  it('merges with the item’s id and the survivor shown; the receipt names both, Undo from the answer', async () => {
    const user = userEvent.setup();
    const u = undoServer();
    const server: DrawnServer = {
      mergeDrawn: vi.fn(async ({ itemId }) => ({
        itemId,
        flagsClosed: 0,
        actionId: 'ma_merge',
        undoable: true as const,
        undoNeedsReason: true,
      })),
      approve: vi.fn(),
      reject: vi.fn(),
    };
    inShell(<Harness item={OVER_MOREY} server={server} />, u);
    await user.click(screen.getByRole('button', { name: 'go-merge' }));
    await waitFor(() =>
      expect(server.mergeDrawn).toHaveBeenCalledWith({
        itemId: OVER_MOREY.itemId,
        survivorId: OVER_MOREY.overlap?.body.waterBodyId,
      }),
    );
    // Both bodies named: the survivor in the title, the drawing as its subject.
    expect(
      (await screen.findAllByText('Merged into Lake Morey · Morey east arm')).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText('Moves what the drawing holds · tells the drawer')).toBeInTheDocument();
    // Undo is the answer's row, and it asks a reason as the answer said: nothing looked up.
    const undo = (await screen.findAllByRole('button', { name: /Undo/ }))[0];
    expect(u.latestOwn).not.toHaveBeenCalled();
    await user.click(must(undo, 'the receipt’s Undo'));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(/needs a reason/);
    expect(u.run).not.toHaveBeenCalled();
  });

  it('says a refused merge in a toast with the server’s words', async () => {
    const user = userEvent.setup();
    const server: DrawnServer = {
      mergeDrawn: vi.fn(async () => {
        throw new ConvexError('The drawing now overlaps another body: open it again.');
      }),
      approve: vi.fn(),
      reject: vi.fn(),
    };
    inShell(<Harness item={OVER_CASPIAN} server={server} />);
    await user.click(screen.getByRole('button', { name: 'go-merge' }));
    expect(
      (
        await screen.findAllByText(
          'The decision: The drawing now overlaps another body: open it again.',
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/Merged into/)).toBeNull();
  });

  it('rejects with the reason trimmed', async () => {
    const user = userEvent.setup();
    const server: DrawnServer = {
      mergeDrawn: vi.fn(async ({ itemId }) => ({ itemId, flagsClosed: 0, ...ANSWER })),
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
      mergeDrawn: vi.fn(),
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
      mergeDrawn: vi.fn(async ({ itemId }) => ({ itemId, flagsClosed: 0, ...ANSWER })),
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
