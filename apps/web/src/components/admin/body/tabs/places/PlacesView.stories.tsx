import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { FAILED_READ } from '@/components/admin/reads/readFailureFixtures';
import { faceLoaded, must } from '@/components/kit/storyKit';
import { InspectorFrame } from '../tabStoryFrame';
import { PlacesView, type PlacesViewProps } from './PlacesView';
import { HOVERED_DAM, MASCOMA_PLACES, SELECTED_UPPER } from './placesFixtures';
import { rowsOf } from './placesModel';

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
  onDismissName: fn(async () => true),
  onSamePlace: fn(),
  onDecline: fn(async () => true),
  onEditLandmark: fn(),
  onLitChange: fn(),
  onDropLandmark: fn(),
  onPlaceName: fn(),
  onAddProposal: fn(),
  onMoveLandmark: fn(),
  onRemoveLandmark: fn(async () => true),
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

/**
 * The map's landmark tools start from here: *Drop a landmark* (and L), *Place it* on an emailed name
 * and *Add* on a skater's proposal each hand the wiring what to open the drop card with.
 */
export const LandmarkTools: Story = {
  args: { ...EVERY_LEVER },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await userEvent.click(page.getByRole('button', { name: /Drop a landmark/ }));
    await expect(args.onDropLandmark).toHaveBeenCalledTimes(1);
    await userEvent.click(page.getByRole('button', { name: 'Place it' }));
    await expect(args.onPlaceName).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ask-narrows', name: 'the Narrows' }),
    );
    await userEvent.click(page.getByRole('button', { name: 'Add' }));
    await expect(args.onAddProposal).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ask-flats', point: { lat: 43.6468, lng: -72.1787 } }),
    );
  },
};

/** While a landmark is dropped, its card stands over the list, and the list is out of reach. */
export const Dropping: Story = {
  args: {
    ...EVERY_LEVER,
    lit: SELECTED_UPPER,
    drop: <div data-slot="drop-stand-in">The drop card</div>,
  },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'drop-stand-in')).toBeVisible();
    // The drop is the one card: a lit landmark's card waits.
    await expect(canvasElement.querySelector('[data-slot="inset-card"]')).toBeNull();
    await expect(slot(canvasElement, 'tab-body')).toHaveAttribute('data-dimmed');
    await expect(slot(canvasElement, 'drop-landmark')).toHaveAttribute('aria-pressed', 'true');
  },
};

/** Move (M) on the card hands the landmark to the map; moving, it reads *Done moving*. */
export const MoveALandmark: Story = {
  args: { ...EVERY_LEVER, lit: SELECTED_UPPER, moving: 'lm-upper' },
  play: async ({ canvasElement, args }) => {
    const card = within(slot(canvasElement, 'inset-card'));
    const move = card.getByRole('button', { name: /Done moving/ });
    await expect(move).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(move);
    await expect(args.onMoveLandmark).toHaveBeenCalledWith('lm-upper');
  },
};

/** Remove asks why — it takes a label away from skaters — and waits for the reason. */
export const RemoveALandmark: Story = {
  args: { ...EVERY_LEVER, lit: SELECTED_UPPER },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(slot(canvasElement, 'inset-card')).getByRole('button', { name: 'Remove' }),
    );
    const dialog = await within(document.body).findByRole('alertdialog');
    await expect(within(dialog).getByText('Remove “Upper Shaker Village”')).toBeInTheDocument();
    const action = within(dialog).getByRole('button', { name: /^Remove/ });
    await expect(action).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox'), 'The village, not the lake');
    await userEvent.click(action);
    await expect(args.onRemoveLandmark).toHaveBeenCalledWith(
      'lm-upper',
      'The village, not the lake',
    );
    await waitFor(() => expect(document.querySelector('[data-slot="reason-ask"]')).toBeNull());
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
  args: { data: { asks: [], asksCapped: false, landmarks: [], failures: [] }, canPlace: true },
  play: async ({ canvasElement }) => {
    await expect(slot(slot(canvasElement, 'asks'), 'section-count')).toHaveTextContent('0');
    await expect(slot(slot(canvasElement, 'landmarks'), 'section-count')).toHaveTextContent('0');
  },
};

/** A viewer who can't see who asks: the asks stand, with no asker line and no blank for one. */
export const NoAskers: Story = {
  args: {
    data: {
      ...MASCOMA_PLACES,
      asks: rowsOf(MASCOMA_PLACES.asks).map((a) =>
        a.kind === 'proposal' ? { ...a, asker: 'hidden' as const } : a,
      ),
    },
  },
  play: async ({ canvasElement }) => {
    const proposal = must(slots(canvasElement, 'ask')[1]);
    await expect(proposal).not.toHaveTextContent('Kate Donovan');
    await expect(proposal.querySelector('[data-slot="person-lockup"]')).toBeNull();
    await expect(proposal.querySelector('[data-slot="skeleton"]')).toBeNull();
  },
};

/** An asker whose account was since erased: said so, never a blank where the name would be. */
export const ErasedAsker: Story = {
  args: {
    data: {
      ...MASCOMA_PLACES,
      asks: rowsOf(MASCOMA_PLACES.asks).map((a) =>
        a.kind === 'proposal' ? { ...a, asker: 'erased' as const } : a,
      ),
    },
  },
  play: async ({ canvasElement }) => {
    await expect(slots(canvasElement, 'ask')[1]).toHaveTextContent(
      'Asked from an account since erased',
    );
  },
};

/** A landmark a moderator dropped: who added it is their lockup, the handle the link to them. */
export const AddedByAModerator: Story = {
  args: {
    ...EVERY_LEVER,
    lit: SELECTED_UPPER,
    data: {
      ...MASCOMA_PLACES,
      landmarks: rowsOf(MASCOMA_PLACES.landmarks).map((l) =>
        l.id === 'lm-upper'
          ? {
              ...l,
              added: {
                at: new Date(2026, 9, 3, 12).getTime(),
                by: { name: 'Teagan Atwater', handle: 'teagan', href: '/admin/people/u-teagan' },
              },
            }
          : l,
      ),
    },
  },
  play: async ({ canvasElement }) => {
    const card = slot(canvasElement, 'inset-card');
    await expect(card).toHaveTextContent('3 Oct 2026');
    await expect(within(card).getByRole('link', { name: '@teagan' })).toHaveAttribute(
      'href',
      '/admin/people/u-teagan',
    );
  },
};

/** The asks are on their way and who added the landmark too: each place is held. */
export const PartlyLoading: Story = {
  args: {
    ...EVERY_LEVER,
    lit: SELECTED_UPPER,
    data: {
      ...MASCOMA_PLACES,
      asks: undefined,
      landmarks: rowsOf(MASCOMA_PLACES.landmarks).map((l) => ({ ...l, added: undefined })),
    },
  },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'asks')).toHaveAttribute('aria-busy', 'true');
    await expect(
      slot(canvasElement, 'inset-card').querySelector('[data-slot="skeleton"]'),
    ).not.toBeNull();
  },
};

/**
 * The landmarks and who asked couldn't be read: each says so in place, the note at the top names
 * both, with Try again; the asks still stand.
 */
export const ReadsFailed: Story = {
  args: {
    ...EVERY_LEVER,
    onRetry: fn(),
    data: {
      ...MASCOMA_PLACES,
      asks: rowsOf(MASCOMA_PLACES.asks).map((a) =>
        a.kind === 'proposal' ? { ...a, asker: FAILED_READ } : a,
      ),
      landmarks: FAILED_READ,
      failures: ['the landmarks', 'who asked'],
    },
  },
  play: async ({ canvasElement, args }) => {
    const note = slot(canvasElement, 'read-failures');
    await expect(note).toHaveTextContent('Couldn’t read the landmarks and who asked.');
    await expect(slot(canvasElement, 'landmarks')).toHaveTextContent('Couldn’t be read');
    await expect(slots(canvasElement, 'ask')[1]).toHaveTextContent('Who asked couldn’t be read');
    await userEvent.click(within(note).getByRole('button', { name: 'Try again' }));
    await expect(args.onRetry).toHaveBeenCalled();
  },
};

/** More is asked than the reads returned: the count is a floor ("2+"), never drawn as whole. */
export const CappedAsks: Story = {
  args: { ...EVERY_LEVER, data: { ...MASCOMA_PLACES, asksCapped: true } },
  play: async ({ canvasElement }) => {
    await expect(slot(slot(canvasElement, 'asks'), 'section-count')).toHaveTextContent('2+');
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
