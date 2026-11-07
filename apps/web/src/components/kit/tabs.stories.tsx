import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import {
  computedColor,
  contrastBetween,
  focusRing,
  JUNCTION_TOLERANCE_PX,
  resolvePx,
  sameColor,
} from './measure';
import { KICKER, must, PSEUDO_STATES, StateMatrix } from './storyKit';
import { Tabs, TabsList, TabsPanel, TabsTab } from './tabs';

const meta = {
  title: 'Kit/Tabs',
  component: Tabs,
  tags: ['autodocs'],
  args: { defaultValue: 'home', onValueChange: fn() },
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Overview's two tabs: joined boxes, the chosen one filled. Clicking moves the plate. */
export const Joined: Story = {
  render: (args) => (
    <Tabs {...args}>
      <TabsList aria-label="Overview">
        <TabsTab value="home">Home</TabsTab>
        <TabsTab value="metrics">Metrics</TabsTab>
      </TabsList>
      <TabsPanel value="home" className="text-row text-fg2">
        The day at a glance
      </TabsPanel>
      <TabsPanel value="metrics" className="text-row text-fg2">
        The season in numbers
      </TabsPanel>
    </Tabs>
  ),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const home = canvas.getByRole('tab', { name: 'Home' });
    const metrics = canvas.getByRole('tab', { name: 'Metrics' });
    await expect(home).toHaveAttribute('aria-selected', 'true');
    // Filled, not a pill, not underlined.
    const style = getComputedStyle(home);
    await expect(style.backgroundColor).toEqual(sameColor(computedColor(home, 'var(--fg1)')));
    await expect(style.textDecorationLine).toBe('none');
    await expect(style.boxShadow).toBe('none');
    await userEvent.click(metrics);
    await expect(metrics).toHaveAttribute('aria-selected', 'true');
    await expect(args.onValueChange).toHaveBeenCalledOnce();
    await expect(canvas.getByText('The season in numbers')).toBeVisible();
  },
};

/** The Body inspector's grid: equal cells over a hairline lattice; a gap flag on one. */
export const Grid: Story = {
  args: { defaultValue: 'shape' },
  render: (args) => (
    <Tabs {...args} className="w-[23.75rem]">
      <TabsList variant="grid" aria-label="Body">
        <TabsTab value="shape">Shape</TabsTab>
        <TabsTab value="places">Places</TabsTab>
        <TabsTab value="access">Access</TabsTab>
        <TabsTab value="water" flag="Missing bathymetry">
          Water
        </TabsTab>
        <TabsTab value="hazards">Hazards</TabsTab>
        <TabsTab value="names">Names</TabsTab>
      </TabsList>
    </Tabs>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const water = canvas.getByRole('tab', { name: 'Water (Missing bathymetry)' });
    const flag = must(water.querySelector('[data-slot="tabs-flag"]'));
    await expect(getComputedStyle(flag).backgroundColor).toEqual(
      sameColor(computedColor(flag, 'var(--warn)')),
    );
  },
};

/** Arrow keys move along the row; Enter chooses (activation waits for intent). */
export const Keyboard: Story = {
  ...Joined,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const home = canvas.getByRole('tab', { name: 'Home' });
    home.focus();
    await userEvent.keyboard('{ArrowRight}');
    const metrics = canvas.getByRole('tab', { name: 'Metrics' });
    await expect(metrics).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(metrics).toHaveAttribute('aria-selected', 'true');
  },
};

/** A tab that can't be chosen yet: the disabled ink; clicking does nothing. */
export const DisabledTab: Story = {
  render: (args) => (
    <Tabs {...args}>
      <TabsList aria-label="Overview">
        <TabsTab value="home">Home</TabsTab>
        <TabsTab value="metrics" disabled>
          Metrics
        </TabsTab>
      </TabsList>
    </Tabs>
  ),
  play: async ({ canvasElement, args }) => {
    const metrics = within(canvasElement).getByRole('tab', { name: 'Metrics' });
    await userEvent.click(metrics, { pointerEventsCheck: 0 });
    await expect(args.onValueChange).not.toHaveBeenCalled();
    await expect(getComputedStyle(metrics).color).toEqual(
      sameColor(computedColor(metrics, 'var(--fg-disabled)')),
    );
  },
};

// ── Matrix and four-up ────────────────────────────────────────────────────────────────────────

const ROWS = [
  { key: 'joined', label: 'Joined' },
  { key: 'grid', label: 'Grid' },
] as const;
const STATES = [
  { key: 'rest', label: 'Rest' },
  { key: 'hover', label: 'Hover' },
  { key: 'focus', label: 'Focus' },
  { key: 'active', label: 'Pressed' },
  { key: 'disabled', label: 'Disabled' },
] as const;

/** The unchosen tab in each state, beside the chosen one, in both rows. */
export const States: Story = {
  render: () => (
    <StateMatrix
      rows={ROWS}
      states={STATES}
      cell={(variant, state) => (
        <Tabs defaultValue="a" className="w-[12rem]">
          <TabsList variant={variant} columns={2} aria-label={`${variant} ${state}`}>
            <TabsTab value="a">Home</TabsTab>
            <TabsTab value="b" data-state={state} disabled={state === 'disabled'}>
              Metrics
            </TabsTab>
          </TabsList>
        </Tabs>
      )}
    />
  ),
  parameters: PSEUDO_STATES,
  play: async ({ canvasElement }) => {
    // The chosen plate and the resting word both pass AA on what they sit on.
    for (const tab of canvasElement.querySelectorAll<HTMLElement>('[data-slot="tabs-tab"]')) {
      if (tab.hasAttribute('data-disabled')) continue;
      const bg = getComputedStyle(tab).backgroundColor;
      const ground = bg === 'rgba(0, 0, 0, 0)' ? ['var(--bg)'] : ['var(--bg)', bg];
      const ratio = contrastBetween(tab, ground, [...ground, getComputedStyle(tab).color]);
      await expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
  },
};

/** Keyboard focus draws the ring over the joined edge and lights the word, as hover does. */
export const FocusLights: Story = {
  ...Joined,
  play: async ({ canvasElement }) => {
    const metrics = within(canvasElement).getByRole('tab', { name: 'Metrics' });
    const lit = computedColor(metrics, 'var(--fg1)');
    metrics.focus();
    await waitFor(() => expect(getComputedStyle(metrics).boxShadow).toEqual(focusRing()));
    await waitFor(() => expect(getComputedStyle(metrics).color).toEqual(sameColor(lit)));
  },
};

export const FourUp: Story = {
  render: () => (
    <div className="flex flex-col gap-heading">
      <Tabs defaultValue="home">
        <TabsList aria-label="Overview">
          <TabsTab value="home">Home</TabsTab>
          <TabsTab value="metrics">Metrics</TabsTab>
        </TabsList>
      </Tabs>
      <Tabs defaultValue="shape" className="w-[18rem]">
        <TabsList variant="grid" aria-label="Body">
          <TabsTab value="shape">Shape</TabsTab>
          <TabsTab value="places">Places</TabsTab>
          <TabsTab value="water" flag="Missing bathymetry">
            Water
          </TabsTab>
        </TabsList>
      </Tabs>
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const tab = must(q.querySelector('[data-slot="tabs-tab"]')).getBoundingClientRect();
      await expect(tab.height).toBeCloseTo(resolvePx(q, 'var(--size-btn-sm)'), 1);
    }
  },
};

// ── Junctions ─────────────────────────────────────────────────────────────────────────────────

/**
 * Joined boxes share one rim (each overlaps the last by a hairline), stand the surface's small
 * button height, and pad their words 1.1 em; grid cells are equal and a hairline apart.
 */
function RowJunction() {
  return (
    <div className="flex flex-col gap-heading">
      <Tabs defaultValue="home">
        <TabsList aria-label="Overview" data-junction="joined">
          <TabsTab value="home">Home</TabsTab>
          <TabsTab value="metrics">Metrics</TabsTab>
          <TabsTab value="health">Health</TabsTab>
        </TabsList>
      </Tabs>
      <Tabs defaultValue="shape" className="w-[23.75rem]">
        <TabsList
          variant="grid"
          aria-label="Body"
          data-junction="grid"
          // A state-function style (Base UI's other form) keeps the lattice's column count.
          style={() => ({ maxWidth: '100%' })}
        >
          <TabsTab value="shape">Shape</TabsTab>
          <TabsTab value="places">Places</TabsTab>
          <TabsTab value="access">Access</TabsTab>
          <TabsTab value="water">Water</TabsTab>
        </TabsList>
      </Tabs>
      <p className={KICKER}>Joined boxes share an edge; grid cells are equal</p>
    </div>
  );
}

async function playRowJunction({ canvasElement }: { canvasElement: HTMLElement }) {
  const joined = [
    ...must(canvasElement.querySelector('[data-junction="joined"]')).querySelectorAll<HTMLElement>(
      '[data-slot="tabs-tab"]',
    ),
  ];
  const btnSm = resolvePx(canvasElement, 'var(--size-btn-sm)');
  for (let i = 0; i < joined.length; i++) {
    const r = must(joined[i]).getBoundingClientRect();
    await expect(r.height).toBeCloseTo(btnSm, 1);
    if (i > 0) {
      const prev = must(joined[i - 1]).getBoundingClientRect();
      await expect(Math.abs(r.left - (prev.right - 1))).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    }
  }
  // The word sits 1.1 em in from each side (plus the rim).
  const first = must(joined[0]);
  const range = document.createRange();
  range.selectNodeContents(first);
  const word = range.getBoundingClientRect();
  const em = parseFloat(getComputedStyle(first).fontSize);
  const box = first.getBoundingClientRect();
  await expect(word.left - box.left - 1).toBeCloseTo(1.1 * em, 0);
  // Grid: equal cells, a hairline apart, two rows of three for four tabs.
  const cells = [
    ...must(canvasElement.querySelector('[data-junction="grid"]')).querySelectorAll<HTMLElement>(
      '[data-slot="tabs-tab"]',
    ),
  ].map((el) => el.getBoundingClientRect());
  const widths = new Set(cells.map((c) => Math.round(c.width * 4) / 4));
  await expect(widths.size).toBe(1);
  await expect(Math.abs(must(cells[1]).left - must(cells[0]).right - 1)).toBeLessThanOrEqual(
    JUNCTION_TOLERANCE_PX,
  );
  await expect(Math.abs(must(cells[3]).top - must(cells[0]).bottom - 1)).toBeLessThanOrEqual(
    JUNCTION_TOLERANCE_PX,
  );
}

export const JunctionRowsAdmin: Story = {
  render: () => <RowJunction />,
  globals: { surface: 'admin' },
  play: playRowJunction,
};

export const JunctionRowsSkater: Story = {
  render: () => <RowJunction />,
  globals: { surface: 'skater' },
  play: playRowJunction,
};
