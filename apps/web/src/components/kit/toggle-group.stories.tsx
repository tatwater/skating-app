import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import {
  computedColor,
  contrastBetween,
  JUNCTION_TOLERANCE_PX,
  resolvePx,
  sameColor,
} from './measure';
import { KICKER, must, PSEUDO_STATES, StateMatrix } from './storyKit';
import { ToggleGroup, ToggleGroupItem } from './toggle-group';

const meta = {
  title: 'Kit/ToggleGroup',
  component: ToggleGroup,
  tags: ['autodocs'],
  args: { defaultValue: 'all', onValueChange: fn(), 'aria-label': 'Imagery' },
} satisfies Meta<typeof ToggleGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

const option = (canvasElement: HTMLElement, name: string) =>
  within(canvasElement).getByRole('button', { name });

/**
 * A filter row over a list: joined boxes, the chosen one filled. Choosing moves the plate;
 * pressing the chosen one again keeps it — a mode always has a value.
 */
export const Joined: Story = {
  render: (args) => (
    <ToggleGroup {...args}>
      <ToggleGroupItem value="all">All</ToggleGroupItem>
      <ToggleGroupItem value="clear">Clear</ToggleGroupItem>
      <ToggleGroupItem value="clouded">Clouded</ToggleGroupItem>
    </ToggleGroup>
  ),
  play: async ({ canvasElement, args }) => {
    const all = option(canvasElement, 'All');
    const clouded = option(canvasElement, 'Clouded');
    await expect(all).toHaveAttribute('aria-pressed', 'true');
    const style = getComputedStyle(all);
    await expect(style.backgroundColor).toEqual(sameColor(computedColor(all, 'var(--fg1)')));
    await expect(style.color).toEqual(sameColor(computedColor(all, 'var(--bg)')));
    await expect(style.boxShadow).toBe('none');
    await expect(style.textTransform).toBe('uppercase');
    await userEvent.click(clouded);
    await expect(args.onValueChange).toHaveBeenCalledWith('clouded');
    await expect(clouded).toHaveAttribute('aria-pressed', 'true');
    await expect(all).toHaveAttribute('aria-pressed', 'false');
    // Again: still chosen, no change reported.
    await userEvent.click(clouded);
    await expect(clouded).toHaveAttribute('aria-pressed', 'true');
    await expect(args.onValueChange).toHaveBeenCalledOnce();
  },
};

/** An in-form segment: the options in a sunken well, a hairline apart. */
export const Well: Story = {
  args: { defaultValue: 'chord', 'aria-label': 'Draw' },
  render: (args) => (
    <ToggleGroup {...args} variant="well">
      <ToggleGroupItem value="chord">Chord</ToggleGroupItem>
      <ToggleGroupItem value="freehand">Freehand</ToggleGroupItem>
      <ToggleGroupItem value="paste">Paste</ToggleGroupItem>
    </ToggleGroup>
  ),
  play: async ({ canvasElement }) => {
    const group = must(canvasElement.querySelector<HTMLElement>('[data-slot="toggle-group"]'));
    await expect(getComputedStyle(group).backgroundColor).toEqual(
      sameColor(computedColor(group, 'var(--panel)')),
    );
    const chord = option(canvasElement, 'Chord');
    await expect(getComputedStyle(chord).backgroundColor).toEqual(
      sameColor(computedColor(chord, 'var(--fg1)')),
    );
  },
};

/**
 * A two-way switch with a key: the cap sits on the option that isn't chosen, because the key
 * switches to it. The cap keeps its room when hidden, so the row never changes width.
 */
export const KeyHint: Story = {
  args: { defaultValue: 'a', 'aria-label': 'On top' },
  render: (args) => (
    <ToggleGroup {...args} variant="well">
      <ToggleGroupItem value="a" hint="A">
        A on top
      </ToggleGroupItem>
      <ToggleGroupItem value="b" hint="B">
        B on top
      </ToggleGroupItem>
    </ToggleGroup>
  ),
  play: async ({ canvasElement }) => {
    const a = option(canvasElement, 'A on top');
    const b = option(canvasElement, 'B on top');
    await expect(b).toHaveAttribute('aria-keyshortcuts', 'B');
    const cap = (el: HTMLElement) =>
      getComputedStyle(must(el.querySelector('[data-slot="toggle-group-hint"]'))).visibility;
    await expect(cap(a)).toBe('hidden');
    await expect(cap(b)).toBe('visible');
    const width = canvasElement
      .querySelector('[data-slot="toggle-group"]')
      ?.getBoundingClientRect().width;
    await userEvent.click(b);
    await waitFor(() => expect(cap(a)).toBe('visible'));
    await expect(cap(b)).toBe('hidden');
    await expect(
      canvasElement.querySelector('[data-slot="toggle-group"]')?.getBoundingClientRect().width,
    ).toBe(width);
  },
};

/** Arrow keys move along the row; Enter chooses. */
export const Keyboard: Story = {
  ...Joined,
  play: async ({ canvasElement, args }) => {
    option(canvasElement, 'All').focus();
    await userEvent.keyboard('{ArrowRight}');
    const clear = option(canvasElement, 'Clear');
    await expect(clear).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(clear).toHaveAttribute('aria-pressed', 'true');
    await expect(args.onValueChange).toHaveBeenCalledWith('clear');
  },
};

/** Controlled: the owner holds the value; the row follows it. */
function Controlled() {
  const [value, setValue] = useState('day');
  return (
    <div className="flex items-center gap-heading">
      <ToggleGroup aria-label="Range" value={value} onValueChange={setValue}>
        <ToggleGroupItem value="day">Day</ToggleGroupItem>
        <ToggleGroupItem value="week">Week</ToggleGroupItem>
      </ToggleGroup>
      <output className="text-row text-fg2">{value}</output>
    </div>
  );
}

/** No starting value: nothing is chosen until the first press, and from then on one always is. */
export const NothingChosenYet: Story = {
  args: { defaultValue: undefined },
  render: Joined.render,
  play: async ({ canvasElement, args }) => {
    for (const el of within(canvasElement).getAllByRole('button')) {
      await expect(el).toHaveAttribute('aria-pressed', 'false');
    }
    await userEvent.click(option(canvasElement, 'Clear'));
    await expect(args.onValueChange).toHaveBeenCalledWith('clear');
    await expect(option(canvasElement, 'Clear')).toHaveAttribute('aria-pressed', 'true');
  },
};

export const ControlledValue: Story = {
  render: () => <Controlled />,
  play: async ({ canvasElement }) => {
    await userEvent.click(option(canvasElement, 'Week'));
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent('week');
  },
};

/** An option that can't be chosen yet: the disabled ink, its key faded; clicking does nothing. */
export const DisabledOption: Story = {
  render: (args) => (
    <ToggleGroup {...args}>
      <ToggleGroupItem value="all">All</ToggleGroupItem>
      <ToggleGroupItem value="naip" disabled hint="N">
        NAIP
      </ToggleGroupItem>
    </ToggleGroup>
  ),
  play: async ({ canvasElement, args }) => {
    const naip = option(canvasElement, 'NAIP');
    await userEvent.click(naip, { pointerEventsCheck: 0 });
    await expect(args.onValueChange).not.toHaveBeenCalled();
    await expect(getComputedStyle(naip).color).toEqual(
      sameColor(computedColor(naip, 'var(--fg-disabled)')),
    );
    const cap = must(naip.querySelector('[data-slot="toggle-group-hint"]'));
    await expect(getComputedStyle(cap).visibility).toBe('visible');
    await expect(Number(getComputedStyle(cap).opacity)).toBeLessThan(1);
  },
};

// ── Matrix and four-up ────────────────────────────────────────────────────────────────────────

const ROWS = [
  { key: 'joined', label: 'Joined' },
  { key: 'well', label: 'Well' },
] as const;
const STATES = [
  { key: 'rest', label: 'Rest' },
  { key: 'hover', label: 'Hover' },
  { key: 'focus', label: 'Focus' },
  { key: 'active', label: 'Pressed' },
  { key: 'disabled', label: 'Disabled' },
] as const;

/** The unchosen option in each state, beside the chosen one, in both rows. */
export const States: Story = {
  render: () => (
    <StateMatrix
      rows={ROWS}
      states={STATES}
      cell={(variant, state) => (
        <ToggleGroup variant={variant} defaultValue="a" aria-label={`${variant} ${state}`}>
          <ToggleGroupItem value="a">Clear</ToggleGroupItem>
          <ToggleGroupItem value="b" data-state={state} disabled={state === 'disabled'}>
            Clouded
          </ToggleGroupItem>
        </ToggleGroup>
      )}
    />
  ),
  parameters: PSEUDO_STATES,
  play: async ({ canvasElement }) => {
    // The chosen plate and the resting words pass AA on what they sit on.
    for (const el of canvasElement.querySelectorAll<HTMLElement>(
      '[data-slot="toggle-group-item"]',
    )) {
      if (el.hasAttribute('data-disabled')) continue;
      const well = el.closest('[data-variant="well"]') ? ['var(--panel)'] : [];
      const bg = getComputedStyle(el).backgroundColor;
      const base = ['var(--bg)', ...well];
      const ground = bg === 'rgba(0, 0, 0, 0)' ? base : [...base, bg];
      const ratio = contrastBetween(el, ground, [...ground, getComputedStyle(el).color]);
      await expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
  },
};

/** Keyboard focus draws the ring over the joined edge and lights the word, as hover does. */
export const FocusLights: Story = {
  ...Joined,
  play: async ({ canvasElement }) => {
    const clear = option(canvasElement, 'Clear');
    const lit = computedColor(clear, 'var(--fg1)');
    clear.focus();
    await waitFor(() => expect(getComputedStyle(clear).boxShadow).toMatch(/3px/));
    await waitFor(() => expect(getComputedStyle(clear).color).toEqual(sameColor(lit)));
  },
};

export const FourUp: Story = {
  render: () => (
    <div className="flex flex-col gap-heading">
      <ToggleGroup defaultValue="all" aria-label="Imagery">
        <ToggleGroupItem value="all">All</ToggleGroupItem>
        <ToggleGroupItem value="clear">Clear</ToggleGroupItem>
        <ToggleGroupItem value="clouded">Clouded</ToggleGroupItem>
      </ToggleGroup>
      <ToggleGroup variant="well" defaultValue="a" aria-label="On top">
        <ToggleGroupItem value="a" hint="A">
          A on top
        </ToggleGroupItem>
        <ToggleGroupItem value="b" hint="B">
          B on top
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      for (const g of q.querySelectorAll('[data-slot="toggle-group"]')) {
        await expect(g.getBoundingClientRect().height).toBeCloseTo(
          resolvePx(q, 'var(--size-btn-sm)'),
          1,
        );
      }
    }
  },
};

// ── Junctions ─────────────────────────────────────────────────────────────────────────────────

/**
 * Both rows stand the surface's small button height. Joined boxes share one rim and pad their
 * words 1.1 em; the well's options sit a hairline inside it and a hairline apart.
 */
function RowJunction() {
  return (
    <div className="flex flex-col gap-heading">
      <ToggleGroup defaultValue="all" aria-label="Imagery" data-junction="joined">
        <ToggleGroupItem value="all">All</ToggleGroupItem>
        <ToggleGroupItem value="clear">Clear</ToggleGroupItem>
        <ToggleGroupItem value="clouded">Clouded</ToggleGroupItem>
      </ToggleGroup>
      <ToggleGroup variant="well" defaultValue="chord" aria-label="Draw" data-junction="well">
        <ToggleGroupItem value="chord">Chord</ToggleGroupItem>
        <ToggleGroupItem value="freehand">Freehand</ToggleGroupItem>
      </ToggleGroup>
      <p className={KICKER}>Both rows a small button tall</p>
    </div>
  );
}

async function playRowJunction({ canvasElement }: { canvasElement: HTMLElement }) {
  const btnSm = resolvePx(canvasElement, 'var(--size-btn-sm)');
  const items = (key: string) => [
    ...must(canvasElement.querySelector(`[data-junction="${key}"]`)).querySelectorAll<HTMLElement>(
      '[data-slot="toggle-group-item"]',
    ),
  ];
  const joined = items('joined');
  for (let i = 0; i < joined.length; i++) {
    const r = must(joined[i]).getBoundingClientRect();
    await expect(r.height).toBeCloseTo(btnSm, 1);
    if (i > 0) {
      const prev = must(joined[i - 1]).getBoundingClientRect();
      await expect(Math.abs(r.left - (prev.right - 1))).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    }
  }
  const first = must(joined[0]);
  const range = document.createRange();
  range.selectNodeContents(first);
  const em = parseFloat(getComputedStyle(first).fontSize);
  await expect(
    range.getBoundingClientRect().left - first.getBoundingClientRect().left - 1,
  ).toBeCloseTo(1.1 * em, 0);
  const well = must(canvasElement.querySelector('[data-junction="well"]')).getBoundingClientRect();
  await expect(well.height).toBeCloseTo(btnSm, 1);
  const [a, b] = items('well').map((el) => el.getBoundingClientRect());
  await expect(Math.abs(must(a).left - well.left - 1)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  await expect(Math.abs(must(a).top - well.top - 1)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  await expect(Math.abs(must(b).left - must(a).right - 1)).toBeLessThanOrEqual(
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
