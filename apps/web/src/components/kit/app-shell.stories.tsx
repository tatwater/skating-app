import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowUpRightFromSquare,
  faCalendarDays,
  faEngine,
  faInbox,
  faMapLocationDot,
  faMessageLines,
} from '@fortawesome/sharp-light-svg-icons';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Component, type ComponentProps, type ReactNode, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { modKey, type PaneBinding } from '@/lib/keys';

import { AppShell, keyCap, paneHints, ShellRailItem, useShell } from './app-shell';
import { Button } from './button';
import { CommandPalette } from './command-palette';
import { Kbd } from './kbd';
import { type LaneGroup, Lanes } from './lanes';
import { computedColor, JUNCTION_TOLERANCE_PX, resolvePx } from './measure';
import { MiddleList, type MiddleListItem } from './middle-list';
import { RailViewer } from './rail-item';
import { StatusLamp, StatusText, useClaimKey } from './status-bar';
import { must } from './storyKit';
import { ColleagueFaces, SearchTrigger, SeasonTape } from './top-bar-parts';

const meta = {
  title: 'Kit/App shell',
  component: AppShell,
  tags: ['autodocs'],
  globals: { surface: 'admin' },
  args: { rail: null },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Admin only. The console’s frame as one grid: the rail (never collapses, no key of its own), the top bar, main with the lanes, the middle list and the inspector as resizable panes, and the status bar. The keyboard is wired once here: Tab walks the panes, ↑↓ stay inside a pane, a pane’s letters act only while it has focus, ⌘K and ? work anywhere, and G then a letter goes to a mode while the rest of the frame dims. Every region is a slot; these stories fill them with stubs.',
      },
    },
  },
} satisfies Meta<typeof AppShell>;

export default meta;
type Story = StoryObj<typeof meta>;

// ── The stub page ───────────────────────────────────────────────────────────────────────────

const LANES: LaneGroup[] = [
  {
    lanes: [
      { id: 'open', label: 'Open', count: 4, countTone: 'warn' },
      { id: 'mine', label: 'Mine', count: 1 },
    ],
  },
  {
    label: 'Kinds',
    lanes: [
      { id: 'hazards', label: 'Hazards', count: 3 },
      { id: 'reports', label: 'Reports', count: 12 },
      { id: 'photos', label: 'Photos', dim: true },
    ],
  },
];

const ROWS: MiddleListItem[] = [
  { id: 'ridge', title: 'Pressure ridge off the north shore', sub: 'Mascoma Lake', meta: '4 d' },
  { id: 'inlet', title: 'Open water by the inlet', sub: 'Post Pond', meta: '5 d' },
  { id: 'reed', title: 'Reeds frozen in at the launch', sub: 'Lake Morey', meta: '6 d' },
  { id: 'crack', title: 'Crack across the bay', sub: 'Goose Pond', meta: '8 d' },
];

const PALETTE_GROUPS = [
  {
    id: 'bodies',
    label: 'Bodies',
    items: [
      { id: 'mascoma', label: 'Mascoma Lake', sub: 'Enfield, NH' },
      { id: 'post', label: 'Post Pond', sub: 'Lyme, NH' },
    ],
  },
];

/** The inspector stub: Resolve wears its R (so the status bar drops it); Hide's H isn't worn. */
function Inspector({ open, act }: { open: MiddleListItem | undefined; act: (w: string) => void }) {
  useClaimKey('R');
  return (
    <div className="flex flex-col gap-heading p-gutter">
      <h2 className="m-0 text-h font-medium text-fg">{open?.title ?? 'Pick a report'}</h2>
      <div className="flex gap-(--space-2)">
        <Button aria-keyshortcuts="R" onClick={() => act('Resolve')}>
          Resolve <Kbd aria-hidden="true">R</Kbd>
        </Button>
        <Button onClick={() => act('Note')}>Add a note</Button>
      </div>
    </div>
  );
}

/** The middle list: ⏎ opens a row and moves focus to the inspector (the shell's `focusPane`). */
function Queue({ selected, onOpen }: { selected: string | null; onOpen: (id: string) => void }) {
  const { focusPane } = useShell();
  return (
    <MiddleList
      className="flex-1"
      label="Open reports"
      emptyLabel="Nothing open"
      items={ROWS}
      selectedId={selected}
      onOpen={(id) => {
        onOpen(id);
        focusPane('inspector');
      }}
    />
  );
}

const MODES = [
  { key: 'I', name: 'Inbox', icon: faInbox, count: 4, countTone: 'warn' },
  { key: 'R', name: 'Reports', icon: faMessageLines, count: 12 },
  { key: 'B', name: 'Bodies', icon: faMapLocationDot },
  { key: 'S', name: 'Seasons', icon: faCalendarDays },
  { key: 'M', name: 'Machinery', icon: faEngine, count: 1, countTone: 'bad' },
] as const;

type ConsoleProps = Pick<
  ComponentProps<typeof AppShell>,
  'defaultLayout' | 'onLayoutChanged' | 'stacked' | 'className'
>;

/** A console page with every region filled: rail, top bar, lanes, list, inspector, status bar. */
function Console({ className = 'h-[40rem] w-[80rem]', ...props }: ConsoleProps) {
  const [log, setLog] = useState<string[]>([]);
  const [lane, setLane] = useState('open');
  const [selected, setSelected] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [query, setQuery] = useState('');
  const note = (what: string) => setLog((l) => [...l, what]);
  const inspectorKeys: PaneBinding[] = [
    { key: 'R', run: () => note('Resolve'), label: 'Resolve' },
    { key: 'H', run: () => note('Hide'), label: 'Hide' },
    {
      key: 'Shift+Enter',
      run: () => document.querySelector<HTMLElement>('[role="listbox"]')?.focus(),
      label: 'Back to the queue',
    },
  ];
  const go = (to: string) => (event: { preventDefault: () => void }) => {
    event.preventDefault();
    note(`Go ${to}`);
  };
  return (
    <AppShell
      className={className}
      railHead={
        <span className="mb-(--space-2_5) flex h-(--space-8) items-center justify-center text-logo font-extrabold tracking-logo text-fg italic">
          GLI
        </span>
      }
      rail={MODES.map((m) => (
        <ShellRailItem
          key={m.key}
          goKey={m.key}
          name={m.name}
          icon={<FontAwesomeIcon icon={m.icon} />}
          count={'count' in m ? m.count : undefined}
          countTone={'countTone' in m ? m.countTone : undefined}
          current={m.name === 'Inbox'}
          href={`#${m.name.toLowerCase()}`}
          onClick={go(m.name)}
        />
      ))}
      railFoot={
        <>
          <ShellRailItem
            variant="app"
            goKey="A"
            name="App"
            icon={<FontAwesomeIcon icon={faArrowUpRightFromSquare} />}
            href="#app"
            onClick={go('the app')}
          />
          <RailViewer name="Teagan Atwater" />
        </>
      }
      topStart={
        <output
          aria-label="Log"
          className="text-kick font-semibold tracking-kick text-fg3 uppercase"
        >
          {log.join(' · ') || 'Nothing yet'}
        </output>
      }
      topCenter={
        <SeasonTape
          season="Winter 2026–27"
          badge="Day 10"
          ticks={[0.146, 0.288, 0.43, 0.58, 0.712, 0.858]}
          marks={[
            { at: 0.009, kind: 'event', tone: 'acc', title: 'Ice watch opened', detail: '3 Oct' },
            { at: 0.056, kind: 'now', title: 'Today', detail: '14 Oct' },
          ]}
        />
      }
      topEnd={
        <>
          <SearchTrigger onClick={() => setPalette(true)} />
          <ColleagueFaces
            people={[
              { id: 's', name: 'Sarah Berman', present: true },
              { id: 'm', name: 'Matt Steinberg' },
            ]}
          />
        </>
      }
      lanes={<Lanes label="Inbox" groups={LANES} selected={lane} onSelect={setLane} />}
      middle={<Queue selected={selected} onOpen={setSelected} />}
      inspector={<Inspector open={ROWS.find((r) => r.id === selected)} act={note} />}
      paneKeys={{ inspector: inspectorKeys }}
      status={[
        <StatusText key="inbox" tone="warn">
          4 need a person
        </StatusText>,
        <StatusText key="corpus">Corpus 1,204</StatusText>,
      ]}
      pageKeys={[{ keys: 'G', label: 'go to' }]}
      lamp={<StatusLamp>Convex live</StatusLamp>}
      onCommandKey={() => setPalette((o) => !o)}
      onKeySheetKey={() => note('Key sheet')}
      overlays={
        <CommandPalette
          hotkey={false}
          open={palette}
          onOpenChange={(open) => setPalette(open)}
          query={query}
          onQueryChange={setQuery}
          groups={PALETTE_GROUPS}
          onSelect={(item) => note(`Open ${item.label}`)}
        />
      }
      {...props}
    />
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────

const slot = (root: ParentNode, name: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${name}"]`));
const near = (a: number, b: number, tol = JUNCTION_TOLERANCE_PX) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);
const logOf = (root: HTMLElement) => within(root).getByRole('status', { name: 'Log' });
const list = (root: HTMLElement) => within(root).getByRole('listbox', { name: 'Open reports' });
const pane = (root: HTMLElement, name: string) => within(root).getByRole('region', { name });
/** The panes' edges (the status bar's group rule is a separator too, outside main). */
const separators = (root: HTMLElement) =>
  within(slot(root, 'shell-main')).queryAllByRole('separator');
const statusKeys = (root: HTMLElement) =>
  [...slot(root, 'shell-status').querySelectorAll('[data-slot="status-key"]')].map(
    (k) => k.textContent,
  );
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Stories ─────────────────────────────────────────────────────────────────────────────────

/**
 * The frame's measurements: the rail is `size-rail` wide and runs the full height; the top bar is
 * `size-top` (44 px on the console) and the status bar `size-status` (26 px), both beside the rail;
 * main fills between them; the panes start at their column tokens, split by the Resizable's
 * one-pixel hairline.
 */
export const Frame: Story = {
  render: () => <Console />,
  play: async ({ canvasElement }) => {
    const shell = slot(canvasElement, 'app-shell');
    const box = shell.getBoundingClientRect();
    const rail = slot(shell, 'shell-rail').getBoundingClientRect();
    const top = slot(shell, 'shell-top').getBoundingClientRect();
    const main = slot(shell, 'shell-main').getBoundingClientRect();
    const status = slot(shell, 'shell-status').getBoundingClientRect();
    await near(rail.width, resolvePx(shell, 'var(--size-rail)'));
    await near(rail.width, 64);
    await near(rail.height, box.height);
    await near(top.height, resolvePx(shell, 'var(--size-top)'));
    await near(top.height, 44);
    await near(status.height, resolvePx(shell, 'var(--size-status)'));
    await near(status.height, 26);
    for (const r of [top, main, status]) {
      await near(r.left, rail.right);
      await near(r.right, box.right);
    }
    await near(main.top, top.bottom);
    await near(main.bottom, status.top);
    await near(status.bottom, box.bottom);
    // The rail's edge and the top bar's rule: hairlines in `line`.
    const railStyle = getComputedStyle(slot(shell, 'shell-rail'));
    await expect(railStyle.borderRightWidth).toBe('1px');
    await expect(railStyle.borderRightColor).toBe(computedColor(shell, 'var(--line)'));
    await expect(getComputedStyle(slot(shell, 'shell-top')).borderBottomWidth).toBe('1px');
    // The tape is centered on the top bar.
    const tape = slot(shell, 'shell-top-center').getBoundingClientRect();
    await near(tape.left + tape.width / 2, top.left + top.width / 2, 0.5);

    // The panes: lanes and list at their column widths, the inspector the rest; two hairlines.
    const [lanes, middle, inspector] = ['Lanes', 'List', 'Inspector'].map((n) =>
      pane(canvasElement, n).getBoundingClientRect(),
    ) as [DOMRect, DOMRect, DOMRect];
    await near(lanes.width, resolvePx(shell, 'var(--size-lanes)'), 1);
    await near(middle.width, resolvePx(shell, 'var(--size-list)'), 1);
    await expect(inspector.width).toBeGreaterThanOrEqual(resolvePx(shell, 'var(--size-inspector)'));
    const edges = separators(canvasElement);
    await expect(edges).toHaveLength(2);
    for (const edge of edges) {
      await near(edge.getBoundingClientRect().width, 1);
      await expect(getComputedStyle(edge).backgroundColor).toBe(computedColor(edge, 'var(--line)'));
    }
    await near(middle.left - lanes.right, 1);
    await near(inspector.left - middle.right, 1);
    // The rail holds the five modes, then the app item and the viewer at its foot.
    const modes = within(slot(shell, 'shell-modes')).getAllByRole('link');
    await expect(modes).toHaveLength(5);
    await expect(modes[0]).toHaveAttribute('aria-current', 'page');
    await near(
      slot(shell, 'shell-rail-foot').getBoundingClientRect().bottom,
      rail.bottom - resolvePx(shell, 'var(--space-2_5)'),
      1,
    );
  },
};

/**
 * The Tab ring: lanes (one stop) → the separator → the middle list (one stop) → the separator →
 * the inspector; ⇧Tab walks back. ↑↓ stay inside the lanes and inside the list.
 */
export const TabRing: Story = {
  render: () => <Console />,
  play: async ({ canvasElement }) => {
    const lane = within(pane(canvasElement, 'Lanes')).getByRole('button', { name: /Open/ });
    lane.focus();
    await userEvent.keyboard('{ArrowDown}');
    await expect(
      within(pane(canvasElement, 'Lanes')).getByRole('button', { name: /Mine/ }),
    ).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    await expect(lane).toHaveFocus();
    const [first, second] = separators(canvasElement) as [HTMLElement, HTMLElement];
    await userEvent.tab();
    await expect(first).toHaveFocus();
    await userEvent.tab();
    const box = list(canvasElement);
    await expect(box).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    await expect(box).toHaveFocus();
    await userEvent.tab();
    await expect(second).toHaveFocus();
    await userEvent.tab();
    const resolve = within(pane(canvasElement, 'Inspector')).getByRole('button', {
      name: /Resolve/,
    });
    await expect(resolve).toHaveFocus();
    await userEvent.tab({ shift: true });
    await expect(second).toHaveFocus();
    await userEvent.tab({ shift: true });
    await expect(box).toHaveFocus();
    // ⏎ opens the row and moves focus into the inspector.
    await userEvent.keyboard('{Enter}');
    await expect(pane(canvasElement, 'Inspector')).toHaveFocus();
    await expect(within(pane(canvasElement, 'Inspector')).getByRole('heading')).toHaveTextContent(
      'Reeds frozen in',
    );
  },
};

/**
 * Keys by focus: the inspector's letters act only there, and while it has focus the status bar
 * lists its keys first — H and ⇧⏎, but not R, which the Resolve button already wears. In the list
 * the same letters are type-ahead, and the inspector's keys leave the bar.
 */
export const PaneKeys: Story = {
  render: () => <Console />,
  play: async ({ canvasElement }) => {
    const inspector = pane(canvasElement, 'Inspector');
    await expect(statusKeys(canvasElement)).toEqual([
      'Tabpanels',
      '↑↓move',
      'A–Ztype to jump',
      'Ggo to',
    ]);
    inspector.focus();
    await waitFor(() =>
      expect(statusKeys(canvasElement)).toEqual([
        'Hhide',
        '⇧⏎back to the queue',
        'Tabpanels',
        '↑↓move',
        'A–Ztype to jump',
        'Ggo to',
      ]),
    );
    await userEvent.keyboard('h');
    await expect(logOf(canvasElement)).toHaveTextContent('Hide');
    await userEvent.keyboard('r');
    await expect(logOf(canvasElement)).toHaveTextContent('Hide · Resolve');
    // ⇧⏎ back to the queue; there H is type-ahead and acts on nothing.
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    await expect(list(canvasElement)).toHaveFocus();
    await waitFor(() => expect(statusKeys(canvasElement)).not.toContain('Hhide'));
    await userEvent.keyboard('h');
    await expect(logOf(canvasElement)).toHaveTextContent(/^Hide · Resolve$/);
  },
};

/**
 * G then a letter: the go bar comes up at the bottom center, the rail wears its letters, and the
 * rest of the frame — top bar, main, status bar — steps back to the dim opacity. B presses Bodies'
 * link (as a click would), and the frame comes back.
 */
export const GoMode: Story = {
  render: () => <Console />,
  play: async ({ canvasElement }) => {
    const shell = slot(canvasElement, 'app-shell');
    const bar = slot(shell, 'go-bar');
    list(canvasElement).focus();
    await userEvent.keyboard('g');
    await waitFor(() => expect(bar).toHaveAttribute('data-open'));
    await expect(shell).toHaveAttribute('data-go');
    await expect(bar).toHaveTextContent('like I to open Inbox');
    const dim = getComputedStyle(shell).getPropertyValue('--opacity-dim').trim();
    for (const name of [
      'shell-main',
      'shell-status',
      'shell-top-center',
      'shell-top-end',
      'shell-top-start',
    ]) {
      await waitFor(() => expect(getComputedStyle(slot(shell, name)).opacity).toBe(dim));
    }
    await expect(getComputedStyle(slot(shell, 'shell-rail')).opacity).toBe('1');
    await expect(shell.querySelectorAll('[data-slot="rail-go"]')).toHaveLength(6);
    // The bar floats the status bar's height plus `space-4_5` over the frame's foot, centered.
    const box = shell.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    await near(
      box.bottom - b.bottom,
      resolvePx(shell, 'calc(var(--size-status) + var(--space-4_5))'),
    );
    await near(b.left + b.width / 2, box.left + box.width / 2, 0.5);

    await userEvent.keyboard('b');
    await expect(logOf(canvasElement)).toHaveTextContent('Go Bodies');
    await expect(bar).not.toHaveAttribute('data-open');
    await expect(shell).not.toHaveAttribute('data-go');
    await waitFor(() => expect(getComputedStyle(slot(shell, 'shell-main')).opacity).toBe('1'));
    // The app item is reachable too.
    await userEvent.keyboard('ga');
    await expect(logOf(canvasElement)).toHaveTextContent('Go Bodies · Go the app');
  },
};

/**
 * ⌘K from anywhere reaches the palette — from the list, from a text field in it — and toggles it;
 * Esc closes it. `?` reaches the key sheet. The palette's own hotkey is off, so ⌘K has one owner.
 */
export const CommandKey: Story = {
  render: () => <Console />,
  play: async ({ canvasElement }) => {
    const mod = modKey();
    const palette = () => document.querySelector('[data-slot="command-palette"]');
    list(canvasElement).focus();
    await userEvent.keyboard(`{${mod}>}k{/${mod}}`);
    await waitFor(() => expect(palette()).not.toBeNull());
    await userEvent.keyboard(`{${mod}>}k{/${mod}}`);
    await waitFor(() => expect(palette()).toBeNull());
    await userEvent.click(within(canvasElement).getByRole('button', { name: /Jump to a body/ }));
    await waitFor(() => expect(palette()).not.toBeNull());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(palette()).toBeNull());
    pane(canvasElement, 'Inspector').focus();
    await userEvent.keyboard('?');
    await expect(logOf(canvasElement)).toHaveTextContent('Key sheet');
  },
};

/**
 * Resizing: a persisted `defaultLayout` sets the panes' widths before anything paints, and only
 * the operator's resize — here from the keyboard — reports the new layout, once, through
 * `onLayoutChanged`, keyed by the panes on the page. Mounting reports nothing.
 */
export const Resize: Story = {
  args: { onLayoutChanged: fn() },
  render: (args) => (
    <Console
      defaultLayout={{ lanes: 20, middle: 30, inspector: 50 }}
      onLayoutChanged={args.onLayoutChanged}
    />
  ),
  play: async ({ canvasElement, args }) => {
    const group = slot(canvasElement, 'shell-panes').getBoundingClientRect();
    const lanes = pane(canvasElement, 'Lanes').getBoundingClientRect();
    const middle = pane(canvasElement, 'List').getBoundingClientRect();
    await near(lanes.width / group.width, 0.2, 0.01);
    await near(middle.width / group.width, 0.3, 0.01);
    const [first] = separators(canvasElement) as [HTMLElement];
    first.focus();
    // The group's own first layout isn't the operator's: nothing is reported for it.
    await pause(50);
    await expect(args.onLayoutChanged).not.toHaveBeenCalled();
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(args.onLayoutChanged).toHaveBeenCalledTimes(1));
    const [layout] = (args.onLayoutChanged as ReturnType<typeof fn>).mock.calls[0] as [
      Record<string, number>,
    ];
    await expect(Object.keys(layout).sort()).toEqual(['inspector', 'lanes', 'middle']);
    const lanesShare = must(layout.lanes);
    await expect(lanesShare).toBeGreaterThan(20);
    await near(
      pane(canvasElement, 'Lanes').getBoundingClientRect().width / group.width,
      lanesShare / 100,
      0.01,
    );
  },
};

/**
 * Narrower than `lg` the panes stack — no separators — each a screen tall, and main
 * scrolls through them. The Tab order is the same.
 */
export const Stacked: Story = {
  render: () => <Console className="h-[40rem] w-[48rem]" />,
  play: async ({ canvasElement }) => {
    const shell = slot(canvasElement, 'app-shell');
    await waitFor(() => expect(shell).toHaveAttribute('data-stacked'));
    await expect(separators(canvasElement)).toHaveLength(0);
    const main = slot(shell, 'shell-main');
    const [lanes, middle, inspector] = ['Lanes', 'List', 'Inspector'].map((n) =>
      pane(canvasElement, n).getBoundingClientRect(),
    ) as [DOMRect, DOMRect, DOMRect];
    await near(lanes.width, main.clientWidth);
    await near(lanes.height, main.clientHeight);
    await near(middle.top, lanes.bottom);
    await near(inspector.top, middle.bottom);
    await expect(main.scrollHeight).toBeGreaterThan(main.clientHeight);
    within(pane(canvasElement, 'Lanes')).getByRole('button', { name: /Open/ }).focus();
    await userEvent.tab();
    await expect(list(canvasElement)).toHaveFocus();
  },
};

/** A shell whose width F2 toggles across `lg`, from wherever focus is. */
function Resizing() {
  const [wide, setWide] = useState(true);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a test harness hears F2 bubble up from the shell
    <div
      onKeyDown={(event) => {
        if (event.key === 'F2') setWide((w) => !w);
      }}
    >
      <AppShell
        className={wide ? 'h-[40rem] w-[80rem]' : 'h-[40rem] w-[48rem]'}
        rail={null}
        lanes={<p className="m-0 p-gutter text-row text-fg2">Lanes</p>}
        middle={<p className="m-0 p-gutter text-row text-fg2">List</p>}
        inspector={
          <textarea aria-label="Note" className="m-gutter text-row text-fg" defaultValue="" />
        }
      />
    </div>
  );
}

/**
 * Crossing `lg` re-lays the panes without remounting them: a half-typed note in the inspector
 * (uncontrolled, so only the DOM holds it) keeps its text and its focus as the panes stack, and
 * again as they group back up.
 */
export const ResizeKeepsDrafts: Story = {
  render: () => <Resizing />,
  play: async ({ canvasElement }) => {
    const shell = slot(canvasElement, 'app-shell');
    const note = within(canvasElement).getByRole('textbox', { name: 'Note' });
    await userEvent.click(note);
    await userEvent.keyboard('Ridge reported twice');
    await userEvent.keyboard('{F2}');
    await waitFor(() => expect(shell).toHaveAttribute('data-stacked'));
    await expect(separators(canvasElement)).toHaveLength(0);
    await expect(within(canvasElement).getByRole('textbox', { name: 'Note' })).toBe(note);
    await expect(note).toHaveValue('Ridge reported twice');
    await expect(note).toHaveFocus();
    await userEvent.keyboard('{F2}');
    await waitFor(() => expect(shell).not.toHaveAttribute('data-stacked'));
    await expect(separators(canvasElement)).toHaveLength(2);
    await expect(within(canvasElement).getByRole('textbox', { name: 'Note' })).toBe(note);
    await expect(note).toHaveValue('Ridge reported twice');
    await expect(note).toHaveFocus();
    // Grouped again, the panes are back at their column widths.
    await near(
      pane(canvasElement, 'Lanes').getBoundingClientRect().width,
      resolvePx(shell, 'var(--size-lanes)'),
      1,
    );
  },
};

/** The same width, with `stacked={false}`: the prop wins over the measured width. */
export const StackedOverridden: Story = {
  render: () => <Console className="h-[40rem] w-[48rem]" stacked={false} />,
  play: async ({ canvasElement }) => {
    await pause(50);
    await expect(slot(canvasElement, 'app-shell')).not.toHaveAttribute('data-stacked');
    await expect(separators(canvasElement)).toHaveLength(2);
  },
};

/** A page without panes: main holds the page's own content. */
export const WithoutPanes: Story = {
  render: () => (
    <AppShell className="h-[24rem] w-[64rem]" rail={null}>
      <p data-testid="page" className="m-0 p-gutter text-row text-fg2">
        Cost ledger · Winter 2026–27
      </p>
    </AppShell>
  ),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByTestId('page')).toBeVisible();
    await expect(separators(canvasElement)).toHaveLength(0);
    await expect(statusKeys(canvasElement)).toEqual([]);
  },
};

const darkLight = async (canvasElement: HTMLElement) => {
  const shell = slot(canvasElement, 'app-shell');
  await expect(getComputedStyle(shell).backgroundColor).toBe(computedColor(shell, 'var(--bg)'));
  await expect(getComputedStyle(slot(shell, 'shell-rail')).borderRightColor).toBe(
    computedColor(shell, 'var(--line)'),
  );
};

/** The frame in the console's dark map. */
export const Dark: Story = {
  render: () => <Console />,
  globals: { surface: 'admin', mode: 'dark' },
  play: ({ canvasElement }) => darkLight(canvasElement),
};

/** The frame in the console's light map. */
export const Light: Story = {
  render: () => <Console />,
  globals: { surface: 'admin', mode: 'light' },
  play: ({ canvasElement }) => darkLight(canvasElement),
};

/** The status bar's caps for pane keys: modifiers as glyphs, Mod per platform; unlabeled keys stay out. */
export const KeyCaps: Story = {
  render: () => (
    <Boundary>
      <Orphan />
    </Boundary>
  ),
  play: async ({ canvasElement }) => {
    await expect(keyCap('Shift+Enter')).toBe('⇧⏎');
    await expect(keyCap('Mod+Enter', 'Meta')).toBe('⌘⏎');
    await expect(keyCap('Mod+Enter', 'Control')).toBe('Ctrl ⏎');
    await expect(keyCap('Escape')).toBe('Esc');
    await expect(keyCap('Delete')).toBe('Del');
    await expect(keyCap('Backspace')).toBe('⌫');
    await expect(keyCap('Shift+H')).toBe('⇧H');
    await expect(
      paneHints([
        { key: 'R', run: () => {}, label: 'Resolve' },
        { key: 'H', run: () => {} },
      ]),
    ).toEqual([{ keys: 'R', label: 'resolve' }]);
    // useShell outside a shell is a bug worth hearing about.
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent(
      'useShell needs an <AppShell> above it.',
    );
  },
};

function Orphan() {
  useShell();
  return null;
}

class Boundary extends Component<{ children: ReactNode }, { error: string | null }> {
  override state = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  override render() {
    return this.state.error === null ? this.props.children : <p role="alert">{this.state.error}</p>;
  }
}
