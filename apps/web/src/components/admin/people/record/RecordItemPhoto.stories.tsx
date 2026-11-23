import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { RecordItem } from './RecordItem';
import { ITEM_PHOTO, ITEM_PHOTO_NONE, NOW, SUBJECT } from './recordFixtures';

/**
 * The record sheet's photo item (B01-5e): a photo verdict's plate, its thumbnail pixelated as the
 * Inbox's stage is until *Show*, at the sheet's width. No read of an image's load state: the story
 * asserts no `<img>` before *Show*, and waits on the mosaic's own `data-drawn`.
 */
const meta = {
  title: 'Admin/People/Record sheet/Photo item',
  component: RecordItem,
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
  args: {
    item: ITEM_PHOTO,
    subject: SUBJECT,
    now: NOW,
    narrow: false,
    keys: true,
    busy: null,
    note: null,
    onLever: fn(),
    onUndoEnd: fn(),
  },
  render: (args) => (
    <div className="flex h-[40rem] w-[30rem] max-w-full flex-col bg-bg text-fg">
      <RecordItem {...args} />
    </div>
  ),
} satisfies Meta<typeof RecordItem>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Pixelated, then shown, then pixelated again. */
export const Pixelated: Story = {
  play: async ({ canvasElement }) => {
    // Pixelated: the plate and its painted mosaic, and no image, in one retry.
    await waitFor(() => {
      expect(canvasElement.querySelector('[data-slot="record-plate"][data-photo]')).not.toBeNull();
      expect(
        canvasElement.querySelector<HTMLElement>('[data-slot="photo-mosaic"]')?.dataset.drawn,
      ).toMatch(/^12x\d+$/);
      expect(canvasElement.querySelector('img')).toBeNull();
    });
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(canvasElement.querySelector('img')).not.toBeNull());
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Pixelate again' }));
    await waitFor(() => expect(canvasElement.querySelector('img')).toBeNull());
  },
};

/** In light mode. */
export const PixelatedLight: Story = {
  ...Pixelated,
  globals: { surface: 'admin', mode: 'light' },
};

/** No address served: a line, no image. */
export const NoPhoto: Story = {
  args: { item: ITEM_PHOTO_NONE },
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      expect(canvasElement).toHaveTextContent('No photo to show');
      expect(canvasElement.querySelector('img, canvas')).toBeNull();
    });
  },
};
