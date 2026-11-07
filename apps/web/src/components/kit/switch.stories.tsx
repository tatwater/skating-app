import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { computedColor, JUNCTION_TOLERANCE_PX, resolvePx, sameColor } from './measure';
import { KICKER, must, PSEUDO_STATES, StateMatrix } from './storyKit';
import { Switch, SwitchRow } from './switch';

const meta = {
  title: 'Kit/Switch',
  component: Switch,
  tags: ['autodocs'],
  args: { 'aria-label': 'Follow the log', onCheckedChange: fn() },
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

const toggle = (canvasElement: HTMLElement, name?: string) =>
  within(canvasElement).getByRole('switch', name === undefined ? undefined : { name });
const part = (el: Element, slot: string) =>
  must(el.querySelector<HTMLElement>(`[data-slot="${slot}"]`));

/** Off: the gray rim and knob. Clicking turns it on — the rim and knob light, the knob travels. */
export const Off: Story = {
  play: async ({ canvasElement, args }) => {
    const el = toggle(canvasElement);
    await expect(el).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(el);
    await expect(args.onCheckedChange).toHaveBeenCalledOnce();
    await expect(el).toHaveAttribute('aria-checked', 'true');
    // Keyboard too: Space toggles it back.
    el.focus();
    await userEvent.keyboard(' ');
    await expect(el).toHaveAttribute('aria-checked', 'false');
  },
};

/** On: the bright rim over a lifted track; the knob lit, with its glow, at the far end. */
export const On: Story = {
  args: { defaultChecked: true },
  play: async ({ canvasElement }) => {
    const el = toggle(canvasElement);
    const track = part(el, 'switch-track');
    // (Resolve the color outside `waitFor`: its probe mutates the DOM, which re-runs `waitFor`.)
    const rim = computedColor(el, 'var(--fg)');
    await waitFor(() => expect(getComputedStyle(track).borderTopColor).toEqual(sameColor(rim)));
    await expect(getComputedStyle(track).borderRadius).toBe('6px');
  },
};

/** Nothing to switch: a dashed rim and no knob — not a faded switch. */
export const Disabled: Story = {
  args: { disabled: true },
  play: async ({ canvasElement, args }) => {
    const el = toggle(canvasElement);
    const track = part(el, 'switch-track');
    await expect(getComputedStyle(track).borderTopStyle).toBe('dashed');
    await expect(getComputedStyle(part(el, 'switch-thumb')).opacity).toBe('0');
    await userEvent.click(el, { pointerEventsCheck: 0 });
    await expect(args.onCheckedChange).not.toHaveBeenCalled();
  },
};

/** The layer rack: a plate per row — switch, name and key, one press target. */
export const Rack: Story = {
  render: () => (
    <div className="flex w-[12rem] flex-col gap-px">
      <SwitchRow label="Outline" kbd="O" defaultChecked />
      <SwitchRow label="Reports" kbd="R" />
      <SwitchRow label="Hazards" kbd="H" defaultChecked />
      <SwitchRow label="Bathy" kbd="B" disabled />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The key is decoration: the row's name is its label, and the key is announced as a shortcut.
    const reports = canvas.getByRole('switch', { name: 'Reports' });
    await expect(reports).toHaveAttribute('aria-keyshortcuts', 'R');
    await userEvent.click(part(reports, 'switch-label'));
    await expect(reports).toHaveAttribute('aria-checked', 'true');
    // A disabled layer keeps its key — faded and inert.
    const bathy = canvas.getByRole('switch', { name: 'Bathy' });
    await expect(bathy).toHaveAttribute('aria-disabled', 'true');
    await expect(part(bathy, 'kbd')).toHaveAttribute('data-disabled');
  },
};

/** A log's Follow: bare (no plate, no key), and it bleeds so its text sits on the text line. */
export const Follow: Story = {
  render: () => <SwitchRow variant="bare" label="Follow" defaultChecked />,
  play: async ({ canvasElement }) => {
    await expect(toggle(canvasElement, 'Follow')).toHaveAttribute('aria-checked', 'true');
  },
};

// ── Matrix and four-up ────────────────────────────────────────────────────────────────────────

const ROWS = [
  { key: 'off', label: 'Off' },
  { key: 'on', label: 'On' },
  { key: 'row-off', label: 'Row, off' },
  { key: 'row-on', label: 'Row, on' },
  { key: 'bare', label: 'Bare row' },
] as const;
const STATES = [
  { key: 'rest', label: 'Rest' },
  { key: 'hover', label: 'Hover' },
  { key: 'focus', label: 'Focus' },
  { key: 'active', label: 'Pressed' },
  { key: 'disabled', label: 'Disabled' },
] as const;

/** Every form in every state (hover, focus and pressed forced for the eye in Storybook). */
export const States: Story = {
  render: () => (
    <StateMatrix
      rows={ROWS}
      states={STATES}
      cell={(row, state) => {
        const common = { 'data-state': state, disabled: state === 'disabled' };
        if (row === 'off' || row === 'on')
          return <Switch {...common} aria-label="Follow" defaultChecked={row === 'on'} />;
        if (row === 'bare')
          return <SwitchRow {...common} variant="bare" label="Follow" defaultChecked />;
        return (
          <SwitchRow
            {...common}
            className="w-[10rem]"
            label="Hazards"
            kbd="H"
            defaultChecked={row === 'row-on'}
          />
        );
      }}
    />
  ),
  parameters: PSEUDO_STATES,
  play: async ({ canvasElement }) => {
    for (const el of canvasElement.querySelectorAll('[data-state="disabled"]')) {
      await expect(el).toHaveAttribute('aria-disabled', 'true');
      await expect(getComputedStyle(part(el, 'switch-track')).borderTopStyle).toBe('dashed');
    }
  },
};

/** Keyboard focus draws the ring and lights the rim, as hover does. */
export const FocusLights: Story = {
  render: () => (
    <div className="flex items-center gap-(--space-4)">
      <Switch aria-label="Follow" />
      <SwitchRow className="w-[10rem]" label="Hazards" kbd="H" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    for (const el of within(canvasElement).getAllByRole('switch')) {
      const track = part(el, 'switch-track');
      const rest = getComputedStyle(track).borderTopColor;
      const lit = computedColor(el, 'var(--fg2)');
      el.focus();
      await waitFor(() => expect(getComputedStyle(el).boxShadow).toMatch(/3px/));
      await waitFor(() => expect(getComputedStyle(track).borderTopColor).toEqual(sameColor(lit)));
      await expect(lit).not.toEqual(sameColor(rest));
    }
  },
};

export const FourUp: Story = {
  render: () => (
    <div className="flex flex-col gap-heading">
      <div className="flex items-center gap-(--space-4)">
        <Switch aria-label="Off" />
        <Switch aria-label="On" defaultChecked />
        <Switch aria-label="Disabled" disabled />
        <SwitchRow variant="bare" label="Follow" defaultChecked />
      </div>
      <div className="flex w-[12rem] flex-col gap-px">
        <SwitchRow label="Outline" kbd="O" defaultChecked />
        <SwitchRow label="Reports" kbd="R" />
        <SwitchRow label="Bathy" kbd="B" disabled />
      </div>
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    // The track is sized by the surface's kicker: two kickers by one, in every quad.
    for (const q of quads) {
      const track = part(q, 'switch-track').getBoundingClientRect();
      const kick = resolvePx(q, 'var(--type-kick)');
      await expect(track.width).toBeCloseTo(kick * 2, 1);
      await expect(track.height).toBeCloseTo(kick, 1);
    }
  },
};

// ── Junctions ─────────────────────────────────────────────────────────────────────────────────

/**
 * A bare switch in a row of text: its box is the track (2 × 1 kickers), the knob travels to the
 * mirror of where it rests, and the pointer area reaches a hit pad past the box.
 */
function BareJunction() {
  return (
    <div data-junction="bare" className="m-(--space-8) flex items-center gap-(--space-2)">
      <span className="text-row leading-none text-fg2">Follow</span>
      <Switch aria-label="Off" />
      <Switch aria-label="On" defaultChecked />
      <span className="text-row leading-none text-fg2">Live</span>
    </div>
  );
}

async function playBareJunction({ canvasElement }: { canvasElement: HTMLElement }) {
  const row = must(canvasElement.querySelector<HTMLElement>('[data-junction="bare"]'));
  // Base UI renders each switch's form input beside it, hidden; it isn't layout.
  const items = [...row.querySelectorAll(':scope > :not(input)')];
  const gap = resolvePx(row, 'var(--space-2)');
  const kick = resolvePx(row, 'var(--type-kick)');
  const hitX = resolvePx(row, 'var(--gap-hit-x)');
  const hitY = resolvePx(row, 'var(--gap-hit-y)');
  // Box to box is the gap: the hit area never touches layout.
  for (let i = 1; i < items.length; i++) {
    const g =
      must(items[i]).getBoundingClientRect().left -
      must(items[i - 1]).getBoundingClientRect().right;
    await expect(Math.abs(g - gap)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  }
  const off = items[1] as HTMLElement;
  const on = items[2] as HTMLElement;
  const box = off.getBoundingClientRect();
  await expect(box.width).toBeCloseTo(kick * 2, 1);
  await expect(box.height).toBeCloseTo(kick, 1);
  // The knob: one hairline in at rest, one hairline in from the far rim when on.
  const inset = (sw: HTMLElement, side: 'left' | 'right') => {
    const track = part(sw, 'switch-track').getBoundingClientRect();
    const knob = part(sw, 'switch-thumb').getBoundingClientRect();
    return side === 'left' ? knob.left - track.left : track.right - knob.right;
  };
  await waitFor(() => expect(Math.abs(inset(on, 'right') - inset(off, 'left'))).toBeLessThan(0.5));
  await expect(inset(off, 'left')).toBeCloseTo(2, 0); // the rim and the hairline inset
  // The pointer area: inside a hit pad past the box it finds the switch; beyond, it doesn't.
  const hits = (x: number, y: number) =>
    document.elementFromPoint(x, y)?.closest('[role="switch"]') === off;
  const cx = box.left + box.width / 2;
  await expect(hits(cx, box.top - hitY + 1)).toBe(true);
  await expect(hits(cx, box.top - hitY - 1)).toBe(false);
  await expect(hits(box.left - hitX + 1, box.top + box.height / 2)).toBe(true);
  await expect(hits(box.left - hitX - 1, box.top + box.height / 2)).toBe(false);
}

export const JunctionBareAdmin: Story = {
  render: () => <BareJunction />,
  globals: { surface: 'admin' },
  play: playBareJunction,
};

export const JunctionBareSkater: Story = {
  render: () => <BareJunction />,
  globals: { surface: 'skater' },
  play: playBareJunction,
};

/**
 * A rack row: the surface's small-button height; the label sits 0.9 em after the track; the key
 * meets the row's inner edge on the right; everything centers on one line.
 */
function RowJunction() {
  return (
    <div className="flex flex-col gap-heading">
      <div data-junction="plate" className="w-[12rem]">
        <SwitchRow label="Hazards" kbd="H" defaultChecked />
      </div>
      <div data-junction="bare" className="flex flex-col gap-heading">
        <p className="text-row leading-none text-fg2">Corpus load</p>
        <SwitchRow variant="bare" label="Follow" />
      </div>
      <p className={KICKER}>The row's parts share one center; bare rows bleed</p>
    </div>
  );
}

async function playRowJunction({ canvasElement }: { canvasElement: HTMLElement }) {
  const plate = part(must(canvasElement.querySelector('[data-junction="plate"]')), 'switch-row');
  const row = plate.getBoundingClientRect();
  await expect(row.height).toBeCloseTo(resolvePx(plate, 'var(--size-btn-sm)'), 1);
  const track = part(plate, 'switch-track').getBoundingClientRect();
  const label = part(plate, 'switch-label').getBoundingClientRect();
  const key = part(plate, 'kbd').getBoundingClientRect();
  const em = parseFloat(getComputedStyle(plate).fontSize);
  await expect(label.left - track.right).toBeCloseTo(0.9 * em, 1);
  await expect(track.left - row.left).toBeCloseTo(0.75 * em, 1);
  await expect(row.right - key.right).toBeCloseTo(0.75 * em, 1);
  const mid = (r: DOMRect) => r.top + r.height / 2;
  for (const r of [track, label, key]) {
    await expect(Math.abs(mid(r) - mid(row))).toBeLessThanOrEqual(1);
  }
  // Bare: the bleed gives its padding back, so its track starts on the text's left edge.
  const bare = must(canvasElement.querySelector('[data-junction="bare"]'));
  const text = must(bare.querySelector('p')).getBoundingClientRect();
  const bareTrack = part(bare, 'switch-track').getBoundingClientRect();
  await expect(Math.abs(bareTrack.left - text.left)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
}

export const JunctionRowAdmin: Story = {
  render: () => <RowJunction />,
  globals: { surface: 'admin' },
  play: playRowJunction,
};

export const JunctionRowSkater: Story = {
  render: () => <RowJunction />,
  globals: { surface: 'skater' },
  play: playRowJunction,
};
