import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor } from 'storybook/test';

import { must } from '@/components/kit/storyKit';

import { InboxBoard } from '../../inboxBoard';
import { queryOf } from '../../inboxSearch';
import { resetInboxScroll } from '../../list/InboxList';
import { ALERT_ROW, SAFETY_ROW, SAFETY_TAIL } from '../../list/inboxFixtures';
import { storyFlagRegistry } from './flagBoard';
import { ALERT_ITEM, AROUND, SAFETY_ITEM, WEATHER } from './flagFixtures';

/**
 * Boards 2.1 and 2.6 as whole pages — the Inbox's own page (W1's) with the flag handler in its
 * inspector, at the boards' 1440 × 900, for the render-compare beside `inbox-v5.html` and
 * `inbox-handler-v5.html?h=alert`. The map is W3's (a stand-in here).
 */
const onWrite = fn(async () => true);
const REGISTRY = storyFlagRegistry({ weather: WEATHER, around: AROUND, onWrite });

const meta = {
  title: 'Admin/Inbox/Flag handler/Page',
  component: InboxBoard,
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
  args: {
    initialQuery: queryOf({ lane: 'safety', item: SAFETY_ROW.itemId }, true),
    canReadSupport: true,
    list: { status: 'done', rows: [SAFETY_ROW], pending: false },
    tail: { rows: SAFETY_TAIL },
    items: { [SAFETY_ROW.itemId]: { ...SAFETY_ITEM, itemId: SAFETY_ROW.itemId } },
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
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');

/** Board 2.1, the page: the handler in the inspector, its keys bound to the inspector pane. */
export const Safety: Story = {
  play: async ({ canvasElement }) => {
    const pane = detail(canvasElement);
    await waitFor(() =>
      expect(pane.querySelector('[data-slot="flag-head"]')).toHaveTextContent('Flagged as unsafe'),
    );
    // A letter acts only with the inspector focused.
    pane.focus();
    await waitFor(() => expect(pane.contains(document.activeElement)).toBe(true));
    await userEvent.keyboard('h');
    await waitFor(() => expect(dialog()).not.toBeNull());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(dialog()).toBeNull());
    await expect(onWrite).not.toHaveBeenCalled();
  },
};

/** Board 2.6, the page. */
export const AccessAlert: Story = {
  args: {
    initialQuery: queryOf({ lane: 'contentFlags', item: ALERT_ROW.itemId }, true),
    list: { status: 'done', rows: [ALERT_ROW], pending: false },
    tail: { rows: [] },
    items: { [ALERT_ROW.itemId]: { ...ALERT_ITEM, itemId: ALERT_ROW.itemId } },
  },
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(detail(canvasElement).querySelector('[data-slot="flag-head"]')).toHaveTextContent(
        'Flag on an access alert',
      ),
    );
  },
};

/** Board 2.1, light. */
export const SafetyLight: Story = {
  globals: { surface: 'admin', mode: 'light' },
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(detail(canvasElement).querySelector('[data-slot="flag-head"]')).not.toBeNull(),
    );
  },
};
