import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faClockRotateLeft, faGear, faUser, faWater } from '@fortawesome/sharp-regular-svg-icons';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, useEffect, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { Button } from './button';
import {
  type CommandAction,
  type CommandGroup,
  CommandPalette,
  type CommandPaletteProps,
} from './command-palette';
import { Kbd, KbdGroup } from './kbd';
import { computedColor, JUNCTION_TOLERANCE_PX, resolvePx, sameColor, sameShadow } from './measure';
import { closeWithEscape, must, openWith, useQuadOpen } from './storyKit';

const meta = {
  title: 'Kit/CommandPalette',
  component: CommandPalette,
  tags: ['autodocs'],
} satisfies Meta<typeof CommandPalette>;

export default meta;
type Story = StoryObj<typeof meta>;

const body = <FontAwesomeIcon icon={faWater} />;
const person = <FontAwesomeIcon icon={faUser} />;
const mode = <FontAwesomeIcon icon={faGear} />;
const run = <FontAwesomeIcon icon={faClockRotateLeft} />;

const BODY_ACTIONS: CommandAction[] = [
  { id: 'console', label: 'Open in the Body console' },
  { id: 'asks', label: 'Jump to its asks' },
  { id: 'boost', label: 'Set curated boost' },
];

/** What the server holds; the story's search reads it as Convex would. */
const CORPUS: CommandGroup[] = [
  {
    id: 'modes',
    label: 'Modes',
    items: [
      { id: 'm-machinery', label: 'Open Machinery', icon: mode, meta: 'G M' },
      { id: 'm-inbox', label: 'Open Inbox', icon: mode, meta: 'G I' },
      { id: 'm-corpus', label: 'Open Corpus', icon: mode, meta: 'G C' },
    ],
  },
  {
    id: 'bodies',
    label: 'Bodies',
    items: [
      {
        id: 'b-mascoma',
        label: 'Mascoma Lake',
        sub: 'Reservoir · Enfield, NH · 1,143 ac',
        meta: '3 asks · 3 reports',
        metaTone: 'warn',
        icon: body,
        actions: BODY_ACTIONS,
      },
      {
        id: 'b-mascoma-n',
        label: 'Mascoma North',
        sub: 'Bay of Mascoma Lake · 612 ac',
        meta: 'Seeded',
        icon: body,
        actions: BODY_ACTIONS,
      },
      { id: 'b-post', label: 'Post Pond', sub: 'Pond · Lyme, NH', meta: '11:20', icon: body },
      { id: 'b-morey', label: 'Lake Morey', sub: 'Lake · Fairlee, VT', icon: body },
    ],
  },
  {
    id: 'people',
    label: 'People',
    items: [
      {
        id: 'p-pat',
        label: 'Pat Lacasse',
        sub: 'Trusted · 4 reports',
        meta: 'Active',
        icon: person,
      },
    ],
  },
  {
    id: 'runs',
    label: 'Runs',
    items: [
      { id: 'r-weather', label: 'Weather sweep', sub: 'Batch 8/21', meta: '08:31', icon: run },
    ],
  },
];

/** The corpus narrowed to a query, as a server search would hand it back. */
function search(query: string): CommandGroup[] {
  const q = query.trim().toLowerCase();
  return CORPUS.map((g) => ({
    ...g,
    items: g.items.filter((i) => q === '' || i.label.toLowerCase().includes(q)),
  })).filter((g) => g.items.length > 0);
}

/** A server search: results land `delay` ms after the query changes, `loading` meanwhile. */
function useServerSearch(query: string, delay: number) {
  const [groups, setGroups] = useState<CommandGroup[]>(() => search(query));
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (delay === 0) {
      setGroups(search(query));
      return;
    }
    setLoading(true);
    const t = setTimeout(() => {
      setGroups(search(query));
      setLoading(false);
    }, delay);
    return () => clearTimeout(t);
  }, [query, delay]);
  return { groups, loading };
}

const TRIGGER = (
  <Button>
    Go to
    <KbdGroup aria-hidden="true">
      <Kbd>⌘</Kbd>
      <Kbd>K</Kbd>
    </KbdGroup>
  </Button>
);

type PaletteStoryProps = Partial<CommandPaletteProps> & {
  delay?: number;
  initialQuery?: string;
  /** Fixed results (the loading and empty cases); otherwise the story's server search. */
  fixed?: { groups: CommandGroup[]; loading?: boolean };
};

function Palette({ delay = 0, initialQuery = '', fixed, ...props }: PaletteStoryProps) {
  const [query, setQuery] = useState(initialQuery);
  const served = useServerSearch(query, delay);
  const [chosen, setChosen] = useState<string>('Nothing chosen');
  return (
    <div className="flex items-center gap-(--space-4)">
      <CommandPalette
        trigger={TRIGGER}
        query={query}
        onQueryChange={setQuery}
        groups={fixed?.groups ?? served.groups}
        loading={fixed?.loading ?? served.loading}
        onSelect={(item, action) =>
          setChosen(action ? `${item.label} · ${action.label}` : item.label)
        }
        {...props}
      />
      <output data-testid="chosen" className="text-row text-fg2">
        {chosen}
      </output>
    </div>
  );
}

const popup = (root: ParentNode = document) =>
  root.querySelector<HTMLElement>('[data-slot="command-palette"]');
const part = (root: Element, slot: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${slot}"]`));
const rows = (root: Element) => [
  ...root.querySelectorAll<HTMLElement>('[data-slot="command-palette-item"]'),
];
const highlightedRow = (root: Element) =>
  root.querySelector<HTMLElement>('[data-slot="command-palette-item"][data-highlighted]');

/**
 * The trigger is a button that wears ⌘K; pressing it opens the palette with focus in the field and
 * the first row selected. The ice edge marks it a transient mode. Esc closes it and focus comes
 * back; ⌘K opens it from anywhere, and ⌘K again closes it.
 */
export const Default: Story = {
  args: { query: '', onQueryChange: fn(), groups: [], onSelect: fn() },
  render: () => <Palette />,
  play: async ({ canvasElement }) => {
    const trigger = await openWith(canvasElement, /Go to/);
    await expect(trigger).toHaveAttribute('aria-keyshortcuts', 'Meta+K Control+K');
    const pal = await waitFor(() => must(popup()));
    await expect(pal).toHaveAccessibleName('Command palette');
    const field = within(pal).getByRole('combobox', { name: 'Search' });
    await waitFor(() => expect(field).toHaveFocus());
    // The ice edge.
    const style = getComputedStyle(pal);
    await expect(style.borderTopColor).toEqual(sameColor(computedColor(pal, 'var(--acc)')));
    await expect(style.boxShadow).not.toBe('none');
    // Always open: the list is there from the first frame, the first row selected.
    await waitFor(() => expect(within(pal).getByRole('listbox')).toBeVisible());
    await waitFor(() => expect(highlightedRow(pal)).toBe(rows(pal)[0]));
    const note = resolvePx(pal, 'var(--stroke-note)');
    await waitFor(() =>
      expect(getComputedStyle(must(highlightedRow(pal))).boxShadow).toEqual(
        sameShadow({ lengths: [note, 0, 0, 0], inset: true }),
      ),
    );
    // Groups take a kicker.
    const labels = [...pal.querySelectorAll('[data-slot="command-palette-group-label"]')];
    await expect(labels.map((l) => l.textContent)).toEqual(['Modes', 'Bodies', 'People', 'Runs']);
    await expect(getComputedStyle(must(labels[0]?.firstElementChild)).textTransform).toBe(
      'uppercase',
    );

    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(highlightedRow(pal)).toBe(rows(pal)[1]));

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(popup()).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());

    // ⌘K anywhere opens it; ⌘K again closes it.
    await userEvent.keyboard('{Meta>}k{/Meta}');
    await waitFor(() => expect(popup()).not.toBeNull());
    await userEvent.keyboard('{Meta>}k{/Meta}');
    await waitFor(() => expect(popup()).toBeNull());
    // Ctrl K too.
    await userEvent.keyboard('{Control>}k{/Control}');
    await waitFor(() => expect(popup()).not.toBeNull());
    await closeWithEscape(popup);
  },
};

/**
 * Keys only on the selected row: its ⏎ (and ⇥, when it has actions) — every other row's key slot
 * is empty. Moving the selection moves the keys with it.
 */
export const KeysOnTheSelectedRow: Story = {
  args: Default.args,
  render: () => <Palette initialQuery="masc" />,
  play: async ({ canvasElement }) => {
    await openWith(canvasElement, /Go to/);
    const pal = await waitFor(() => must(popup()));
    await waitFor(() => expect(highlightedRow(pal)).toBe(rows(pal)[0]));
    const keysIn = (row: Element) => row.querySelectorAll('[data-slot="command-palette-key"]');
    const [first, second] = rows(pal);
    await expect([...keysIn(must(first))].map((k) => k.textContent)).toEqual(['⏎open', '⇥actions']);
    await expect(keysIn(must(second))).toHaveLength(0);
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(keysIn(must(second))).toHaveLength(2));
    await expect(keysIn(must(first))).toHaveLength(0);
    // The list's caps: only the selected row's (the foot's are outside the list).
    const list = within(pal).getByRole('listbox');
    await expect(list.querySelectorAll('[data-slot="kbd"]')).toHaveLength(2);
    await closeWithEscape(popup);
  },
};

/**
 * ⇥ moves to the selected row's actions: ⇥ lights the first, ⇥ the next, ⇧⇥ back (and from the
 * first, back to the row). ⏎ runs the lit action, and the palette closes. Focus never leaves the
 * field.
 */
export const RowActions: Story = {
  args: Default.args,
  render: () => <Palette initialQuery="masc" />,
  play: async ({ canvasElement }) => {
    await openWith(canvasElement, /Go to/);
    const pal = await waitFor(() => must(popup()));
    const field = within(pal).getByRole('combobox');
    await waitFor(() => expect(highlightedRow(pal)).toBe(rows(pal)[0]));
    const litAction = () =>
      pal.querySelector<HTMLElement>('[data-slot="command-palette-action"][data-lit]');

    await userEvent.tab();
    await expect(field).toHaveFocus();
    await waitFor(() => expect(litAction()).toHaveTextContent('Open in the Body console'));
    // The ⏎ moved onto the lit action; the row's own hints gave way.
    await expect(pal.querySelectorAll('[data-slot="command-palette-key"]')).toHaveLength(0);
    await userEvent.tab();
    await waitFor(() => expect(litAction()).toHaveTextContent('Jump to its asks'));
    await userEvent.tab({ shift: true });
    await waitFor(() => expect(litAction()).toHaveTextContent('Open in the Body console'));
    await userEvent.tab({ shift: true });
    await waitFor(() => expect(litAction()).toBeNull());
    await expect(field).toHaveFocus();

    await userEvent.tab();
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(popup()).toBeNull());
    await expect(within(canvasElement).getByTestId('chosen')).toHaveTextContent(
      'Mascoma Lake · Jump to its asks',
    );

    // A row without actions: ⇥ stays put; ⏎ opens the row itself.
    await openWith(canvasElement, /Go to/);
    const again = await waitFor(() => must(popup()));
    const input = within(again).getByRole('combobox');
    await userEvent.clear(input);
    await userEvent.type(input, 'post');
    await waitFor(() => expect(highlightedRow(again)).toHaveTextContent('Post Pond'));
    await userEvent.tab();
    await expect(again.querySelector('[data-slot="command-palette-action"]')).toBeNull();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(popup()).toBeNull());
    await expect(within(canvasElement).getByTestId('chosen')).toHaveTextContent('Post Pond');
  },
};

/** A press works too: on a row, or on one of its actions once ⇥ shows them. */
export const PointerChoice: Story = {
  args: Default.args,
  render: () => <Palette initialQuery="masc" />,
  play: async ({ canvasElement }) => {
    await openWith(canvasElement, /Go to/);
    const pal = await waitFor(() => must(popup()));
    await waitFor(() => expect(highlightedRow(pal)).toBe(rows(pal)[0]));
    await userEvent.tab();
    const action = await waitFor(() =>
      must(within(pal).getByText('Set curated boost').closest<HTMLElement>('[data-slot]')),
    );
    await userEvent.click(action);
    await waitFor(() => expect(popup()).toBeNull());
    await expect(within(canvasElement).getByTestId('chosen')).toHaveTextContent(
      'Mascoma Lake · Set curated boost',
    );

    await openWith(canvasElement, /Go to/);
    const again = await waitFor(() => must(popup()));
    await userEvent.clear(within(again).getByRole('combobox'));
    await userEvent.click(await within(again).findByText('Open Machinery'));
    await waitFor(() => expect(popup()).toBeNull());
    await expect(within(canvasElement).getByTestId('chosen')).toHaveTextContent('Open Machinery');
  },
};

/**
 * Fed by a server search: typing changes the query, the caller searches and hands back groups —
 * nothing is filtered in the browser. While a search runs over earlier results, they stay and a
 * spinner turns in the field's row. The palette's height never changes: results, loading and
 * empty all fit one fixed region.
 */
export const ServerSearch: Story = {
  args: Default.args,
  render: () => <Palette delay={300} />,
  play: async ({ canvasElement }) => {
    await openWith(canvasElement, /Go to/);
    const pal = await waitFor(() => must(popup()));
    await waitFor(() => expect(getComputedStyle(pal).opacity).toBe('1'));
    const height = pal.getBoundingClientRect().height;
    const busy = part(pal, 'command-palette-busy');
    const field = within(pal).getByRole('combobox');
    await userEvent.type(field, 'mascoma');
    // In flight: the earlier rows stay, the spinner shows.
    await waitFor(() => expect(getComputedStyle(busy).visibility).toBe('visible'));
    await expect(rows(pal).length).toBeGreaterThan(2);
    await expect(pal.getBoundingClientRect().height).toBe(height);
    // Landed.
    await waitFor(() => expect(rows(pal)).toHaveLength(2));
    await waitFor(() => expect(getComputedStyle(busy).visibility).toBe('hidden'));
    await expect(pal.getBoundingClientRect().height).toBe(height);
    await waitFor(() => expect(highlightedRow(pal)).toHaveTextContent('Mascoma Lake'));
    // Nothing matches: the note sits where the rows were; still one height.
    await userEvent.type(field, 'zzz');
    await waitFor(() =>
      expect(part(pal, 'command-palette-note')).toHaveTextContent('Nothing matches'),
    );
    await expect(pal.getBoundingClientRect().height).toBe(height);
    await closeWithEscape(popup);
  },
};

/** Loading with nothing yet: the spinner sits where the rows will land, in the same height. */
export const Loading: Story = {
  args: Default.args,
  render: () => <Palette fixed={{ groups: [], loading: true }} />,
  play: async ({ canvasElement }) => {
    await openWith(canvasElement, /Go to/);
    const pal = await waitFor(() => must(popup()));
    const note = part(pal, 'command-palette-note');
    await expect(note).toHaveAttribute('role', 'status');
    await expect(note).toHaveTextContent('Searching');
    await expect(note.querySelector('svg')).not.toBeNull();
    // The field-row spinner is only for a search over earlier results.
    await expect(getComputedStyle(part(pal, 'command-palette-busy')).visibility).toBe('hidden');
    await closeWithEscape(popup);
  },
};

/** Empty: one quiet line, centered in the reserved region. */
export const Empty: Story = {
  args: Default.args,
  render: () => <Palette fixed={{ groups: [] }} empty="No body, person or run by that name" />,
  play: async ({ canvasElement }) => {
    await openWith(canvasElement, /Go to/);
    const pal = await waitFor(() => must(popup()));
    const note = part(pal, 'command-palette-note');
    await expect(note).toHaveTextContent('No body, person or run by that name');
    const region = part(pal, 'command-palette-region').getBoundingClientRect();
    await expect(region.height).toBeGreaterThan(resolvePx(pal, 'var(--size-td)') * 4);
    await closeWithEscape(popup);
  },
};

/**
 * The junctions: rows are a table row tall; the icon, the group kicker and the field's glyph all
 * start on the gutter; a group's kicker sits `space-1_5` over its first row; the selected row's
 * inset bar is a `stroke-note`.
 */
export const Junctions: Story = {
  args: Default.args,
  render: () => <Palette />,
  play: async ({ canvasElement }) => {
    await openWith(canvasElement, /Go to/);
    const pal = await waitFor(() => must(popup()));
    await waitFor(() => expect(getComputedStyle(pal).opacity).toBe('1'));
    await waitFor(() => expect(highlightedRow(pal)).not.toBeNull());
    const near = (a: number, b: number) =>
      expect(Math.abs(a - b)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    const box = pal.getBoundingClientRect();
    const edge = resolvePx(pal, 'var(--stroke-hair)');
    const gutter = resolvePx(pal, 'var(--gap-gutter)');
    const td = resolvePx(pal, 'var(--size-td)');

    for (const row of rows(pal)) await near(row.getBoundingClientRect().height, td);
    const icon = part(pal, 'command-palette-icon').getBoundingClientRect();
    await near(icon.left - box.left - edge, gutter);
    const glyph = must(
      part(pal, 'command-palette-input').querySelector('svg'),
    ).getBoundingClientRect();
    await near(glyph.left - box.left - edge, gutter);
    const kicker = must(
      part(pal, 'command-palette-group-label').firstElementChild,
    ).getBoundingClientRect();
    await near(kicker.left - box.left - edge, gutter);
    const first = must(rows(pal)[0]).getBoundingClientRect();
    await near(first.top - kicker.bottom, resolvePx(pal, 'var(--space-1_5)'));
    const bar = resolvePx(pal, 'var(--stroke-note)');
    await expect(getComputedStyle(must(highlightedRow(pal))).boxShadow).toEqual(
      sameShadow({ lengths: [bar, 0, 0, 0], inset: true }),
    );
    // Wider than a dialog, and inside the gutter of a narrow frame.
    await expect(box.width).toBeGreaterThan(resolvePx(pal, 'var(--size-sheet-sm)'));
    await expect(box.left).toBeGreaterThanOrEqual(gutter - 1);
    await closeWithEscape(popup);
  },
};

/** Opening fades, and only fades, on `duration-base` — zero under reduced motion. */
export const Motion: Story = {
  args: Default.args,
  render: () => <Palette />,
  play: async ({ canvasElement }) => {
    await openWith(canvasElement, /Go to/);
    const pal = await waitFor(() => must(popup()));
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    await expect(getComputedStyle(pal).transitionProperty).toBe('opacity');
    await expect(getComputedStyle(pal).transitionDuration).toBe(reduce ? '0s' : '0.2s');
    await closeWithEscape(popup);
  },
};

function QuadPalette(): ReactNode {
  const [frame, setFrame] = useState<HTMLElement | null>(null);
  const quad = useQuadOpen(frame);
  const [query, setQuery] = useState('masc');
  return (
    <div ref={setFrame} className="relative h-[24rem] w-full min-w-[30rem]">
      {frame !== null && (
        <CommandPalette
          {...quad}
          hotkey={false}
          modal={false}
          container={frame}
          trigger={<Button>Go to</Button>}
          query={query}
          onQueryChange={setQuery}
          groups={search(query)}
          onSelect={() => {}}
        />
      )}
    </div>
  );
}

/**
 * Open in all four maps, each confined to its quad and non-modal (four focus traps would fight):
 * the console's rows are a shorter table row and its type smaller; each takes its quad's ice.
 */
export const FourUp: Story = {
  args: Default.args,
  render: () => <QuadPalette />,
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) await userEvent.click(within(q).getByRole('button', { name: 'Go to' }));
    const measure = async (q: HTMLElement) => {
      const pal = await waitFor(() => must(popup(q)));
      const row = must(rows(pal)[0]);
      return {
        row: row.getBoundingClientRect().height,
        type: parseFloat(getComputedStyle(row).fontSize),
        edge: getComputedStyle(pal).borderTopColor,
        surface: q.dataset.surface,
      };
    };
    const all = await Promise.all(quads.map(measure));
    const admin = all.filter((m) => m.surface === 'admin');
    const skater = all.filter((m) => m.surface === 'skater');
    await expect(Math.max(...admin.map((m) => m.row))).toBeLessThan(
      Math.min(...skater.map((m) => m.row)),
    );
    await expect(Math.max(...admin.map((m) => m.type))).toBeLessThan(
      Math.min(...skater.map((m) => m.type)),
    );
    await expect(new Set(all.map((m) => m.edge)).size).toBeGreaterThan(1);
  },
};
