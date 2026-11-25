import { act, render, screen, waitFor } from '@testing-library/react';
import { ConvexError } from 'convex/values';
import { useEffect, useRef } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { Toaster } from '@/components/kit/toast';

import { stubJsdomAnimations } from '../body/tabs/jsdomStubs';
import { UndoProvider, type UndoServer } from '../shell/undo';
import { type Decision, type Landed, useDecisionRunner } from './useDecisionRunner';

/**
 * **The runner when the server answers late** (R9). The console's rule for a receipt: it shows only
 * over the item it was written for — asked again once the server has answered — so a write that
 * lands after the moderator opened another item draws no receipt there. Its row still stands, and
 * its Undo is History's (the undo engine offers a row there with no window; the toast's ten seconds
 * are the only window). A refusal is the other way round: it always reaches a toast, late or not.
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

const ANSWER = { actionId: 'ma_late', undoable: true as const, undoNeedsReason: false };
const target = { targetType: 'waterBodyRequest', targetId: 'rq1' } as const;

/** A held write, released by the test. */
function held() {
  let release: (v: Landed) => void = () => {};
  let refuse: (e: unknown) => void = () => {};
  const promise = new Promise<Landed>((res, rej) => {
    release = res;
    refuse = rej;
  });
  return { promise, release: (v: Landed) => release(v), refuse: (e: unknown) => refuse(e) };
}

/** The runner for the item drawn (`itemId`), starting one decision as soon as it mounts. */
function Runner({
  itemId,
  decision,
  onDone,
}: {
  itemId: string;
  decision: Decision<'approve'> | null;
  onDone: (landed: boolean) => void;
}) {
  const { run } = useDecisionRunner<'approve'>({ itemId, subject: 'Lake Morey' });
  // Once, for the item it was started on — not again when the moderator opens another.
  const started = useRef(false);
  useEffect(() => {
    if (decision === null || started.current) return;
    started.current = true;
    void run(decision).then(onDone);
  }, [decision, run, onDone]);
  return null;
}

function shell(ui: React.ReactNode, server: UndoServer) {
  return render(
    <Toaster>
      <UndoProvider server={server}>{ui}</UndoProvider>
    </Toaster>,
  );
}

const undoServer = (): UndoServer & { latestOwn: ReturnType<typeof vi.fn> } => ({
  latestOwn: vi.fn(async () => null),
  run: vi.fn(async () => {}),
});

describe('a decision the server answers after the moderator moved on', () => {
  it('draws no receipt over the item now open — the write still landed, its Undo in History', async () => {
    const write = held();
    const onDone = vi.fn();
    const decision: Decision<'approve'> = {
      act: 'approve',
      write: () => write.promise,
      what: 'The decision',
      receipt: { title: 'Admitted' },
    };
    const server = undoServer();
    const view = shell(<Runner itemId="item:a" decision={decision} onDone={onDone} />, server);
    // The moderator opens another item while the write is out.
    view.rerender(
      <Toaster>
        <UndoProvider server={server}>
          <Runner itemId="item:b" decision={decision} onDone={onDone} />
        </UndoProvider>
      </Toaster>,
    );
    await act(async () => write.release({ target, answer: ANSWER }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(true));
    expect(screen.queryByText(/Admitted/)).toBeNull();
  });

  it('draws the receipt, with its Undo, while the item it was written for is still open', async () => {
    const write = held();
    const onDone = vi.fn();
    const decision: Decision<'approve'> = {
      act: 'approve',
      write: () => write.promise,
      what: 'The decision',
      receipt: { title: 'Admitted' },
    };
    shell(<Runner itemId="item:a" decision={decision} onDone={onDone} />, undoServer());
    await act(async () => write.release({ target, answer: ANSWER }));
    expect((await screen.findAllByText(/Admitted/)).length).toBeGreaterThan(0);
    expect((await screen.findAllByRole('button', { name: /Undo/ })).length).toBeGreaterThan(0);
  });

  it('says a late refusal in a toast all the same', async () => {
    const write = held();
    const onDone = vi.fn();
    const decision: Decision<'approve'> = {
      act: 'approve',
      write: () => write.promise,
      what: 'The decision',
      receipt: { title: 'Admitted' },
    };
    const server = undoServer();
    const view = shell(<Runner itemId="item:a" decision={decision} onDone={onDone} />, server);
    view.rerender(
      <Toaster>
        <UndoProvider server={server}>
          <Runner itemId="item:b" decision={decision} onDone={onDone} />
        </UndoProvider>
      </Toaster>,
    );
    await act(async () => write.refuse(new ConvexError('This has already been decided.')));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(false));
    expect(
      (await screen.findAllByText('The decision: This has already been decided.')).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/Admitted/)).toBeNull();
  });
});

describe('a merge’s receipt', () => {
  it('carries its verb to the Undo, so the Undone toast says what the unmerge left', async () => {
    const write = held();
    const decision: Decision<'approve'> = {
      act: 'approve',
      write: () => write.promise,
      what: 'The decision',
      receipt: { title: 'Merged into Crystal Lake', action: 'merge_waterbody' },
    };
    const undoneLine = vi.fn(({ actionId }: { actionId: string }) => `left by ${actionId}`);
    const server = { ...undoServer(), undoneLine };
    shell(<Runner itemId="item:a" decision={decision} onDone={vi.fn()} />, server);
    await act(async () => write.release({ target, answer: ANSWER }));
    const [undo] = await screen.findAllByRole('button', { name: /Undo/ });
    await act(async () => undo?.click());
    await waitFor(() => expect(server.run).toHaveBeenCalledWith({ actionId: 'ma_late' }));
    expect((await screen.findAllByText('left by ma_late')).length).toBeGreaterThan(0);
    expect(undoneLine).toHaveBeenCalledWith({ actionId: 'ma_late', action: 'merge_waterbody' });
  });
});
