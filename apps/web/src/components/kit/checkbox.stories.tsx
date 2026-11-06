import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { Checkbox, CheckboxGroup, CheckboxRow } from './checkbox';
import { computedColor, JUNCTION_TOLERANCE_PX, resolvePx } from './measure';
import { must, PSEUDO_STATES, StateMatrix } from './storyKit';

const meta = {
  title: 'Kit/Checkbox',
  component: Checkbox,
  tags: ['autodocs'],
  args: { 'aria-label': 'Restore', onCheckedChange: fn() },
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

const box = (canvasElement: HTMLElement, name?: string) =>
  within(canvasElement).getByRole('checkbox', name === undefined ? undefined : { name });

/** Unchecked: the hairline square. A click fills it with the check knocked out. */
export const Unchecked: Story = {
  play: async ({ canvasElement, args }) => {
    const el = box(canvasElement);
    await expect(getComputedStyle(el).borderRadius).toBe(
      getComputedStyle(document.documentElement).getPropertyValue('--corner-control').trim(),
    );
    await userEvent.click(el);
    await expect(args.onCheckedChange).toHaveBeenCalledOnce();
    await expect(el).toHaveAttribute('aria-checked', 'true');
    // (Resolve the color outside `waitFor`: its probe mutates the DOM, which re-runs `waitFor`.)
    const fill = computedColor(el, 'var(--fg)');
    await waitFor(() => expect(getComputedStyle(el).backgroundColor).toBe(fill));
    el.focus();
    await userEvent.keyboard(' ');
    await expect(el).toHaveAttribute('aria-checked', 'false');
  },
};

export const Checked: Story = { args: { defaultChecked: true } };

/** Some of a group picked: the parent shows the dash. */
export const Indeterminate: Story = {
  args: { indeterminate: true },
  play: async ({ canvasElement }) => {
    const el = box(canvasElement);
    await expect(el).toHaveAttribute('aria-checked', 'mixed');
    const icons = el.querySelectorAll('svg');
    const shown = [...icons].filter((i) => getComputedStyle(i).display !== 'none');
    await expect(shown).toHaveLength(1);
    await expect(shown[0]).toHaveClass('fa-minus');
  },
};

/** A field that must be checked and isn't: the red rim. */
export const Invalid: Story = {
  args: { 'aria-invalid': true },
  play: async ({ canvasElement }) => {
    const el = box(canvasElement);
    await expect(getComputedStyle(el).borderTopColor).toBe(computedColor(el, 'var(--bad)'));
  },
};

export const Disabled: Story = {
  args: { disabled: true, defaultChecked: true },
  play: async ({ canvasElement, args }) => {
    const el = box(canvasElement);
    await userEvent.click(el, { pointerEventsCheck: 0 });
    await expect(args.onCheckedChange).not.toHaveBeenCalled();
    await expect(getComputedStyle(el).backgroundColor).toBe(computedColor(el, 'var(--line2)'));
  },
};

/** The label is part of the target; a sub-line hangs under it. */
export const Row: Story = {
  render: () => (
    <CheckboxRow
      label="Restore the post"
      description="Hidden 14 Oct by Sarah"
      onCheckedChange={fn()}
    />
  ),
  play: async ({ canvasElement }) => {
    const el = box(canvasElement, 'Restore the post Hidden 14 Oct by Sarah');
    await userEvent.click(within(canvasElement).getByText('Restore the post'));
    await expect(el).toHaveAttribute('aria-checked', 'true');
  },
};

function RestoreAll() {
  const posts = ['hike', 'report', 'photo'];
  const [value, setValue] = useState<string[]>(['report']);
  return (
    <CheckboxGroup
      aria-label="Hidden content"
      value={value}
      onValueChange={setValue}
      allValues={posts}
    >
      <CheckboxRow parent label="Restore all" />
      <div className="flex flex-col gap-heading pl-(--space-6)">
        <CheckboxRow value="hike" label="A hike-in note" description="Hidden 12 Oct by Matt" />
        <CheckboxRow value="report" label="A report" description="Hidden 13 Oct by Sarah" />
        <CheckboxRow value="photo" label="A photo" description="Hidden 14 Oct by Sarah" />
      </div>
    </CheckboxGroup>
  );
}

/** "Restore all": the parent is mixed while some are picked, and checks or clears them all. */
export const GroupWithParent: Story = {
  render: () => <RestoreAll />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const all = canvas.getByRole('checkbox', { name: 'Restore all' });
    await expect(all).toHaveAttribute('aria-checked', 'mixed');
    await userEvent.click(all);
    for (const el of canvas.getAllByRole('checkbox')) {
      await expect(el).toHaveAttribute('aria-checked', 'true');
    }
    await userEvent.click(all);
    for (const el of canvas.getAllByRole('checkbox')) {
      await expect(el).toHaveAttribute('aria-checked', 'false');
    }
  },
};

// ── Matrix and four-up ────────────────────────────────────────────────────────────────────────

const ROWS = [
  { key: 'off', label: 'Unchecked' },
  { key: 'on', label: 'Checked' },
  { key: 'mixed', label: 'Indeterminate' },
  { key: 'invalid', label: 'Invalid' },
] as const;
const STATES = [
  { key: 'rest', label: 'Rest' },
  { key: 'hover', label: 'Hover' },
  { key: 'focus', label: 'Focus' },
  { key: 'active', label: 'Pressed' },
  { key: 'disabled', label: 'Disabled' },
] as const;

export const States: Story = {
  render: () => (
    <StateMatrix
      rows={ROWS}
      states={STATES}
      cell={(row, state) => (
        <Checkbox
          data-state={state}
          aria-label={row}
          disabled={state === 'disabled'}
          defaultChecked={row === 'on'}
          indeterminate={row === 'mixed'}
          aria-invalid={row === 'invalid' || undefined}
        />
      )}
    />
  ),
  parameters: PSEUDO_STATES,
  play: async ({ canvasElement }) => {
    const disabled = canvasElement.querySelectorAll('[data-state="disabled"]');
    for (const el of disabled) await expect(el).toHaveAttribute('aria-disabled', 'true');
  },
};

/** Keyboard focus draws the ring and brightens the rim, as hover does. */
export const FocusLights: Story = {
  play: async ({ canvasElement }) => {
    const el = box(canvasElement);
    const lit = computedColor(el, 'var(--fg)');
    await expect(getComputedStyle(el).borderTopColor).not.toBe(lit);
    el.focus();
    await waitFor(() => expect(getComputedStyle(el).boxShadow).toMatch(/3px/));
    await waitFor(() => expect(getComputedStyle(el).borderTopColor).toBe(lit));
  },
};

export const FourUp: Story = {
  render: () => (
    <div className="flex flex-col gap-heading">
      <div className="flex items-center gap-(--space-4)">
        <Checkbox aria-label="Off" />
        <Checkbox aria-label="On" defaultChecked />
        <Checkbox aria-label="Mixed" indeterminate />
        <Checkbox aria-label="Disabled" disabled />
      </div>
      <CheckboxRow label="Restore the post" description="Hidden 14 Oct by Sarah" defaultChecked />
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const el = must(q.querySelector('[role="checkbox"]')).getBoundingClientRect();
      const kick = resolvePx(q, 'var(--type-kick)');
      await expect(el.width).toBeCloseTo(kick * 1.4, 1);
      await expect(el.height).toBeCloseTo(kick * 1.4, 1);
    }
  },
};

// ── Junctions ─────────────────────────────────────────────────────────────────────────────────

/**
 * The box is 1.4 kickers square and centers on the label's first line; the label starts the
 * `space-2_5` gap after it; the pointer area reaches a hit pad past the box.
 */
function RowJunction() {
  return (
    <div data-junction="row" className="m-(--space-8) w-[20rem]">
      <CheckboxRow label="Restore the post" description="Hidden 14 Oct by Sarah, for spam" />
    </div>
  );
}

async function playRowJunction({ canvasElement }: { canvasElement: HTMLElement }) {
  const row = must(canvasElement.querySelector<HTMLElement>('[data-slot="checkbox-row"]'));
  const control = must(row.querySelector<HTMLElement>('[role="checkbox"]'));
  const c = control.getBoundingClientRect();
  const kick = resolvePx(row, 'var(--type-kick)');
  await expect(c.width).toBeCloseTo(kick * 1.4, 1);
  const label = must(row.querySelector('[data-slot="checkbox-label"]'));
  const range = document.createRange();
  range.selectNodeContents(must(label.firstChild));
  const firstLine = must(range.getClientRects()[0]);
  const gap = resolvePx(row, 'var(--space-2_5)');
  await expect(Math.abs(label.getBoundingClientRect().left - c.right - gap)).toBeLessThanOrEqual(
    JUNCTION_TOLERANCE_PX,
  );
  // The text's rect is the font's content area; half-leading pads it equally above and below, so
  // its center is the line's center — and the box sits on it.
  const mid = (r: DOMRect) => r.top + r.height / 2;
  await expect(Math.abs(mid(c) - mid(firstLine))).toBeLessThanOrEqual(1);
  // The pointer area grows past the box by the hit pad, and no further.
  const hitY = resolvePx(row, 'var(--gap-hit-y)');
  const hits = (x: number, y: number) =>
    document.elementFromPoint(x, y)?.closest('[data-slot="checkbox-row"]') === row;
  await expect(hits(c.left + c.width / 2, c.top - hitY + 1)).toBe(true);
  await expect(hits(c.left + c.width / 2, c.top - hitY - 1)).toBe(false);
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
