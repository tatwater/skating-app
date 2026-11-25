import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConvexError } from 'convex/values';
import { type ReactElement, useRef } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { Toaster } from '@/components/kit/toast';
import { stubJsdomAnimations } from '../../../body/tabs/jsdomStubs';
import { InspectorProvider } from '../../../inspector/inspectorContext';
import { UndoProvider, type UndoServer } from '../../../shell/undo';
import { ClassesInspector } from './ClassesInspector';
import {
  CLASSES_NOW,
  GROTON,
  GROTON_DECIDED,
  GROTON_LOCK,
  GROTON_REFUSED,
} from './classesFixtures';
import type { ClassesItem, ClassLever } from './classesModel';
import { type ClassServer, useClassWrites } from './useClassWrites';

/**
 * The Class conflicts inspector and its write: ⏎ applies the pick only inside the pane, the bar
 * is drawn only where `can` allows, the write sends the task and the class, a landed decision is announced with Undo on the write's own row, a refusal is a toast.
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
  item: ClassesItem;
  onDecide?: (lever: ClassLever) => Promise<boolean>;
  locked?: typeof GROTON_LOCK | null;
}) {
  const pane = useRef<HTMLElement | null>(null);
  return (
    <section ref={pane} tabIndex={-1} data-testid="pane">
      <InspectorProvider value={{ pane, decidedOnOpen: false, now: CLASSES_NOW }}>
        <ClassesInspector
          item={item}
          locked={locked}
          now={CLASSES_NOW}
          map={null}
          bodyLink={<a href="/admin/body/wbgroton?tab=names">x</a>}
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
        <Pane item={GROTON} onDecide={onDecide} />
        <div tabIndex={-1} data-testid="elsewhere" />
      </>,
    );
    // Focus outside the pane, on a plain focusable (an input would swallow ⏎ anyway).
    act(() => screen.getByTestId('elsewhere').focus());
    await user.keyboard('{Enter}');
    expect(onDecide).not.toHaveBeenCalled();
    await user.click(screen.getByRole('radio', { name: 'Reservoir' }));
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(onDecide).toHaveBeenCalledWith({
        verb: 'setClass',
        bodyClass: 'reservoir',
        label: 'Set as Reservoir',
      }),
    );
  });

  it('draws no bar for a decided or refused task', () => {
    const { unmount } = render(<Pane item={GROTON_DECIDED} locked={GROTON_LOCK} />);
    expect(screen.queryByRole('button', { name: /Keep|Set as/ })).toBeNull();
    unmount();
    render(<Pane item={GROTON_REFUSED} />);
    expect(screen.queryByRole('button', { name: /Keep|Set as/ })).toBeNull();
    expect(
      screen.getByText('This body was removed from the corpus since this was asked.'),
    ).toBeInTheDocument();
  });

  it('opens another task on its own default pick', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Pane item={GROTON} />);
    await user.click(screen.getByRole('radio', { name: 'Reservoir' }));
    expect(screen.getByRole('radio', { name: 'Reservoir' })).toBeChecked();
    rerender(<Pane item={{ ...GROTON, taskId: 'ctother' as never }} />);
    expect(screen.getByRole('radio', { name: 'Wetland' })).toBeChecked();
  });
});

describe('the write', () => {
  function Harness({ item, server }: { item: ClassesItem; server: ClassServer }) {
    const { decide, pending } = useClassWrites(item, server);
    return (
      <>
        <button
          type="button"
          onClick={() => void decide({ verb: 'setClass', bodyClass: 'wetland', label: '' })}
        >
          go-pick
        </button>
        <button
          type="button"
          onClick={() => void decide({ verb: 'keepClass', bodyClass: 'lakePond', label: '' })}
        >
          go-keep
        </button>
        <span data-testid="pending">{pending ?? 'none'}</span>
      </>
    );
  }
  const answer = { actionId: 'macorpus' as never, undoable: true as const, undoNeedsReason: false };
  const okServer = (): ClassServer => ({
    decideClass: vi.fn(async ({ taskId }: { taskId: never }) => ({
      taskId,
      ...answer,
    })) as unknown as ClassServer['decideClass'],
  });

  it('sends the class, and announces it with Undo from the write’s own answer', async () => {
    const user = userEvent.setup();
    const u = undoServer();
    const server = okServer();
    inShell(<Harness item={GROTON} server={server} />, u);
    await user.click(screen.getByRole('button', { name: 'go-pick' }));
    await waitFor(() =>
      expect(server.decideClass).toHaveBeenCalledWith({
        taskId: GROTON.taskId,
        bodyClass: 'wetland',
      }),
    );
    expect((await screen.findAllByText(/Set as Wetland/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Refused by the size rules next campaign/).length).toBeGreaterThan(
      0,
    );
    expect((await screen.findAllByRole('button', { name: /Undo/ })).length).toBeGreaterThan(0);
    expect(u.latestOwn).not.toHaveBeenCalled();
  });

  it('sends a keep as the body’s own class', async () => {
    const user = userEvent.setup();
    const server = okServer();
    inShell(<Harness item={GROTON} server={server} />);
    await user.click(screen.getByRole('button', { name: 'go-keep' }));
    await waitFor(() =>
      expect(server.decideClass).toHaveBeenCalledWith({
        taskId: GROTON.taskId,
        bodyClass: 'lakePond',
      }),
    );
    expect((await screen.findAllByText(/Kept as Lake or pond/)).length).toBeGreaterThan(0);
  });

  it('says a refusal in a toast naming the body, and announces nothing', async () => {
    const user = userEvent.setup();
    const u = undoServer();
    const server: ClassServer = {
      decideClass: vi.fn(async () => {
        throw new ConvexError('This has already been decided.');
      }),
    };
    inShell(<Harness item={GROTON} server={server} />, u);
    await user.click(screen.getByRole('button', { name: 'go-pick' }));
    expect((await screen.findAllByText('Not saved · Unnamed water')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/This has already been decided/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Set as Wetland/)).toBeNull();
    await waitFor(() => expect(screen.getByTestId('pending')).toHaveTextContent('none'));
  });

  it('runs one write at a time', async () => {
    const user = userEvent.setup();
    let release: (v: unknown) => void = () => {};
    const server: ClassServer = {
      decideClass: vi.fn(
        () =>
          new Promise((r) => {
            release = r;
          }),
      ) as ClassServer['decideClass'],
    };
    inShell(<Harness item={GROTON} server={server} />);
    await user.click(screen.getByRole('button', { name: 'go-pick' }));
    expect(screen.getByTestId('pending')).toHaveTextContent('setClass');
    await user.click(screen.getByRole('button', { name: 'go-keep' }));
    expect(server.decideClass).toHaveBeenCalledTimes(1);
    release({ taskId: GROTON.taskId, ...answer });
    await waitFor(() => expect(screen.getByTestId('pending')).toHaveTextContent('none'));
  });
});
