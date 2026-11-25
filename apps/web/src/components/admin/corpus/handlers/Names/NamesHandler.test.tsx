import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConvexError } from 'convex/values';
import { type ReactElement, useRef } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { Toaster } from '@/components/kit/toast';
import { stubJsdomAnimations } from '../../../body/tabs/jsdomStubs';
import { InspectorProvider } from '../../../inspector/inspectorContext';
import { UndoProvider, type UndoServer } from '../../../shell/undo';
import { NamesInspector } from './NamesInspector';
import { BASIN, BASIN_DECIDED, BASIN_LOCK, BASIN_REFUSED, NAMES_NOW } from './namesFixtures';
import type { NameLever, NamesItem } from './namesModel';
import { type NameServer, useNameWrites } from './useNameWrites';

/**
 * The Name conflicts inspector and its write: ⏎ applies the pick only inside the pane, the bar is
 * drawn only where `can` allows, the write sends the task and the pick (`'shown'` for a keep), a
 * landed decision is announced with Undo on the write's own row, a refusal is a toast.
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

const undoServer = (): UndoServer & { latestOwn: ReturnType<typeof vi.fn> } => ({
  latestOwn: vi.fn(async () => null),
  run: vi.fn(async () => {}),
});

const inShell = (ui: ReactElement, s: UndoServer = undoServer()) =>
  render(
    <Toaster>
      <UndoProvider server={s}>{ui}</UndoProvider>
    </Toaster>,
  );

function Pane({
  item,
  onDecide = vi.fn(async () => true),
  locked = null,
}: {
  item: NamesItem;
  onDecide?: (lever: NameLever) => Promise<boolean>;
  locked?: typeof BASIN_LOCK | null;
}) {
  const pane = useRef<HTMLElement | null>(null);
  return (
    <section ref={pane} tabIndex={-1} data-testid="pane">
      <InspectorProvider value={{ pane, decidedOnOpen: false, now: NAMES_NOW }}>
        <NamesInspector
          item={item}
          locked={locked}
          now={NAMES_NOW}
          map={null}
          bodyLink={<a href="/admin/body/wbbasin?tab=names">x</a>}
          onDecide={onDecide}
          pending={null}
          pane={pane}
          timeZone="America/New_York"
        />
      </InspectorProvider>
      <button type="button">outside-ish</button>
    </section>
  );
}

describe('the inspector', () => {
  it('applies the pick with ⏎ inside the pane, and not outside it', async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn(async () => true);
    render(
      <>
        <Pane item={BASIN} onDecide={onDecide} />
        <div tabIndex={-1} data-testid="elsewhere" />
      </>,
    );
    // Focus outside the pane, on a plain focusable (an input would swallow ⏎ anyway).
    act(() => screen.getByTestId('elsewhere').focus());
    await user.keyboard('{Enter}');
    expect(onDecide).not.toHaveBeenCalled();
    await user.click(screen.getByRole('radio', { name: 'Lake Auburn' }));
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(onDecide).toHaveBeenCalledWith({
        verb: 'pickName',
        pick: 'Lake Auburn',
        label: 'Display “Lake Auburn” instead',
        name: 'Lake Auburn',
      }),
    );
  });

  it('draws no bar for a decided or refused task', () => {
    const { unmount } = render(<Pane item={BASIN_DECIDED} locked={BASIN_LOCK} />);
    expect(screen.queryByRole('button', { name: /Keep|Display/ })).toBeNull();
    unmount();
    render(<Pane item={BASIN_REFUSED} />);
    expect(screen.queryByRole('button', { name: /Keep|Display/ })).toBeNull();
    expect(
      screen.getByText('The Basin was merged into another body since this was asked.'),
    ).toBeInTheDocument();
  });

  it('opens another task on its own default pick', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Pane item={BASIN} />);
    await user.click(screen.getByRole('radio', { name: 'Lake Auburn' }));
    expect(screen.getByRole('radio', { name: 'Lake Auburn' })).toBeChecked();
    rerender(<Pane item={{ ...BASIN, taskId: 'ctother' as never }} />);
    expect(screen.getByRole('radio', { name: 'The Basin' })).toBeChecked();
  });
});

describe('the write', () => {
  function Harness({ item, server }: { item: NamesItem; server: NameServer }) {
    const { decide, pending } = useNameWrites(item, server);
    return (
      <>
        <button
          type="button"
          onClick={() =>
            void decide({ verb: 'pickName', pick: 'Lake Auburn', label: '', name: 'Lake Auburn' })
          }
        >
          go-pick
        </button>
        <button
          type="button"
          onClick={() =>
            void decide({ verb: 'keepName', pick: 'shown', label: '', name: 'The Basin' })
          }
        >
          go-keep
        </button>
        <span data-testid="pending">{pending ?? 'none'}</span>
      </>
    );
  }
  const answer = { actionId: 'macorpus' as never, undoable: true as const, undoNeedsReason: false };
  const okServer = (): NameServer => ({
    decideName: vi.fn(async ({ taskId }: { taskId: never }) => ({
      taskId,
      ...answer,
    })) as unknown as NameServer['decideName'],
  });

  it('sends the pick, and announces it with Undo from the write’s own answer', async () => {
    const user = userEvent.setup();
    const u = undoServer();
    const server = okServer();
    inShell(<Harness item={BASIN} server={server} />, u);
    await user.click(screen.getByRole('button', { name: 'go-pick' }));
    await waitFor(() =>
      expect(server.decideName).toHaveBeenCalledWith({ taskId: BASIN.taskId, pick: 'Lake Auburn' }),
    );
    expect((await screen.findAllByText(/Displays “Lake Auburn”/)).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/“The Basin” stays an alias, found by search/).length,
    ).toBeGreaterThan(0);
    expect((await screen.findAllByRole('button', { name: /Undo/ })).length).toBeGreaterThan(0);
    expect(u.latestOwn).not.toHaveBeenCalled();
  });

  it('sends a keep as “shown”', async () => {
    const user = userEvent.setup();
    const server = okServer();
    inShell(<Harness item={BASIN} server={server} />);
    await user.click(screen.getByRole('button', { name: 'go-keep' }));
    await waitFor(() =>
      expect(server.decideName).toHaveBeenCalledWith({ taskId: BASIN.taskId, pick: 'shown' }),
    );
    expect((await screen.findAllByText(/Keeps “The Basin”/)).length).toBeGreaterThan(0);
  });

  it('says a refusal in a toast naming the body, and announces nothing', async () => {
    const user = userEvent.setup();
    const u = undoServer();
    const server: NameServer = {
      decideName: vi.fn(async () => {
        throw new ConvexError('This has already been decided.');
      }),
    };
    inShell(<Harness item={BASIN} server={server} />, u);
    await user.click(screen.getByRole('button', { name: 'go-pick' }));
    expect((await screen.findAllByText('Not saved · The Basin')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/This has already been decided/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Displays “Lake Auburn”/)).toBeNull();
    await waitFor(() => expect(screen.getByTestId('pending')).toHaveTextContent('none'));
  });

  it('runs one write at a time', async () => {
    const user = userEvent.setup();
    let release: (v: unknown) => void = () => {};
    const server: NameServer = {
      decideName: vi.fn(
        () =>
          new Promise((r) => {
            release = r;
          }),
      ) as NameServer['decideName'],
    };
    inShell(<Harness item={BASIN} server={server} />);
    await user.click(screen.getByRole('button', { name: 'go-pick' }));
    expect(screen.getByTestId('pending')).toHaveTextContent('pickName');
    await user.click(screen.getByRole('button', { name: 'go-keep' }));
    expect(server.decideName).toHaveBeenCalledTimes(1);
    release({ taskId: BASIN.taskId, ...answer });
    await waitFor(() => expect(screen.getByTestId('pending')).toHaveTextContent('none'));
  });
});
