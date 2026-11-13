import type { Meta, StoryObj } from '@storybook/react-vite';
import { ConvexError } from 'convex/values';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '@/components/kit/button';
import { must } from '@/components/kit/storyKit';
import { createToastManager, Toaster } from '@/components/kit/toast';
import { type Receipt, UndoProvider, type UndoServer, useUndo } from './undo';

const run = fn();

const meta = {
  title: 'Admin/Shell/Undo toast',
  component: UndoProvider,
  tags: ['autodocs'],
  globals: { surface: 'admin' },
  parameters: {
    docs: {
      description: {
        component:
          'The receipt after an operator action, with its ten-second Undo (⌘Z) while the server offers one (D226). An undo that takes something away from skaters asks the reason first; a refusal — someone changed it since, it was already undone — is the server’s own words. The server here is a fixture.',
      },
    },
  },
  args: { server: { latestOwn: fn(), run }, children: null },
  beforeEach: () => run.mockReset(),
} satisfies Meta<typeof UndoProvider>;

export default meta;
type Story = StoryObj<typeof meta>;

const RECEIPT: Receipt = {
  title: 'Hidden · “Black ice, 2½ in. at the beach”',
  description: 'The flag stays open · decide it next',
  target: { targetType: 'report', targetId: 'r1' },
};

type Fixture = {
  needsReason?: boolean;
  offered?: boolean;
  refusal?: string;
};

function Board({ needsReason = false, offered = true, refusal }: Fixture) {
  const [manager] = useState(createToastManager);
  const [box, setBox] = useState<HTMLElement | null>(null);
  const server: UndoServer = {
    latestOwn: async () =>
      offered
        ? { actionId: 'a1', undo: { state: 'available', needsReason } }
        : { actionId: 'a1', undo: { state: 'overtaken' } },
    run: async (args) => {
      run(args);
      if (refusal !== undefined) throw new ConvexError(refusal);
    },
  };
  return (
    <UndoProvider server={server} manager={manager}>
      <div className="flex flex-col gap-heading">
        <Hide />
        <div ref={setBox} className="relative h-[9rem] w-full max-w-(--size-sheet-sm)">
          {box !== null && <Toaster manager={manager} contained container={box} />}
        </div>
      </div>
    </UndoProvider>
  );
}

function Hide() {
  const { announce } = useUndo();
  return (
    <Button className="self-start" onClick={() => void announce(RECEIPT)}>
      Hide report
    </Button>
  );
}

const toastIn = (root: ParentNode) => root.querySelector<HTMLElement>('[data-slot="toast"]');

/** The receipt with its Undo; pressing it undoes, and the next toast says so. */
export const Offered: Story = {
  render: () => <Board />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Hide report' }));
    const t = await waitFor(() => must(toastIn(canvasElement)));
    await expect(t).toHaveTextContent('Hidden · “Black ice, 2½ in. at the beach”');
    await userEvent.click(within(t).getByRole('button', { name: /Undo/ }));
    await expect(run).toHaveBeenCalledWith({ actionId: 'a1' });
    await waitFor(() => expect(toastIn(canvasElement)).toHaveTextContent('Undone'));
    await expect(toastIn(canvasElement)).toHaveTextContent('Both rows stay in the audit log');
  },
};

/** Someone acted on it since: the receipt shows, without an Undo the server would refuse. */
export const NotOffered: Story = {
  render: () => <Board offered={false} />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Hide report' }));
    const t = await waitFor(() => must(toastIn(canvasElement)));
    await expect(within(t).queryByRole('button', { name: /Undo/ })).toBeNull();
  },
};

/** A later write beat the undo: the red toast says the server's own words. */
export const Refused: Story = {
  render: () => <Board refusal="Something changed this since; open its history to see what" />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Hide report' }));
    const t = await waitFor(() => must(toastIn(canvasElement)));
    await userEvent.click(within(t).getByRole('button', { name: /Undo/ }));
    await waitFor(() => expect(toastIn(canvasElement)).toHaveTextContent('Not undone'));
    await expect(toastIn(canvasElement)).toHaveAttribute('data-type', 'bad');
    await expect(toastIn(canvasElement)).toHaveTextContent('Something changed this since');
  },
};

/** Undoing a restore takes the report away again, so it asks why before it runs. */
export const AsksTheReason: Story = {
  render: () => <Board needsReason />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Hide report' }));
    const t = await waitFor(() => must(toastIn(canvasElement)));
    await userEvent.click(within(t).getByRole('button', { name: /Undo/ }));
    const dialog = await within(document.body).findByRole('alertdialog');
    const go = within(dialog).getByRole('button', { name: /^Undo/ });
    await expect(go).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox'), 'The author asked by email');
    await userEvent.click(go);
    await expect(run).toHaveBeenCalledWith({ actionId: 'a1', reason: 'The author asked by email' });
    await waitFor(() => expect(within(document.body).queryByRole('alertdialog')).toBeNull());
  },
};

/** The receipt in all four maps. */
export const FourUp: Story = {
  render: () => <Board />,
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      await userEvent.click(within(q).getByRole('button', { name: 'Hide report' }));
      await waitFor(() => expect(toastIn(q)).not.toBeNull());
    }
  },
};
