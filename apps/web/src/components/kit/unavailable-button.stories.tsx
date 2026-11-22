import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { must } from '@/components/kit/storyKit';
import { Button } from './button';
import { Kbd } from './kbd';
import { createToastManager, Toaster } from './toast';

import { ComingSoonLink, sayComingSoon, UnavailableButton } from './unavailable-button';

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

const tipTitle = () => document.querySelector('[data-slot="tooltip-title"]');
const tipBody = () => document.querySelector('[data-slot="tooltip-body"]');

/**
 * A link into a console mode that isn't built yet (D286): *Open in Reports →* drawn as the pane
 * head draws its live *Open in Body →* — the same chip, the same arrow, the same height — beside
 * it, so the two read as one kind. It says *Coming soon* on hover, focus and press, and its key
 * (the pane's binding, here a plain button standing in for it) says the same.
 */
function ComingSoonHead() {
  const [manager] = useState(createToastManager);
  const [box, setBox] = useState<HTMLElement | null>(null);
  return (
    <div className="flex w-full max-w-(--size-sheet-sm) flex-col gap-heading">
      <div className="flex items-center justify-end gap-(--space-2)">
        <Button variant="link" size="xs">
          Open in Body
        </Button>
        <ComingSoonLink manager={manager}>Open in Reports</ComingSoonLink>
      </div>
      <button type="button" className="sr-only" onClick={() => sayComingSoon(manager)}>
        The pane's key
      </button>
      <div ref={setBox} className="relative h-[6rem] w-full">
        {box !== null && <Toaster manager={manager} contained container={box} />}
      </div>
    </div>
  );
}

export const ComingSoon: Story = {
  parameters: { fourUp: true },
  render: () => <ComingSoonHead />,
  play: async ({ canvasElement }) => {
    const quad = must(canvasElement.querySelector<HTMLElement>('[data-theme-scope]'));
    const link = within(quad).getByRole('button', { name: /Open in Reports/ });
    const live = within(quad).getByRole('button', { name: /Open in Body/ });
    // Drawn as the live link: the same variant, height and arrow; reachable, and does nothing.
    await expect(link).toHaveAttribute('data-variant', 'link');
    await expect(link).toHaveTextContent('Open in Reports→');
    await expect(link.getBoundingClientRect().height).toBeCloseTo(
      live.getBoundingClientRect().height,
      1,
    );
    await expect(link).toHaveAttribute('aria-disabled', 'true');
    await expect(link).not.toBeDisabled();
    // Focus says Coming soon, with no sentence under it.
    link.focus();
    await waitFor(() => expect(tipTitle()).toHaveTextContent('Coming soon'));
    await expect(tipBody()).toBeNull();
    link.blur();
    await waitFor(() => expect(tipTitle()).toBeNull());
    // Hover says it too.
    await userEvent.hover(link);
    await waitFor(() => expect(tipTitle()).toHaveTextContent('Coming soon'));
    await userEvent.unhover(link);
    await waitFor(() => expect(tipTitle()).toBeNull());
    // A press says it in a toast, and nothing else happens.
    await userEvent.click(link);
    await waitFor(() => expect(within(quad).getAllByText('Coming soon').at(-1)).toBeVisible());
    // The key path: the pane's binding says the same words.
    const before = within(quad).getAllByText('Coming soon').length;
    await userEvent.click(within(quad).getByRole('button', { name: "The pane's key" }));
    await waitFor(() =>
      expect(within(quad).getAllByText('Coming soon').length).toBeGreaterThan(before),
    );
  },
};
