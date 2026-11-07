import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { Badge } from './badge';
import { computedColor, JUNCTION_TOLERANCE_PX, resolvePx } from './measure';
import { MiddleList, type MiddleListItem, type MiddleListProps } from './middle-list';
import { KICKER, must } from './storyKit';

const meta = {
  title: 'Kit/MiddleList',
  component: MiddleList,
  tags: ['autodocs'],
} satisfies Meta<typeof MiddleList>;

export default meta;
type Story = StoryObj<typeof meta>;

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────

const OPEN: MiddleListItem[] = [
  {
    id: 'ridge',
    title: 'Pressure ridge off the north shore',
    sub: 'Mascoma Lake · by Rob Tremblay',
    meta: '4 d',
    chips: <Badge variant="outline">Hazard</Badge>,
  },
  {
    id: 'inlet',
    title: 'Open water by the inlet',
    sub: 'Post Pond · by Dana Whitlock',
    meta: '5 d',
    chips: <Badge variant="outline">Report</Badge>,
  },
  {
    id: 'narrows',
    title: 'Thin ice at the narrows',
    sub: 'Lake Morey · Sarah Berman has it',
    meta: '6 d',
    locked: true,
  },
  {
    id: 'crack',
    title: 'Pressure crack in the bay',
    sub: 'Goose Pond · by Pat Lacasse',
    meta: '8 d',
  },
];

const DECIDED = {
  label: 'Decided this week',
  items: [
    {
      id: 'slush',
      title: 'Slush over the ice',
      sub: 'Crystal Lake · Matt hid the report',
      meta: '3 d',
    },
    {
      id: 'hole',
      title: 'Hole by the boat launch',
      sub: 'Mascoma Lake · Sarah dismissed it',
      meta: '5 d',
    },
  ],
} satisfies MiddleListProps['decided'];

/**
 * A console column: the list's bar, the list, and a stub right pane that opening a row focuses —
 * the handoff R3 asks for (⏎ or Space opens and moves focus right).
 */
function Console({
  items = OPEN,
  decided = DECIDED,
  initial = null,
  height = '26rem',
  onOpen,
  ...props
}: Omit<Partial<MiddleListProps>, 'decided'> & {
  /** The decided list; `null` for none. */
  decided?: MiddleListProps['decided'] | null;
  initial?: string | null;
  height?: string;
}) {
  const [selected, setSelected] = useState<string | null>(initial);
  const pane = useRef<HTMLElement>(null);
  const all = [...items, ...(decided?.items ?? [])];
  const open = all.find((i) => i.id === selected);
  return (
    <div className="flex w-[40rem] border border-solid border-line" style={{ height }}>
      <div className="flex h-full w-list shrink-0 flex-col border-0 border-r border-solid border-line">
        <div
          data-slot="bar"
          className={`flex h-btn shrink-0 items-center border-0 border-b border-solid border-line px-gutter ${KICKER}`}
        >
          Open
        </div>
        <MiddleList
          className="flex-1"
          label="Open reports"
          emptyLabel="Nothing open"
          items={items}
          decided={decided ?? undefined}
          selectedId={selected}
          onOpen={(id) => {
            setSelected(id);
            onOpen?.(id);
            pane.current?.focus();
          }}
          {...props}
        />
      </div>
      <section
        ref={pane}
        tabIndex={-1}
        aria-label="Detail"
        data-slot="detail"
        className="flex-1 p-gutter text-row text-fg2 outline-none focus-visible:shadow-[inset_0_0_0_var(--stroke-hair)_var(--fg)]"
      >
        {open?.title ?? 'Pick a report'}
      </section>
    </div>
  );
}

const listbox = (root: HTMLElement) => within(root).getByRole('listbox', { name: 'Open reports' });
const row = (root: HTMLElement, name: string | RegExp) =>
  within(root).getByRole('option', { name });
const activeRow = (box: HTMLElement) => {
  const id = box.getAttribute('aria-activedescendant');
  return id === null ? null : document.getElementById(id);
};
const near = (a: number, b: number, tol = JUNCTION_TOLERANCE_PX) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Behavior ────────────────────────────────────────────────────────────────────────────────

/**
 * The queue column. Tab lands on the list (one stop); ↑↓ move the cursor and skip the locked row;
 * ⏎ opens the row and hands focus to the right pane; Shift+Tab comes back to the same row.
 */
export const Default: Story = {
  args: { label: 'Open reports', items: OPEN, emptyLabel: 'Nothing open', onOpen: fn() },
  render: (args) => <Console onOpen={args.onOpen} />,
  play: async ({ canvasElement, args }) => {
    const box = listbox(canvasElement);
    await expect(within(box).getAllByRole('option')).toHaveLength(6);
    await expect(row(canvasElement, /Thin ice/)).toHaveAttribute('aria-disabled', 'true');
    // One Tab stop: the list itself, with its cursor on the first row.
    await userEvent.tab();
    await expect(box).toHaveFocus();
    await expect(activeRow(box)).toBe(row(canvasElement, /Pressure ridge/));
    await userEvent.keyboard('{ArrowDown}');
    await expect(activeRow(box)).toBe(row(canvasElement, /Open water/));
    // The locked row is passed by.
    await userEvent.keyboard('{ArrowDown}');
    await expect(activeRow(box)).toBe(row(canvasElement, /Pressure crack/));
    // ↓ runs straight on into the decided list.
    await userEvent.keyboard('{ArrowDown}');
    await expect(activeRow(box)).toBe(row(canvasElement, /Slush/));
    await userEvent.keyboard('{End}');
    await expect(activeRow(box)).toBe(row(canvasElement, /Hole by/));
    await userEvent.keyboard('{ArrowDown}');
    await expect(activeRow(box)).toBe(row(canvasElement, /Hole by/));
    await userEvent.keyboard('{Home}');
    await expect(activeRow(box)).toBe(row(canvasElement, /Pressure ridge/));
    await userEvent.keyboard('{ArrowUp}');
    await expect(activeRow(box)).toBe(row(canvasElement, /Pressure ridge/));
    // ⏎ opens, and focus moves to the right pane.
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await expect(args.onOpen).toHaveBeenCalledWith('inlet');
    const detail = within(canvasElement).getByRole('region', { name: 'Detail' });
    await expect(detail).toHaveFocus();
    await expect(detail).toHaveTextContent('Open water by the inlet');
    await expect(row(canvasElement, /Open water/)).toHaveAttribute('aria-selected', 'true');
    // Back to the list: the cursor is where it was.
    await userEvent.tab({ shift: true });
    await expect(box).toHaveFocus();
    await expect(activeRow(box)).toBe(row(canvasElement, /Open water/));
    // Space opens too.
    await userEvent.keyboard('{ArrowDown}{ArrowDown} ');
    await expect(args.onOpen).toHaveBeenLastCalledWith('slush');
    await expect(detail).toHaveFocus();
  },
};

/** A press opens a row; a press on the locked row does nothing. */
export const Press: Story = {
  ...Default,
  play: async ({ canvasElement, args }) => {
    await userEvent.click(row(canvasElement, /Thin ice/));
    await expect(args.onOpen).not.toHaveBeenCalled();
    await userEvent.click(row(canvasElement, /Pressure crack/));
    await expect(args.onOpen).toHaveBeenCalledWith('crack');
    await expect(within(canvasElement).getByRole('region', { name: 'Detail' })).toHaveFocus();
  },
};

/**
 * A press far down a scrolled list, while the list doesn't have focus, opens that row: focusing
 * the list on the press doesn't scroll it back up to the first row from under the pointer.
 */
export const PressFarDown: Story = {
  ...Default,
  render: (args) => <Console onOpen={args.onOpen} height="12rem" />,
  play: async ({ canvasElement, args }) => {
    const box = listbox(canvasElement);
    box.scrollTop = box.scrollHeight;
    await waitFor(() => expect(box.scrollTop).toBeGreaterThan(0));
    const scrolled = box.scrollTop;
    await userEvent.click(row(canvasElement, /Hole by/));
    await expect(args.onOpen).toHaveBeenCalledWith('hole');
    await expect(box.scrollTop).toBe(scrolled);
  },
};

/**
 * Focus with a row already open: the cursor starts on it. A row that's open but locked (claimed
 * meanwhile) can't hold the cursor, so it starts on the first open row instead.
 */
export const CursorStartsOnTheOpenRow: Story = {
  ...Default,
  render: (args) => <Console onOpen={args.onOpen} initial="crack" />,
  play: async ({ canvasElement }) => {
    const box = listbox(canvasElement);
    await userEvent.tab();
    await expect(activeRow(box)).toBe(row(canvasElement, /Pressure crack/));
  },
};

export const CursorSkipsALockedOpenRow: Story = {
  ...Default,
  render: (args) => <Console onOpen={args.onOpen} initial="narrows" />,
  play: async ({ canvasElement }) => {
    const box = listbox(canvasElement);
    await userEvent.tab();
    await expect(activeRow(box)).toBe(row(canvasElement, /Pressure ridge/));
  },
};

/**
 * Typing jumps: a run of letters finds the first row that starts with them; one letter again and
 * again steps through the rows that start with it. The locked row is never a match. `G` and `?`
 * aren't type-ahead unless a run is already under way — they belong to go-mode and the key sheet.
 */
export const TypeAhead: Story = {
  ...Default,
  play: async ({ canvasElement, args }) => {
    const box = listbox(canvasElement);
    await userEvent.tab();
    await userEvent.keyboard('o');
    await expect(activeRow(box)).toBe(row(canvasElement, /Open water/));
    await pause(600);
    await userEvent.keyboard('pp');
    await expect(activeRow(box)).toBe(row(canvasElement, /Pressure ridge/));
    await userEvent.keyboard('p');
    await expect(activeRow(box)).toBe(row(canvasElement, /Pressure crack/));
    await pause(600);
    // A longer run matches from the cursor on.
    await userEvent.keyboard('hole');
    await expect(activeRow(box)).toBe(row(canvasElement, /Hole by/));
    await pause(600);
    // Only the locked row starts with T: the cursor stays.
    await userEvent.keyboard('t');
    await expect(activeRow(box)).toBe(row(canvasElement, /Hole by/));
    await pause(600);
    // G isn't type-ahead at the start of a run…
    await userEvent.keyboard('g');
    await expect(activeRow(box)).toBe(row(canvasElement, /Hole by/));
    // …and Space inside a run is a letter, not "open".
    await userEvent.keyboard('s');
    await expect(activeRow(box)).toBe(row(canvasElement, /Slush/));
    await userEvent.keyboard('lush over');
    await expect(activeRow(box)).toBe(row(canvasElement, /Slush/));
    await expect(args.onOpen).not.toHaveBeenCalled();
    // A modified key is the page's (a shortcut), never type-ahead.
    await pause(600);
    await userEvent.keyboard('{Alt>}o{/Alt}');
    await expect(activeRow(box)).toBe(row(canvasElement, /Slush/));
  },
};

/**
 * A wash only where a press does something (R3#3). The keyboard cursor wears the hover look (one
 * look, as every console control); the open row wears the selection wash and the white rule; the
 * locked row is half opacity with no wash at all.
 */
export const Washes: Story = {
  ...Default,
  render: (args) => <Console onOpen={args.onOpen} initial="crack" />,
  play: async ({ canvasElement }) => {
    const box = listbox(canvasElement);
    const lift05 = computedColor(box, 'var(--lift-05)');
    const lift08 = computedColor(box, 'var(--lift-08)');
    const fg = computedColor(box, 'var(--fg)');
    const fg1 = computedColor(box, 'var(--fg1)');
    const ridge = row(canvasElement, /Pressure ridge/);
    const crack = row(canvasElement, /Pressure crack/);
    const narrows = row(canvasElement, /Thin ice/);
    // At rest (unfocused): only the open row is washed.
    await expect(getComputedStyle(ridge).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    await waitFor(() => expect(getComputedStyle(crack).backgroundColor).toBe(lift08));
    const rule = resolvePx(box, 'var(--stroke-note)');
    await expect(getComputedStyle(crack).boxShadow).toContain(`${rule}px 0px 0px 0px`);
    await expect(getComputedStyle(crack).boxShadow).toContain(fg);
    const title = (el: HTMLElement) =>
      must(el.querySelector<HTMLElement>('[data-slot="middle-list-title"]'));
    await expect(getComputedStyle(title(crack)).color).toBe(fg);
    await expect(getComputedStyle(title(ridge)).color).toBe(fg1);
    // Focused: the cursor row takes the hover look; the open row keeps its own.
    await userEvent.click(within(canvasElement).getByRole('region', { name: 'Detail' }));
    await userEvent.tab({ shift: true });
    await userEvent.keyboard('{Home}');
    await waitFor(() => expect(getComputedStyle(ridge).backgroundColor).toBe(lift05));
    await expect(getComputedStyle(crack).backgroundColor).toBe(lift08);
    // On the open row, the cursor doesn't dim the selection.
    await userEvent.keyboard('{End}{ArrowUp}{ArrowUp}');
    await expect(activeRow(box)).toBe(crack);
    await waitFor(() => expect(getComputedStyle(crack).backgroundColor).toBe(lift08));
    // Locked: half opacity, readable, no wash ever — and no hover rule at all.
    await expect(getComputedStyle(narrows).opacity).toBe(
      String(parseFloat(resolveOpacity(box, '--opacity-muted'))),
    );
    await expect(getComputedStyle(narrows).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    await expect(narrows.className).not.toMatch(/hover:/);
    await expect(ridge.className).toMatch(/hover:bg-lift-05/);
    await expect(narrows).toBeVisible();
  },
};

/** A custom property's value in `scope`. */
function resolveOpacity(scope: Element, name: string): string {
  return getComputedStyle(scope).getPropertyValue(name).trim();
}

/**
 * Keys the list uses never reach the page: an arrow, a type-ahead letter, ⏎ — a listener on the
 * document never hears them. A key it doesn't use (Tab, a ⌘ shortcut, G at the start) goes on.
 */
export const KeysStayInTheList: Story = {
  ...Default,
  play: async ({ canvasElement }) => {
    const heard: string[] = [];
    const listen = (e: KeyboardEvent) => heard.push(e.key);
    await userEvent.tab();
    document.addEventListener('keydown', listen);
    try {
      await userEvent.keyboard('{ArrowDown}{ArrowUp}{Home}{End}o');
      await expect(heard).toEqual([]);
      await pause(600);
      await userEvent.keyboard('g');
      await expect(heard).toEqual(['g']);
    } finally {
      document.removeEventListener('keydown', listen);
    }
    await expect(listbox(canvasElement)).toHaveFocus();
  },
};

// ── States ──────────────────────────────────────────────────────────────────────────────────

/**
 * Empty keeps its name: the list is still "Open reports" to a reader, and its end tab says what
 * is empty ("Nothing open"), `space-0_5` under the bar. The decided list still follows.
 */
export const Empty: Story = {
  ...Default,
  render: (args) => <Console onOpen={args.onOpen} items={[]} />,
  play: async ({ canvasElement }) => {
    const box = listbox(canvasElement);
    await expect(box).toHaveAccessibleDescription('Nothing open');
    await expect(within(canvasElement).getByText('Nothing open')).toBeVisible();
    const end = must(box.querySelector('[data-slot="list-end"]'));
    const bar = must(canvasElement.querySelector('[data-slot="bar"]')).getBoundingClientRect();
    await near(end.getBoundingClientRect().top - bar.bottom, resolvePx(box, 'var(--space-0_5)'));
    await expect(within(box).getAllByRole('option')).toHaveLength(2);
    await userEvent.tab();
    await expect(activeRow(box)).toBe(row(canvasElement, /Slush/));
  },
};

/** Empty, nothing decided either: the list and its tab, nothing to move to. */
export const EmptyAndNothingDecided: Story = {
  ...Default,
  render: (args) => (
    <Console onOpen={args.onOpen} items={[]} decided={{ label: 'Decided this week', items: [] }} />
  ),
  play: async ({ canvasElement, args }) => {
    const box = listbox(canvasElement);
    await userEvent.tab();
    await expect(box).toHaveFocus();
    await expect(box).not.toHaveAttribute('aria-activedescendant');
    await userEvent.keyboard('{ArrowDown}{ArrowUp}{Enter} a');
    await expect(box).not.toHaveAttribute('aria-activedescendant');
    await expect(args.onOpen).not.toHaveBeenCalled();
  },
};

/**
 * Loading: skeleton rows in the rows' own box — a title-and-sub row's exact height — under the
 * list's name, `aria-busy`. Nothing moves when the rows land.
 */
export const Loading: Story = {
  ...Default,
  render: (args) => (
    <div className="flex gap-gutter">
      <Console onOpen={args.onOpen} loading loadingRows={4} height="18rem" />
      <div data-junction="real" className="w-list">
        <MiddleList
          label="Reference"
          emptyLabel="Nothing open"
          items={[OPEN[3] as MiddleListItem]}
          onOpen={() => {}}
          className="h-[10rem]"
        />
      </div>
    </div>
  ),
  play: async ({ canvasElement, args }) => {
    const box = listbox(canvasElement);
    await expect(box).toHaveAttribute('aria-busy', 'true');
    await expect(within(box).queryAllByRole('option')).toHaveLength(0);
    const skeletons = box.querySelectorAll<HTMLElement>('[data-slot="middle-list-skeleton"]');
    await expect(skeletons).toHaveLength(4);
    for (const s of skeletons) await expect(s).toHaveAttribute('aria-hidden', 'true');
    // The skeleton row is exactly a title-and-sub row's box.
    const real = must(
      canvasElement.querySelector<HTMLElement>('[data-junction="real"] [role="option"]'),
    );
    await document.fonts.ready;
    await near(
      must(skeletons[0]).getBoundingClientRect().height,
      real.getBoundingClientRect().height,
      0.5,
    );
    await userEvent.tab();
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await expect(args.onOpen).not.toHaveBeenCalled();
  },
};

// ── Virtualized ─────────────────────────────────────────────────────────────────────────────

const LAKES = ['Mascoma Lake', 'Post Pond', 'Lake Morey', 'Goose Pond', 'Crystal Lake'];

const MANY: MiddleListItem[] = Array.from({ length: 5000 }, (_, i) =>
  i === 4321
    ? {
        id: `r${i}`,
        title: 'Zebra mussel shells on the shore',
        sub: 'Lake Fairlee · by Dana Whitlock',
        meta: '2 d',
      }
    : {
        id: `r${i}`,
        title: `${LAKES[i % LAKES.length]} report ${i + 1}`,
        sub: i % 3 === 0 ? 'Pressure ridge · by Rob Tremblay' : 'Open water · by Pat Lacasse',
        meta: `${(i % 9) + 1} d`,
        chips: i % 4 === 0 ? <Badge variant="outline">Hazard</Badge> : undefined,
        locked: i === 4998,
      },
);

/**
 * Five thousand rows: only the rows in view are in the page. Focus stays on the list while the
 * cursor moves — End, type-ahead to a row thousands down, ↑↓ — and `aria-activedescendant` always
 * names a row that's really there, scrolled into view.
 */
export const Virtualized: Story = {
  args: { label: 'Open reports', items: MANY, emptyLabel: 'Nothing open', onOpen: fn() },
  render: (args) => <Console onOpen={args.onOpen} items={MANY} decided={null} />,
  play: async ({ canvasElement, args }) => {
    const box = listbox(canvasElement);
    const inView = (el: Element) => {
      const r = el.getBoundingClientRect();
      const v = box.getBoundingClientRect();
      return r.top >= v.top - 1 && r.bottom <= v.bottom + 1;
    };
    await waitFor(() => expect(within(box).getAllByRole('option').length).toBeGreaterThan(0));
    await expect(within(box).getAllByRole('option').length).toBeLessThan(60);
    await expect(box.scrollHeight).toBeGreaterThan(5000 * resolvePx(box, 'var(--space-8)'));
    await userEvent.tab();
    await expect(box).toHaveFocus();
    await userEvent.keyboard('{End}');
    // Row 5,000; 4,999 is locked, so ↑ skips it.
    await waitFor(() => expect(activeRow(box)).toHaveTextContent('report 5000'));
    await waitFor(() => expect(inView(must(activeRow(box)))).toBe(true));
    await expect(box).toHaveFocus();
    const last = must(activeRow(box));
    await expect(last).toHaveAttribute('aria-posinset', '5000');
    await expect(last).toHaveAttribute('aria-setsize', '5000');
    await userEvent.keyboard('{ArrowUp}');
    await waitFor(() => expect(activeRow(box)).toHaveTextContent('report 4998'));
    // Type-ahead searches every row, not the rendered ones.
    await userEvent.keyboard('z');
    await waitFor(() => expect(activeRow(box)).toHaveTextContent('Zebra mussel'));
    await waitFor(() => expect(inView(must(activeRow(box)))).toBe(true));
    await expect(box).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(activeRow(box)).toHaveTextContent('report 4323'));
    await userEvent.keyboard('{Home}');
    await waitFor(() => expect(activeRow(box)).toHaveTextContent('Mascoma Lake report 1'));
    await expect(within(box).getAllByRole('option').length).toBeLessThan(60);
    // The cursor's row stays in the page even scrolled far away from it.
    box.scrollTop = box.scrollHeight;
    await waitFor(() => expect(activeRow(box)).not.toBeNull());
    await expect(activeRow(box)).toHaveTextContent('Mascoma Lake report 1');
    await userEvent.keyboard('{Enter}');
    await expect(args.onOpen).toHaveBeenCalledWith('r0');
  },
};

/**
 * Virtualized with a decided list: the end tab and the decided heading are entries like the rows,
 * measured where they land, so the 32 px gap and ↓ into the decided list hold under the virtualizer.
 */
export const VirtualizedWithDecided: Story = {
  ...Default,
  render: (args) => <Console onOpen={args.onOpen} virtualizeAbove={2} />,
  play: async ({ canvasElement }) => {
    const box = listbox(canvasElement);
    // Virtualized: every entry is absolutely placed inside one sized track.
    const track = must(box.querySelector<HTMLElement>('[data-index]')).parentElement;
    await expect(must(track).style.height).not.toBe('');
    await document.fonts.ready;
    const end = await waitFor(() => must(box.querySelector<HTMLElement>('[data-slot="list-end"]')));
    const heading = within(box).getByText('Decided this week');
    const gap = resolvePx(box, 'var(--space-8)');
    // Plain reads only inside the wait: the measured entries settle a frame after they render.
    await waitFor(() =>
      near(heading.getBoundingClientRect().top - end.getBoundingClientRect().bottom, gap),
    );
    await userEvent.tab();
    await userEvent.keyboard('{End}');
    await waitFor(() => expect(activeRow(box)).toHaveTextContent('Hole by the boat launch'));
  },
};

// ── Four-up ─────────────────────────────────────────────────────────────────────────────────

export const FourUp: Story = {
  ...Default,
  render: () => (
    <div className="h-[24rem] w-list border border-solid border-line">
      <MiddleList
        label="Open reports"
        emptyLabel="Nothing open"
        items={OPEN}
        decided={DECIDED}
        selectedId="inlet"
        onOpen={() => {}}
        className="h-full"
      />
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const box = within(q).getByRole('listbox');
      const lift08 = computedColor(box, 'var(--lift-08)');
      const selected = within(q).getByRole('option', { selected: true });
      await waitFor(() => expect(getComputedStyle(selected).backgroundColor).toBe(lift08));
      const locked = within(q).getByRole('option', { name: /Thin ice/ });
      await expect(getComputedStyle(locked).opacity).toBe('0.5');
    }
  },
};

// ── Junctions ───────────────────────────────────────────────────────────────────────────────

/**
 * The column's measurements, per surface: a row is the gutter in from each edge and `space-2_5`
 * tall in padding over a dotted hairline; chips sit `space-1_5` over the title, the sub-line
 * `space-0_5` under it; the end tab is `space-0_5` under the last row, and the decided list's
 * heading `space-8` (32 px) under the end tab.
 */
async function playJunctions({ canvasElement }: { canvasElement: HTMLElement }) {
  await document.fonts.ready;
  const box = listbox(canvasElement);
  const px = (len: string) => resolvePx(box, len);
  const rows = within(box).getAllByRole('option');
  for (const r of rows) {
    const s = getComputedStyle(r);
    await near(parseFloat(s.paddingTop), px('var(--space-2_5)'));
    await near(parseFloat(s.paddingBottom), px('var(--space-2_5)'));
    await near(parseFloat(s.paddingLeft), px('var(--gap-gutter)'));
    await expect(s.borderBottomStyle).toBe('dotted');
    await near(parseFloat(s.borderBottomWidth), px('var(--stroke-hair)'));
    await expect(s.borderBottomColor).toBe(computedColor(box, 'var(--line)'));
  }
  // A plain row's height is its parts: padding, the title's line, the sub's gap and line, the rule.
  const plain = row(canvasElement, /Pressure crack/);
  const title = must(plain.querySelector<HTMLElement>('[data-slot="middle-list-title"]'));
  const sub = must(plain.querySelector<HTMLElement>('[data-slot="middle-list-sub"]'));
  await near(parseFloat(getComputedStyle(title).fontSize), px('var(--type-body)'));
  await near(parseFloat(getComputedStyle(sub).fontSize), px('var(--type-assist)'));
  await near(
    sub.getBoundingClientRect().top - title.getBoundingClientRect().bottom,
    px('var(--space-0_5)'),
  );
  await near(
    plain.getBoundingClientRect().height,
    2 * px('var(--space-2_5)') +
      title.getBoundingClientRect().height +
      px('var(--space-0_5)') +
      sub.getBoundingClientRect().height +
      px('var(--stroke-hair)'),
    0.5,
  );
  // Chips: `space-1_5` over the title. The meta sits on the title's baseline.
  const chipped = row(canvasElement, /Pressure ridge/);
  const chips = must(chipped.querySelector<HTMLElement>('[data-slot="middle-list-chips"]'));
  const ctitle = must(chipped.querySelector<HTMLElement>('[data-slot="middle-list-title"]'));
  await near(
    ctitle.getBoundingClientRect().top - chips.getBoundingClientRect().bottom,
    px('var(--space-1_5)'),
  );
  const metaEl = must(chipped.querySelector<HTMLElement>('[data-slot="middle-list-meta"]'));
  await near(baseline(metaEl), baseline(ctitle), 1);
  // End tab: `space-0_5` under the last open row.
  const end = must(box.querySelector<HTMLElement>('[data-slot="list-end"]'));
  const lastOpen = row(canvasElement, /Pressure crack/);
  await near(
    end.getBoundingClientRect().top - lastOpen.getBoundingClientRect().bottom,
    px('var(--space-0_5)'),
  );
  // The decided list: its heading `space-8` (32 px on both surfaces) under the end tab.
  const heading = within(box).getByText('Decided this week');
  await near(heading.getBoundingClientRect().top - end.getBoundingClientRect().bottom, px('2rem'));
  await near(px('var(--space-8)'), px('2rem'));
  const firstDecided = row(canvasElement, /Slush/);
  const divider = must(box.querySelector<HTMLElement>('[data-slot="middle-list-divider"]'));
  await near(
    firstDecided.getBoundingClientRect().top - heading.getBoundingClientRect().bottom,
    px('var(--space-1)'),
  );
  await near(divider.getBoundingClientRect().bottom, firstDecided.getBoundingClientRect().top);
}

/** A text element's first alphabetic baseline, in page px (where a grid aligns it). */
function baseline(el: HTMLElement): number {
  const probe = document.createElement('span');
  probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
  el.prepend(probe);
  const y = probe.getBoundingClientRect().bottom;
  probe.remove();
  return y;
}

function Junctions() {
  return (
    <div className="h-[30rem] w-list border border-solid border-line">
      <MiddleList
        label="Open reports"
        emptyLabel="Nothing open"
        items={OPEN}
        decided={DECIDED}
        selectedId="inlet"
        onOpen={() => {}}
        className="h-full"
      />
    </div>
  );
}

export const JunctionsAdmin: Story = {
  ...Default,
  render: () => <Junctions />,
  globals: { surface: 'admin' },
  play: playJunctions,
};

export const JunctionsSkater: Story = {
  ...Default,
  render: () => <Junctions />,
  globals: { surface: 'skater' },
  play: playJunctions,
};

/** With a leading avatar column: the title, sub and meta keep their places beside it. */
export const Leading: Story = {
  ...Default,
  render: (args) => (
    <Console
      onOpen={args.onOpen}
      decided={null}
      items={OPEN.map((item) => ({
        ...item,
        leading: (
          <span
            aria-hidden="true"
            className="block size-avatar rounded-full border border-solid border-line2 bg-raise"
          />
        ),
      }))}
    />
  ),
  play: async ({ canvasElement }) => {
    const r = row(canvasElement, /Pressure ridge/);
    const lead = must(r.querySelector<HTMLElement>('[data-slot="middle-list-leading"]'));
    const title = must(r.querySelector<HTMLElement>('[data-slot="middle-list-title"]'));
    const gap = resolvePx(r, 'var(--space-3)');
    await near(title.getBoundingClientRect().left - lead.getBoundingClientRect().right, gap);
    // Centered on the row's content box.
    const rr = r.getBoundingClientRect();
    const lr = lead.getBoundingClientRect();
    const pad = resolvePx(r, 'var(--space-2_5)');
    await near(
      (lr.top + lr.bottom) / 2,
      (rr.top + pad + rr.bottom - pad - resolvePx(r, 'var(--stroke-hair)')) / 2,
      1,
    );
  },
};
