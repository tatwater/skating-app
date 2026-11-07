import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import {
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleTrigger,
} from './collapsible';
import { computedColor, JUNCTION_TOLERANCE_PX, resolvePx, sameColor } from './measure';
import { KICKER, must, PSEUDO_STATES, StateMatrix } from './storyKit';

const meta = {
  title: 'Kit/Collapsible',
  component: Collapsible,
  tags: ['autodocs'],
  args: { onOpenChange: fn() },
  decorators: [(Story) => <div className="w-[22rem]">{Story()}</div>],
} satisfies Meta<typeof Collapsible>;

export default meta;
type Story = StoryObj<typeof meta>;

/** What a motion token computes to here: zero under reduced motion. */
const motion = (ms: number) =>
  matchMedia('(prefers-reduced-motion: reduce)').matches ? '0s' : `${ms / 1000}s`;

const head = (canvasElement: HTMLElement, name: RegExp | string) =>
  within(canvasElement).getByRole('button', { name });
const panelOf = (root: Element) =>
  root.querySelector<HTMLElement>('[data-slot="collapsible-content"]');
const chevronOf = (trigger: Element) =>
  must(trigger.querySelector<HTMLElement>('[data-slot="collapsible-chevron"]'));

/** A quarter turn: the chevron's computed `rotate` once it points down. */
const DOWN = '90deg';

function Rows({ rows }: { rows: readonly string[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-(--space-1_5) p-0 pb-(--space-2)">
      {rows.map((r) => (
        <li key={r} className="text-row leading-(--lead-list) text-fg2">
          {r}
        </li>
      ))}
    </ul>
  );
}

const ARCHIVED = [
  'North cove · Pressure ridge',
  'Boat launch · Open water',
  'Inlet · Thin ice reported',
  'East shore · Crack',
];
const KNOWN = ['Inlet · Current', 'Spring by the dam · Springs'];

/** A Body's hazards groups: each head opens its group; the counts sit at the right. */
function Hazards({ archivedOpen = false }: { archivedOpen?: boolean }) {
  return (
    <div data-junction="groups" className="flex flex-col">
      <Collapsible defaultOpen={archivedOpen}>
        <CollapsibleTrigger count={ARCHIVED.length}>Archived this winter</CollapsibleTrigger>
        <CollapsibleContent>
          <Rows rows={ARCHIVED} />
        </CollapsibleContent>
      </Collapsible>
      <Collapsible>
        <CollapsibleTrigger count={KNOWN.length}>Known features</CollapsibleTrigger>
        <CollapsibleContent>
          <Rows rows={KNOWN} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/**
 * Closed groups: the chevron points right, and a closed group reserves nothing — the next head
 * sits right under this one. A press opens it; the chevron turns down and the panel grows open.
 */
export const Closed: Story = {
  render: () => <Hazards />,
  play: async ({ canvasElement }) => {
    const archived = head(canvasElement, /Archived this winter/);
    const known = head(canvasElement, /Known features/);
    await expect(archived).toHaveAttribute('aria-expanded', 'false');
    await expect(getComputedStyle(chevronOf(archived)).rotate).toBe('none');
    await expect(panelOf(canvasElement)).toBeNull();
    // No phantom space: the next head starts where this one ends.
    await expect(
      Math.abs(known.getBoundingClientRect().top - archived.getBoundingClientRect().bottom),
    ).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    await userEvent.click(archived);
    await expect(archived).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(getComputedStyle(chevronOf(archived)).rotate).toBe(DOWN));
    const panel = must(panelOf(canvasElement));
    await expect(within(panel).getByText('North cove · Pressure ridge')).toBeVisible();
    // Settled: the panel is as tall as what it holds, and pushes the next head down by that.
    await waitFor(() =>
      expect(Math.abs(panel.getBoundingClientRect().height - panel.scrollHeight)).toBeLessThan(1),
    );
    await expect(
      Math.abs(known.getBoundingClientRect().top - panel.getBoundingClientRect().bottom),
    ).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  },
};

/** Open, then closed again: the panel shrinks away and leaves no space behind. */
export const OpenThenClose: Story = {
  render: () => <Hazards archivedOpen />,
  play: async ({ canvasElement }) => {
    const archived = head(canvasElement, /Archived this winter/);
    const known = head(canvasElement, /Known features/);
    await expect(archived).toHaveAttribute('aria-expanded', 'true');
    await expect(getComputedStyle(chevronOf(archived)).rotate).toBe(DOWN);
    await userEvent.click(archived);
    await expect(archived).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(panelOf(canvasElement)).toBeNull());
    await expect(getComputedStyle(chevronOf(archived)).rotate).toBe('none');
    await expect(
      Math.abs(known.getBoundingClientRect().top - archived.getBoundingClientRect().bottom),
    ).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  },
};

/** Enter and Space open and close it from the keyboard; it reports each change. */
export const Keyboard: Story = {
  render: (args) => (
    <Collapsible {...args}>
      <CollapsibleTrigger count={2}>Known features</CollapsibleTrigger>
      <CollapsibleContent>
        <Rows rows={KNOWN} />
      </CollapsibleContent>
    </Collapsible>
  ),
  play: async ({ canvasElement, args }) => {
    const trigger = head(canvasElement, /Known features/);
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(args.onOpenChange).toHaveBeenLastCalledWith(true, expect.anything());
    await userEvent.keyboard(' ');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(args.onOpenChange).toHaveBeenLastCalledWith(false, expect.anything());
    // Keyboard focus rings the row and lights the name, as hover does.
    await waitFor(() => expect(getComputedStyle(trigger).boxShadow).toMatch(/3px/));
    const lit = computedColor(trigger, 'var(--fg1)');
    await waitFor(() => expect(getComputedStyle(trigger).color).toEqual(sameColor(lit)));
  },
};

/**
 * The reveal rides the motion tokens: the panel's height on `duration-base`, the chevron's turn on
 * `duration-fast`, both with the standard easing — and both zero under reduced motion.
 */
export const Motion: Story = {
  render: () => <Hazards />,
  play: async ({ canvasElement }) => {
    const archived = head(canvasElement, /Archived this winter/);
    const chevron = getComputedStyle(chevronOf(archived));
    await expect(chevron.transitionProperty).toBe('rotate');
    await expect(chevron.transitionDuration).toBe(motion(120));
    await userEvent.click(archived);
    const panel = await waitFor(() => must(panelOf(canvasElement)));
    const style = getComputedStyle(panel);
    await expect(style.transitionProperty).toBe('height');
    await expect(style.transitionDuration).toBe(motion(200));
    await expect(style.transitionTimingFunction).toBe('cubic-bezier(0.2, 0, 0, 1)');
    await expect(style.overflow).toBe('hidden');
  },
};

/** Kept in the page for find-in-page while closed — still taking no room. */
export const HiddenUntilFound: Story = {
  render: () => (
    <div data-junction="groups" className="flex flex-col">
      <Collapsible>
        <CollapsibleTrigger count={4}>Archived this winter</CollapsibleTrigger>
        <CollapsibleContent hiddenUntilFound>
          <Rows rows={ARCHIVED} />
        </CollapsibleContent>
      </Collapsible>
      <Collapsible>
        <CollapsibleTrigger count={2}>Known features</CollapsibleTrigger>
      </Collapsible>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const panel = must(panelOf(canvasElement));
    await expect(panel).toHaveAttribute('hidden', 'until-found');
    const archived = head(canvasElement, /Archived this winter/);
    const known = head(canvasElement, /Known features/);
    await expect(
      Math.abs(known.getBoundingClientRect().top - archived.getBoundingClientRect().bottom),
    ).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  },
};

/** A group that can't be opened right now: the disabled ink; pressing does nothing. */
export const Disabled: Story = {
  render: (args) => (
    <Collapsible {...args} disabled>
      <CollapsibleTrigger count={0}>Known features</CollapsibleTrigger>
      <CollapsibleContent>
        <Rows rows={KNOWN} />
      </CollapsibleContent>
    </Collapsible>
  ),
  play: async ({ canvasElement, args }) => {
    const trigger = head(canvasElement, /Known features/);
    await userEvent.click(trigger, { pointerEventsCheck: 0 });
    await expect(args.onOpenChange).not.toHaveBeenCalled();
    await expect(getComputedStyle(trigger).color).toEqual(
      sameColor(computedColor(trigger, 'var(--fg-disabled)')),
    );
  },
};

/** Controlled from outside — a "Show all" elsewhere opens it — and the chevron alone, for a custom head. */
function Controlled() {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-heading">
      <button type="button" className="w-fit text-row text-fg2" onClick={() => setOpen(!open)}>
        {open ? 'Hide the layers' : 'Show the layers'}
      </button>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          render={<button type="button" />}
          className="w-fit border-t-0 tracking-kick"
        >
          Layers
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Rows rows={['Imagery', 'Depth', 'Landmarks']} />
        </CollapsibleContent>
      </Collapsible>
      <span className="inline-flex items-center gap-(--space-2) text-kick text-fg2">
        <CollapsibleChevron /> A chevron on its own points right
      </span>
    </div>
  );
}

export const ControlledOpen: Story = {
  render: () => <Controlled />,
  play: async ({ canvasElement }) => {
    await userEvent.click(head(canvasElement, 'Show the layers'));
    const layers = head(canvasElement, 'Layers');
    await expect(layers).toHaveAttribute('aria-expanded', 'true');
    // No count given: no count slot.
    await expect(layers.querySelector('[data-slot="collapsible-count"]')).toBeNull();
    await userEvent.click(layers);
    await expect(head(canvasElement, 'Show the layers')).toBeInTheDocument();
  },
};

// ── Matrix and four-up ────────────────────────────────────────────────────────────────────────

const ROWS = [
  { key: 'closed', label: 'Closed' },
  { key: 'open', label: 'Open' },
] as const;
const STATES = [
  { key: 'rest', label: 'Rest' },
  { key: 'hover', label: 'Hover' },
  { key: 'focus', label: 'Focus' },
  { key: 'disabled', label: 'Disabled' },
] as const;

export const States: Story = {
  decorators: [(Story) => Story()],
  render: () => (
    <StateMatrix
      rows={ROWS}
      states={STATES}
      cell={(row, state) => (
        <div className="w-[14rem]">
          <Collapsible defaultOpen={row === 'open'} disabled={state === 'disabled'}>
            <CollapsibleTrigger data-state={state} count={2}>
              Known features
            </CollapsibleTrigger>
            <CollapsibleContent>
              <Rows rows={KNOWN} />
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}
    />
  ),
  parameters: PSEUDO_STATES,
  play: async ({ canvasElement }) => {
    for (const t of within(canvasElement).getAllByRole('button')) {
      const open = t.getAttribute('aria-expanded') === 'true';
      await expect(getComputedStyle(chevronOf(t)).rotate).toBe(open ? DOWN : 'none');
    }
  },
};

export const FourUp: Story = {
  decorators: [(Story) => Story()],
  render: () => (
    <div className="w-[16rem]">
      <Hazards archivedOpen />
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      for (const t of q.querySelectorAll<HTMLElement>('[data-slot="collapsible-trigger"]')) {
        await expect(getComputedStyle(t).borderTopColor).toEqual(
          sameColor(computedColor(t, 'var(--line)')),
        );
        await expect(getComputedStyle(t).color).toEqual(sameColor(computedColor(t, 'var(--fg2)')));
      }
    }
  },
};

// ── Junctions ─────────────────────────────────────────────────────────────────────────────────

/**
 * The head: a hair rule on top, `space-2` above and below its line, the chevron in a box a kicker
 * wide, the name `space-2` after it, the count flush right. Closed groups stack head to head.
 */
function HeadJunction() {
  return (
    <div className="flex w-[22rem] flex-col gap-(--space-6)">
      <Hazards />
      <p className={KICKER}>Heads stack with nothing between them</p>
    </div>
  );
}

async function playHeadJunction({ canvasElement }: { canvasElement: HTMLElement }) {
  const groups = must(canvasElement.querySelector<HTMLElement>('[data-junction="groups"]'));
  const [a, b] = [...groups.querySelectorAll<HTMLElement>('[data-slot="collapsible-trigger"]')];
  const t = must(a);
  const r = t.getBoundingClientRect();
  const style = getComputedStyle(t);
  const hair = resolvePx(t, 'var(--stroke-hair)');
  const s2 = resolvePx(t, 'var(--space-2)');
  const kick = resolvePx(t, 'var(--type-kick)');
  await expect(parseFloat(style.borderTopWidth)).toBe(hair);
  await expect(parseFloat(style.paddingTop)).toBeCloseTo(s2, 2);
  await expect(parseFloat(style.paddingBottom)).toBeCloseTo(s2, 2);
  const chevron = chevronOf(t).getBoundingClientRect();
  await expect(chevron.width).toBeCloseTo(kick, 1);
  await expect(Math.abs(chevron.left - r.left)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  const label = must(t.querySelector('[data-slot="collapsible-label"]')).getBoundingClientRect();
  await expect(Math.abs(label.left - chevron.right - s2)).toBeLessThanOrEqual(
    JUNCTION_TOLERANCE_PX,
  );
  const count = must(t.querySelector('[data-slot="collapsible-count"]')).getBoundingClientRect();
  await expect(Math.abs(count.right - r.right)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  await expect(Math.abs(must(b).getBoundingClientRect().top - r.bottom)).toBeLessThanOrEqual(
    JUNCTION_TOLERANCE_PX,
  );
}

export const JunctionHeadAdmin: Story = {
  decorators: [(Story) => Story()],
  render: () => <HeadJunction />,
  globals: { surface: 'admin' },
  play: playHeadJunction,
};

export const JunctionHeadSkater: Story = {
  decorators: [(Story) => Story()],
  render: () => <HeadJunction />,
  globals: { surface: 'skater' },
  play: playHeadJunction,
};
