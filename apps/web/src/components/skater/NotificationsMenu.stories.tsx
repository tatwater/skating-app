import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { computedColor, sameColor } from '../kit/measure';
import { must } from '../kit/storyKit';
import { NotificationsMenuView } from './NotificationsMenuView';
import { NOTIFICATIONS, SkaterPair } from './storySupport';

/** The bell's dropdown (3.21–3.23): unread and read, and empty. */
const meta = {
  title: 'Skater/Notifications',
  component: NotificationsMenuView,
  globals: { surface: 'skater', mode: 'light' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof NotificationsMenuView>;

export default meta;
type Story = StoryObj<typeof meta>;

const plate = (root: ParentNode) =>
  root.querySelector<HTMLElement>('[data-slot="popover-content"]');

function Pinned({
  rows,
  container,
}: {
  rows: typeof NOTIFICATIONS;
  container: HTMLElement | null;
}) {
  return (
    <div className="flex justify-end p-(--space-3) pr-[5rem]">
      <NotificationsMenuView
        open
        modal={false}
        onOpenChange={() => {}}
        unreadCount={rows.filter((r) => r.unread).length}
        rows={rows}
        canLoadMore={rows.length > 0}
        onOpenRow={() => {}}
        onNavigate={() => {}}
        container={container}
      />
    </div>
  );
}

/** 3.21 / 3.22: New with the ice wash and its rule, then Earlier. */
export const UnreadAndRead: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="52rem">
      {(_, c) => <Pinned rows={NOTIFICATIONS} container={c} />}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    for (const q of canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')) {
      const p = await waitFor(() => must(plate(q)));
      await expect(getComputedStyle(p).borderRadius).toBe('0px');
      await expect(p.getBoundingClientRect().width).toBe(420);
      const groups = [...p.querySelectorAll('[data-slot="notifications-group"] h3')].map(
        (h) => h.textContent,
      );
      await expect(groups).toEqual(['New', 'Earlier']);
      const unread = must(
        p.querySelector<HTMLElement>('[data-slot="notification-row"][data-unread]'),
      );
      await expect(getComputedStyle(unread).backgroundColor).toEqual(
        sameColor(computedColor(unread, 'var(--acc-wash)')),
      );
      // A list's last row has no rule under it.
      const items = p.querySelectorAll('li');
      await expect(getComputedStyle(must(items[items.length - 1])).borderBottomWidth).toBe('0px');
      // The hazard's tile is red, square.
      const bad = must(
        p.querySelector<HTMLElement>('[data-slot="notification-glyph"][data-tone="bad"]'),
      );
      await expect(getComputedStyle(bad).borderRadius).toBe('0px');
      // A row with nowhere honest to go is not a link.
      await expect(
        within(p)
          .getByText(/left it up/)
          .closest('a'),
      ).toBeNull();
    }
  },
};

/** 3.23: nothing yet. */
export const Empty: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="22rem">{(_, c) => <Pinned rows={[]} container={c} />}</SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const p = await waitFor(() => must(plate(canvasElement)));
    await expect(within(p).getByText('Nothing yet')).toBeInTheDocument();
    // The gear and the empty state's button both go to the settings, as links.
    const doors = within(p).getAllByRole('link', { name: 'Notification settings' });
    await expect(doors).toHaveLength(2);
    for (const d of doors) await expect(d).toHaveAttribute('href', '/settings/notifications');
  },
};

const opened = fn();

/** The keyboard: Enter opens, Tab stays in the plate, Esc closes and focus returns to the bell. */
export const Keyboard: Story = {
  args: {} as never,
  globals: { mode: 'dark' },
  render: function Render() {
    const [open, setOpen] = useState(false);
    return (
      <div className="flex h-[44rem] justify-end p-(--space-3) pr-[5rem]">
        <NotificationsMenuView
          open={open}
          onOpenChange={setOpen}
          unreadCount={3}
          rows={NOTIFICATIONS}
          onOpenRow={(row) => {
            opened(row.id);
            setOpen(false);
          }}
          onNavigate={() => {}}
        />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const bell = within(canvasElement).getByRole('button', { name: 'Notifications, 3 unread' });
    await userEvent.tab();
    await expect(bell).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    const p = await waitFor(() => must(plate(document)));
    // Focus opens on the first row, so ⏎ again follows it; the gear's tip stays shut.
    await waitFor(() =>
      expect(document.activeElement).toBe(p.querySelector('[data-slot="notification-row"]')),
    );
    await expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
    for (let i = 0; i < 10; i++) {
      await userEvent.tab();
      await waitFor(() => expect(p.contains(document.activeElement)).toBe(true));
    }
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(plate(document)).toBeNull());
    await waitFor(() => expect(bell).toHaveFocus());
    await userEvent.click(bell);
    await userEvent.click(await within(must(plate(document))).findByText(/still there/));
    await expect(opened).toHaveBeenCalledWith('n2');
  },
};
