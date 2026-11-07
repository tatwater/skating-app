import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import {
  computedColor,
  focusRing,
  JUNCTION_TOLERANCE_PX,
  resolvePx,
  sameColor,
  sameShadow,
  transitionsDone,
} from './measure';
import { KICKER, must, PSEUDO_STATES, StateMatrix } from './storyKit';
import {
  type Colleague,
  ColleagueFaces,
  SearchTrigger,
  SeasonTape,
  type TapeMark,
} from './top-bar-parts';

const SEASON = 'Winter 2026–27';
// Month starts across a 1 Oct – 30 Apr season.
const TICKS = [0, 0.146, 0.287, 0.435, 0.58, 0.712, 0.858];
const MARKS: TapeMark[] = [
  {
    at: 0.009,
    kind: 'event',
    tone: 'acc',
    title: 'Ice watch opened',
    detail: '3 Oct · 2 of 3 sentinels',
  },
  {
    at: 0.028,
    kind: 'event',
    tone: 'warn',
    title: 'First imagery-line night',
    detail: '7 Oct · 19 °F',
  },
  { at: 0.056, kind: 'now', title: 'Today', detail: '14 Oct · Day 10 of the watch' },
  { at: 0.311, kind: 'ghost', title: 'Last winter’s first report', detail: '6 Dec · Crystal Lake' },
];
const STAFF: Colleague[] = [
  { id: 'teagan', name: 'Teagan Atwater', present: true },
  { id: 'matt', name: 'Matt Steinberg', present: false },
  { id: 'sarah', name: 'Sarah Berman', present: true },
];

const meta = {
  title: 'Kit/Top bar parts',
  component: SeasonTape,
  tags: ['autodocs'],
  args: { season: SEASON, ticks: TICKS, marks: MARKS, badge: 'Day 10' },
  globals: { surface: 'admin' },
  // Room under the bar for the tips, which open downward.
  decorators: [(Story) => <div className="pb-[8rem]">{Story()}</div>],
  parameters: {
    docs: {
      description: {
        component:
          'Admin only. The top bar’s parts: the **season tape** (the console’s clock — month ticks, the season’s marks, today’s notch, last winter’s ghost, the day badge), whose marks are real buttons with kit tooltips; the **search trigger**, a button dressed as the underline input with its ⌘K cap; and the **colleagues’ faces**, present over idle, never the viewer. Every part dims in go-mode.',
      },
    },
  },
} satisfies Meta<typeof SeasonTape>;

export default meta;
type Story = StoryObj<typeof meta>;

const popup = () => document.querySelector<HTMLElement>('[data-slot="tooltip-content"]');
const part = (root: ParentNode, slot: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${slot}"]`));
const all = (root: ParentNode, slot: string) => [
  ...root.querySelectorAll<HTMLElement>(`[data-slot="${slot}"]`),
];

function Tape(props: { dimmed?: boolean }) {
  return <SeasonTape season={SEASON} ticks={TICKS} marks={MARKS} badge="Day 10" {...props} />;
}

/** The right of the bar: the search, then the faces. */
function BarRight({ dimmed = false }: { dimmed?: boolean }) {
  return (
    <div className="flex items-center gap-(--space-4)">
      <SearchTrigger dimmed={dimmed} />
      <ColleagueFaces people={STAFF} viewerId="teagan" dimmed={dimmed} />
    </div>
  );
}

/** The bar as the boards draw it: the tape centered, the search and faces at the right. */
function TopBar({ dimmed = false }: { dimmed?: boolean }) {
  return (
    <header className="relative flex h-top w-full min-w-0 items-center gap-(--space-3_5) border-b border-solid border-line px-(--space-5_5)">
      <div className="absolute inset-y-0 left-1/2 flex -translate-x-1/2 items-center">
        <Tape dimmed={dimmed} />
      </div>
      <div className="ml-auto">
        <BarRight dimmed={dimmed} />
      </div>
    </header>
  );
}

// ── The season tape ──────────────────────────────────────────────────────────────────────────

/** The tape: four marks, each a button whose name says what it marks. Nothing uses `title`. */
export const Tape_: Story = {
  name: 'Season tape',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tape = canvas.getByRole('group', { name: SEASON });
    const marks = within(tape).getAllByRole('button');
    await expect(marks).toHaveLength(4);
    await expect(
      canvas.getByRole('button', { name: 'Today, 14 Oct · Day 10 of the watch' }),
    ).toBeVisible();
    await expect(canvasElement.querySelector('[title]')).toBeNull();
    // The tones: ice for the watch (a water mark), amber for a person's attention.
    const events = all(canvasElement, 'tape-event');
    await expect(getComputedStyle(must(events[0])).backgroundColor).toEqual(
      sameColor(computedColor(tape, 'var(--acc)')),
    );
    await expect(getComputedStyle(must(events[1])).backgroundColor).toEqual(
      sameColor(computedColor(tape, 'var(--warn)')),
    );
    await expect(getComputedStyle(part(canvasElement, 'tape-ghost')).borderLeftStyle).toBe(
      'dashed',
    );
    // The day badge reads beside the season: outlined, mono, never filled.
    const badge = part(canvasElement, 'tape-badge');
    await expect(badge).toHaveTextContent('Day 10');
    await expect(getComputedStyle(badge).backgroundColor).toEqual(sameColor('rgba(0, 0, 0, 0)'));
    await expect(getComputedStyle(badge).fontFamily).toMatch(/Martian Mono/);
  },
};

/** Hovering a mark opens its tip: the caps title, then the words. Leaving closes it. */
export const TapeTip: Story = {
  ...Tape_,
  name: 'Season tape tip',
  play: async ({ canvasElement }) => {
    const ghost = within(canvasElement).getByRole('button', { name: /Last winter/ });
    await expect(popup()).toBeNull();
    await userEvent.hover(ghost);
    const tip = await waitFor(() => must(popup()));
    await expect(part(tip, 'tooltip-title')).toHaveTextContent('Last winter’s first report');
    await expect(tip).toHaveTextContent('6 Dec · Crystal Lake');
    await userEvent.unhover(ghost);
    await waitFor(() => expect(popup()).toBeNull());
  },
};

/** Keyboard focus reaches every mark and opens its tip — the reason they aren't `title`s. */
export const TapeKeyboard: Story = {
  ...Tape_,
  name: 'Season tape keyboard',
  play: async ({ canvasElement }) => {
    const today = within(canvasElement).getByRole('button', { name: /^Today/ });
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    await expect(today).toHaveFocus();
    // Tabbing past the first two marks opened and closed their tips on the way; wait for today's.
    await waitFor(() =>
      expect(
        [...document.querySelectorAll('[data-slot="tooltip-content"]')].some((t) =>
          t.textContent?.includes('Day 10 of the watch'),
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(getComputedStyle(today).boxShadow).toEqual(focusRing()));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(popup()).toBeNull());
    today.blur();
  },
};

/**
 * Admin junctions: the tape is 240 × 14 with its rule at 7; an event is 2 × 9, today's notch 8 × 6.
 * A lone mark's hit area is 24 px wide and the tape's height plus the hit pad above and below;
 * marks closer than that split the gap at the midpoint — no two hit areas overlap, and each one
 * holds its own mark.
 */
export const TapeJunction: Story = {
  ...Tape_,
  name: 'Season tape junction',
  play: async ({ canvasElement }) => {
    const px = (len: string) => resolvePx(canvasElement, len);
    const near = (a: number, b: number) => Math.abs(a - b) <= JUNCTION_TOLERANCE_PX;
    const tape = part(canvasElement, 'tape').getBoundingClientRect();
    await expect(tape.width).toBeCloseTo(px('var(--size-tape)'), 1);
    await expect(tape.width).toBeCloseTo(px('15rem'), 1);
    await expect(tape.height).toBeCloseTo(px('0.875rem'), 1);
    const base = part(canvasElement, 'tape-base').getBoundingClientRect();
    await expect(base.height).toBe(1);
    await expect(near(base.top - tape.top, px('0.4375rem'))).toBe(true);
    const ticks = all(canvasElement, 'tape-tick');
    await expect(ticks).toHaveLength(TICKS.length);
    await expect(must(ticks[0]).getBoundingClientRect().height).toBeCloseTo(px('0.3125rem'), 1);

    const event = must(all(canvasElement, 'tape-event')[0]).getBoundingClientRect();
    await expect(event.width).toBe(2);
    await expect(event.height).toBeCloseTo(px('0.5625rem'), 1);
    const now = part(canvasElement, 'tape-now').getBoundingClientRect();
    await expect(now.width).toBe(8);
    await expect(now.height).toBe(6);
    await expect(near(now.top, tape.top)).toBe(true);

    const hits = all(canvasElement, 'tape-mark').map((m) => m.getBoundingClientRect());
    const drawn = [
      ...all(canvasElement, 'tape-event'),
      part(canvasElement, 'tape-now'),
      part(canvasElement, 'tape-ghost'),
    ].map((d) => {
      const r = d.getBoundingClientRect();
      return (r.left + r.right) / 2;
    });
    const hitY = px('var(--gap-hit-y)');
    for (const [i, hit] of hits.entries()) {
      await expect(near(hit.height, tape.height + 2 * hitY)).toBe(true);
      await expect(hit.width).toBeLessThanOrEqual(px('1.5rem') + JUNCTION_TOLERANCE_PX);
      // Each hit area holds its own mark's center.
      await expect(drawn[i]).toBeGreaterThanOrEqual(hit.left);
      await expect(drawn[i]).toBeLessThanOrEqual(hit.right);
      // …and never overlaps the next.
      const next = hits[i + 1];
      if (next !== undefined)
        await expect(hit.right).toBeLessThanOrEqual(next.left + JUNCTION_TOLERANCE_PX);
    }
    // The lone ghost gets the full 24 px; the season's first, crowded marks split their gaps.
    await expect(must(hits[3]).width).toBeCloseTo(px('1.5rem'), 1);
    await expect(must(hits[1]).width).toBeLessThan(px('1.5rem'));
    // The pieces of the lockup sit 12 px apart.
    const label = part(canvasElement, 'tape-season').getBoundingClientRect();
    await expect(near(tape.left - label.right, px('var(--space-3)'))).toBe(true);
  },
};

// ── The search trigger ───────────────────────────────────────────────────────────────────────

/** A button dressed as the underline input: pressing it opens the palette; ⌘K is its key. */
export const Search: Story = {
  render: () => <SearchTrigger onClick={fn()} />,
  play: async ({ canvasElement }) => {
    const search = within(canvasElement).getByRole('button', {
      name: 'Jump to a body or a person',
    });
    await expect(search).toHaveAttribute('aria-keyshortcuts', 'Meta+K');
    await expect(search).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(part(search, 'search-kbd')).toHaveAttribute('aria-hidden', 'true');
    await expect(part(search, 'search-kbd')).toHaveTextContent('⌘K');
    const style = getComputedStyle(search);
    // One rule under it, no box: the input's look.
    await expect(style.borderBottomWidth).toBe('1px');
    await expect(style.borderTopWidth).toBe('0px');
    await expect(style.borderBottomColor).toEqual(sameColor(computedColor(search, 'var(--line2)')));
    await expect(style.color).toEqual(sameColor(computedColor(search, 'var(--fg3)')));
  },
};

/** Pressing it hands off (to the palette, in the app). */
const onSearch = fn();
export const SearchPress: Story = {
  render: () => <SearchTrigger onClick={onSearch} />,
  play: async ({ canvasElement }) => {
    onSearch.mockClear();
    await userEvent.click(within(canvasElement).getByRole('button'));
    await expect(onSearch).toHaveBeenCalledOnce();
  },
};

/** Keyboard focus is the input's focus: the rule turns bright and doubles. Hover is the same. */
export const SearchFocus: Story = {
  render: () => <SearchTrigger />,
  play: async ({ canvasElement }) => {
    const search = within(canvasElement).getByRole('button');
    await userEvent.tab();
    await expect(search).toHaveFocus();
    const bright = computedColor(search, 'var(--fg)');
    await waitFor(() =>
      expect(getComputedStyle(search).borderBottomColor).toEqual(sameColor(bright)),
    );
    // The color can match a frame before the transition ends; the doubled rule is read at its end.
    await transitionsDone(search);
    await expect(getComputedStyle(search).boxShadow).toEqual(sameShadow([0, 1, 0, 0]));
    search.blur();
  },
};

/** Admin: 200 × 24, the 13 px magnifier first, the cap flush with the rule's right end. */
export const SearchJunction: Story = {
  render: () => <SearchTrigger />,
  play: async ({ canvasElement }) => {
    const px = (len: string) => resolvePx(canvasElement, len);
    const near = (a: number, b: number) => Math.abs(a - b) <= JUNCTION_TOLERANCE_PX;
    const search = within(canvasElement).getByRole('button');
    const box = search.getBoundingClientRect();
    await expect(box.width).toBeCloseTo(px('var(--size-search)'), 1);
    await expect(box.width).toBeCloseTo(px('12.5rem'), 1);
    await expect(box.height).toBeCloseTo(px('var(--size-btn-sm)'), 1);
    const icon = must(part(search, 'search-icon').querySelector('svg')).getBoundingClientRect();
    await expect(icon.height).toBeCloseTo(px('var(--type-row)'), 0);
    await expect(near(icon.left, box.left)).toBe(true);
    const kbd = part(search, 'search-kbd').getBoundingClientRect();
    await expect(near(kbd.right, box.right)).toBe(true);
    const label = part(search, 'search-label').getBoundingClientRect();
    await expect(near(label.left - icon.right, px('var(--space-2)'))).toBe(true);
    // The cap never makes the field taller.
    await expect(kbd.height).toBeLessThan(box.height);
  },
};

// ── The colleagues' faces ────────────────────────────────────────────────────────────────────

/** Two colleagues: Sarah here (lit, on top), Matt idle under her. The viewer is left out. */
export const Faces: Story = {
  render: () => <ColleagueFaces people={STAFF} viewerId="teagan" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', {
      name: 'Also here: Sarah Berman, Matt Steinberg (idle)',
    });
    const faces = all(trigger, 'avatar');
    await expect(faces).toHaveLength(2);
    // Present first, over the idle face.
    await expect(faces[0]).toHaveAttribute('data-present');
    await expect(faces[1]).not.toHaveAttribute('data-present');
    await expect(Number(must(faces[0]).style.zIndex)).toBeGreaterThan(
      Number(must(faces[1]).style.zIndex),
    );
    // The viewer is never in the run.
    await expect(trigger.textContent).not.toMatch(/TA/);
    // Circles, always; idle is dim but solid (never see-through).
    for (const face of faces) await expect(getComputedStyle(face).borderRadius).not.toBe('0px');
    await expect(getComputedStyle(must(faces[1])).opacity).toBe('1');
    await expect(getComputedStyle(must(faces[1])).backgroundColor).toEqual(
      sameColor(computedColor(trigger, 'var(--panel)')),
    );
  },
};

/** Hover says who: the run's title, then each name, the idle one marked. */
export const FacesTip: Story = {
  ...Faces,
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button');
    await userEvent.hover(trigger);
    const tip = await waitFor(() => must(popup()));
    await expect(part(tip, 'tooltip-title')).toHaveTextContent('Also here');
    const lines = all(tip, 'colleague-line').map((l) => l.textContent);
    await expect(lines).toEqual(['Sarah Berman', 'Matt Steinberg · Idle']);
    await userEvent.unhover(trigger);
    await waitFor(() => expect(popup()).toBeNull());
  },
};

/** Nobody else on: no run at all — never an empty "nobody here". */
export const FacesAlone: Story = {
  render: () => (
    <div data-testid="bar">
      <ColleagueFaces
        people={[{ id: 'teagan', name: 'Teagan Atwater', present: true }]}
        viewerId="teagan"
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByTestId('bar')).toBeEmptyDOMElement();
  },
};

/** A crowd folds past four into a "+N" circle. */
export const FacesCrowd: Story = {
  render: () => (
    <ColleagueFaces
      viewerId="teagan"
      people={[
        { id: 'sarah', name: 'Sarah Berman', present: true },
        { id: 'matt', name: 'Matt Steinberg' },
        { id: 'ana', name: 'Ana Ruiz', present: true },
        { id: 'jo', name: 'Jo Park' },
        { id: 'lee', name: 'Lee Chen' },
        { id: 'teagan', name: 'Teagan Atwater', present: true },
      ]}
    />
  ),
  play: async ({ canvasElement }) => {
    await expect(all(canvasElement, 'avatar')).toHaveLength(4);
    await expect(part(canvasElement, 'avatar-overflow')).toHaveTextContent('+1');
  },
};

// ── The bar, go-mode, states and four-up ─────────────────────────────────────────────────────

/** The three parts in place, as the bar draws them. */
export const Bar: Story = {
  decorators: [(Story) => <div className="w-full min-w-[56rem]">{Story()}</div>],
  render: () => <TopBar />,
  play: async ({ canvasElement }) => {
    const bar = must(canvasElement.querySelector('header')).getBoundingClientRect();
    await expect(bar.height).toBeCloseTo(resolvePx(canvasElement, 'var(--size-top)'), 1);
    for (const slot of ['season-tape', 'search-trigger', 'colleague-faces'])
      await expect(part(canvasElement, slot)).not.toHaveAttribute('data-dimmed');
  },
};

/** Go-mode: the tape, the search and the faces all step back to the dim opacity. */
export const GoMode: Story = {
  decorators: [(Story) => <div className="w-full min-w-[56rem]">{Story()}</div>],
  render: () => <TopBar dimmed />,
  play: async ({ canvasElement }) => {
    const dim = getComputedStyle(canvasElement).getPropertyValue('--opacity-dim').trim();
    for (const slot of ['season-tape', 'search-trigger', 'colleague-faces']) {
      const el = part(canvasElement, slot);
      await expect(el).toHaveAttribute('data-dimmed');
      await expect(getComputedStyle(el).opacity).toBe(dim);
    }
  },
};

const STATES = [
  { key: 'rest', label: 'Rest' },
  { key: 'hover', label: 'Hover' },
  { key: 'focus', label: 'Focus' },
] as const;

/** The search at rest, hovered and focused — one lit look for both. */
export const States: Story = {
  render: () => (
    <StateMatrix
      rows={[{ key: 'search', label: 'Search' }] as const}
      states={STATES}
      cell={(_, state) => <SearchTrigger data-state={state} />}
    />
  ),
  parameters: PSEUDO_STATES,
  play: async ({ canvasElement }) => {
    // The forced columns are for the eye (the pseudo-states addon runs in Storybook, not under
    // Vitest); `SearchFocus` tests the real lit look. Here: the resting cell.
    const [rest] = all(canvasElement, 'search-trigger');
    await expect(getComputedStyle(must(rest)).borderBottomColor).toEqual(
      sameColor(computedColor(canvasElement, 'var(--line2)')),
    );
  },
};

/** The parts in all four maps. Admin only: the skater quads show the same parts, unused there. */
export const FourUp: Story = {
  render: () => (
    <div className="flex flex-col gap-heading">
      <span className={KICKER}>Tape</span>
      <Tape />
      <span className={KICKER}>Search and faces</span>
      <BarRight />
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      await expect(part(q, 'tape').getBoundingClientRect().width).toBeCloseTo(
        resolvePx(q, 'var(--size-tape)'),
        1,
      );
      await expect(part(q, 'search-trigger').getBoundingClientRect().height).toBeCloseTo(
        resolvePx(q, 'var(--size-btn-sm)'),
        1,
      );
    }
  },
};
