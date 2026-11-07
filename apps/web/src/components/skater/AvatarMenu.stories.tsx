import type { ThemePreference } from '@skating/design';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { must } from '../kit/storyKit';
import { AvatarMenuView } from './AvatarMenuView';
import { KATE, SkaterPair } from './storySupport';
import { ThemeMenu } from './ThemeMenu';

/** The avatar's menu (3.24) and its theme row. */
const meta = {
  title: 'Skater/Avatar menu',
  component: AvatarMenuView,
  globals: { surface: 'skater', mode: 'light' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof AvatarMenuView>;

export default meta;
type Story = StoryObj<typeof meta>;

const menu = (root: ParentNode) =>
  root.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"]');

/** 3.24: a moderator's menu — Moderation opens the console in a new tab. */
export const Moderator: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="30rem">
      {(mode, c) => (
        <div className="flex justify-end p-(--space-3) pr-(--space-5)">
          <AvatarMenuView
            open
            onOpenChange={() => {}}
            person={KATE}
            isModerator
            theme={mode}
            onThemeChange={() => {}}
            onNavigate={() => {}}
            onSignOut={() => {}}
            container={c}
          />
        </div>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    for (const q of canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')) {
      const m = await waitFor(() => must(menu(q)));
      await expect(getComputedStyle(m).borderRadius).toBe('0px');
      const mod = within(m).getByRole('menuitem', { name: /Moderation/ });
      await expect(mod).toHaveAttribute('target', '_blank');
      await expect(
        within(m).getByRole('button', { name: q.dataset.mode === 'dark' ? 'Dark' : 'Light' }),
      ).toHaveAttribute('aria-pressed', 'true');
      // People are circles.
      const face = must(m.querySelector<HTMLElement>('[data-slot="avatar"]'));
      await expect(getComputedStyle(face).borderRadius).not.toBe('0px');
    }
  },
};

const navigate = fn();
const signOut = fn();

/** The keyboard: ↓ walks the rows, Tab reaches the theme, ←→ choose, Esc returns to the avatar. */
export const Keyboard: Story = {
  args: {} as never,
  globals: { mode: 'dark' },
  render: function Render() {
    const [open, setOpen] = useState(false);
    const [theme, setTheme] = useState<ThemePreference>('system');
    return (
      <div className="flex h-[30rem] justify-end p-(--space-3) pr-(--space-5)">
        <AvatarMenuView
          open={open}
          onOpenChange={setOpen}
          person={KATE}
          isModerator={false}
          theme={theme}
          onThemeChange={setTheme}
          onNavigate={(href) => {
            navigate(href);
            setOpen(false);
          }}
          onSignOut={signOut}
        />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button', { name: 'Your account' });
    await userEvent.tab();
    await expect(trigger).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    const m = await waitFor(() => must(menu(document)));
    // Opened from the keyboard, the first row is already lit.
    await waitFor(() =>
      expect(within(m).getByRole('menuitem', { name: 'Your profile' })).toHaveFocus(),
    );
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() =>
      expect(within(m).getByRole('menuitem', { name: 'Settings' })).toHaveFocus(),
    );
    await userEvent.tab();
    const system = within(m).getByRole('button', { name: 'System' });
    await waitFor(() => expect(system).toHaveFocus());
    await userEvent.keyboard('{ArrowRight}');
    const light = within(m).getByRole('button', { name: 'Light' });
    await waitFor(() => expect(light).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(light).toHaveAttribute('aria-pressed', 'true'));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(menu(document)).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
    // Enter on a row navigates.
    await userEvent.keyboard('{Enter}');
    await waitFor(() => must(menu(document)));
    await waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('menuitem'));
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(navigate).toHaveBeenLastCalledWith('/u/kdonovan'));
  },
};

/** The theme row alone: System · Light · Dark, one always chosen. */
export const Theme: Story = {
  args: {} as never,
  render: function Render() {
    return <SkaterPair height="6rem">{(mode) => <ThemeRow initial={mode} />}</SkaterPair>;
  },
  play: async ({ canvasElement }) => {
    const q = must(canvasElement.querySelector<HTMLElement>('[data-theme-scope]'));
    const dark = within(q).getByRole('button', { name: 'Dark' });
    await expect(dark).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(dark);
    await expect(dark).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(q).getByRole('button', { name: 'System' }));
    await expect(within(q).getByRole('button', { name: 'System' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  },
};

function ThemeRow({ initial }: { initial: ThemePreference }) {
  const [value, setValue] = useState(initial);
  return (
    <div className="w-[13.5rem] p-(--space-4)">
      <ThemeMenu value={value} onValueChange={setValue} />
    </div>
  );
}
