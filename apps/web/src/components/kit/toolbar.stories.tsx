import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { Kbd } from './kbd';
import {
  computedColor,
  horizontalGaps,
  JUNCTION_TOLERANCE_PX,
  resolvePx,
  sameColor,
} from './measure';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';
import { KICKER, must } from './storyKit';
import { ToggleGroup, ToggleGroupItem } from './toggle-group';
import {
  Toolbar,
  type ToolbarAction,
  ToolbarButton,
  ToolbarGroup,
  ToolbarItem,
  ToolbarLabel,
  ToolbarOverflow,
  ToolbarSeparator,
} from './toolbar';

const meta = {
  title: 'Kit/Toolbar',
  component: Toolbar,
  tags: ['autodocs'],
} satisfies Meta<typeof Toolbar>;

export default meta;
type Story = StoryObj<typeof meta>;

const bar = (canvasElement: HTMLElement) => within(canvasElement).getByRole('toolbar');
const btn = (scope: HTMLElement, name: string | RegExp) =>
  within(scope).getByRole('button', { name });

const LANES = [
  { value: 'all', label: 'All lanes' },
  { value: 'weather', label: 'Weather' },
  { value: 'imagery', label: 'Imagery' },
];

/** The Inbox's bar under a report: keep, merge, hide — each with its key — then the lane. */
function ReportBar({ onKeep }: { onKeep?: () => void }) {
  return (
    <Toolbar aria-label="Report actions">
      <ToolbarGroup>
        <ToolbarButton onClick={onKeep}>
          Keep <Kbd variant="dim">K</Kbd>
        </ToolbarButton>
        <ToolbarButton>
          Merge <Kbd variant="dim">M</Kbd>
        </ToolbarButton>
        <ToolbarButton variant="danger">
          Hide <Kbd variant="dim">H</Kbd>
        </ToolbarButton>
      </ToolbarGroup>
      <ToolbarSeparator />
      <ToolbarGroup>
        <ToolbarLabel>Lane</ToolbarLabel>
        <Select items={LANES} defaultValue="all">
          <ToolbarItem render={<SelectTrigger variant="boxed" className="w-auto" />}>
            <SelectValue />
          </ToolbarItem>
          <SelectContent side="top">
            {LANES.map((l) => (
              <SelectItem key={l.value} value={l.value}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ToolbarGroup>
    </Toolbar>
  );
}

/**
 * The action bar: a solid plate with one edge, every button resting alike — outlined, its key
 * beside its label. A hairline parts the actions from the lane picker.
 */
export const ActionBar: Story = {
  render: () => <ReportBar onKeep={fn()} />,
  play: async ({ canvasElement }) => {
    const el = bar(canvasElement);
    await expect(el).toHaveAccessibleName('Report actions');
    const style = getComputedStyle(el);
    await expect(style.backgroundColor).toEqual(sameColor(computedColor(el, 'var(--plate-solid)')));
    await expect(style.borderTopColor).toEqual(sameColor(computedColor(el, 'var(--line)')));
    await expect(style.borderTopColor).toEqual(sameColor(style.borderBottomColor));
    await expect(style.borderTopLeftRadius).toBe('0px');
    // Every button rests alike: none wears the primary's filled face.
    for (const b of within(el).getAllByRole('button')) {
      if (b.dataset.slot !== 'button') continue;
      await expect(getComputedStyle(b).backgroundColor).toEqual(sameColor('rgba(0, 0, 0, 0)'));
    }
  },
};

/**
 * One tab stop; the arrows move along the bar — buttons and the lane picker alike — and Home and
 * End jump to its ends. Tab leaves the bar.
 */
export const ArrowKeys: Story = {
  render: () => (
    <div className="flex flex-col gap-heading">
      <button type="button" className={KICKER}>
        Before the bar
      </button>
      <ReportBar />
      <button type="button" className={KICKER}>
        After the bar
      </button>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const el = bar(canvasElement);
    const keep = btn(el, /Keep/);
    const merge = btn(el, /Merge/);
    const hide = btn(el, /Hide/);
    const lane = within(el).getByRole('combobox');
    btn(canvasElement, 'Before the bar').focus();
    await userEvent.tab();
    await expect(keep).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(merge).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(hide).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(lane).toHaveFocus();
    await userEvent.keyboard('{Home}');
    await expect(keep).toHaveFocus();
    await userEvent.keyboard('{End}');
    await expect(lane).toHaveFocus();
    // Focus lights the button with the primary's look (its corner dots), the only lit one.
    await userEvent.keyboard('{Home}');
    await waitFor(() => expect(getComputedStyle(keep, '::after').opacity).toBe('1'));
    await expect(getComputedStyle(merge, '::after').opacity).toBe('0');
    // One tab stop: Tab leaves the bar.
    await userEvent.tab();
    await expect(btn(canvasElement, 'After the bar')).toHaveFocus();
  },
};

/** A kit ToggleGroup in the bar joins its arrow keys: one roving row, not a trap inside a trap. */
export const WithToggleGroup: Story = {
  render: () => (
    <Toolbar aria-label="Map tools">
      <ToolbarGroup>
        <ToolbarLabel>Imagery</ToolbarLabel>
        <ToggleGroup variant="well" defaultValue="a" aria-label="Imagery pass">
          <ToggleGroupItem value="a">A</ToggleGroupItem>
          <ToggleGroupItem value="b">B</ToggleGroupItem>
        </ToggleGroup>
      </ToolbarGroup>
      <ToolbarSeparator />
      <ToolbarButton>Reset view</ToolbarButton>
    </Toolbar>
  ),
  play: async ({ canvasElement }) => {
    const el = bar(canvasElement);
    const [a, b] = within(el).getAllByRole('button', { pressed: undefined });
    a?.focus();
    await expect(a).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(b).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(btn(el, 'Reset view')).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}{Enter}');
    await expect(b).toHaveAttribute('aria-pressed', 'true');
  },
};

/** A disabled action stays in the arrow order (focusable, not pressable), so focus never jumps. */
export const DisabledStaysFocusable: Story = {
  render: () => (
    <Toolbar aria-label="Run actions">
      <ToolbarButton>Run now</ToolbarButton>
      <ToolbarButton disabled>Retry</ToolbarButton>
      <ToolbarButton>History →</ToolbarButton>
    </Toolbar>
  ),
  play: async ({ canvasElement }) => {
    const el = bar(canvasElement);
    btn(el, 'Run now').focus();
    await userEvent.keyboard('{ArrowRight}');
    const retry = btn(el, 'Retry');
    await expect(retry).toHaveFocus();
    await expect(retry).toHaveAttribute('aria-disabled', 'true');
    await expect(getComputedStyle(retry).color).toEqual(
      sameColor(computedColor(retry, 'var(--fg-disabled)')),
    );
  },
};

/**
 * Armed and busy, in a bar: a destructive action turns red only once armed; a busy one keeps its
 * width under the spinner, so the bar never changes size.
 */
export const ArmedAndBusy: Story = {
  render: () => <ArmedBar />,
  play: async ({ canvasElement }) => {
    const el = bar(canvasElement);
    await document.fonts.ready; // the label face changes the bar's width as it loads
    const width = el.getBoundingClientRect().width;
    const remove = btn(el, 'Remove');
    await expect(getComputedStyle(remove).color).not.toEqual(
      sameColor(computedColor(remove, 'var(--bad)')),
    );
    await userEvent.click(remove);
    await expect(remove).toHaveAttribute('data-armed');
    const bad = computedColor(remove, 'var(--bad)'); // (a probe: never inside waitFor)
    await waitFor(() => expect(getComputedStyle(remove).color).toEqual(sameColor(bad)));
    await userEvent.click(btn(el, 'Save'));
    await expect(btn(el, 'Save')).toHaveAttribute('aria-busy', 'true');
    await expect(el.getBoundingClientRect().width).toBe(width);
  },
};

function ArmedBar() {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Toolbar aria-label="Rate actions">
      <ToolbarButton loading={busy} onClick={() => setBusy(true)}>
        Save
      </ToolbarButton>
      <ToolbarButton variant="danger" armed={armed} onClick={() => setArmed(true)}>
        Remove
      </ToolbarButton>
    </Toolbar>
  );
}

// ── Floating and full ─────────────────────────────────────────────────────────────────────────

function Pane({ children }: { children: ReactNode }) {
  return (
    <div
      data-pane=""
      className="relative h-[14rem] w-[30rem] overflow-hidden border border-solid border-line bg-bg"
    >
      <div className="p-gutter text-row leading-(--lead-list) text-fg2">
        Mascoma Lake · 3 reports since Tuesday
      </div>
      {children}
    </div>
  );
}

/**
 * Floating: locked to the pane's foot, `space-2` over its bottom edge, centered and tight to its
 * buttons — never nearer than `space-2` to either side.
 */
export const Floating: Story = {
  render: () => (
    <Pane>
      <Toolbar floating aria-label="Report actions">
        <ToolbarButton>Keep</ToolbarButton>
        <ToolbarButton>Merge</ToolbarButton>
        <ToolbarButton variant="danger">Hide</ToolbarButton>
      </Toolbar>
    </Pane>
  ),
  play: async ({ canvasElement }) => {
    const pane = must(canvasElement.querySelector<HTMLElement>('[data-pane]'));
    const el = bar(canvasElement);
    const p = pane.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    const edge = resolvePx(pane, 'var(--space-2)');
    // (The pane's own 1 px edge sits between its box and its padding box.)
    await expect(Math.abs(p.bottom - 1 - b.bottom - edge)).toBeLessThanOrEqual(0.5);
    await expect(Math.abs(b.left - p.left - (p.right - b.right))).toBeLessThanOrEqual(1);
    await expect(getComputedStyle(el).zIndex).toBe(
      getComputedStyle(pane).getPropertyValue('--z-actbar').trim(),
    );
  },
};

/** A one-action bar spans its pane and its button fills it — outlined, like every bar button. */
export const OneAction: Story = {
  render: () => (
    <Pane>
      <Toolbar floating full aria-label="Body actions">
        <ToolbarButton>Open in Body →</ToolbarButton>
      </Toolbar>
    </Pane>
  ),
  play: async ({ canvasElement }) => {
    const pane = must(canvasElement.querySelector<HTMLElement>('[data-pane]'));
    const el = bar(canvasElement);
    const p = pane.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    const edge = resolvePx(pane, 'var(--space-2)');
    await expect(Math.abs(b.left - (p.left + 1) - edge)).toBeLessThanOrEqual(0.5);
    await expect(Math.abs(p.right - 1 - b.right - edge)).toBeLessThanOrEqual(0.5);
    const open = btn(el, /Open in Body/);
    const style = getComputedStyle(el);
    const inner =
      b.width -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight) -
      parseFloat(style.borderLeftWidth) * 2;
    await expect(open.getBoundingClientRect().width).toBeCloseTo(inner, 0);
    await expect(getComputedStyle(open).backgroundColor).toEqual(sameColor('rgba(0, 0, 0, 0)'));
  },
};

// ── Overflow ──────────────────────────────────────────────────────────────────────────────────

const ACTIONS: ToolbarAction[] = [
  { id: 'promote', label: 'Promote', kbd: 'P' },
  { id: 'suppress', label: 'Suppress', kbd: 'S' },
  { id: 'demote', label: 'Demote', kbd: 'D' },
  { id: 'refit', label: 'Refit outline', kbd: 'R' },
  { id: 'split', label: 'Split bay' },
  { id: 'remove', label: 'Remove', danger: true },
];

function OverflowBar({ onSuppress }: { onSuppress?: () => void }) {
  const actions = ACTIONS.map((a) => (a.id === 'suppress' ? { ...a, onClick: onSuppress } : a));
  return (
    <div data-room="" className="w-[24rem]">
      <Toolbar aria-label="Place actions">
        <ToolbarOverflow actions={actions} />
      </Toolbar>
    </div>
  );
}

/**
 * When the bar runs out of room, the actions that don't fit fold into "More" at its end, in
 * order, keys and all; given room again, they come back. Nothing opens until "More" is pressed,
 * and Esc closes the menu back onto it.
 */
export const Overflow: Story = {
  args: { onClick: fn() },
  render: (args) => <OverflowBar onSuppress={args.onClick as () => void} />,
  play: async ({ canvasElement, args }) => {
    const el = bar(canvasElement);
    const group = must(el.querySelector<HTMLElement>('[data-slot="toolbar-overflow"]'));
    await waitFor(() => expect(group).toHaveAttribute('data-folded'));
    const more = btn(el, 'More actions');
    // The bar stays inside its room, "More" included.
    const room = must(canvasElement.querySelector<HTMLElement>('[data-room]'));
    await expect(el.getBoundingClientRect().right).toBeLessThanOrEqual(
      room.getBoundingClientRect().right + 0.5,
    );
    const shown = within(group)
      .getAllByRole('button')
      .filter((b) => b !== more && !b.closest('[aria-hidden="true"]'));
    const folded = Number(group.dataset.folded);
    await expect(shown.length + folded).toBe(ACTIONS.length);
    // Nothing is open at rest.
    await expect(document.querySelector('[data-slot="dropdown-menu-content"]')).toBeNull();
    await userEvent.click(more);
    const menu = await within(document.body).findByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    await expect(items.map((i) => i.textContent)).toEqual(
      ACTIONS.slice(ACTIONS.length - folded).map((a) => `${a.label}${a.kbd ?? ''}`),
    );
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(within(document.body).queryByRole('menu')).toBeNull());
    // The menu leaves the tree as the close starts; focus comes home only once the exit has run.
    await waitFor(() => expect(more).toHaveFocus());
    // Room again: everything comes back, "More" goes.
    room.style.width = '60rem';
    await waitFor(() => expect(group).not.toHaveAttribute('data-folded'));
    await expect(within(el).queryByRole('button', { name: 'More actions' })).toBeNull();
    await userEvent.click(btn(el, 'Suppress'));
    await expect(args.onClick).toHaveBeenCalledOnce();
    // Leave the story as it opened: tight, folded, nothing lit.
    btn(el, 'Suppress').blur();
    room.style.width = '';
    await waitFor(() => expect(group).toHaveAttribute('data-folded'));
  },
};

/** A folded action still works from the menu. */
export const OverflowChooses: Story = {
  args: { onClick: fn() },
  render: (args) => (
    <div data-room="" className="w-[14rem]">
      <Toolbar aria-label="Place actions">
        <ToolbarOverflow
          actions={ACTIONS.map((a) =>
            a.id === 'suppress' ? { ...a, onClick: args.onClick as () => void } : a,
          )}
        />
      </Toolbar>
    </div>
  ),
  play: async ({ canvasElement, args }) => {
    const el = bar(canvasElement);
    const more = await waitFor(() => btn(el, 'More actions'));
    await userEvent.click(more);
    const menu = await within(document.body).findByRole('menu');
    await userEvent.click(within(menu).getByRole('menuitem', { name: /Suppress/ }));
    await expect(args.onClick).toHaveBeenCalledOnce();
    await waitFor(() => expect(within(document.body).queryByRole('menu')).toBeNull());
  },
};

// ── Four-up and junctions ─────────────────────────────────────────────────────────────────────

export const FourUp: Story = {
  render: () => <ReportBar />,
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const el = must(q.querySelector<HTMLElement>('[role="toolbar"]'));
      await expect(getComputedStyle(el).backgroundColor).toEqual(
        sameColor(computedColor(el, 'var(--plate-solid)')),
      );
      // Every control in the bar stands the button height.
      for (const b of el.querySelectorAll('[data-slot="button"], [data-slot="select-trigger"]')) {
        await expect(b.getBoundingClientRect().height).toBeCloseTo(
          resolvePx(q, 'var(--size-btn)'),
          1,
        );
      }
    }
  },
};

/**
 * The bar's junctions: buttons `space-2` apart; a group's members `space-2_5`; a hairline (one
 * pixel of `line`, `space-5` tall, centered) `space-2` + `space-1` from its neighbors on each
 * side; the plate's inset `space-2_5` by `space-2`.
 */
function Junction() {
  return (
    <div className="flex flex-col gap-(--space-6)">
      <Toolbar aria-label="Junctions">
        <ToolbarButton>Keep</ToolbarButton>
        <ToolbarButton>Merge</ToolbarButton>
        <ToolbarSeparator />
        <ToolbarGroup>
          <ToolbarLabel>Lane</ToolbarLabel>
          <ToolbarButton>Weather</ToolbarButton>
        </ToolbarGroup>
      </Toolbar>
      <p className={KICKER}>Buttons, groups and hairlines</p>
    </div>
  );
}

async function playJunction({ canvasElement }: { canvasElement: HTMLElement }) {
  const el = bar(canvasElement);
  const [keep, merge, sep, group] = [...el.children] as HTMLElement[];
  const [label, weather] = [...must(group).children] as HTMLElement[];
  const s2 = resolvePx(el, 'var(--space-2)');
  const s1 = resolvePx(el, 'var(--space-1)');
  const s25 = resolvePx(el, 'var(--space-2_5)');
  const gaps = horizontalGaps([must(keep), must(merge), must(sep), must(group)]);
  await expect(Math.abs(must(gaps[0]) - s2)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  await expect(Math.abs(must(gaps[1]) - (s2 + s1))).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  await expect(Math.abs(must(gaps[2]) - (s2 + s1))).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  const [inGroup] = horizontalGaps([must(label), must(weather)]);
  await expect(Math.abs(must(inGroup) - s25)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  // The hairline: one pixel of `line`, `space-5` tall, centered on the buttons.
  const s = must(sep).getBoundingClientRect();
  const k = must(keep).getBoundingClientRect();
  await expect(s.width).toBe(1);
  await expect(s.height).toBeCloseTo(resolvePx(el, 'var(--space-5)'), 1);
  await expect(Math.abs(s.top + s.height / 2 - (k.top + k.height / 2))).toBeLessThanOrEqual(0.5);
  await expect(getComputedStyle(must(sep)).backgroundColor).toEqual(
    sameColor(computedColor(el, 'var(--line)')),
  );
  await expect(must(sep)).toHaveAttribute('aria-orientation', 'vertical');
  // The plate's inset, content to its edge.
  const b = el.getBoundingClientRect();
  await expect(Math.abs(k.left - b.left - 1 - s25)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  await expect(Math.abs(k.top - b.top - 1 - s2)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
}

export const JunctionAdmin: Story = {
  render: () => <Junction />,
  globals: { surface: 'admin' },
  play: playJunction,
};

export const JunctionSkater: Story = {
  render: () => <Junction />,
  globals: { surface: 'skater' },
  play: playJunction,
};
