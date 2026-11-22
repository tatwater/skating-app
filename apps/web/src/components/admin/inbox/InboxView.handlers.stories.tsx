import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ComponentProps, useEffect, useRef, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { expectControlsInside, expectNoSidewaysScroll, must } from '@/components/kit/storyKit';

import { accessSlots } from './handlers/Access/AccessHandlerView';
import { DISPUTE } from './handlers/Access/accessHandlerFixtures';
import type { AccessItem } from './handlers/Access/accessModel';
import { storyFlagRegistry } from './handlers/Flag/flagBoard';
import { AROUND, SAFETY_ITEM as FLAG_ITEM, WEATHER } from './handlers/Flag/flagFixtures';
import { InboxBoard, storyLink } from './inboxBoard';
import { queryOf } from './inboxSearch';
import type { HandlerKey, InboxHandler } from './inspector/handlerRegistry';
import { InspectorFrame } from './inspector/InspectorFrame';
import { useInspectorContext } from './inspector/inspectorContext';
import { resetInboxScroll } from './list/InboxList';
import {
  ACCESS_ROW,
  ALERT_ROW,
  decidedItem,
  decidedRow,
  MATT,
  SAFETY_ROW,
  TEAGAN,
} from './list/inboxFixtures';
import type { InboxItemView } from './list/inboxTypes';

/**
 * **The real handlers in the real frame** — the flag handler (W2's, over its fixtures through its
 * own story registry) and the access handler (W3's, through its `accessSlots`), inside the Inbox's
 * page at the boards' 1440 × 900 and at a phone's 360 px: the action bar (folding to *More* when
 * narrow), the head whole at 360, the lock over a real handler when a colleague decides, ⇧⏎ back
 * to the list from inside a handler, and focus moving on to the next row when the viewer's own
 * decision takes the item out of the list.
 */

const onWrite = fn(async () => true);

/** Access through its own slots, over its fixtures (the app's handler reads Convex). */
const AccessStoryHandler: InboxHandler = ({ item, now, locked }) => {
  const { pane } = useInspectorContext();
  const { head, actions, body } = accessSlots({
    item: item as AccessItem,
    now,
    map: null,
    bodyLink: storyLink('/admin/body'),
    onRule: async () => true,
    pending: null,
    pane,
  });
  return (
    <InspectorFrame head={head} actions={actions} locked={locked}>
      {body}
    </InspectorFrame>
  );
};

const REGISTRY: ReadonlyMap<HandlerKey, InboxHandler> = new Map([
  ...storyFlagRegistry({ weather: WEATHER, around: AROUND, onWrite }),
  ['access', AccessStoryHandler],
]);

const SAFETY = { ...FLAG_ITEM, itemId: SAFETY_ROW.itemId } as unknown as InboxItemView;
const ACCESS = { ...DISPUTE, itemId: ACCESS_ROW.itemId } as unknown as InboxItemView;
const NEXT_ROW = {
  ...ALERT_ROW,
  lane: 'safety',
  itemId: 'itnext00000000000000000000000000',
} as typeof SAFETY_ROW;

const meta = {
  title: 'Admin/Inbox/Page with handlers',
  component: InboxBoard,
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
  args: {
    initialQuery: queryOf({ lane: 'safety', item: SAFETY_ROW.itemId }, true),
    canReadSupport: true,
    list: { status: 'done', rows: [SAFETY_ROW, NEXT_ROW], pending: false },
    tail: null,
    items: { [SAFETY_ROW.itemId]: SAFETY, [ACCESS_ROW.itemId]: ACCESS },
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
const listbox = (root: HTMLElement) => within(root).getByRole('listbox', { hidden: true });

/** 2.1 at 1440: the flag handler's bar floats in the frame; ⇧⏎ from its button goes to the list. */
export const FlagAtDesktop: Story = {
  play: async ({ canvasElement }) => {
    const pane = detail(canvasElement);
    const bar = await within(pane).findByRole('toolbar');
    await expect(bar).toHaveAttribute('data-floating');
    const dismiss = within(bar).getByRole('button', { name: /Dismiss/ });
    dismiss.focus();
    await waitFor(() => expect(dismiss).toHaveFocus());
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    await waitFor(() => expect(listbox(canvasElement)).toHaveFocus());
    await expect(onWrite).not.toHaveBeenCalled();
  },
};

export const FlagAtDesktopLight: Story = { globals: { surface: 'admin', mode: 'light' } };

/** 2.1 at 360 px: one pane, the head whole (title, age, its link), the bar folded to More. */
export const FlagAtPhone: Story = {
  args: { className: 'h-[50rem] w-[22.5rem]' },
  play: async ({ canvasElement }) => {
    const pane = detail(canvasElement);
    await waitFor(() => expect(pane.querySelector('[data-slot="flag-head"]')).not.toBeNull());
    const head = must(pane.querySelector<HTMLElement>('[data-slot="inbox-inspector-head"]'));
    await expectHeadWhole(head);
    const bar = await within(pane).findByRole('toolbar');
    await waitFor(() => expect(within(bar).getByRole('button', { name: /More/ })).toBeVisible());
    // The frame and the page scroll nothing sideways. The handler's body is the handler's own (its
    // *How it is calculated →* chip is wider than a phone's column today — reported to its builder).
    await expectNoSidewaysScroll(
      must(canvasElement.querySelector<HTMLElement>('[data-slot="inbox-page"]')),
      { except: ['inbox-inspector-scroll'] },
    );
    await expectControlsInside(head, head);
  },
};

/** 2.2 at 360 px: the access handler's head keeps *Open in Body →* whole. */
export const AccessAtPhone: Story = {
  args: {
    className: 'h-[50rem] w-[22.5rem]',
    initialQuery: queryOf({ lane: 'accessReports', item: ACCESS_ROW.itemId }, true),
    list: { status: 'done', rows: [ACCESS_ROW], pending: false },
  },
  play: async ({ canvasElement }) => {
    const pane = detail(canvasElement);
    const head = await waitFor(() =>
      must(pane.querySelector<HTMLElement>('[data-slot="inbox-inspector-head"]')),
    );
    await waitFor(() => expect(head).toHaveTextContent(/Open in Body/i));
    await expectHeadWhole(head);
  },
};

/** 2.2 at 1440. */
export const AccessAtDesktop: Story = {
  args: {
    initialQuery: queryOf({ lane: 'accessReports', item: ACCESS_ROW.itemId }, true),
    list: { status: 'done', rows: [ACCESS_ROW], pending: false },
  },
  play: async ({ canvasElement }) => {
    const pane = detail(canvasElement);
    await within(pane).findByRole('toolbar');
    // One line at a desktop's width: the head keeps the board's 36 px.
    const head = must(pane.querySelector<HTMLElement>('[data-slot="inbox-inspector-head"]'));
    await expect(Math.round(head.getBoundingClientRect().height)).toBeLessThanOrEqual(37);
  },
};

/** A colleague decided it while it was open: the bar goes, the lock stands over the real handler. */
export const FlagDecidedByColleague: Story = {
  args: {
    inspector: {
      kind: 'item',
      item: decidedItem(SAFETY, MATT, 20 * 60_000, 'hidden'),
      phase: 'locked',
    },
  },
  play: async ({ canvasElement }) => {
    const pane = detail(canvasElement);
    const lock = await waitFor(() =>
      must(pane.querySelector<HTMLElement>('[data-slot="inbox-decided-lock"]')),
    );
    await expect(lock).toHaveTextContent(/Decided by Matt Steinberg · .* · hidden/);
    await expect(within(pane).queryByRole('toolbar')).toBeNull();
    pane.focus();
    await waitFor(() => expect(pane).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(listbox(canvasElement)).toHaveFocus());
  },
};

/**
 * The viewer's own decision takes the item out of the list: the bar that took it goes, and focus
 * lands on the next row — never lost.
 */
function DecidingBoard({
  by = 'me',
  ...props
}: ComponentProps<typeof InboxBoard> & { by?: 'me' | 'colleague' }) {
  const [decided, setDecided] = useState(false);
  useEffect(() => {
    const on = () => setDecided(true);
    window.addEventListener('story-decide', on);
    return () => window.removeEventListener('story-decide', on);
  }, []);
  const item = useRef(
    by === 'me'
      ? decidedItem(SAFETY, TEAGAN, 0, 'dismissed', true)
      : decidedItem(SAFETY, MATT, 0, 'hidden'),
  );
  return (
    <InboxBoard
      {...props}
      list={{ status: 'done', rows: decided ? [NEXT_ROW] : [SAFETY_ROW, NEXT_ROW], pending: false }}
      tail={{
        rows: decided ? [decidedRow(SAFETY_ROW, by === 'me' ? TEAGAN : MATT, 0, 'dismissed')] : [],
      }}
      inspector={
        decided
          ? { kind: 'item', item: item.current, phase: by === 'me' ? 'quiet' : 'locked' }
          : { kind: 'item', item: SAFETY, phase: 'live' }
      }
    />
  );
}

/** A colleague decides while the operator's focus is on a bar button: focus to the inspector, ⏎ back. */
export const ColleagueDecidesWhileOnTheBar: Story = {
  render: (args) => <DecidingBoard {...args} by="colleague" />,
  play: async ({ canvasElement }) => {
    const pane = detail(canvasElement);
    const dismiss = within(await within(pane).findByRole('toolbar')).getByRole('button', {
      name: /Dismiss/,
    });
    dismiss.focus();
    await waitFor(() => expect(dismiss).toHaveFocus());
    window.dispatchEvent(new Event('story-decide'));
    await waitFor(() =>
      expect(pane.querySelector('[data-slot="inbox-decided-lock"]')).not.toBeNull(),
    );
    // Not lost to the page body: the inspector holds it, so its keys still work.
    await waitFor(() => expect(pane).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(listbox(canvasElement)).toHaveFocus());
  },
};

/**
 * A colleague decides while the operator's reason dialog is open: the dialog closes with the bar
 * that opened it, nothing is sent, and focus comes to the inspector.
 */
export const ColleagueDecidesWhileAsking: Story = {
  render: (args) => <DecidingBoard {...args} by="colleague" />,
  play: async ({ canvasElement }) => {
    const pane = detail(canvasElement);
    const bar = await within(pane).findByRole('toolbar');
    await userEvent.click(within(bar).getByRole('button', { name: /Hide/ }));
    const dialog = await within(document.body).findByRole('alertdialog');
    const field = within(dialog).getByRole('textbox');
    await userEvent.type(field, 'Thin ice by the beach');
    await waitFor(() => expect(field).toHaveFocus());
    window.dispatchEvent(new Event('story-decide'));
    await waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
    await expect(onWrite).not.toHaveBeenCalled();
    await waitFor(() => expect(pane).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(listbox(canvasElement)).toHaveFocus());
  },
};

/** At 360 px the list is hidden while the item has the page: the viewer's decision keeps focus in it. */
export const OwnDecisionAtPhone: Story = {
  args: { className: 'h-[50rem] w-[22.5rem]' },
  render: (args) => <DecidingBoard {...args} by="me" />,
  play: async ({ canvasElement }) => {
    const pane = detail(canvasElement);
    const bar = await within(pane).findByRole('toolbar');
    const first = must(within(bar).getAllByRole('button')[0]);
    first.focus();
    await waitFor(() => expect(first).toHaveFocus());
    window.dispatchEvent(new Event('story-decide'));
    await waitFor(() => expect(within(pane).queryByRole('toolbar')).toBeNull());
    await waitFor(() => expect(pane).toHaveFocus());
    // Never sent to the hidden list; the way back is on screen.
    await expect(listbox(canvasElement).contains(document.activeElement)).toBe(false);
    await expect(
      within(canvasElement).getByRole('button', { name: 'Back to the list' }),
    ).toBeVisible();
  },
};

export const OwnDecisionMovesOn: Story = {
  render: (args) => <DecidingBoard {...args} />,
  play: async ({ canvasElement }) => {
    const pane = detail(canvasElement);
    const bar = await within(pane).findByRole('toolbar');
    const dismiss = within(bar).getByRole('button', { name: /Dismiss/ });
    dismiss.focus();
    await waitFor(() => expect(dismiss).toHaveFocus());
    // The decision lands (the item read turns decided by the viewer; the row leaves the list).
    window.dispatchEvent(new Event('story-decide'));
    await waitFor(() => expect(within(pane).queryByRole('toolbar')).toBeNull());
    // No banner for the viewer's own decision; focus on the list, the cursor on the next row.
    await expect(pane.querySelector('[data-slot="inbox-decided-lock"]')).toBeNull();
    await waitFor(() => expect(listbox(canvasElement)).toHaveFocus());
    await waitFor(() => {
      const active = listbox(canvasElement).getAttribute('aria-activedescendant');
      expect(active).not.toBeNull();
      expect(document.getElementById(active as string)).toHaveTextContent(/Fairlee launch closed/);
    });
  },
};

/** The head's title, age and links each whole inside the head: none clipped, none cut. */
async function expectHeadWhole(head: HTMLElement) {
  const box = head.getBoundingClientRect();
  await expect(head.scrollWidth).toBeLessThanOrEqual(head.clientWidth + 1);
  const parts = head.querySelectorAll<HTMLElement>(
    '[data-slot="inbox-inspector-title"], [data-slot="inbox-inspector-age"], [data-slot="inbox-inspector-head-end"] a, [data-slot="inbox-inspector-head-end"] button',
  );
  await expect(parts.length).toBeGreaterThan(1);
  for (const el of parts) {
    const r = el.getBoundingClientRect();
    const name = el.textContent?.trim() ?? el.dataset.slot;
    await expect(r.left, name).toBeGreaterThanOrEqual(box.left - 1);
    await expect(r.right, name).toBeLessThanOrEqual(box.right + 1);
    await expect(el.scrollWidth, name).toBeLessThanOrEqual(el.clientWidth + 1);
  }
}
