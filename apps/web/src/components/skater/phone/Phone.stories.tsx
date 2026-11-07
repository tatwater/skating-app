import type { ThemePreference } from '@skating/design';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { useChromeStore } from '@/stores/chromeStore';

import { must } from '../../kit/storyKit';
import { LakeHeader, type LakeHeaderProps } from '../lake/LakeHeader';
import { LakeSidebar, LakeTabs } from '../lake/LakeSidebar';
import { NotificationsMenuView } from '../NotificationsMenuView';
import { StoryRouter } from '../panels/storyRouter';
import { KATE, type Mode, RESULTS, SkaterPair, StoryRegion } from '../storySupport';
import { LatestPhoneBar } from './LatestPhoneBar';
import { PhoneLakeSheet } from './PhoneLakeDrawer';
import { PhoneMenuSheetView } from './PhoneMenuSheetView';
import { PhoneSearchView } from './PhoneSearchView';
import { PhoneTabBarView } from './PhoneTabBarView';
import { PhoneTopBarView } from './PhoneTopBarView';

/**
 * Row 9: the skater app at 390 × 844. Each story draws a phone's screen in the skater dark / light
 * pair — the screen is its own containing block, so the docked tab bar and the sheets stay inside
 * it — and walks its keyboard path: the a11y rule doesn't relax at a phone's width.
 */
const meta = {
  title: 'Skater/Phone',
  component: PhoneTopBarView,
  globals: { surface: 'skater', mode: 'light' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof PhoneTopBarView>;

export default meta;
type Story = StoryObj<typeof meta>;

const SCREEN_H = '52.75rem';
const noop = () => {};

/** A phone's screen: 390 × 844, a containing block for everything docked inside it. */
function Screen({ children }: { children: (el: HTMLElement | null) => ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  return (
    <div
      ref={setEl}
      data-slot="phone-screen"
      className="relative mx-auto h-[52.75rem] w-[24.375rem] overflow-hidden bg-bg [transform:translateZ(0)]"
    >
      {children(el)}
    </div>
  );
}

/** The chrome around a page: the top bar, the page area between the bars, the tab bar. */
function Chrome({
  active,
  container,
  avatar,
  search,
  onNewReport = noop,
  children,
}: {
  active: 'explore' | 'latest' | null;
  container: HTMLElement | null;
  avatar?: ReactNode;
  search?: ReactNode;
  onNewReport?: () => void;
  children?: ReactNode;
}) {
  return (
    <>
      <PhoneTopBarView
        onNavigate={noop}
        search={
          search ?? (
            <PhoneSearchView
              open={false}
              onOpenChange={noop}
              query=""
              onQueryChange={noop}
              groups={[]}
              onPick={noop}
            />
          )
        }
        notifications={
          <NotificationsMenuView
            open={false}
            onOpenChange={noop}
            unreadCount={2}
            rows={[]}
            onOpenRow={noop}
            onNavigate={noop}
            container={container}
          />
        }
        avatar={
          avatar ?? (
            <PhoneMenuSheetView
              open={false}
              onOpenChange={noop}
              person={KATE}
              isModerator={false}
              theme="system"
              onThemeChange={noop}
              onNavigate={noop}
              onSignOut={noop}
              container={container}
            />
          )
        }
      />
      <div data-slot="phone-page" className="absolute inset-x-0 top-13 bottom-16 overflow-hidden">
        {children}
      </div>
      <PhoneTabBarView active={active} onNavigate={noop} onNewReport={onNewReport} />
    </>
  );
}

const screens = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLElement>('[data-slot="phone-screen"]'),
];

const newReport = fn();

/** 9.1: nothing chosen — the bare map under the chrome; the labels carry what the list did. */
export const ExploreNothingChosen: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height={SCREEN_H}>
      {() => (
        <Screen>
          {(el) => (
            <Chrome active="explore" container={el} onNewReport={newReport}>
              <StoryRegion className="size-full object-cover" />
            </Chrome>
          )}
        </Screen>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const screen = must(screens(canvasElement)[0]);
    const s = within(screen);
    // The bars' measures, from the board: 52 on top, 64 under the thumb, the screen's width.
    const top = must(screen.querySelector<HTMLElement>('[data-slot="phone-top-bar"]'));
    const tabs = must(screen.querySelector<HTMLElement>('[data-slot="phone-tab-bar"]'));
    await expect(top.getBoundingClientRect().height).toBe(52);
    await expect(tabs.getBoundingClientRect().height).toBe(64);
    await expect(tabs.getBoundingClientRect().bottom).toBe(screen.getBoundingClientRect().bottom);
    await expect(s.getByRole('link', { name: 'Explore' })).toHaveAttribute('aria-current', 'page');
    // Only what you can press is rounded; the bars are square.
    await expect(getComputedStyle(tabs).borderRadius).toBe('0px');
    // The keyboard path: logo, search, bell, you, then the tab bar in order.
    await userEvent.tab();
    await expect(s.getByRole('link', { name: 'Gli' })).toHaveFocus();
    await userEvent.tab();
    await expect(s.getByRole('button', { name: 'Search lakes, bays, and skaters' })).toHaveFocus();
    await userEvent.tab();
    await userEvent.tab();
    await expect(s.getByRole('button', { name: 'Your account' })).toHaveFocus();
    await userEvent.tab();
    await expect(s.getByRole('link', { name: 'Explore' })).toHaveFocus();
    await userEvent.tab();
    await expect(s.getByRole('button', { name: 'New report' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(newReport).toHaveBeenCalledTimes(1);
    await userEvent.tab();
    await expect(s.getByRole('link', { name: 'Latest' })).toHaveFocus();
  },
};

const MASCOMA: LakeHeaderProps = {
  kicker: 'Reservoir · NH',
  name: 'Mascoma Lake',
  facts: [
    { kicker: 'Area', value: '1,143', unit: 'ac' },
    { kicker: 'Depth avg / max', value: '31 / 79', unit: 'ft' },
    { kicker: 'Elevation', value: '748', unit: 'ft' },
  ],
  favorite: { on: false, pending: false, onToggle: noop },
  newReport: { href: '/water/mascoma?post=new', onClick: (e) => e.preventDefault() },
  reportHazard: { href: '/water/mascoma?act=hazard', onClick: (e) => e.preventDefault() },
  postBounty: { href: '/water/mascoma?act=bounty', onClick: (e) => e.preventDefault() },
  directions: { href: 'https://maps.google.com', label: 'Directions', onOpen: noop },
};

function LakeScreen() {
  return (
    <StoryRouter>
      <Screen>
        {(el) => (
          <Chrome active="explore" container={el}>
            <StoryRegion className="size-full object-cover" />
            <PhoneLakeSheet label="Mascoma Lake" escapes>
              <LakeSidebar
                label="Mascoma Lake"
                header={<LakeHeader {...MASCOMA} />}
                body={
                  <LakeTabs tab="reports" onTabChange={noop}>
                    {Array.from({ length: 12 }, (_, i) => (
                      <p
                        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows
                        key={i}
                        className="m-0 border-0 border-b border-dotted border-line pb-(--space-4) text-body text-fg1"
                      >
                        Report {i + 1} · Mascoma South · from the Shaker Bridge launch
                      </p>
                    ))}
                  </LakeTabs>
                }
              />
            </PhoneLakeSheet>
          </Chrome>
        )}
      </Screen>
    </StoryRouter>
  );
}

const lakeSheet = (root: ParentNode) =>
  root.querySelector<HTMLElement>('[data-slot="phone-lake-drawer"]');

/**
 * 9.2–9.4: Mascoma in the drawer over the live map — half first, then full under the top bar.
 * The keyboard's way between them is the toggle over the grab bar; Esc steps full → half.
 */
export const LakeDrawer: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height={SCREEN_H}>
      {() => {
        useChromeStore.setState({ phoneDrawerSnap: 'half' });
        return <LakeScreen />;
      }}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const screen = must(screens(canvasElement)[0]);
    const page = must(screen.querySelector<HTMLElement>('[data-slot="phone-page"]'));
    const sheet = await waitFor(() => must(lakeSheet(screen)));
    const visible = () => page.getBoundingClientRect().bottom - sheet.getBoundingClientRect().top;
    // Half: about half the page area, the map above it.
    await waitFor(() => expect(Math.abs(visible() - page.clientHeight / 2)).toBeLessThan(4));
    await expect(getComputedStyle(sheet).borderRadius).toBe('0px');
    const toggle = within(sheet).getByRole('button', { name: 'Show more of Mascoma Lake' });
    toggle.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(Math.abs(visible() - page.clientHeight)).toBeLessThan(4));
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // Esc steps down one rung: full → half.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(useChromeStore.getState().phoneDrawerSnap).toBe('half'));
    await expect(within(sheet).getByRole('button', { name: 'Close Mascoma Lake' })).toBeVisible();
  },
};

/** 9.5: the account sheet over a scrim, a moderator's — Moderation opens the console in a tab. */
export const AccountSheet: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height={SCREEN_H}>
      {(mode) => (
        <Screen>
          {(el) => (
            <Chrome
              active="explore"
              container={el}
              avatar={
                <PhoneMenuSheetView
                  open
                  onOpenChange={noop}
                  person={KATE}
                  isModerator
                  theme={mode}
                  onThemeChange={noop}
                  onNavigate={noop}
                  onSignOut={noop}
                  container={el}
                />
              }
            >
              <StoryRegion className="size-full object-cover" />
            </Chrome>
          )}
        </Screen>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    for (const screen of screens(canvasElement)) {
      const mode = screen.closest<HTMLElement>('[data-mode]')?.dataset.mode as Mode;
      const sheet = await waitFor(() =>
        must(screen.querySelector<HTMLElement>('[data-slot="phone-menu-sheet"]')),
      );
      const s = within(sheet);
      await expect(getComputedStyle(sheet).borderRadius).toBe('0px');
      // Each quad's sheet is modal, so the other quad's reads as hidden: query past that.
      await expect(s.getByRole('link', { name: /Moderation/, hidden: true })).toHaveAttribute(
        'target',
        '_blank',
      );
      await expect(
        s.getByRole('button', { name: mode === 'dark' ? 'Dark' : 'Light', hidden: true }),
      ).toHaveAttribute('aria-pressed', 'true');
      // Thumb-height rows, docked to the screen's foot.
      await expect(
        s.getByRole('link', { name: 'Settings', hidden: true }).getBoundingClientRect().height,
      ).toBe(48);
      await expect(
        Math.abs(sheet.getBoundingClientRect().bottom - screen.getBoundingClientRect().bottom),
      ).toBeLessThan(2);
    }
  },
};

const navigate = fn();

/** 9.5's keyboard: Enter on you opens the sheet, Tab walks it, ←→ choose a theme, Esc returns. */
export const AccountSheetKeyboard: Story = {
  args: {} as never,
  globals: { mode: 'dark' },
  render: function Render() {
    const [open, setOpen] = useState(false);
    const [theme, setTheme] = useState<ThemePreference>('system');
    return (
      <Screen>
        {(el) => (
          <Chrome
            active="latest"
            container={el}
            avatar={
              <PhoneMenuSheetView
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
                onSignOut={noop}
                container={el}
              />
            }
          />
        )}
      </Screen>
    );
  },
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button', { name: 'Your account' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const sheet = await waitFor(() =>
      must(canvasElement.querySelector<HTMLElement>('[data-slot="phone-menu-sheet"]')),
    );
    const s = within(sheet);
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
    const system = s.getByRole('button', { name: 'System' });
    system.focus();
    await userEvent.keyboard('{ArrowRight}');
    const light = s.getByRole('button', { name: 'Light' });
    await waitFor(() => expect(light).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(light).toHaveAttribute('aria-pressed', 'true'));
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(canvasElement.querySelector('[data-slot="phone-menu-sheet"]')).toBeNull(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
    // A row is a link: Enter goes where it says.
    await userEvent.keyboard('{Enter}');
    const again = await waitFor(() =>
      must(canvasElement.querySelector<HTMLElement>('[data-slot="phone-menu-sheet"]')),
    );
    within(again).getByRole('link', { name: 'Settings' }).focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(navigate).toHaveBeenLastCalledWith('/settings'));
  },
};

const picked = fn();

/** 9.6: search takes the screen — Back, the query, Clear; the groups under a full-width rule. */
export const Search: Story = {
  args: {} as never,
  render: function Render() {
    return (
      <SkaterPair height={SCREEN_H}>
        {() => <Screen>{(el) => <SearchScreen container={el} />}</Screen>}
      </SkaterPair>
    );
  },
  play: async ({ canvasElement }) => {
    // Both quads open a modal dialog; whichever opened last holds focus (and hides the other).
    const input = await waitFor(() =>
      must(
        [
          ...canvasElement.querySelectorAll<HTMLInputElement>('[data-slot="phone-search"] input'),
        ].find((i) => i === document.activeElement),
      ),
    );
    await expect(input).toHaveAccessibleName('Search lakes, bays, and skaters');
    const panel = must(input.closest<HTMLElement>('[data-slot="phone-search"]'));
    const screen = must(panel.closest<HTMLElement>('[data-slot="phone-screen"]'));
    const s = within(panel);
    await expect(panel.getBoundingClientRect().width).toBe(screen.getBoundingClientRect().width);
    // 16 px, so a phone never zooms into the field.
    await expect(getComputedStyle(input).fontSize).toBe('16px');
    const rows = panel.querySelectorAll<HTMLElement>('[data-slot="global-search-row"]');
    await expect(must(rows[0]).getBoundingClientRect().height).toBe(56);
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(picked).toHaveBeenCalled());
    await userEvent.click(s.getByRole('button', { name: 'Clear', hidden: true }));
    await expect(input).toHaveValue('');
    await expect(input).toHaveFocus();
  },
};

function SearchScreen({ container }: { container: HTMLElement | null }) {
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState('ma');
  return (
    <Chrome
      active="explore"
      container={container}
      search={
        <PhoneSearchView
          open={open}
          onOpenChange={setOpen}
          query={query}
          onQueryChange={setQuery}
          groups={query === '' ? [] : RESULTS}
          onPick={picked}
          container={container}
        />
      }
    />
  );
}

/**
 * 9.7: Latest's pane switch — Reports, Filters (with how many are on), Wanted. The frame shows the
 * chosen column below `md`; the switch is drawn here at any width.
 */
export const LatestPanes: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="6rem">
      {() => {
        useChromeStore.setState({ latestPhonePane: 'feed' });
        return (
          <div className="mx-auto w-[24.375rem]">
            <LatestPhoneBar filterCount={2} className="px-(--space-4) pt-(--space-3_5) md:block" />
          </div>
        );
      }}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const s = within(must(canvasElement.querySelector<HTMLElement>('[data-mode="dark"]')));
    const reports = s.getByRole('button', { name: 'Reports' });
    await expect(reports).toHaveAttribute('aria-pressed', 'true');
    await expect(s.getByRole('button', { name: /Filters/ })).toHaveTextContent('Filters2');
    // A pressable segment keeps its 2 px corner.
    await expect(getComputedStyle(reports).borderRadius).not.toBe('0px');
    reports.focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(s.getByRole('button', { name: /Filters/ })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(useChromeStore.getState().latestPhonePane).toBe('filters'));
    await userEvent.keyboard('{ArrowRight}{Enter}');
    await waitFor(() => expect(useChromeStore.getState().latestPhonePane).toBe('wanted'));
  },
};
