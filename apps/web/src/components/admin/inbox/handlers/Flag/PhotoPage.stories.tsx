import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, waitFor } from 'storybook/test';

import { must } from '@/components/kit/storyKit';

import { InboxBoard } from '../../inboxBoard';
import { queryOf } from '../../inboxSearch';
import { resetInboxScroll } from '../../list/InboxList';
import { ALERT_ROW, PHOTO_ROW } from '../../list/inboxFixtures';
import { storyFlagRegistry } from './flagBoard';
import { AROUND, WEATHER } from './flagFixtures';
import { PHOTO_ITEM } from './photoFixtures';

/**
 * Board 2.7 as a whole page — the Inbox's own page with the photo flag in its inspector, at the
 * board's 1440 × 900, for the render-compare beside `inbox-handler-v5.html?h=photo`.
 */
const onWrite = fn(async () => true);
const REGISTRY = storyFlagRegistry({ weather: WEATHER, around: AROUND, onWrite });

const meta = {
  title: 'Admin/Inbox/Flag handler/Photo page',
  component: InboxBoard,
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
  args: {
    initialQuery: queryOf({ lane: 'contentFlags', item: PHOTO_ROW.itemId }, true),
    canReadSupport: true,
    list: { status: 'done', rows: [PHOTO_ROW, ALERT_ROW], pending: false },
    items: { [PHOTO_ROW.itemId]: { ...PHOTO_ITEM, itemId: PHOTO_ROW.itemId } },
    registry: REGISTRY,
  },
  beforeEach: () => {
    resetInboxScroll();
    onWrite.mockClear();
  },
} satisfies Meta<typeof InboxBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

const detail = (root: HTMLElement) =>
  must(root.querySelector<HTMLElement>('[data-slot="inbox-page"] > [data-pane="detail"]'));

/** Board 2.7, the page: the photo pixelated in the inspector, the full one nowhere in the page. */
export const Photo: Story = {
  play: async ({ canvasElement }) => {
    const pane = detail(canvasElement);
    await waitFor(() =>
      expect(pane.querySelector('[data-slot="flag-head"]')).toHaveTextContent('Flag on a photo'),
    );
    await expect(pane.querySelector('[data-slot="photo-stage"] img')).toBeNull();
  },
};

/** Board 2.7's page in light mode. */
export const PhotoLight: Story = {
  ...Photo,
  globals: { surface: 'admin', mode: 'light' },
};
