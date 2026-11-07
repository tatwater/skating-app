import type { Meta, StoryObj } from '@storybook/react-vite';
import { useCallback, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { useChromeStore } from '@/stores/chromeStore';

import { AvatarMenuView } from './AvatarMenuView';
import { useChromeKeys, useChromeOverlay } from './chrome';
import { GlobalSearchView } from './GlobalSearchView';
import { NotificationsMenuView } from './NotificationsMenuView';
import { SkaterTopBarView } from './SkaterTopBarView';
import { fixtureSearch, KATE, NOTIFICATIONS, SkaterPair } from './storySupport';

/**
 * The skater top bar (row 1's strip; 3.17, 3.21, 3.24), wired the way `SkaterTopBar` wires it — the
 * real chrome store, the real `/` and Esc — with the server swapped for the boards' rows.
 */
const meta = {
  title: 'Skater/Top bar',
  component: SkaterTopBarView,
  globals: { surface: 'skater', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
  beforeEach: () => {
    useChromeStore.setState({ overlay: null });
  },
} satisfies Meta<typeof SkaterTopBarView>;

export default meta;
type Story = StoryObj<typeof meta>;

const navigate = fn();
const newReport = fn();

function Harness({ moderator = false }: { moderator?: boolean }) {
  const search = useChromeOverlay('search');
  const bell = useChromeOverlay('notifications');
  const avatar = useChromeOverlay('avatar');
  const [query, setQuery] = useState('');
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>('system');
  useChromeKeys(useCallback(() => useChromeStore.getState().setOverlay('search'), []));
  return (
    <div className="h-[34rem]">
      <SkaterTopBarView
        active="explore"
        onNavigate={navigate}
        onNewReport={newReport}
        search={
          <GlobalSearchView
            open={search.open}
            onOpenChange={(next) => {
              if (!next) setQuery('');
              search.onOpenChange(next);
            }}
            query={query}
            onQueryChange={setQuery}
            groups={fixtureSearch(query)}
            noResultsFor={
              query.trim().length >= 2 && fixtureSearch(query).length === 0 ? query.trim() : null
            }
            onPick={(row) => {
              search.onOpenChange(false);
              navigate(row.href);
            }}
          />
        }
        notifications={
          <NotificationsMenuView
            open={bell.open}
            onOpenChange={bell.onOpenChange}
            unreadCount={3}
            rows={NOTIFICATIONS}
            canLoadMore
            onOpenRow={(row) => {
              bell.onOpenChange(false);
              if (row.href) navigate(row.href);
            }}
            onNavigate={navigate}
          />
        }
        avatar={
          <AvatarMenuView
            open={avatar.open}
            onOpenChange={avatar.onOpenChange}
            person={KATE}
            isModerator={moderator}
            theme={theme}
            onThemeChange={setTheme}
            onNavigate={navigate}
            onSignOut={fn()}
          />
        }
      />
    </div>
  );
}

const overlay = () => useChromeStore.getState().overlay;

/** The keyboard path: Tab across the bar, `/` for search, ↓ and ⏎ to open, Esc out. */
export const KeyboardPath: Story = {
  args: {} as never,
  render: () => <Harness />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const order = [
      c.getByRole('link', { name: 'Gli' }),
      c.getByRole('link', { name: 'Explore' }),
      c.getByRole('link', { name: 'Latest' }),
      c.getByRole('button', { name: 'Search lakes, bays, and skaters' }),
      c.getByRole('button', { name: 'New report' }),
      c.getByRole('button', { name: 'Notifications, 3 unread' }),
      c.getByRole('button', { name: 'Your account' }),
    ];
    for (const el of order) {
      await userEvent.tab();
      await expect(el).toHaveFocus();
    }
    await expect(c.getByRole('link', { name: 'Explore' })).toHaveAttribute('aria-current', 'page');

    // `/` from the page opens search with the field focused; typing filters; ↓ then ⏎ opens a row.
    (document.activeElement as HTMLElement).blur();
    await userEvent.keyboard('/');
    await waitFor(() => expect(overlay()).toBe('search'));
    const field = await c.findByRole('combobox', { name: 'Search lakes, bays, and skaters' });
    await waitFor(() => expect(field).toHaveFocus());
    await userEvent.keyboard('mascoma');
    await waitFor(() =>
      expect(document.querySelector('[data-slot="global-search-plate"]')).not.toBeNull(),
    );
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(navigate).toHaveBeenLastCalledWith('/water/mascoma?sub=north'));
    await waitFor(() => expect(overlay()).toBeNull());

    // Esc closes the plate and hands focus back to the field's trigger.
    await userEvent.keyboard('/');
    await waitFor(() => expect(c.getByRole('combobox')).toHaveFocus());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(overlay()).toBeNull());
    await waitFor(() =>
      expect(c.getByRole('button', { name: 'Search lakes, bays, and skaters' })).toHaveFocus(),
    );

    // One overlay at a time: the avatar's press closes the bell's plate. (While the plate is open
    // its focus trap hides the rest of the bar from a reader, so the avatar is found first.)
    const account = c.getByRole('button', { name: 'Your account' });
    await userEvent.click(c.getByRole('button', { name: 'Notifications, 3 unread' }));
    await waitFor(() => expect(overlay()).toBe('notifications'));
    await userEvent.click(account);
    await waitFor(() => expect(overlay()).toBe('avatar'));
    await waitFor(() => expect(document.querySelector('[data-slot="popover-content"]')).toBeNull());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(overlay()).toBeNull());
    await waitFor(() => expect(account).toHaveFocus());

    // `/` never fires while a field has focus or a modal is over the page.
    await userEvent.click(c.getByRole('button', { name: 'New report' }));
    await expect(newReport).toHaveBeenCalled();
  },
};

/** Bar heights and type against the boards: a 56 px bar, the logo 22 px, the search 460 px wide. */
export const Measures: Story = {
  args: {} as never,
  render: () => <Harness moderator />,
  play: async ({ canvasElement }) => {
    const bar = canvasElement.querySelector<HTMLElement>('[data-slot="skater-top-bar"]');
    await expect(bar?.getBoundingClientRect().height).toBe(56);
    const logo = within(canvasElement)
      .getAllByAltText('Gli')
      .find((i) => i.getBoundingClientRect().height > 0);
    await expect(logo?.getBoundingClientRect().height).toBe(22);
    const search = canvasElement.querySelector<HTMLElement>('[data-slot="global-search"]');
    await expect(search?.getBoundingClientRect().width).toBeLessThanOrEqual(460);
    const primary = within(canvasElement).getByRole('button', { name: 'New report' });
    // Solid ink: the inverted ground.
    await expect(getComputedStyle(primary).backgroundColor).not.toBe(
      getComputedStyle(bar as HTMLElement).backgroundColor,
    );
  },
};

/** Dark and light on the skater surface. */
export const DarkAndLight: Story = {
  args: {} as never,
  globals: { mode: 'light' },
  render: () => (
    <SkaterPair height="4rem">
      {() => (
        <SkaterTopBarView
          active="latest"
          onNavigate={navigate}
          onNewReport={newReport}
          search={
            <GlobalSearchView
              open={false}
              onOpenChange={() => {}}
              query=""
              onQueryChange={() => {}}
              groups={[]}
              onPick={() => {}}
            />
          }
          notifications={
            <NotificationsMenuView
              open={false}
              onOpenChange={() => {}}
              unreadCount={2}
              rows={[]}
              onOpenRow={() => {}}
              onNavigate={() => {}}
            />
          }
          avatar={
            <AvatarMenuView
              open={false}
              onOpenChange={() => {}}
              person={KATE}
              isModerator={false}
              theme="system"
              onThemeChange={() => {}}
              onNavigate={() => {}}
              onSignOut={() => {}}
            />
          }
        />
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const quads = canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]');
    await expect(quads).toHaveLength(2);
    const grounds = [...quads].map((q) => getComputedStyle(q).backgroundColor);
    await expect(new Set(grounds).size).toBe(2);
    for (const q of quads) {
      await expect(within(q).getByRole('link', { name: 'Latest' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      // The right mark per theme: exactly one logo is drawn.
      const drawn = within(q)
        .getAllByAltText('Gli')
        .filter((i) => i.getBoundingClientRect().height > 0);
      await expect(drawn).toHaveLength(1);
    }
  },
};
