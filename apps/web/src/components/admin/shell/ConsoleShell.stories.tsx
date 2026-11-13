import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ComponentProps, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { CommandPalette } from '@/components/kit/command-palette';
import { StatusLamp, StatusText } from '@/components/kit/status-bar';
import { must } from '@/components/kit/storyKit';
import { ConsoleShell, ConsoleStatus, ConsoleTopStart } from './ConsoleShell';
import { CONSOLE_MODES, LEGACY_PAGES } from './consoleNav';
import { seasonTape } from './consoleTime';

/** The boards' day: Wednesday 14 October 2026, day 10 of the watch. */
const TAPE = seasonTape(Date.UTC(2026, 9, 14, 16), 'America/New_York');

const onLegacy = fn();
const onPick = fn();

const meta = {
  title: 'Admin/Shell/Console shell',
  component: ConsoleShell,
  tags: ['autodocs'],
  globals: { surface: 'admin' },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The console’s frame (B01), drawn from props: the kit AppShell with the console’s rail — the built modes, then Legacy (a menu of the old pages still standing), the app and the viewer at its foot — the season tape and the search in the top bar, and the page’s status groups, the keys and the connection lamp in the status bar. `ConsoleLayout` is the same frame wired to the router, the role and Convex.',
      },
    },
  },
  args: {
    modes: [],
    legacy: [],
    onLegacy,
    onSearch: fn(),
  },
  beforeEach: () => {
    onLegacy.mockClear();
    onPick.mockClear();
  },
} satisfies Meta<typeof ConsoleShell>;

export default meta;
type Story = StoryObj<typeof meta>;

type Props = Partial<ComponentProps<typeof ConsoleShell>> & { admin?: boolean };

/** A console page: the Overview current, the rail as an admin or a moderator sees it. */
function Console({ admin = true, className = 'h-[56.25rem] w-[90rem]', ...props }: Props) {
  const [palette, setPalette] = useState(false);
  const [query, setQuery] = useState('');
  const legacy = admin
    ? LEGACY_PAGES
    : LEGACY_PAGES.filter(
        (p) =>
          !['/admin/seasons', '/admin/support', '/admin/tuning', '/admin/imports'].includes(p.to),
      );
  return (
    <ConsoleShell
      className={className}
      modes={CONSOLE_MODES.map((m) => ({ ...m, current: m.id === 'overview' }))}
      legacy={legacy}
      onLegacy={onLegacy}
      linkFor={(to) => (
        // biome-ignore lint/a11y/useAnchorContent: the rail item renders its icon and name into it
        <a href={`#${to}`} onClick={(e) => e.preventDefault()} />
      )}
      appHref="#app"
      viewer={{ name: 'Teagan Atwater' }}
      tape={TAPE}
      colleagues={[
        { id: 's', name: 'Sarah Berman', present: true },
        { id: 'm', name: 'Matt Steinberg' },
      ]}
      viewerId="t"
      onSearch={() => setPalette(true)}
      onCommandKey={() => setPalette((o) => !o)}
      lamp={<StatusLamp>Convex live</StatusLamp>}
      overlays={
        <CommandPalette
          hotkey={false}
          open={palette}
          onOpenChange={setPalette}
          query={query}
          onQueryChange={setQuery}
          groups={[
            {
              id: 'places',
              label: 'Go to',
              items: [
                { id: '/admin', label: 'Overview', verb: 'Go' },
                { id: '/admin/flags', label: 'Flags', sub: 'Legacy', verb: 'Go' },
              ],
            },
          ]}
          onSelect={onPick}
        />
      }
      {...props}
    >
      <ConsoleStatus
        groups={[
          <StatusText key="s" tone="bad">
            1 safety
          </StatusText>,
          <StatusText key="c">Pre-ice pass not run</StatusText>,
        ]}
      />
      <ConsoleTopStart>
        <span
          data-testid="page-control"
          className="text-kick font-semibold tracking-kick text-fg3 uppercase"
        >
          Home
        </span>
      </ConsoleTopStart>
      <div className="p-(--space-6)">
        <h1 className="m-0 text-disp font-semibold tracking-disp text-fg uppercase">Overview</h1>
      </div>
    </ConsoleShell>
  );
}

const slot = (root: ParentNode, name: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${name}"]`));
const rail = (root: HTMLElement) => within(root).getByRole('navigation', { name: 'Modes' });

/**
 * The frame as the Overview board draws it: the logo, Overview lit, Legacy under it, the app and
 * the viewer at the foot; the tape centered; the page's status groups split by the strong rule,
 * then the keys and the lamp.
 */
export const Frame: Story = {
  render: () => <Console />,
  play: async ({ canvasElement }) => {
    const modes = rail(canvasElement);
    const overview = within(modes).getByRole('link', { name: /Overview/ });
    await expect(overview).toHaveAttribute('aria-current', 'page');
    await expect(within(modes).getByRole('button', { name: /Legacy/ })).toBeVisible();
    await expect(within(canvasElement).getByRole('link', { name: /App/ })).toHaveAttribute(
      'target',
      '_blank',
    );
    await expect(within(canvasElement).getByRole('img', { name: 'Teagan Atwater' })).toBeVisible();
    await expect(slot(canvasElement, 'shell-top-center')).toHaveTextContent('Winter 2026–27');
    // The page's status, portaled into the bar: two groups, one strong rule between them.
    const status = slot(canvasElement, 'console-status');
    await expect(status.querySelectorAll('[data-slot="status-group"]')).toHaveLength(2);
    await expect(status.querySelectorAll('[data-slot="status-sep"]')).toHaveLength(1);
    await expect(status).toHaveTextContent('1 safety');
    // The page's own top-bar control, portaled to the bar's start.
    await expect(
      within(slot(canvasElement, 'shell-top')).getByTestId('page-control'),
    ).toBeVisible();
    // The keys this page has: G, and no number keys or J/K ever.
    const keys = [...canvasElement.querySelectorAll('[data-slot="status-key"]')].map(
      (k) => k.textContent,
    );
    await expect(keys).toEqual(['Ggo to']);
  },
};

/** Legacy opens the old pages beside the rail; choosing one goes there; Esc gives focus back. */
export const LegacyMenu: Story = {
  render: () => <Console />,
  play: async ({ canvasElement }) => {
    const trigger = within(rail(canvasElement)).getByRole('button', { name: /Legacy/ });
    await userEvent.click(trigger);
    const menu = await within(document.body).findByRole('menu');
    await expect(within(menu).getAllByRole('menuitem')).toHaveLength(LEGACY_PAGES.length);
    // Beside the rail, not over it.
    await expect(menu.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      slot(canvasElement, 'shell-rail').getBoundingClientRect().right - 1,
    );
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(within(document.body).queryByRole('menu')).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
    await userEvent.click(trigger);
    await userEvent.click(
      await within(document.body).findByRole('menuitem', { name: 'Intake review' }),
    );
    await expect(onLegacy).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/admin/water/review' }),
    );
  },
};

/** A moderator's Legacy menu leaves out the admin-only pages. */
export const ModeratorLegacy: Story = {
  render: () => <Console admin={false} />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(rail(canvasElement)).getByRole('button', { name: /Legacy/ }));
    const menu = await within(document.body).findByRole('menu');
    const names = within(menu)
      .getAllByRole('menuitem')
      .map((i) => i.textContent);
    await expect(names).not.toContain('Imports');
    await expect(names).toContain('Ice calibration');
    await userEvent.keyboard('{Escape}');
  },
};

/** G then L opens Legacy; G then O goes to the Overview; the rail wears the letters meanwhile. */
export const GoMode: Story = {
  render: () => <Console />,
  play: async ({ canvasElement }) => {
    const shell = slot(canvasElement, 'app-shell');
    slot(canvasElement, 'shell-main').focus();
    await userEvent.keyboard('g');
    await waitFor(() => expect(shell).toHaveAttribute('data-go'));
    const chips = [...shell.querySelectorAll('[data-slot="rail-go"]')].map((c) => c.textContent);
    await expect(chips).toEqual(['GO', 'GL', 'GA']);
    await userEvent.keyboard('l');
    const menu = await within(document.body).findByRole('menu');
    await expect(await within(menu).findAllByRole('menuitem')).toHaveLength(LEGACY_PAGES.length);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(within(document.body).queryByRole('menu')).toBeNull());
    await expect(shell).not.toHaveAttribute('data-go');
  },
};

/** ⌘K opens the palette from anywhere, and so does the search; Esc closes it. */
export const Palette: Story = {
  render: () => <Console />,
  play: async ({ canvasElement }) => {
    const palette = () => document.querySelector('[data-slot="command-palette"]');
    await userEvent.click(within(canvasElement).getByRole('button', { name: /Jump to a body/ }));
    await waitFor(() => expect(palette()).not.toBeNull());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(palette()).toBeNull());
  },
};

/** The frame in all four maps: the console's dark and light, and the skater maps for contrast. */
export const FourUp: Story = {
  render: () => <Console className="h-[34rem] w-[54rem]" />,
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    const grounds = new Set(
      quads.map((q) => getComputedStyle(slot(q, 'app-shell')).backgroundColor),
    );
    await expect(grounds.size).toBeGreaterThan(1);
  },
};

/** The console's dark map, the founder's default. */
export const Dark: Story = {
  render: () => <Console />,
  globals: { surface: 'admin', mode: 'dark' },
};

/** The console's light map. */
export const Light: Story = {
  render: () => <Console />,
  globals: { surface: 'admin', mode: 'light' },
};
