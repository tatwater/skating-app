import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { expectNoSidewaysScroll, must } from '@/components/kit/storyKit';

import { InboxBoard } from '../../inboxBoard';
import { queryOf } from '../../inboxSearch';
import { resetInboxScroll } from '../../list/InboxList';
import type { InboxItemView } from '../../list/inboxTypes';
import { storyRequestRegistry } from './requestBoard';
import {
  activate,
  admit,
  admitNoMatch,
  contest,
  restore,
  rowOf,
  takedown,
} from './requestFixtures';
import type { RequestItem } from './requestModel';

/**
 * Board 2.3 and the request kinds derived from it as whole pages — the Inbox's own page with the
 * request handler in its inspector, at the boards' 1440 × 900 (the render-compare beside
 * `inbox-handler-v5.html?h=admit`) and at a phone's 360 px, where one pane shows at a time and the
 * bar folds under *More*.
 */
const onWrite = fn(async () => true);

/** The Requests lane as 2.3's list draws it: each kind, newest last. */
const ITEMS: RequestItem[] = [
  restore(),
  contest(),
  admit(),
  admitNoMatch(),
  takedown(),
  activate(),
];
const ROWS = ITEMS.map(rowOf);
const BY_ID: Record<string, InboxItemView> = Object.fromEntries(
  ITEMS.map((i) => [i.itemId, i as InboxItemView]),
);

const at = (item: RequestItem) => queryOf({ lane: 'requests', item: item.itemId }, true);

const meta = {
  title: 'Admin/Inbox/Handlers/Request/Page',
  component: InboxBoard,
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
  args: {
    initialQuery: at(admit()),
    canReadSupport: true,
    list: { status: 'done', rows: ROWS, pending: false },
    tail: { rows: [] },
    items: BY_ID,
    registry: new Map(storyRequestRegistry(onWrite)),
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
const handler = (root: HTMLElement) =>
  waitFor(() => must(detail(root).querySelector<HTMLElement>('[data-slot="request-handler"]')));

/** Board 2.3, the page: A acts only with the inspector focused; D opens the note it asks. */
export const Admit: Story = {
  play: async ({ canvasElement }) => {
    await handler(canvasElement);
    const pane = detail(canvasElement);
    await expect(within(pane).getByText('Admit a body')).toBeVisible();
    pane.focus();
    await waitFor(() => expect(pane.contains(document.activeElement)).toBe(true));
    await userEvent.keyboard('d');
    const dialog = await waitFor(() =>
      must(document.querySelector<HTMLElement>('[role="alertdialog"]')),
    );
    await expect(within(dialog).getByRole('textbox')).toHaveValue('');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
    await expect(onWrite).not.toHaveBeenCalled();
  },
};

/** Board 2.3, light. */
export const AdmitLight: Story = {
  globals: { surface: 'admin', mode: 'light' },
  play: async ({ canvasElement }) => {
    await handler(canvasElement);
  },
};

export const AdmitNoMatch: Story = {
  args: { initialQuery: at(admitNoMatch()) },
  play: async ({ canvasElement }) => {
    await handler(canvasElement);
    await expect(
      within(detail(canvasElement)).getByRole('button', { name: /^Look up again/ }),
    ).toBeVisible();
  },
};

export const Activate: Story = {
  args: { initialQuery: at(activate()) },
  play: async ({ canvasElement }) => {
    await handler(canvasElement);
  },
};

export const Restore: Story = {
  args: { initialQuery: at(restore()) },
  play: async ({ canvasElement }) => {
    await handler(canvasElement);
  },
};

export const Contest: Story = {
  args: { initialQuery: at(contest()) },
  play: async ({ canvasElement }) => {
    await handler(canvasElement);
  },
};

export const Takedown: Story = {
  args: { initialQuery: at(takedown()) },
  play: async ({ canvasElement }) => {
    await handler(canvasElement);
  },
};

/** 2.3 at 360 px: one pane, the head whole, the bar at the foot, nothing sideways. */
export const AdmitAtPhone: Story = {
  args: {
    className: 'h-[50rem] w-[22.5rem]',
    registry: new Map(storyRequestRegistry(onWrite, 360)),
  },
  play: async ({ canvasElement }) => {
    await handler(canvasElement);
    await within(detail(canvasElement)).findByRole('toolbar');
    await expectNoSidewaysScroll(
      must(canvasElement.querySelector<HTMLElement>('[data-slot="inbox-page"]')),
    );
  },
};

/** An activate at 360 px: *Open in Body →* stays whole in the head. */
export const ActivateAtPhone: Story = {
  args: {
    className: 'h-[50rem] w-[22.5rem]',
    initialQuery: at(activate()),
    registry: new Map(storyRequestRegistry(onWrite, 360)),
  },
  play: async ({ canvasElement }) => {
    await handler(canvasElement);
    await expectNoSidewaysScroll(
      must(canvasElement.querySelector<HTMLElement>('[data-slot="inbox-page"]')),
    );
  },
};
