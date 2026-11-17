import type { ThemePreference } from '@skating/design';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { StatusLamp } from '@/components/kit/status-bar';
import { must } from '@/components/kit/storyKit';
import { ThemePair } from '../../../../.storybook/theme';
import { computedColor, sameColor } from '../../kit/measure';
import { ConsoleShell } from './ConsoleShell';
import { CONSOLE_MODES } from './consoleNav';
import { type MenuViewer, UserMenuView } from './UserMenuView';

/** The viewer's menu at the rail's foot (B01-2c): their page in People, the theme, Sign out. */
const meta = {
  title: 'Admin/Shell/User menu',
  component: UserMenuView,
  globals: { surface: 'admin' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof UserMenuView>;

export default meta;
type Story = StoryObj<typeof meta>;

const ROBIN: MenuViewer = { state: 'ready', id: 'p_robin', name: 'Robin Ashford' };

const onSignOut = fn();

const plate = (root: ParentNode) =>
  root.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"]');

/** A rail's foot: the menu's column, the rail wide, at the foot of its quad. */
function Foot({
  viewer = ROBIN,
  open,
  container,
  mode = 'system',
}: {
  viewer?: MenuViewer;
  open?: boolean;
  container?: HTMLElement;
  mode?: ThemePreference;
}) {
  const [theme, setTheme] = useState<ThemePreference>(mode);
  return (
    <div className="flex h-full w-rail flex-col justify-end border-0 border-r border-solid border-line pb-(--space-2_5)">
      <UserMenuView
        viewer={viewer}
        theme={theme}
        onThemeChange={setTheme}
        onSignOut={onSignOut}
        canOpenOwnPage
        {...(open !== undefined && { open })}
        {...(container !== undefined && { container })}
      />
    </div>
  );
}

/** Closed, in both maps: the boards' circle at the rail's foot, and the same box while it loads. */
export const Closed: Story = {
  args: {} as never,
  render: () => (
    <ThemePair surface="admin" height="8rem" columns="lg">
      {() => (
        <div className="flex h-full">
          <Foot />
          <Foot viewer={{ state: 'loading' }} />
          <Foot viewer={{ state: 'failed' }} />
        </div>
      )}
    </ThemePair>
  ),
  play: async ({ canvasElement }) => {
    for (const q of canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')) {
      const faces = [...q.querySelectorAll<HTMLElement>('[data-slot="user-menu-face"]')];
      await expect(faces).toHaveLength(3);
      // One box in every state, so the rail never shifts as the profile arrives: 26 px, round.
      for (const face of faces) {
        const box = face.getBoundingClientRect();
        await expect(box.width).toBeCloseTo(26, 0);
        await expect(box.height).toBeCloseTo(26, 0);
        await expect(getComputedStyle(face).borderRadius).not.toBe('0px');
      }
      const tops = faces.map((f) => f.getBoundingClientRect().top);
      await expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(0.5);
      await expect(
        within(q).getAllByRole('button', { name: 'Your account' }).length,
      ).toBe(3);
    }
  },
};

/** Open, in both maps: the viewer by name, their page, the theme as stored, Sign out. */
export const Open: Story = {
  args: {} as never,
  render: () => (
    <ThemePair surface="admin" height="20rem" columns="lg">
      {(mode, c) => <Foot open container={c} mode={mode} />}
    </ThemePair>
  ),
  play: async ({ canvasElement }) => {
    for (const q of canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')) {
      // Read fresh after every await: a node held across one can be mid-transition.
      const m = () => must(plate(q));
      await waitFor(() => expect(getComputedStyle(m()).opacity).toBe('1'));
      // The console's square plate on its own ground, the person a circle.
      await expect(getComputedStyle(m()).borderRadius).toBe('0px');
      await expect(getComputedStyle(m()).backgroundColor).toEqual(
        sameColor(computedColor(m(), 'var(--plate-solid)')),
      );
      await expect(
        getComputedStyle(must(m().querySelector<HTMLElement>('[data-slot="avatar"]'))).borderRadius,
      ).not.toBe('0px');
      await expect(getComputedStyle(within(m()).getByText('Robin Ashford')).color).toEqual(sameColor(computedColor(m(), 'var(--fg)')));
      await expect(m().textContent).not.toContain('@');
      await expect(
        within(m()).getByRole('menuitem', { name: 'Your page in People' }),
      ).toHaveAttribute('href', '/admin/people/p_robin');
      await expect(
        within(must(m().querySelector<HTMLElement>('[data-slot="theme-menu"]'))).getByRole('button', { name: q.dataset.mode === 'dark' ? 'Dark' : 'Light' }),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(within(m()).getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
      // Opened beside the rail, at its edge, never over it.
      const left = m().getBoundingClientRect().left;
      const railEdge = must(
        q.querySelector<HTMLElement>('[data-slot="user-menu-trigger"]'),
      ).getBoundingClientRect().right;
      await expect(left).toBeGreaterThanOrEqual(railEdge - 0.5);
    }
  },
};

/** While the profile loads: a skeleton head, the page row held back, the theme and Sign out live. */
export const Loading: Story = {
  args: {} as never,
  render: () => (
    <ThemePair surface="admin" height="20rem" columns="lg">
      {(mode, c) => <Foot open container={c} mode={mode} viewer={{ state: 'loading' }} />}
    </ThemePair>
  ),
  play: async ({ canvasElement }) => {
    for (const q of canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')) {
      const m = () => must(plate(q));
      await waitFor(() => m());
      await expect(within(m()).getByText('Loading your profile')).toBeInTheDocument();
      await expect(
        within(m()).getByRole('menuitem', { name: 'Your page in People' }),
      ).toHaveAttribute('aria-disabled', 'true');
      await expect(within(m()).getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
    }
  },
};

/** The profile didn't load: said in the head; Sign out still works. */
export const Failed: Story = {
  args: {} as never,
  render: () => (
    <ThemePair surface="admin" height="20rem" columns="lg">
      {(mode, c) => <Foot open container={c} mode={mode} viewer={{ state: 'failed' }} />}
    </ThemePair>
  ),
  play: async ({ canvasElement }) => {
    for (const q of canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')) {
      const m = () => must(plate(q));
      await waitFor(() => m());
      await expect(within(m()).getByText('Your profile didn’t load')).toBeVisible();
      await expect(
        within(m()).getByRole('menuitem', { name: 'Your page in People' }),
      ).toHaveAttribute('aria-disabled', 'true');
    }
  },
};

/** The keyboard: Enter opens on the first row, ↓ walks, Tab reaches the theme, Esc gives focus back. */
export const Keyboard: Story = {
  args: {} as never,
  globals: { mode: 'dark' },
  beforeEach: () => {
    onSignOut.mockClear();
  },
  render: () => (
    <div className="h-[24rem]">
      <Foot />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button', { name: 'Your account' });
    await userEvent.tab();
    await expect(trigger).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(
        within(must(plate(document))).getByRole('menuitem', { name: 'Your page in People' }),
      ).toHaveFocus(),
    );
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() =>
      expect(within(must(plate(document))).getByRole('menuitem', { name: 'Sign out' })).toHaveFocus(),
    );
    await userEvent.keyboard('{ArrowUp}');
    await userEvent.tab();
    await waitFor(() =>
      expect(within(must(plate(document))).getByRole('button', { name: 'System' })).toHaveFocus(),
    );
    await userEvent.keyboard('{ArrowRight}{Enter}');
    await waitFor(() =>
      expect(within(must(plate(document))).getByRole('button', { name: 'Light' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(plate(document)).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
    await expect(onSignOut).not.toHaveBeenCalled();
  },
};

/**
 * At phone width the rail stays (it never collapses), so the circle is where it is on a desktop,
 * and the menu opens beside it inside the screen, over the page.
 */
export const PhoneWidth: Story = {
  args: {} as never,
  globals: { mode: 'dark' },
  render: function Render() {
    const [theme, setTheme] = useState<ThemePreference>('dark');
    return (
      <ConsoleShell
        className="h-[40rem] w-[22.5rem]"
        modes={CONSOLE_MODES.map((m) => ({ ...m, current: m.id === 'people' }))}
        legacy={[]}
        onLegacy={() => {}}
        appHref="#app"
        account={
          <UserMenuView
            viewer={ROBIN}
            theme={theme}
            onThemeChange={setTheme}
            onSignOut={onSignOut}
            canOpenOwnPage
          />
        }
        onSearch={() => {}}
        lamp={<StatusLamp>Convex live</StatusLamp>}
      >
        <div data-testid="page" className="size-full p-(--space-4)">
          The page
        </div>
      </ConsoleShell>
    );
  },
  play: async ({ canvasElement }) => {
    const foot = must(canvasElement.querySelector<HTMLElement>('[data-slot="shell-rail-foot"]'));
    await userEvent.click(within(foot).getByRole('button', { name: 'Your account' }));
    await waitFor(() => expect(getComputedStyle(must(plate(document))).opacity).toBe('1'));
    const frame = must(canvasElement.querySelector<HTMLElement>('[data-slot="app-shell"]'));
    const box = must(plate(document)).getBoundingClientRect();
    const screenBox = frame.getBoundingClientRect();
    await expect(box.left).toBeGreaterThanOrEqual(screenBox.left);
    await expect(box.right).toBeLessThanOrEqual(screenBox.right + 0.5);
    await expect(box.bottom).toBeLessThanOrEqual(screenBox.bottom + 0.5);
    // Over the page: the point at the plate's middle is the plate's.
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    await expect(must(plate(document)).contains(hit)).toBe(true);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(plate(document)).toBeNull());
  },
};
