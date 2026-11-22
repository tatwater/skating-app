import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { KeysProvider } from '@/lib/keys';
import { ReplyDock, type ReplyDockMode } from './reply-dock';
import { must } from './storyKit';

/** A reply docked under a thread (board 2.8): two modes, each with its own cap and foot. */
const MODES: ReplyDockMode<'reply' | 'note'>[] = [
  {
    id: 'reply',
    label: 'Reply by email',
    to: 'To Rob Tremblay',
    field: 'Your reply',
    foot: 'Sent from the support address.',
    send: 'Send reply',
    max: 40,
    tooLong: (n) => `${n - 40} characters over`,
  },
  {
    id: 'note',
    label: 'Note',
    to: 'Staff only',
    field: 'Your note',
    foot: 'Seen only by staff.',
    send: 'Add note',
    max: 20,
    tooLong: (n) => `${n - 20} characters over`,
  },
];

const onSend = fn();

function Dock({ initial = '' }: { initial?: string }) {
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [value, setValue] = useState(initial);
  return (
    <KeysProvider>
      <ReplyDock
        className="max-w-[32rem]"
        modes={MODES}
        mode={mode}
        onModeChange={setMode}
        modesLabel="Answer as"
        value={value}
        onValueChange={setValue}
        onSend={onSend}
        sending={false}
      />
    </KeysProvider>
  );
}

const meta = {
  title: 'Kit/ReplyDock',
  component: Dock,
  parameters: { fourUp: true },
} satisfies Meta<typeof Dock>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FourUp: Story = {
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const field = within(q).getByRole('textbox', { name: 'Your reply' });
      // The mode's cap, as the field's own.
      await expect(field).toHaveAttribute('maxlength', '40');
      // Nothing to send: the button waits.
      await expect(within(q).getByRole('button', { name: /Send reply/ })).toBeDisabled();
    }
  },
};

/** Words carried into a mode with a smaller cap are kept, the check says so, and the send waits. */
export const OverTheCap: Story = {
  args: { initial: 'Thirty characters of words, ok' },
  play: async ({ canvasElement }) => {
    onSend.mockClear();
    const [q] = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    const quad = must(q);
    await userEvent.click(within(quad).getByRole('button', { name: 'Note' }));
    const field = await within(quad).findByRole('textbox', { name: 'Your note' });
    await expect(field).toHaveValue('Thirty characters of words, ok');
    await waitFor(() =>
      expect(quad.querySelector('[data-slot="reply-dock-check"]')).toHaveTextContent(
        '10 characters over',
      ),
    );
    await expect(within(quad).getByRole('button', { name: /Add note/ })).toBeDisabled();
    await expect(onSend).not.toHaveBeenCalled();
  },
};
