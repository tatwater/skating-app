import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';

import { Badge, Tag } from './badge';
import { type LaneGroup, Lanes, type LanesProps } from './lanes';
import { computedColor, contrastBetween, JUNCTION_TOLERANCE_PX, resolvePx } from './measure';
import { must, PSEUDO_STATES, StateMatrix } from './storyKit';

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
    (Story) => (
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
    await expect(getComputedStyle(health).color).toBe(computedColor(nav, 'var(--fg)'));
    await expect(getComputedStyle(health).backgroundColor).toBe(
      computedColor(nav, 'var(--lift-08)'),
    );
    // On, every count reads lit; elsewhere, by meaning.
    const tone = (name: RegExp) => part(row(nav, name), 'lane-count').dataset.tone;
    await expect(tone(/Health/)).toBe('lit');
    await expect(tone(/Corpus/)).toBe('warn');
    await expect(tone(/Retention/)).toBe('bad');
    await expect(tone(/Notifications/)).toBe('default');
    await expect(getComputedStyle(part(row(nav, /Corpus/), 'lane-count')).color).toBe(
      computedColor(nav, 'var(--warn)'),
    );
    await expect(getComputedStyle(part(row(nav, /Corpus/), 'lane-count')).fontFamily).toMatch(
      /Martian Mono/,
    );
    // A dim lane is the quiet ink, still a lane.
    const roll = row(nav, 'Rollovers');
    await expect(getComputedStyle(roll).color).toBe(computedColor(nav, 'var(--fg3)'));
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
    row(nav, /Corpus/).blur();
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
    await expect(shadow).toMatch(/inset/);
    await expect(shadow).toMatch(/2px 0px 0px 0px/);
    await expect(shadow).toContain(computedColor(nav, 'var(--fg)'));

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
