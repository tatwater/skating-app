import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { ChipInput } from '@/components/kit/chip-input';
import { Input } from '@/components/kit/input';
import { must } from '@/components/kit/storyKit';
import { createToastManager, Toaster } from '@/components/kit/toast';

import { UnavailableField } from './unavailable-field';

/**
 * A kit candidate from the Body console's tabs: a field whose tool isn't built yet, drawn where the
 * board draws it in its disabled face, saying *Not available yet* on hover, focus and press — the
 * `UnavailableButton`'s pattern for a field. Promoted to the kit, it would sit beside it.
 */
const meta = {
  title: 'Kit candidates/UnavailableField',
  component: UnavailableField,
  globals: { surface: 'admin', mode: 'dark' },
  args: {
    what: 'Adding and removing the names skaters use comes with the aliases editor.',
    label: 'Aliases',
    children: null,
  },
} satisfies Meta<typeof UnavailableField>;

export default meta;
type Story = StoryObj<typeof meta>;

function WithToasts({ what }: { what: string }) {
  const [manager] = useState(createToastManager);
  const [box, setBox] = useState<HTMLElement | null>(null);
  return (
    <div className="flex w-full max-w-[22rem] flex-col gap-heading">
      <UnavailableField what={what} label="Aliases" manager={manager}>
        <ChipInput aria-label="Aliases" value={['Shaker Lake']} disabled />
      </UnavailableField>
      <UnavailableField what={what} label="A survey" manager={manager}>
        <Input aria-label="A survey" placeholder="Paste a link or a citation" disabled />
      </UnavailableField>
      <div ref={setBox} className="relative h-[6rem] w-full">
        {box !== null && <Toaster manager={manager} contained container={box} />}
      </div>
    </div>
  );
}

/** In all four maps: the field's disabled face; a press says so in a toast, hover in a tip. */
export const AsDrawn: Story = {
  parameters: { fourUp: true },
  render: (args) => <WithToasts what={String(args.what)} />,
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const quad of quads) {
      const group = within(quad).getByRole('group', { name: 'Aliases' });
      await expect(group).toHaveAttribute('aria-disabled', 'true');
      await expect(group).toHaveAttribute('tabindex', '0');
    }
    const quad = must(quads[0]);
    const group = within(quad).getByRole('group', { name: 'Aliases' });
    await userEvent.click(group);
    await waitFor(() =>
      expect(within(quad).getByText(/comes with the aliases editor/)).toBeVisible(),
    );
    await userEvent.hover(group);
    await waitFor(() =>
      expect(document.querySelector('[data-slot="tooltip-title"]')).toHaveTextContent(
        'Not available yet',
      ),
    );
    await userEvent.unhover(group);
  },
};
