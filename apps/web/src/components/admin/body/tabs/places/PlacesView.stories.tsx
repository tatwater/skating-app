import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { faceLoaded, must } from '@/components/kit/storyKit';

import { InspectorFrame } from '../tabStoryFrame';
import { PlacesView, type PlacesViewProps } from './PlacesView';
import { HOVERED_DAM, MASCOMA_PLACES, SELECTED_UPPER } from './placesFixtures';

/**
 * Boards 5.4.3 and 5.4.3 | Landmark, Body › Places: the tab's column at the board's size. Render
 * `Board` beside `body-v5.html?tab=places` and `Landmark` beside `…&lm=upper-shaker-village`
 * (x 1060–1440, y 178–870).
 */
const meta = {
  title: 'Admin/Body/Places',
  component: PlacesView,
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
  render: (args) => <Controlled {...args} />,
} satisfies Meta<typeof PlacesView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The frame keeps the lit item in its URL; a story keeps it in state. */
function Controlled(args: PlacesViewProps) {
  const [lit, setLit] = useState(args.lit ?? null);
  const [hovered, setHovered] = useState(args.hovered ?? null);
  return (
    <InspectorFrame>
      <PlacesView
        {...args}
        lit={lit}
        onLitChange={(id) => {
          setLit(id);
          args.onLitChange?.(id);
        }}
        hovered={hovered}
        onHoverChange={setHovered}
      />
    </InspectorFrame>
  );
}

const slot = (root: ParentNode, name: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${name}"]`));
const slots = (root: ParentNode, name: string) => [
  ...root.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`),
];

const EVERY_LEVER = {
  data: MASCOMA_PLACES,
  canPlace: true,
  onFileAsSpelling: fn(),
  onDismissName: fn(async () => null),
  onSamePlace: fn(),
  onDecline: fn(async () => null),
  onEditLandmark: fn(),
  onLitChange: fn(),
};

/** Board 5.4.3 as drawn: the asks, sixteen landmarks, the dam's row hovered. */
export const Board: Story = {
  args: { ...EVERY_LEVER, hovered: HOVERED_DAM },
  play: async ({ canvasElement }) => {
    const rows = slots(canvasElement, 'landmark-row');
    await faceLoaded(must(rows[0]));
    await expect(rows).toHaveLength(16);
    await expect(slot(slot(canvasElement, 'landmarks'), 'section-count')).toHaveTextContent('16');
    await expect(slot(slot(canvasElement, 'asks'), 'section-count')).toHaveTextContent('2');
    // The list's words: one word per kind, ordered by it.
    await expect(
      rows.map((r) => r.textContent?.match(/(Beach|Bridge|Camp|Dam|Island|Point|River|Town)/)?.[0]),
    ).toEqual([
      'Beach',
      'Bridge',
      'Camp',
      'Dam',
      'Island',
      'Island',
      'Island',
      'Point',
      'River',
      'River',
      'River',
      'River',
      'Town',
      'Town',
      'Town',
      'Town',
    ]);
    const dam = must(rows.find((r) => r.textContent?.includes('Mascoma Lake Dam')));
    await expect(dam).toHaveAttribute('data-hovered');
    // The proposal says what it may be, in amber, and who asked.
    const asks = slots(canvasElement, 'ask');
    await expect(asks[1]).toHaveTextContent('Possibly Mascoma Lake Dam, 0.2 mi away');
    await expect(asks[1]).toHaveTextContent('Kate Donovan@kdonovan');
  },
};

/** Board 5.4.3 | Landmark: the selected landmark on its card, over the dimmed list. */
export const Landmark: Story = {
  args: { ...EVERY_LEVER, lit: SELECTED_UPPER },
  play: async ({ canvasElement }) => {
    const card = slot(canvasElement, 'inset-card');
    await faceLoaded(slot(card, 'inset-card-head'));
    const page = within(card);
    await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue('Upper Shaker Village');
    await expect(card).toHaveTextContent('43.6117, −72.1381');
    await expect(card).toHaveTextContent('node/158821324');
    await expect(card).toHaveTextContent('29 Sep 2026');
    // A town can't become a bay: the verb keeps its place, inert.
    await expect(page.getByRole('button', { name: 'Draw as a bay' })).toBeDisabled();
    // The list behind is dimmed and out of reach.
    await expect(slot(canvasElement, 'tab-body')).toHaveAttribute('data-dimmed');
    // The head has focus, so the keyboard is where the task is.
    await waitFor(() => expect(slot(card, 'inset-card-head')).toHaveFocus());
  },
};

/** Esc on the card goes back to the list. */
export const BackToTheList: Story = {
  args: { ...EVERY_LEVER, lit: SELECTED_UPPER },
  play: async ({ canvasElement, args }) => {
    await waitFor(() => expect(slot(canvasElement, 'inset-card-head')).toHaveFocus());
    await userEvent.keyboard('{Escape}');
    await expect(args.onLitChange).toHaveBeenLastCalledWith(null);
    await waitFor(() => expect(canvasElement.querySelector('[data-slot="inset-card"]')).toBeNull());
  },
};

/** A field saves when it is left or ⏎ is pressed — one edit at a time, each its own undo. */
export const RenameALandmark: Story = {
  args: { ...EVERY_LEVER, lit: SELECTED_UPPER },
  play: async ({ canvasElement, args }) => {
    const name = within(canvasElement).getByRole('textbox', { name: 'Name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Upper Shaker{Enter}');
    await expect(args.onEditLandmark).toHaveBeenCalledWith('lm-upper', { name: 'Upper Shaker' });
  },
};

/** Pressing a row selects it. */
export const SelectARow: Story = {
  args: { ...EVERY_LEVER },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /Wood Island/ }));
    await expect(args.onLitChange).toHaveBeenCalledWith('landmark:lm-wood');
    await waitFor(() => expect(slot(canvasElement, 'inset-card')).toBeVisible());
  },
};

/** Declining asks the note the skaters will read; Decline waits for it. */
export const DeclineAProposal: Story = {
  args: { ...EVERY_LEVER },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Decline' }));
    const dialog = await within(document.body).findByRole('alertdialog');
    const action = within(dialog).getByRole('button', { name: /^Decline/ });
    await expect(action).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox'), 'The dam is already on the map');
    await userEvent.click(action);
    await expect(args.onDecline).toHaveBeenCalledWith('ask-flats', 'The dam is already on the map');
    await waitFor(() => expect(document.querySelector('[data-slot="reason-ask"]')).toBeNull());
  },
};

/** A map tool that isn't built yet says so, and does nothing else. */
export const NotAvailableYet: Story = {
  args: { ...EVERY_LEVER },
  play: async ({ canvasElement }) => {
    const drop = within(canvasElement).getByRole('button', { name: /Drop a landmark/ });
    await expect(drop).toHaveAttribute('aria-disabled', 'true');
    await userEvent.hover(drop);
    await expect(await within(document.body).findByText('Not available yet')).toBeInTheDocument();
  },
};

/** A viewer with no places levers: the asks and landmarks, no controls, rows not pressable. */
export const ReadOnly: Story = {
  args: { data: MASCOMA_PLACES },
  render: (args) => (
    <InspectorFrame>
      <PlacesView {...args} />
    </InspectorFrame>
  ),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('button')).toBeNull();
    await expect(slots(canvasElement, 'landmark-row')).toHaveLength(16);
  },
};

/** Nothing asked, no landmarks: each list still says what it is, with its 0. */
export const Empty: Story = {
  args: { data: { asks: [], landmarks: [] }, canPlace: true },
  play: async ({ canvasElement }) => {
    await expect(slot(slot(canvasElement, 'asks'), 'section-count')).toHaveTextContent('0');
    await expect(slot(slot(canvasElement, 'landmarks'), 'section-count')).toHaveTextContent('0');
  },
};

export const Loading: Story = {
  args: { data: undefined },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'places-tab')).toHaveAttribute('aria-busy', 'true');
  },
};

/** The list and the card in all four maps. */
export const FourMaps: Story = {
  args: { ...EVERY_LEVER, lit: SELECTED_UPPER },
  parameters: { fourUp: true },
  render: (args) => (
    <div className="relative h-[43.25rem] w-(--size-inspector) px-(--space-5)">
      <PlacesView {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const quad of quads) await expect(slot(quad, 'inset-card')).toBeVisible();
  },
};
