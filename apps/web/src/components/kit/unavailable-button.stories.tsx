import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { must } from '@/components/kit/storyKit';
import { Kbd } from './kbd';
import { createToastManager, Toaster } from './toast';

import { UnavailableButton } from './unavailable-button';

/** A tool's entry point that isn't built yet — drawn as the board draws it. */
const meta = {
  title: 'Kit/UnavailableButton',
  component: UnavailableButton,
  globals: { surface: 'admin', mode: 'dark' },
  args: {
    what: 'Dropping a landmark on the map comes with the map’s landmark tools.',
    children: 'Drop a landmark',
  },
} satisfies Meta<typeof UnavailableButton>;

export default meta;
type Story = StoryObj<typeof meta>;

function WithToasts({ what }: { what: string }) {
  const [manager] = useState(createToastManager);
  const [box, setBox] = useState<HTMLElement | null>(null);
  return (
    <div className="flex flex-col gap-heading">
      <UnavailableButton what={what} size="sm" manager={manager} className="self-start">
        Drop a landmark
        <Kbd variant="dim" aria-hidden="true">
          L
        </Kbd>
      </UnavailableButton>
      <div ref={setBox} className="relative h-[6rem] w-full max-w-(--size-sheet-sm)">
        {box !== null && <Toaster manager={manager} contained container={box} />}
      </div>
    </div>
  );
}

export const AsDrawn: Story = {
  parameters: { fourUp: true },
  render: (args) => <WithToasts what={String(args.what)} />,
  play: async ({ canvasElement }) => {
    const quad = must(canvasElement.querySelector<HTMLElement>('[data-theme-scope]'));
    const button = within(quad).getByRole('button', { name: /Drop a landmark/ });
    // Reachable, and a reader hears it does nothing yet.
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button).not.toBeDisabled();
    // A press says so, in the plain words, and does nothing else.
    await userEvent.click(button);
    await waitFor(() =>
      expect(within(quad).getByText(/comes with the map’s landmark tools/)).toBeVisible(),
    );
    // Hover says so too.
    await userEvent.hover(button);
    await waitFor(() =>
      expect(document.querySelector('[data-slot="tooltip-title"]')).toHaveTextContent(
        'Not available yet',
      ),
    );
    await userEvent.unhover(button);
  },
};
