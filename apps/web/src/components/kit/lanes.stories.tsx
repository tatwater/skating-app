import * as tokens from '@skating/design/tokens';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactElement, type ReactNode, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { Badge, Tag } from './badge';
import { type Lane, type LaneGroup, Lanes, type LanesProps } from './lanes';
import {
  colorsIn,
  computedColor,
  contrastBetween,
  JUNCTION_TOLERANCE_PX,
  resolvePx,
  sameColor,
  sameShadow,
  transitionsDone,
} from './measure';
import { Meter } from './meter';
import { faceLoaded, KICKER, must, PSEUDO_STATES, StateMatrix } from './storyKit';

const MACHINERY: LaneGroup[] = [
  {
    label: 'Machinery',
    lanes: [
      { id: 'health', label: 'Health', count: 3, countTone: 'bad' },
      { id: 'ledger', label: 'Cost ledger', count: '$75.80' },
    ],
  },
  {
    label: 'Pipelines',
    lanes: [
      { id: 'corpus', label: 'Corpus', tail: <Tag>Local</Tag>, count: 2, countTone: 'warn' },
      { id: 'enrich', label: 'Enrichment', tail: <Tag>Local</Tag>, count: 1, countTone: 'bad' },
      { id: 'imagery', label: 'Imagery', count: 12, countTone: 'lit' },
      { id: 'weather', label: 'Weather', count: 1, countTone: 'warn' },
      { id: 'notif', label: 'Notifications', count: 4 },
      { id: 'roll', label: 'Rollovers', dim: true },
      { id: 'analytics', label: 'Analytics', count: 2 },
      { id: 'hygiene', label: 'Retention', count: 1, countTone: 'bad' },
    ],
  },
];

/** The sidebar, its selection held as a page would hold it. */
function Controlled(props: Omit<LanesProps, 'selected'> & { initial?: string }) {
  const { initial = 'health', onSelect, ...rest } = props;
  const [selected, setSelected] = useState(initial);
  return (
    <Lanes
      {...rest}
      selected={selected}
      onSelect={(id) => {
        setSelected(id);
        onSelect?.(id);
      }}
    />
  );
}

const meta = {
  title: 'Kit/Lanes',
  component: Lanes,
  tags: ['autodocs'],
  args: { label: 'Machinery', groups: MACHINERY, onSelect: fn() },
  globals: { surface: 'admin' },
  render: (args) => <Controlled {...args} />,
  decorators: [
    // The sidebar's column; a story that draws its own columns (`bare`) goes without it.
    (Story, { parameters }) =>
      parameters.bare ? (
        Story()
      ) : (
        <div className="flex h-[30rem] w-lanes border-r border-solid border-line">{Story()}</div>
      ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          'Admin only. The middle column’s lanes: they pick **which list** the page shows (facets go in tabs over the list, never here). Group kickers, 28 px rows with a mono count (quiet, lit, amber, red), the selected lane on the lit plate with its 2 px inset bar, dim lanes in the quiet ink. One tab stop; ↑ ↓, Home, End and type-ahead move focus; Enter picks. No tooltips. Routing is a `link` slot — the stories pass plain anchors.',
      },
    },
  },
} satisfies Meta<typeof Lanes>;

export default meta;
type Story = StoryObj<typeof meta>;

const row = (root: HTMLElement, name: string | RegExp) =>
  within(root).getByRole('button', { name }) as HTMLElement;
const part = (root: ParentNode, slot: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${slot}"]`));

/** Machinery's lanes on Health: two groups, counts in their tones, a dim lane. */
export const Machinery: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const nav = canvas.getByRole('navigation', { name: 'Machinery' });
    // Each group is a list named by its kicker.
    await expect(within(nav).getByRole('list', { name: 'Pipelines' })).toBeVisible();
    const health = row(nav, /Health/);
    await expect(health).toHaveAttribute('aria-current', 'true');
    await expect(getComputedStyle(health).color).toEqual(
      sameColor(computedColor(nav, 'var(--fg)')),
    );
    await expect(getComputedStyle(health).backgroundColor).toEqual(
      sameColor(computedColor(nav, 'var(--lift-08)')),
    );
    // Counts read by meaning, chosen or not — a red count stays red on the chosen lane (board 8.1's
    // amber Suspended); only a quiet count lights with its lane.
    const tone = (name: RegExp) => part(row(nav, name), 'lane-count').dataset.tone;
    await expect(tone(/Health/)).toBe('bad');
    await expect(tone(/Corpus/)).toBe('warn');
    await expect(tone(/Retention/)).toBe('bad');
    await expect(tone(/Notifications/)).toBe('default');
    await expect(getComputedStyle(part(row(nav, /Corpus/), 'lane-count')).color).toEqual(
      sameColor(computedColor(nav, 'var(--warn)')),
    );
    await expect(getComputedStyle(part(row(nav, /Corpus/), 'lane-count')).fontFamily).toMatch(
      /Martian Mono/,
    );
    // A dim lane is the quiet ink, still a lane.
    const roll = row(nav, 'Rollovers');
    await expect(getComputedStyle(roll).color).toEqual(sameColor(computedColor(nav, 'var(--fg3)')));
    // Navigation: no tips, no titles.
    await expect(nav.querySelector('[data-slot="tooltip-trigger"], [title]')).toBeNull();
    // Clicking picks: the callback hears it, and the plate moves.
    await userEvent.click(roll);
    await expect(args.onSelect).toHaveBeenCalledWith('roll');
    await expect(roll).toHaveAttribute('aria-current', 'true');
    await expect(health).not.toHaveAttribute('aria-current');
  },
};

/**
 * One tab stop, on the selected lane; ↑ ↓ cross groups, Home and End jump, typing jumps (a letter
 * again cycles; letters typed together build one search). Enter picks. Handled keys are marked
 * handled, so the page's hotkeys leave them alone.
 */
export const Keyboard: Story = {
  play: async ({ canvasElement, args }) => {
    const nav = canvasElement;
    const lanes = within(nav).getAllByRole('button');
    await expect(lanes.filter((l) => l.tabIndex === 0)).toHaveLength(1);
    await userEvent.tab();
    await expect(row(nav, /Health/)).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    await expect(row(nav, /Corpus/)).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    await expect(row(nav, /Cost ledger/)).toHaveFocus();
    await userEvent.keyboard('{End}');
    await expect(row(nav, /Retention/)).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}'); // the end holds
    await expect(row(nav, /Retention/)).toHaveFocus();
    await userEvent.keyboard('{Home}');
    await expect(row(nav, /Health/)).toHaveFocus();
    // The tab stop follows focus.
    await expect(row(nav, /Health/).tabIndex).toBe(0);

    // Type-ahead, and it's marked handled.
    let handled = 0;
    const count = (e: KeyboardEvent) => {
      if (e.defaultPrevented) handled++;
    };
    document.addEventListener('keydown', count);
    await userEvent.keyboard('r');
    await expect(row(nav, 'Rollovers')).toHaveFocus();
    await new Promise((r) => setTimeout(r, 600));
    await userEvent.keyboard('r');
    await expect(row(nav, /Retention/)).toHaveFocus();
    await new Promise((r) => setTimeout(r, 600));
    await userEvent.keyboard('co');
    await expect(row(nav, /Cost ledger/)).toHaveFocus();
    await userEvent.keyboard('r');
    await expect(row(nav, /Corpus/)).toHaveFocus();
    document.removeEventListener('keydown', count);
    await expect(handled).toBe(5); // r, r, c, o, r
    // A modified key is the page's (⌘K), never type-ahead.
    await userEvent.keyboard('{Meta>}k{/Meta}');
    await expect(row(nav, /Corpus/)).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    await expect(args.onSelect).toHaveBeenCalledWith('corpus');
    await expect(row(nav, /Corpus/)).toHaveAttribute('aria-current', 'true');

    // G and ? pass through to the keyboard layer (go-mode, the key sheet) when no type-ahead
    // run is under way — the middle list's rule. Mid-run they are ordinary letters.
    await new Promise((r) => setTimeout(r, 600));
    const seen: string[] = [];
    const see = (e: KeyboardEvent) => {
      if (!e.defaultPrevented) seen.push(e.key);
    };
    document.addEventListener('keydown', see);
    await userEvent.keyboard('g');
    await userEvent.keyboard('?');
    await expect(seen).toEqual(['g', '?']); // both left for the page
    await expect(row(nav, /Corpus/)).toHaveFocus(); // and neither moved the cursor
    await userEvent.keyboard('rolloverg'); // a run under way: g is type-ahead…
    await expect(seen).toEqual(['g', '?']); // …so it no longer reaches the page
    await expect(row(nav, 'Rollovers')).toHaveFocus();

    // A letter pressed again quickly is a run of one letter, not a search for "rr": it cycles
    // through the lanes starting with it, wrapping — the middle list's rule.
    await new Promise((r) => setTimeout(r, 600));
    await userEvent.keyboard('r');
    await expect(row(nav, /Retention/)).toHaveFocus();
    await userEvent.keyboard('r');
    await expect(row(nav, 'Rollovers')).toHaveFocus();
    await userEvent.keyboard('r');
    await expect(row(nav, /Retention/)).toHaveFocus();
    // G mid-run is still a letter, never go-mode.
    await userEvent.keyboard('g');
    await expect(seen).toEqual(['g', '?']);
    document.removeEventListener('keydown', see);
    (document.activeElement as HTMLElement | null)?.blur();
  },
};

/** The routing slot: each lane renders as the link the caller hands over; the pick still reports. */
export const LinkSlot: Story = {
  args: {
    // A router's link would go here. It handles the click itself, as this stand-in does — a bare
    // anchor would navigate the test's frame.
    link: (lane) => (
      // biome-ignore lint/a11y/useAnchorContent: the lane row renders its name into this element.
      <a href={`#lane-${lane.id}`} data-router-link="" onClick={(e) => e.preventDefault()} />
    ),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const health = canvas.getByRole('link', { name: /Health/ });
    await expect(health).toHaveAttribute('href', '#lane-health');
    await expect(health).toHaveAttribute('data-router-link');
    await expect(health).toHaveAttribute('aria-current', 'page');
    await expect(health).not.toHaveAttribute('type');
    await expect(canvas.queryAllByRole('button')).toHaveLength(0);
    await userEvent.click(canvas.getByRole('link', { name: /Weather/ }));
    await expect(args.onSelect).toHaveBeenCalledWith('weather');
  },
};

/** Seasons: a lead group with no kicker, the open season's solid status badge beside its lane. */
export const Seasons: Story = {
  args: {
    label: 'Seasons',
    groups: [
      {
        lanes: [
          { id: 'w27', label: 'Winter 2026–27', tail: <Badge tone="lit">Open</Badge> },
          { id: 'w26', label: 'Winter 2025–26' },
          { id: 'w25', label: 'Winter 2024–25' },
        ],
      },
      { label: 'Setup', lanes: [{ id: 'thresholds', label: 'Thresholds' }] },
    ],
  },
  render: (args) => <Controlled {...args} initial="w27" />,
  play: async ({ canvasElement }) => {
    const nav = within(canvasElement).getByRole('navigation', { name: 'Seasons' });
    // The lead group has no kicker, so the first lane is the column's first line.
    await expect(nav.querySelectorAll('[data-slot="lanes-kicker"]')).toHaveLength(1);
    const open = row(nav, /Winter 2026–27/);
    await expect(within(open).getByText('Open')).toBeVisible();
  },
};

/** What isn't navigation docks to the foot, over a hairline, in small type. */
export const Foot: Story = {
  args: { foot: 'Load 3 of 5 · Started 14:02' },
  play: async ({ canvasElement }) => {
    const nav = within(canvasElement).getByRole('navigation');
    const foot = part(nav, 'lanes-foot');
    await expect(foot.getBoundingClientRect().bottom).toBeCloseTo(
      nav.getBoundingClientRect().bottom,
      0,
    );
    await expect(getComputedStyle(foot).borderTopWidth).toBe('1px');
  },
};

// ── Junctions ────────────────────────────────────────────────────────────────────────────────

/**
 * Admin: rows are the lane step (28 px), 2 px apart; the selected lane's bar is 2 px, inset on its
 * left edge; names and counts sit 18 px in; a kicker is 8 px over its first row and 14 px under the
 * group before; the first kicker is 14 px under the column's top.
 */
export const Junction: Story = {
  play: async ({ canvasElement }) => {
    const px = (len: string) => resolvePx(canvasElement, len);
    const near = (a: number, b: number, what = '') =>
      expect(Math.abs(a - b), `${what}: ${a} vs ${b}`).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    const nav = within(canvasElement).getByRole('navigation');
    const health = row(nav, /Health/);
    const box = health.getBoundingClientRect();
    await expect(box.height).toBeCloseTo(px('var(--size-lane)'), 1);
    await expect(box.height).toBeCloseTo(px('1.75rem'), 1);
    // The inset bar: 2 px of the bright ink on the left edge.
    const shadow = getComputedStyle(health).boxShadow;
    await expect(shadow).toEqual(sameShadow({ lengths: [2, 0, 0, 0], inset: true }));
    await expect(colorsIn(shadow)).toContainEqual(sameColor(computedColor(nav, 'var(--fg)')));

    const label = part(health, 'lane-label').getBoundingClientRect();
    const count = part(health, 'lane-count').getBoundingClientRect();
    await near(label.left - box.left, px('var(--space-4_5)'), 'name inset');
    await near(box.right - count.right, px('var(--space-4_5)'), 'count inset');

    const ledger = row(nav, /Cost ledger/).getBoundingClientRect();
    await near(ledger.top - box.bottom, px('var(--space-0_5)'), 'row gap');

    // A kicker's line (its content box), not its padded box: junctions run content to content.
    const textRect = (el: Element) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      const [t, rt, b, l] = [st.paddingTop, st.paddingRight, st.paddingBottom, st.paddingLeft].map(
        parseFloat,
      ) as [number, number, number, number];
      return new DOMRect(r.left + l, r.top + t, r.width - l - rt, r.height - t - b);
    };
    const [first, second] = [
      ...nav.querySelectorAll<HTMLElement>('[data-slot="lanes-kicker"]'),
    ].map(textRect);
    await near(
      must(first).top - nav.getBoundingClientRect().top,
      px('var(--space-3_5)'),
      'column top',
    );
    // Kicker → its first row: 6 px of pad and the 2 px row gap.
    await near(box.top - must(first).bottom, px('0.5rem'), 'kicker to row');
    // The group before → the next kicker's text: the 2 px gap and 12 px of pad.
    await near(must(second).top - ledger.bottom, px('0.875rem'), 'group to kicker');
    // The kicker's text lines up with the lanes' names.
    await near(must(first).left, label.left, 'kicker aligns');
  },
};

// ── Matrix and four-up ───────────────────────────────────────────────────────────────────────

const ROWS = [
  { key: 'lane', label: 'Lane' },
  { key: 'on', label: 'On' },
  { key: 'dim', label: 'Dim' },
] as const;
const STATES = [
  { key: 'rest', label: 'Rest' },
  { key: 'hover', label: 'Hover' },
  { key: 'focus', label: 'Focus' },
] as const;

/** A lane, the selected lane and a dim lane, at rest, hovered and focused (one lit look). */
export const States: Story = {
  decorators: [(Story) => <div className="w-full">{Story()}</div>],
  render: () => (
    <StateMatrix
      rows={ROWS}
      states={STATES}
      cell={(kind, state) => (
        <div className="w-[12rem]" data-state-cell={`${kind}-${state}`}>
          <Lanes
            label={`${kind} ${state}`}
            className="pt-0"
            selected={kind === 'on' ? 'a' : undefined}
            groups={[
              {
                lanes: [
                  {
                    id: 'a',
                    label: 'Weather',
                    count: 1,
                    countTone: 'warn',
                    ...(kind === 'dim' ? { dim: true, count: undefined } : {}),
                  },
                ],
              },
            ]}
            link={() => <button type="button" data-state={state} />}
          />
        </div>
      )}
    />
  ),
  parameters: PSEUDO_STATES,
  play: async ({ canvasElement }) => {
    // The forced columns are for the eye (the pseudo-states addon doesn't run under Vitest). Every
    // resting lane's name and count pass AA on the ground they sit on — the plate included.
    for (const lane of canvasElement.querySelectorAll<HTMLElement>('[data-slot="lane"]')) {
      const plate = getComputedStyle(lane).backgroundColor;
      const ground = plate === 'rgba(0, 0, 0, 0)' ? ['var(--bg)'] : ['var(--bg)', plate];
      await expect(
        contrastBetween(lane, ground, [...ground, getComputedStyle(lane).color]),
      ).toBeGreaterThanOrEqual(4.5);
      const count = lane.querySelector<HTMLElement>('[data-slot="lane-count"]');
      if (count !== null)
        await expect(
          contrastBetween(lane, ground, [...ground, getComputedStyle(count).color]),
        ).toBeGreaterThanOrEqual(4.5);
    }
  },
};

/** The sidebar in all four maps. Admin only: the skater quads show the same lanes, unused there. */
export const FourUp: Story = {
  decorators: [(Story) => <div>{Story()}</div>],
  render: () => (
    <div className="flex h-[24rem] w-lanes">
      <Controlled label="Machinery" groups={MACHINERY} />
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const lanes = [...q.querySelectorAll<HTMLElement>('[data-slot="lane"]')];
      await expect(must(lanes[0]).getBoundingClientRect().height).toBeCloseTo(
        resolvePx(q, 'var(--size-lane)'),
        1,
      );
      for (const lane of lanes) {
        const plate = getComputedStyle(lane).backgroundColor;
        const ground = plate === 'rgba(0, 0, 0, 0)' ? ['var(--bg)'] : ['var(--bg)', plate];
        await expect(
          contrastBetween(lane, ground, [...ground, getComputedStyle(lane).color]),
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  },
};

// ── The Pre-Season Pass ─────────────────────────────────────────────────────────────────────────────
//
// The seasonal group the Corpus sidebar gains each July. While it waits on a person it wears the
// bracketed card (the founder's pick) at the top of the column, its meter at its foot; once every
// item in it is decided it folds to one plain line, kept so its decisions can be read again — and an
// undo that reopens one puts the card back.

const PASS = 'Pre-Season Pass';
/** Known features is the pass's third lane, but a record, not a queue: never in the meter. */
const KNOWN_FEATURES: Lane = { id: 'features', label: 'Known features', count: 12 };
const PASS_LANES: Lane[] = [
  { id: 'recurrence', label: 'Recurrence', count: 7 },
  { id: 'promotion', label: 'Promotion candidates', count: 3 },
  KNOWN_FEATURES,
];
/** While it is computed: no counts yet on the pass's own queues. */
const COMPUTING_LANES: Lane[] = [
  { id: 'recurrence', label: 'Recurrence' },
  { id: 'promotion', label: 'Promotion candidates' },
  KNOWN_FEATURES,
];
/** Done: nothing left open in its queues; every decision still there to read. */
const DONE_LANES: Lane[] = [
  { id: 'recurrence', label: 'Recurrence', dim: true },
  { id: 'promotion', label: 'Promotion candidates', dim: true },
  KNOWN_FEATURES,
];
const DONE = 'Done 14 Sep';

/** The pass's foot: its meter and that meter's line. It counts decisions, never conditions. */
function PassFoot({ decided, total }: { decided: number | null; total: number }) {
  return (
    <>
      <Meter value={decided} max={total} aria-label="Decided" />
      <span data-slot="pass-line" className="leading-none">
        {decided === null ? 'Being computed' : `${decided} of ${total} decided`}
      </span>
    </>
  );
}

const openPass = (lanes: Lane[] = PASS_LANES): LaneGroup => ({
  label: PASS,
  dress: 'bracketed',
  lanes,
  foot: <PassFoot decided={3} total={10} />,
});
const computingPass: LaneGroup = {
  label: PASS,
  dress: 'bracketed',
  lanes: COMPUTING_LANES,
  foot: <PassFoot decided={null} total={10} />,
};
const donePass = (open: boolean, onOpenChange: (open: boolean) => void): LaneGroup => ({
  label: PASS,
  lanes: DONE_LANES,
  collapsible: { open, onOpenChange, summary: DONE },
});

const TASKS: LaneGroup = {
  label: 'Tasks',
  lanes: [
    { id: 'duplicates', label: 'Duplicates', count: 283 },
    { id: 'names', label: 'Name conflicts', count: 412 },
    { id: 'classes', label: 'Class conflicts', count: 140 },
    { id: 'contested', label: 'Contested as water', count: 42 },
    { id: 'bays', label: 'Orphan bays', count: 61 },
    { id: 'refits', label: 'Chord re-fits', count: 7, countTone: 'warn' },
    { id: 'places', label: 'Place names', count: 237 },
  ],
};
const VIEWS: LaneGroup = {
  label: 'Views',
  lanes: [
    { id: 'opened', label: 'Opened recently' },
    { id: 'changed', label: 'Changed this week' },
  ],
};
const STANDING: LaneGroup = {
  label: 'Standing',
  lanes: [
    { id: 'all', label: 'All bodies' },
    { id: 'active', label: 'Active' },
    { id: 'dormant-inactive', label: 'Dormant · inactive' },
    { id: 'dormant-campaign', label: 'Dormant · not in campaign' },
    { id: 'dormant-moderator', label: 'Dormant · moderator' },
    { id: 'no-access', label: 'No public access' },
    { id: 'removed', label: 'Removed · rejected' },
  ],
};
const LIBRARY = [TASKS, VIEWS, STANDING];

/** Every lane state, inside the card: forced for the eye by the pseudo-states addon. */
const STATE_LANES: Lane[] = [
  { id: 'rest', label: 'At rest', count: 7 },
  { id: 'hover', label: 'Hovered', count: 3 },
  { id: 'focus', label: 'Focused', count: 5 },
  { id: 'on', label: 'Chosen', count: 4 },
  { id: 'dim', label: 'Nothing in it', dim: true },
  { id: 'warn', label: 'Waits on a person', count: 2, countTone: 'warn' },
  { id: 'bad', label: 'Failed', count: 1, countTone: 'bad' },
];

/** Rows as buttons that carry a forced state (`data-state`) for the pseudo-states addon. */
const forced =
  (states: Record<string, 'hover' | 'focus'>) =>
  (lane: Lane): ReactElement => <button type="button" data-state={states[lane.id]} />;

/** A sidebar column as the console draws it: the lanes' width, a hairline on its right. */
function Column({
  caption,
  height,
  children,
}: {
  caption: string;
  height: string;
  children: ReactNode;
}) {
  return (
    <figure className="m-0 flex w-lanes flex-col gap-(--space-2_5)">
      {/* Two lines kept for every caption, so columns side by side start level. */}
      <figcaption className={`${KICKER} min-h-[2lh]`}>{caption}</figcaption>
      <div
        data-column=""
        className="flex w-lanes border-0 border-r border-solid border-line"
        style={{ height }}
      >
        {children}
      </div>
    </figure>
  );
}

/**
 * The sidebar as a route holds it: the pass group's open state and the chosen lane are the caller's
 * (here, state; in the console, the URL).
 */
function CorpusSidebar({
  pass,
  initialOpen = false,
  initialSelected = 'active',
  passLast = false,
}: {
  pass: 'open' | 'computing' | 'done';
  initialOpen?: boolean;
  initialSelected?: string;
  passLast?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [selected, setSelected] = useState(initialSelected);
  const group =
    pass === 'open' ? openPass() : pass === 'computing' ? computingPass : donePass(open, setOpen);
  return (
    <Lanes
      label="Corpus"
      groups={passLast ? [...LIBRARY, group] : [group, ...LIBRARY]}
      selected={selected}
      onSelect={setSelected}
    />
  );
}

/** What a motion token computes to here: zero under reduced motion. */
const motion = (ms: number) =>
  matchMedia('(prefers-reduced-motion: reduce)').matches ? '0s' : `${ms / 1000}s`;

/** An element's box inside its padding: junctions run content to content. */
function innerRect(el: Element): DOMRect {
  const r = el.getBoundingClientRect();
  const st = getComputedStyle(el);
  const [t, rt, b, l] = [st.paddingTop, st.paddingRight, st.paddingBottom, st.paddingLeft].map(
    parseFloat,
  ) as [number, number, number, number];
  return new DOMRect(r.left + l, r.top + t, r.width - l - rt, r.height - t - b);
}

/** The box of an element's text: a lane-step line's kicker is the text, not its row. */
const textOf = (el: Element) => must(el.querySelector('[id]') ?? el).getBoundingClientRect();

/** A text is whole when its ink fits its box: a range measures the ink, cut or not. */
async function expectWhole(el: Element, what: string) {
  const ink = document.createRange();
  ink.selectNodeContents(el);
  await expect(ink.getBoundingClientRect().width, `${what} whole`).toBeLessThanOrEqual(
    el.getBoundingClientRect().width + JUNCTION_TOLERANCE_PX,
  );
}

/**
 * A folded line's kicker gives way only as far as it must: its box is its text's width or the
 * room beside the word, whichever is less — whole whenever the line has room for it. The room is
 * the line's content less the gap and the word, with the kicker's trailing tracking given back:
 * the design's rule, not the kicker's own margin, so a kicker that stops giving it back is caught.
 * The text's width is its own ink, so the claim holds under any renderer's glyph widths. They
 * differ: CI's Linux Chromium rounds each advance to a whole pixel, so "Pre-Season Pass" is 124 px
 * there and 123.6 on a Mac, and at the console's width it is cut by 0.8 px there and whole here.
 */
async function expectKickerGivesWay(line: HTMLElement) {
  const kicker = must(line.querySelector<HTMLElement>('[id]'));
  const word = part(line, 'lanes-line-summary');
  await faceLoaded(kicker, kicker.textContent ?? undefined);
  await faceLoaded(word, word.textContent ?? undefined);
  const ink = document.createRange();
  ink.selectNodeContents(kicker);
  const text = ink.getBoundingClientRect().width;
  const room =
    innerRect(line).width -
    parseFloat(getComputedStyle(line).columnGap) -
    word.getBoundingClientRect().width +
    parseFloat(getComputedStyle(kicker).letterSpacing);
  await expect(
    kicker.getBoundingClientRect().width,
    `the kicker whole or the room (text ${text}, room ${room})`,
  ).toBeGreaterThanOrEqual(Math.min(text, room) - JUNCTION_TOLERANCE_PX);
}

/** Everything painted under `el` up to `root`, bottom first: the ground its ink sits on. */
function groundUnder(el: HTMLElement, root: HTMLElement): string[] {
  const layers: string[] = [];
  for (let n: HTMLElement | null = el; n !== null && n !== root; n = n.parentElement) {
    const paint = getComputedStyle(n).backgroundColor;
    if (paint !== 'rgba(0, 0, 0, 0)') layers.unshift(paint);
  }
  return [computedColor(root, 'var(--bg)'), ...layers];
}

/** Every lane's name and count, and every folded line, pass AA on the ground they're painted on. */
async function expectLanesReadable(root: HTMLElement) {
  const inks = (el: HTMLElement) => [
    el,
    ...el.querySelectorAll<HTMLElement>(
      '[data-slot="lane-count"], [data-slot="lanes-line-summary"]',
    ),
  ];
  for (const row of root.querySelectorAll<HTMLElement>(
    '[data-slot="lane"], [data-slot="lanes-line"]',
  )) {
    const ground = groundUnder(row, root);
    for (const ink of inks(row))
      await expect(
        contrastBetween(row, ground, [...ground, getComputedStyle(ink).color]),
        ink.textContent ?? '',
      ).toBeGreaterThanOrEqual(4.5);
  }
}

const near = (a: number, b: number, what: string) =>
  expect(Math.abs(a - b), `${what}: ${a} vs ${b}`).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);

/** Every kicker, folded line, name and count on the column's 18 px line; rows the lane step. */
async function expectColumnLine(nav: HTMLElement) {
  const px = (len: string) => resolvePx(nav, len);
  const col = nav.getBoundingClientRect();
  for (const k of nav.querySelectorAll<HTMLElement>(
    '[data-slot="lanes-kicker"], [data-slot="lanes-line"]',
  )) {
    const text = k.dataset.slot === 'lanes-kicker' ? innerRect(k) : textOf(k);
    await near(text.left - col.left, px('var(--space-4_5)'), `${k.textContent} kicker inset`);
  }
  for (const lane of nav.querySelectorAll<HTMLElement>('[data-slot="lane"]')) {
    await near(
      lane.getBoundingClientRect().height,
      px('var(--size-lane)'),
      `${lane.textContent} height`,
    );
    const label = part(lane, 'lane-label').getBoundingClientRect();
    await near(label.left - col.left, px('var(--space-4_5)'), `${lane.textContent} name inset`);
    const count = lane.querySelector('[data-slot="lane-count"]');
    if (count !== null)
      await near(
        col.right - count.getBoundingClientRect().right,
        px('var(--space-4_5)'),
        `${lane.textContent} count inset`,
      );
  }
}

/**
 * The bracketed card's junctions: inset `space-2` from the column's sides and top; its kicker a
 * step under its top; its foot (the meter and its line) inside it, under its last lane.
 */
async function expectCard(nav: HTMLElement) {
  const px = (len: string) => resolvePx(nav, len);
  const col = nav.getBoundingClientRect();
  const group = must(nav.querySelector<HTMLElement>('[data-dress="bracketed"]'));
  const box = group.getBoundingClientRect();
  await near(box.left - col.left, px('var(--space-2)'), 'card left');
  await near(col.right - box.right, px('var(--space-2)'), 'card right');
  await near(box.top - col.top, px('var(--space-2)'), 'card top');
  await near(
    innerRect(part(group, 'lanes-kicker')).top - box.top,
    px('var(--space-3)'),
    'card top to kicker',
  );
  const foot = innerRect(part(group, 'lanes-group-foot'));
  const last = must([...group.querySelectorAll<HTMLElement>('[data-slot="lane"]')].at(-1));
  await near(
    foot.top - last.getBoundingClientRect().bottom,
    px('var(--space-0_5)') + px('var(--space-2_5)'),
    'last lane to foot',
  );
  await near(box.bottom - foot.bottom, px('var(--space-3)'), 'foot to card bottom');
  // The corner marks: thin, long and flush on the hairline — never the hover bracket's shape.
  const marks = getComputedStyle(group, '::after');
  await expect(marks.backgroundSize.split(', ')[0]).toBe(
    `${px('calc(2 * var(--stroke-tick))')}px ${px('var(--stroke-note)')}px`,
  );
  await expect(marks.top).toBe(`-${px('var(--stroke-hair)')}px`);
}

/**
 * A folded line's junctions: its text lands where a plain kicker's would — `space-3_5` under the
 * column's top when it leads, `space-3` and the row gap under the group before otherwise; the
 * chevron hangs in the gutter; the line is the lane step tall.
 */
async function expectLine(nav: HTMLElement) {
  const px = (len: string) => resolvePx(nav, len);
  const col = nav.getBoundingClientRect();
  const line = part(nav, 'lanes-line');
  const box = line.getBoundingClientRect();
  const text = textOf(line);
  await near(box.height, px('var(--size-lane)'), 'line height');
  const before = line.closest('[data-slot="lanes-group"]')?.previousElementSibling;
  if (before == null) await near(text.top - col.top, px('var(--space-3_5)'), 'column top to line');
  else {
    const lastRow = must([...before.querySelectorAll('[data-slot="lane"]')].at(-1));
    await near(
      text.top - lastRow.getBoundingClientRect().bottom,
      px('var(--space-0_5)') + px('var(--space-3)'),
      'group before to line',
    );
  }
  const chevron = part(line, 'collapsible-chevron').getBoundingClientRect();
  await expect(chevron.left).toBeGreaterThanOrEqual(col.left);
  // In the gutter, clear of the kicker (the chevron is the kick step wide, so wider on skater).
  await expect(chevron.right).toBeLessThanOrEqual(
    text.left - px('var(--space-0_5)') + JUNCTION_TOLERANCE_PX,
  );
  // The word is never cut, and ends where the counts end; short of room, the kicker gives way.
  const word = part(line, 'lanes-line-summary');
  await expectWhole(word, 'the word');
  await near(col.right - word.getBoundingClientRect().right, px('var(--space-4_5)'), 'word inset');
  await expect(text.right).toBeLessThanOrEqual(word.getBoundingClientRect().left);
  await expectKickerGivesWay(line);
}

/** The card, four-up: over the Tasks group, every lane state inside it, and while it is computed. */
function CardSheet() {
  return (
    <div className="flex flex-wrap gap-(--space-6)">
      <Column caption="In the sidebar" height="25rem">
        <Lanes label={`${PASS} and tasks`} groups={[openPass(), TASKS]} selected="duplicates" />
      </Column>
      <Column caption="Every state" height="25rem">
        <Lanes
          label={`${PASS} states`}
          groups={[openPass(STATE_LANES)]}
          selected="on"
          link={forced({ hover: 'hover', focus: 'focus' })}
        />
      </Column>
      <Column caption="Being computed" height="25rem">
        <Lanes label={`${PASS} computing`} groups={[computingPass, TASKS]} />
      </Column>
    </div>
  );
}

/**
 * **The bracketed card** (the founder's pick): the pass in the kit's `Plate` card, warn tone, inset
 * from the column's edges, its meter at its foot. Its corners are thin, long amber marks laid flush
 * on the hairline — the frame's own corners, never the short, thick hover bracket of a card you can
 * press. Every lane state carries over inside it; the rows give back the card's inset and hairline,
 * so the names keep the column's line. While the pass is computed nothing moves when its counts
 * and meter arrive.
 */
export const Bracketed: Story = {
  render: () => <CardSheet />,
  parameters: { fourUp: true, bare: true, ...PSEUDO_STATES },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const [sidebar, sheet, computing] = within(q).getAllByRole('navigation').map(must);
      for (const nav of [must(sidebar), must(computing)]) {
        await expectColumnLine(nav);
        await expectCard(nav);
      }
      await expect(within(must(sidebar)).getByRole('meter', { name: 'Decided' })).toHaveAttribute(
        'aria-valuenow',
        '3',
      );
      // Loading reserves the final size: the computing card is the open card's height.
      const card = (nav: HTMLElement) =>
        must(nav.querySelector('[data-dress]')).getBoundingClientRect();
      await near(card(must(computing)).height, card(must(sidebar)).height, 'computing card height');
      await expectLanesReadable(q);
      // The chosen lane inside the card: its plate and its 2 px bar.
      const on = within(must(sheet)).getByRole('button', { name: /Chosen/ });
      await expect(getComputedStyle(on).boxShadow).toEqual(
        sameShadow({ lengths: [2, 0, 0, 0], inset: true }),
      );
      await expect(colorsIn(getComputedStyle(on).boxShadow)).toContainEqual(
        sameColor(computedColor(on, 'var(--fg)')),
      );
      // Amber and red keep their meaning inside the card.
      const tone = (name: RegExp) =>
        getComputedStyle(part(within(must(sheet)).getByRole('button', { name }), 'lane-count'))
          .color;
      await expect(tone(/Waits on a person/)).toEqual(sameColor(computedColor(q, 'var(--warn)')));
      await expect(tone(/Failed/)).toEqual(sameColor(computedColor(q, 'var(--bad)')));
      await expect(getComputedStyle(on).transitionDuration).toBe(motion(tokens.duration.fast));
    }
  },
};

/** Done, four-up: the folded line, the group opened, and a folded line holding the chosen lane. */
function DoneSheet() {
  const [open, setOpen] = useState(true);
  const [shut, setShut] = useState(false);
  return (
    <div className="flex flex-wrap gap-(--space-6)">
      <Column caption="Collapsed" height="12rem">
        <Lanes
          label="Done, collapsed"
          groups={[donePass(false, () => {}), VIEWS]}
          selected="opened"
        />
      </Column>
      <Column caption="Expanded" height="12rem">
        <Lanes label="Done, expanded" groups={[donePass(open, setOpen), VIEWS]} selected="opened" />
      </Column>
      <Column caption="Collapsed, holding the chosen lane" height="12rem">
        <Lanes
          label="Done, holding the chosen lane"
          groups={[donePass(shut, setShut), VIEWS]}
          selected="promotion"
        />
      </Column>
    </div>
  );
}

/**
 * **Done**: the pass folds to one plain line — its kicker and *Done 14 Sep*, a chevron hung in the
 * gutter — with no card, no amber and no meter, quieter than the groups under it. Pressed, it opens
 * to its lanes, drawn as any plain group's; they still work. A folded line holding the chosen lane
 * takes the chosen look and names the lane, so the choice is never hidden — the longest name here,
 * so the kicker giving way to it is on the page, not discovered later.
 */
export const Done: Story = {
  render: () => <DoneSheet />,
  parameters: { fourUp: true, bare: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    for (const q of quads) {
      const [collapsed, expanded, holding] = within(q).getAllByRole('navigation').map(must);
      for (const nav of [must(collapsed), must(expanded), must(holding)]) {
        await expectColumnLine(nav);
        await expectLine(nav);
        // Finished is ordinary: no card, no foot, no meter, no amber.
        await expect(nav.querySelector('[data-dress], [data-slot="lanes-group-foot"]')).toBeNull();
        await expect(within(nav).queryByRole('meter')).toBeNull();
      }
      await expectLanesReadable(q);
      // The line is the button, named by its kicker and its word, and says whether it is open.
      const line = within(must(collapsed)).getByRole('button', {
        name: /Pre-Season Pass.*Done 14 Sep/,
      });
      await expect(line).toHaveAttribute('aria-expanded', 'false');
      await expect(getComputedStyle(line).color).toEqual(sameColor(computedColor(q, 'var(--fg3)')));
      await expect(
        within(must(collapsed)).queryByRole('button', { name: /Recurrence/ }),
      ).toBeNull();
      // Open, its lanes are a plain list named by the kicker, and they work.
      await expect(
        within(must(expanded)).getByRole('button', { name: /Pre-Season Pass/ }),
      ).toHaveAttribute('aria-expanded', 'true');
      await expect(within(must(expanded)).getByRole('list', { name: PASS })).toBeVisible();
      // Holding the chosen lane: the chosen look, the lane's name, and the tab stop.
      const held = within(must(holding)).getByRole('button', {
        name: /Pre-Season Pass.*Promotion candidates/,
      });
      await expect(held).toHaveAttribute('data-holds-selected');
      await expect(held.tabIndex).toBe(0);
      await expect(getComputedStyle(held).boxShadow).toEqual(
        sameShadow({ lengths: [2, 0, 0, 0], inset: true }),
      );
      await expect(getComputedStyle(held).backgroundColor).toEqual(
        sameColor(computedColor(q, 'var(--lift-08)')),
      );
    }
    // Opening the line that holds the chosen lane shows the lane, chosen; the line steps back.
    const holding = within(must(quads[0])).getAllByRole('navigation')[2] as HTMLElement;
    const line = within(holding).getByRole('button', { name: /Pre-Season Pass/ });
    await userEvent.click(line);
    await waitFor(() =>
      expect(within(holding).getByRole('button', { name: /Promotion candidates/ })).toHaveAttribute(
        'aria-current',
        'true',
      ),
    );
    await expect(line).not.toHaveAttribute('data-holds-selected');
    await expect(part(holding, 'lanes-line-summary')).toHaveTextContent(DONE);
    // Folded again, the line holds it again: the sheet ends as it began.
    await userEvent.click(line);
    await waitFor(() => expect(line).toHaveAttribute('data-holds-selected'));
    await transitionsDone(holding, { subtree: true });
    line.blur();
  },
};

/** An in-context story: the whole Corpus sidebar at the console's lanes width, one state. */
const inContext = (
  caption: string,
  props: Parameters<typeof CorpusSidebar>[0],
  play: Story['play'],
): Story => ({
  render: () => (
    <Column caption={caption} height="49rem">
      <CorpusSidebar {...props} />
    </Column>
  ),
  parameters: { bare: true },
  play,
});

const groupOrder = (nav: HTMLElement) =>
  [...nav.querySelectorAll('[data-slot="lanes-kicker"], [data-slot="lanes-line"] [id]')].map(
    (k) => k.textContent,
  );

/** Open: the bracketed card at the top, Known features its third lane, outside the meter. */
export const PassOpen: Story = inContext('Open', { pass: 'open' }, async ({ canvasElement }) => {
  const nav = within(canvasElement).getByRole('navigation');
  await expectColumnLine(nav);
  await expectCard(nav);
  await expectLanesReadable(canvasElement);
  await expect(groupOrder(nav)).toEqual([PASS, 'Tasks', 'Views', 'Standing']);
  const pass = within(nav).getByRole('list', { name: PASS });
  await expect(
    within(pass)
      .getAllByRole('button')
      .map((b) => part(b, 'lane-label').textContent),
  ).toEqual(['Recurrence', 'Promotion candidates', 'Known features']);
  await expect(within(nav).getByRole('meter', { name: 'Decided' })).toHaveAttribute(
    'aria-valuemax',
    '10',
  );
  // The keys cross the card like any group.
  await userEvent.click(within(nav).getByRole('button', { name: /Known features/ }));
  await userEvent.keyboard('{ArrowDown}');
  await waitFor(() =>
    expect(within(nav).getByRole('button', { name: /Duplicates/ })).toHaveFocus(),
  );
  await userEvent.keyboard('{Home}');
  await waitFor(() =>
    expect(within(nav).getByRole('button', { name: /Recurrence/ })).toHaveFocus(),
  );
  (document.activeElement as HTMLElement | null)?.blur();
});

/** Being computed: the card and its lanes in place, no counts and no fill yet. */
export const PassBeingComputed: Story = inContext(
  'Being computed',
  { pass: 'computing' },
  async ({ canvasElement }) => {
    const nav = within(canvasElement).getByRole('navigation');
    await expectColumnLine(nav);
    await expectCard(nav);
    await expectLanesReadable(canvasElement);
    await expect(within(nav).getByText('Being computed')).toBeVisible();
    await expect(within(nav).queryByRole('meter')).toBeNull();
  },
);

/**
 * Done, collapsed: one plain line at the top. The keys take the line into their run and skip the
 * folded lanes; pressing the line opens the group, and only the group's own height moves the rest.
 */
export const PassDoneCollapsed: Story = inContext(
  'Done, collapsed',
  { pass: 'done' },
  async ({ canvasElement }) => {
    const nav = within(canvasElement).getByRole('navigation');
    const button = (name: RegExp) => within(nav).getByRole('button', { name });
    await expectColumnLine(nav);
    await expectLine(nav);
    await expectLanesReadable(canvasElement);
    const line = button(/Pre-Season Pass/);
    await expect(line).toHaveAttribute('aria-expanded', 'false');
    // At the console's width the word is whole and the kicker gives way only as far as it must
    // (`expectLine`): whole on a Mac, 0.8 px short under CI's whole-pixel glyphs.
    // Keyboard: the line is in the run, its folded lanes are not.
    button(/Duplicates/).focus();
    await userEvent.keyboard('{ArrowUp}');
    await waitFor(() => expect(line).toHaveFocus());
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(button(/Duplicates/)).toHaveFocus());
    await userEvent.keyboard('k'); // only a folded lane starts with K: nothing moves
    await expect(button(/Duplicates/)).toHaveFocus();
    await new Promise((r) => setTimeout(r, 600));
    await userEvent.keyboard('p');
    await waitFor(() => expect(button(/Place names/)).toHaveFocus());
    await new Promise((r) => setTimeout(r, 600));
    await userEvent.keyboard('p'); // past the end, round to the line
    await waitFor(() => expect(line).toHaveFocus());
    // Opening it moves what is under it by the group's own height, no more.
    const tasks = must(nav.querySelectorAll<HTMLElement>('[data-slot="lanes-kicker"]')[0]);
    const before = tasks.getBoundingClientRect().top;
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(line).toHaveAttribute('aria-expanded', 'true'));
    const panel = part(nav, 'collapsible-content');
    await expect(getComputedStyle(panel).transitionDuration).toBe(motion(tokens.duration.base));
    await transitionsDone(nav, { subtree: true });
    await near(
      tasks.getBoundingClientRect().top - before,
      panel.getBoundingClientRect().height + resolvePx(nav, 'var(--space-0_5)'),
      'only the group grows',
    );
    // Open, its lanes join the run.
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(button(/Recurrence/)).toHaveFocus());
    // Folded again, everything under it is back where it was: the story ends as it began.
    await userEvent.keyboard('{ArrowUp}{Enter}');
    await waitFor(() => expect(line).toHaveAttribute('aria-expanded', 'false'));
    await transitionsDone(nav, { subtree: true });
    await near(tasks.getBoundingClientRect().top, before, 'folded again');
    line.blur();
  },
);

/** Done, opened, a lane in it chosen: an ordinary group under its line. */
export const PassDoneExpanded: Story = inContext(
  'Done, expanded, a lane chosen',
  { pass: 'done', initialOpen: true, initialSelected: 'recurrence' },
  async ({ canvasElement }) => {
    const nav = within(canvasElement).getByRole('navigation');
    await expectColumnLine(nav);
    await expectLine(nav);
    await expectLanesReadable(canvasElement);
    await expect(within(nav).getByRole('button', { name: /Recurrence/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(part(nav, 'lanes-line')).not.toHaveAttribute('data-holds-selected');
    // Pressing a lane in a done pass works as any lane does.
    await userEvent.click(within(nav).getByRole('button', { name: /Known features/ }));
    await expect(within(nav).getByRole('button', { name: /Known features/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    (document.activeElement as HTMLElement | null)?.blur();
  },
);

/** For the founder's eye: done and collapsed at the bottom, since a finished line may not earn the top. */
export const PassDoneAtBottom: Story = inContext(
  'Done, collapsed, at the bottom',
  { pass: 'done', passLast: true },
  async ({ canvasElement }) => {
    const nav = within(canvasElement).getByRole('navigation');
    await expectColumnLine(nav);
    await expectLine(nav);
    await expectLanesReadable(canvasElement);
    await expect(groupOrder(nav)).toEqual(['Tasks', 'Views', 'Standing', PASS]);
  },
);

/** An undo reopens a finished pass: the same group goes from the folded line back to the card, open. */
export const PassReopened: Story = {
  render: () => (
    <div className="flex flex-wrap gap-(--space-8)">
      <Column caption="Done" height="24rem">
        <CorpusSidebar pass="done" />
      </Column>
      <Column caption="Reopened by an undo" height="24rem">
        <CorpusSidebar pass="open" />
      </Column>
    </div>
  ),
  parameters: { bare: true },
  play: async ({ canvasElement }) => {
    const [done, reopened] = within(canvasElement).getAllByRole('navigation').map(must);
    await expect(must(done).querySelector('[data-slot="lanes-group"]')).toHaveAttribute(
      'data-collapsible',
    );
    const card = must(must(reopened).querySelector<HTMLElement>('[data-slot="lanes-group"]'));
    await expect(card).toHaveAttribute('data-dress', 'bracketed');
    await expect(within(card).getAllByRole('button')).toHaveLength(3);
    await expectCard(must(reopened));
  },
};
