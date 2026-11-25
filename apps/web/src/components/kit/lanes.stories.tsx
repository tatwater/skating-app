import * as tokens from '@skating/design/tokens';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactElement, type ReactNode, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { Badge, Tag } from './badge';
import { LANE_DRESSES, type LaneDress } from './lane-dress';
import { type Lane, type LaneGroup, Lanes, type LanesProps } from './lanes';
import {
  colorsIn,
  computedColor,
  contrastBetween,
  JUNCTION_TOLERANCE_PX,
  resolvePx,
  sameColor,
  sameShadow,
} from './measure';
import { Meter } from './meter';
import { KICKER, must, PSEUDO_STATES, StateMatrix } from './storyKit';

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

// ── The Pre-Season Pass: its dress, candidates for the founder ─────────────────────────────────────
//
// The seasonal group the Corpus sidebar gains each July and loses once every item in it is decided,
// dressed apart from the plain groups. Four dresses, one story each (four-up), and each in the whole
// Corpus sidebar at the console's width. None is picked; the unpicked ones go when the pick ships.

const PASS = 'Pre-Season Pass';
const PASS_LANES: Lane[] = [
  { id: 'recurrence', label: 'Recurrence', count: 7 },
  { id: 'promotion', label: 'Promotion candidates', count: 3 },
];

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

const passGroup = (
  dress: LaneDress,
  { lanes = PASS_LANES, decided = 3 }: { lanes?: Lane[]; decided?: number | null } = {},
): LaneGroup => ({
  label: PASS,
  dress,
  lanes,
  foot: <PassFoot decided={decided} total={10} />,
  // The taped dress carries its urgency in a badge in the kicker's row.
  ...(dress === 'taped' && { tail: <Badge tone="warn">Due</Badge> }),
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
    { id: 'features', label: 'Known features', count: 12 },
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

/** Every lane state, inside the dress: forced for the eye by the pseudo-states addon. */
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

/** The dress, four-up: the pass over the Tasks group, and every lane state inside the dress. */
function PassDressSheet({ dress }: { dress: LaneDress }) {
  return (
    <div className="flex flex-wrap gap-(--space-6)">
      <Column caption="In the sidebar" height="24rem">
        <Lanes
          label={`${PASS} and tasks`}
          groups={[passGroup(dress), TASKS]}
          selected="duplicates"
        />
      </Column>
      <Column caption="Every state" height="24rem">
        <Lanes
          label={`${PASS} states`}
          groups={[{ ...passGroup(dress), lanes: STATE_LANES }]}
          selected="on"
          link={forced({ hover: 'hover', focus: 'focus' })}
        />
      </Column>
    </div>
  );
}

/** The Corpus sidebar whole, at the console's width: Active chosen, then a pass lane chosen. */
function CorpusSidebar({ dress }: { dress: LaneDress }) {
  return (
    <div className="flex flex-wrap gap-(--space-8)">
      <Column caption="Active chosen" height="49rem">
        <Lanes
          label="Corpus"
          groups={[passGroup(dress), TASKS, VIEWS, STANDING]}
          selected="active"
        />
      </Column>
      <Column caption="Recurrence chosen, the next focused" height="49rem">
        <Lanes
          label="Corpus, a pass lane chosen"
          groups={[passGroup(dress), TASKS, VIEWS, STANDING]}
          selected="recurrence"
          link={forced({ promotion: 'focus' })}
        />
      </Column>
    </div>
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

/** Everything painted under `el` up to `root`, bottom first: the ground its ink sits on. */
function groundUnder(el: HTMLElement, root: HTMLElement): string[] {
  const layers: string[] = [];
  for (let n: HTMLElement | null = el; n !== null && n !== root; n = n.parentElement) {
    const paint = getComputedStyle(n).backgroundColor;
    if (paint !== 'rgba(0, 0, 0, 0)') layers.unshift(paint);
  }
  // The field as the root has it: inside the inverted plate `--bg` is the plate's.
  return [computedColor(root, 'var(--bg)'), ...layers];
}

/** Every lane's name and count pass AA on the ground they're painted on, dress and plate included. */
async function expectLanesReadable(root: HTMLElement) {
  for (const lane of root.querySelectorAll<HTMLElement>('[data-slot="lane"]')) {
    const ground = groundUnder(lane, root);
    const name = lane.textContent ?? '';
    await expect(
      contrastBetween(lane, ground, [...ground, getComputedStyle(lane).color]),
      name,
    ).toBeGreaterThanOrEqual(4.5);
    const count = lane.querySelector<HTMLElement>('[data-slot="lane-count"]');
    if (count !== null)
      await expect(
        contrastBetween(lane, ground, [...ground, getComputedStyle(count).color]),
        `${name} count`,
      ).toBeGreaterThanOrEqual(4.5);
  }
}

/**
 * The dress's junctions, in one sidebar: the dressed group's kicker, names and counts keep the
 * column's 18 px line, the plain groups' line; rows stay the lane step; the meter and its line sit
 * inside the dress, under the lanes.
 */
async function expectDressJunctions(nav: HTMLElement, dress: LaneDress) {
  const px = (len: string) => resolvePx(nav, len);
  const near = (a: number, b: number, what: string) =>
    expect(Math.abs(a - b), `${what}: ${a} vs ${b}`).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  const col = nav.getBoundingClientRect();
  const group = must(nav.querySelector<HTMLElement>(`[data-dress="${dress}"]`));
  const box = group.getBoundingClientRect();
  const kickers = [...nav.querySelectorAll<HTMLElement>('[data-slot="lanes-kicker"] > span[id]')];
  for (const k of kickers)
    await near(
      k.getBoundingClientRect().left - col.left,
      px('var(--space-4_5)'),
      `${k.textContent} kicker inset`,
    );
  for (const lane of nav.querySelectorAll<HTMLElement>('[data-slot="lane"]')) {
    const r = lane.getBoundingClientRect();
    await near(r.height, px('var(--size-lane)'), `${lane.textContent} height`);
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
  // The foot is the group's: inside its dress, under its last lane.
  const foot = innerRect(part(group, 'lanes-group-foot'));
  const lanes = [...group.querySelectorAll<HTMLElement>('[data-slot="lane"]')];
  const last = must(lanes.at(-1)).getBoundingClientRect();
  await near(
    foot.top - last.bottom,
    px('var(--space-0_5)') + px('var(--space-2_5)'),
    'last lane to foot',
  );
  await expect(foot.bottom).toBeLessThanOrEqual(box.bottom + JUNCTION_TOLERANCE_PX);
  await expect(within(group).getByRole('meter', { name: 'Decided' })).toHaveAttribute(
    'aria-valuenow',
    '3',
  );
  if (dress === 'edge') {
    // The rule on the column's edge; the rows step in past its gutter, so a chosen lane's own bar
    // never touches it.
    await near(box.left, col.left, 'rule on the edge');
    await near(
      parseFloat(getComputedStyle(group).borderInlineStartWidth),
      px('var(--stroke-note)'),
      'rule width',
    );
    // Its kicker sits where a leading plain kicker would: a step under the column's top.
    await near(
      innerRect(part(group, 'lanes-kicker')).top - col.top,
      px('var(--space-3_5)'),
      'column top to kicker',
    );
    await near(
      must(lanes[0]).getBoundingClientRect().left - col.left,
      px('var(--stroke-note)') + px('var(--space-2)'),
      'rows past the gutter',
    );
  } else {
    // A box inset as far from the column's top as from its sides.
    await near(box.left - col.left, px('var(--space-2)'), 'box left');
    await near(col.right - box.right, px('var(--space-2)'), 'box right');
    await near(box.top - col.top, px('var(--space-2)'), 'box top');
    // The kicker's text sits a step under the box's top, as a plain kicker sits under the group before.
    const kicker = innerRect(part(group, 'lanes-kicker'));
    await near(kicker.top - box.top, px('var(--space-3)'), 'box top to kicker');
  }
}

const passDressStory = (dress: LaneDress): Story => ({
  render: () => <PassDressSheet dress={dress} />,
  parameters: { fourUp: true, bare: true, ...PSEUDO_STATES },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const [sidebar, sheet] = within(q).getAllByRole('navigation');
      await expectDressJunctions(must(sidebar), dress);
      await expectLanesReadable(q);
      // A badge in the kicker's row never makes the row taller.
      const [passKicker, tasksKicker] = [
        ...must(sidebar).querySelectorAll<HTMLElement>('[data-slot="lanes-kicker"]'),
      ].map(innerRect);
      await expect(must(passKicker).height).toBeCloseTo(must(tasksKicker).height, 1);
      // The list is named by the kicker alone, never the badge beside it.
      await expect(within(must(sidebar)).getByRole('list', { name: PASS })).toBeVisible();
      // The chosen lane inside the dress: its plate and its 2 px bar, in the dress's own bright ink.
      const on = within(must(sheet)).getByRole('button', { name: /Chosen/ });
      const group = must(on.closest<HTMLElement>('[data-dress]'));
      await expect(getComputedStyle(on).boxShadow).toEqual(
        sameShadow({ lengths: [2, 0, 0, 0], inset: true }),
      );
      await expect(colorsIn(getComputedStyle(on).boxShadow)).toContainEqual(
        sameColor(computedColor(group, 'var(--fg)')),
      );
      await expect(getComputedStyle(on).backgroundColor).toEqual(
        sameColor(computedColor(group, 'var(--lift-08)')),
      );
      // Amber and red keep their meaning inside the dress.
      const tone = (name: RegExp) =>
        getComputedStyle(part(within(must(sheet)).getByRole('button', { name }), 'lane-count'))
          .color;
      await expect(tone(/Waits on a person/)).toEqual(
        sameColor(computedColor(group, 'var(--warn)')),
      );
      await expect(tone(/Failed/)).toEqual(sameColor(computedColor(group, 'var(--bad)')));
      // Hover and focus ride the motion tokens: zero under reduced motion.
      await expect(getComputedStyle(on).transitionDuration).toBe(motion(tokens.duration.fast));
    }
  },
});

/**
 * **The inverted plate.** The pass on the inverted ground, inset from the column's edges, square:
 * a label stuck onto the sidebar, and its loudest thing. Inside it every lane state is the other
 * mode's own — the plate rebinds the inks, washes and accents to the `inv-*` tokens — so the
 * hover wash, the chosen plate and its bar, the focus ring, dim and the amber and red counts all
 * carry over with their contrast.
 */
export const PassDressInverted: Story = {
  ...passDressStory('inverted'),
  play: async (context) => {
    await passDressStory('inverted').play?.(context);
    for (const q of context.canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')) {
      for (const group of q.querySelectorAll<HTMLElement>('[data-dress="inverted"]')) {
        await expect(getComputedStyle(group).backgroundColor).toEqual(
          sameColor(computedColor(q, 'var(--inv-bg)')),
        );
        for (const key of ['fg', 'fg1', 'fg2', 'fg3', 'warn', 'bad', 'lift-05', 'lift-08', 'line'])
          await expect(computedColor(group, `var(--${key})`), key).toEqual(
            sameColor(computedColor(q, `var(--inv-${key})`)),
          );
      }
    }
  },
};

/**
 * **The bracketed card.** The pass in the kit's `Plate` card, warn tone: a hairline box with amber
 * corner ticks, the console's mark for the thing being worked on. The rows give back the box's
 * inset and border, so the names keep the column's line.
 */
export const PassDressBracketed: Story = passDressStory('bracketed');

/**
 * **The taped outline.** An amber die line round the pass, a long dash (6 on, 4 off) drawn rather
 * than a CSS dashed border, whose short dash already means “nothing to draw” and “dim” in this
 * console; a solid amber *Due* in the kicker's row; the meter under the lanes.
 */
export const PassDressTaped: Story = passDressStory('taped');

/**
 * **The amber edge.** No box: a 2 px amber rule down the column's own left edge, the amber tint
 * behind the group, the kicker in amber, the meter its last row. The rows step in past a gutter,
 * so the chosen lane's own 2 px bar stands clear of the rule.
 */
export const PassDressEdge: Story = passDressStory('edge');

/** While the pass is being computed: no counts, no fill — and nothing moves when they arrive. */
export const PassBeingComputed: Story = {
  parameters: { bare: true },
  render: () => (
    <div className="flex flex-wrap gap-(--space-6)">
      {(Object.keys(LANE_DRESSES) as LaneDress[]).flatMap((dress) =>
        [3, null].map((decided) => (
          <Column
            key={`${dress}-${decided}`}
            caption={`${dress} · ${decided === null ? 'computing' : 'open'}`}
            height="12rem"
          >
            <Lanes
              label={`${dress} ${decided === null ? 'computing' : 'open'}`}
              groups={[
                passGroup(dress, {
                  decided,
                  lanes: decided === null ? PASS_LANES.map(({ count: _, ...l }) => l) : PASS_LANES,
                }),
              ]}
            />
          </Column>
        )),
      )}
    </div>
  ),
  play: async ({ canvasElement }) => {
    for (const dress of Object.keys(LANE_DRESSES)) {
      const [open, computing] = [
        ...canvasElement.querySelectorAll<HTMLElement>(`[data-dress="${dress}"]`),
      ].map((g) => g.getBoundingClientRect());
      await expect(must(computing).height, dress).toBeCloseTo(must(open).height, 1);
      await expect(must(computing).width, dress).toBeCloseTo(must(open).width, 1);
    }
    await expect(within(canvasElement).getAllByText('Being computed')).toHaveLength(4);
  },
};

/**
 * The whole Corpus sidebar in a dress, at the console's lanes width: the pass over Tasks, Views
 * and Standing. Left, the library's Active chosen; right, a lane inside the pass chosen and the next
 * one focused — where the dresses differ most. The keys cross the dress like any group.
 */
const inContextStory = (dress: LaneDress): Story => ({
  render: () => <CorpusSidebar dress={dress} />,
  parameters: { bare: true, ...PSEUDO_STATES },
  play: async ({ canvasElement }) => {
    const [library, pass] = within(canvasElement).getAllByRole('navigation');
    for (const nav of [must(library), must(pass)]) await expectDressJunctions(nav, dress);
    await expectLanesReadable(canvasElement);
    // The pass leads the column; the sidebar's groups keep their order and their kickers.
    await expect(
      [...must(library).querySelectorAll('[data-slot="lanes-kicker"] > span[id]')].map(
        (k) => k.textContent,
      ),
    ).toEqual([PASS, 'Tasks', 'Views', 'Standing']);
    // Keys: Tab lands on the chosen pass lane; ↓ moves within the dress, then out of it.
    const nav = must(pass);
    const button = (name: RegExp) => within(nav).getByRole('button', { name });
    await userEvent.click(button(/Recurrence/));
    await expect(button(/Recurrence/)).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(button(/Promotion candidates/)).toHaveFocus());
    const promotion = button(/Promotion candidates/);
    const group = must(promotion.closest<HTMLElement>('[data-dress]'));
    // The focus ring: 1 px, inset, in the dress's own bright ink (the box shadow isn't transitioned).
    await expect(colorsIn(getComputedStyle(promotion).boxShadow)).toContainEqual(
      sameColor(computedColor(group, 'var(--fg)')),
    );
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(button(/Duplicates/)).toHaveFocus());
    await userEvent.keyboard('{Home}');
    await waitFor(() => expect(button(/Recurrence/)).toHaveFocus());
    (document.activeElement as HTMLElement | null)?.blur();
  },
});

export const InContextInverted: Story = inContextStory('inverted');
export const InContextBracketed: Story = inContextStory('bracketed');
export const InContextTaped: Story = inContextStory('taped');
export const InContextEdge: Story = inContextStory('edge');
