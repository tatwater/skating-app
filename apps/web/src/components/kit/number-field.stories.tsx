import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { Button } from './button';
import { Field, FieldError, FieldLabel } from './input';
import { computedColor, JUNCTION_TOLERANCE_PX, resolvePx, sameColor } from './measure';
import { NumberField } from './number-field';
import { KICKER, must, PSEUDO_STATES, StateMatrix, settled, underPointer } from './storyKit';

const meta = {
  title: 'Kit/NumberField',
  component: NumberField,
  tags: ['autodocs'],
  args: { onValueChange: fn() },
  decorators: [(Story) => <div className="w-[18rem]">{Story()}</div>],
} satisfies Meta<typeof NumberField>;

export default meta;
type Story = StoryObj<typeof meta>;

const box = (canvasElement: HTMLElement, name?: string | RegExp) =>
  within(canvasElement).getByRole('textbox', name === undefined ? undefined : { name });
const part = (scope: Element, slot: string) =>
  must(scope.querySelector<HTMLElement>(`[data-slot="number-field${slot ? `-${slot}` : ''}"]`));

/**
 * The Rates sheet's price: the kicker over an underline, the dollar sign quiet inside the rule,
 * the number in mono — four decimals, as a metered price is written — and the unit outside.
 */
export const Rest: Story = {
  args: {
    label: 'Price per unit',
    currency: 'USD',
    decimals: 4,
    defaultValue: 0.0035,
    unit: 'per call',
  },
  play: async ({ canvasElement }) => {
    const el = box(canvasElement, 'Price per unit');
    await expect(el).toHaveValue('0.0035');
    const group = part(canvasElement, 'group');
    const style = getComputedStyle(group);
    await expect(style.borderTopWidth).toBe('0px');
    await expect(style.borderBottomColor).toEqual(sameColor(computedColor(group, 'var(--line2)')));
    // Mono, tabular — and the sign is a separate, quiet glyph, not part of the value.
    await expect(getComputedStyle(el).fontVariantNumeric).toContain('tabular-nums');
    await expect(getComputedStyle(el).fontFamily).toBe(
      getComputedStyle(part(canvasElement, 'prefix')).fontFamily,
    );
    await expect(part(canvasElement, 'prefix')).toHaveTextContent('$');
    // The unit hangs outside the rule.
    const unit = part(canvasElement, 'unit').getBoundingClientRect();
    await expect(unit.left).toBeGreaterThanOrEqual(group.getBoundingClientRect().right - 0.5);
    // The button's height.
    await expect(group.getBoundingClientRect().height).toBeCloseTo(
      resolvePx(group, 'var(--size-btn)'),
      1,
    );
  },
};

/** Focus turns the rule bright and doubles it, as on every underline; nothing moves. */
export const Focused: Story = {
  args: { label: 'Daily quota', defaultValue: 10000, unit: 'calls' },
  play: async ({ canvasElement }) => {
    const el = box(canvasElement, 'Daily quota');
    const group = part(canvasElement, 'group');
    const rest = group.getBoundingClientRect();
    el.focus();
    const bright = computedColor(group, 'var(--fg)');
    await waitFor(() =>
      expect(getComputedStyle(group).borderBottomColor).toEqual(sameColor(bright)),
    );
    await waitFor(() => expect(getComputedStyle(group).boxShadow).toMatch(/0px 1px 0px 0px/));
    const focused = group.getBoundingClientRect();
    await expect([focused.height, focused.top]).toEqual([rest.height, rest.top]);
    el.blur();
  },
};

/**
 * The keyboard steps: ↑↓ by the step, ⇧ by the large step, Home and End to the ends. Formatting
 * settles on blur (here, two decimals).
 */
export const Keyboard: Story = {
  args: {
    label: 'Monthly plan',
    currency: 'USD',
    defaultValue: 25,
    min: 0,
    max: 500,
    step: 1,
    largeStep: 10,
    unit: '/mo',
  },
  play: async ({ canvasElement, args }) => {
    const el = box(canvasElement, 'Monthly plan');
    await expect(el).toHaveValue('25.00');
    await userEvent.click(el);
    await userEvent.keyboard('{ArrowUp}');
    await expect(el).toHaveValue('26.00');
    await userEvent.keyboard('{Shift>}{ArrowUp}{/Shift}');
    await expect(el).toHaveValue('36.00');
    await userEvent.keyboard('{ArrowDown}');
    await expect(el).toHaveValue('35.00');
    await userEvent.keyboard('{End}');
    await expect(el).toHaveValue('500.00');
    await userEvent.keyboard('{Home}');
    await expect(el).toHaveValue('0.00');
    await expect(args.onValueChange).toHaveBeenCalled();
    // Typed digits settle to the format on blur.
    await userEvent.clear(el);
    await userEvent.type(el, '12.5');
    el.blur();
    await waitFor(() => expect(el).toHaveValue('12.50'));
  },
};

/**
 * A draft beside its saved value: unchanged, it rests like any field; changed, the rule and the
 * number turn bright — the row reads as edited.
 */
export const Changed: Story = {
  args: { label: 'Retry after', defaultValue: 15, saved: 15, unit: 'min' },
  play: async ({ canvasElement }) => {
    const root = part(canvasElement, '');
    const el = box(canvasElement, 'Retry after');
    const group = part(canvasElement, 'group');
    await expect(root).not.toHaveAttribute('data-changed');
    await expect(getComputedStyle(el).color).toEqual(sameColor(computedColor(el, 'var(--fg1)')));
    await userEvent.click(el);
    await userEvent.keyboard('{ArrowUp}');
    el.blur();
    await waitFor(() => expect(root).toHaveAttribute('data-changed'));
    await expect(getComputedStyle(el).color).toEqual(sameColor(computedColor(el, 'var(--fg)')));
    const bright = computedColor(group, 'var(--fg)');
    await waitFor(() =>
      expect(getComputedStyle(group).borderBottomColor).toEqual(sameColor(bright)),
    );
    // Back to the saved value, it rests again.
    await userEvent.click(el);
    await userEvent.keyboard('{ArrowDown}');
    el.blur();
    await waitFor(() => expect(root).not.toHaveAttribute('data-changed'));
  },
};

/** In a kit `Field`: the field's label names it, and an invalid field turns the rule red. */
export const Invalid: Story = {
  render: () => (
    <Field invalid>
      <FieldLabel>Daily quota</FieldLabel>
      <NumberField defaultValue={0} unit="calls" />
      <FieldError match>A quota needs at least one call</FieldError>
    </Field>
  ),
  play: async ({ canvasElement }) => {
    const el = box(canvasElement, 'Daily quota');
    await expect(el).toHaveAttribute('aria-invalid', 'true');
    await expect(el).toHaveAccessibleDescription('A quota needs at least one call');
    const group = part(canvasElement, 'group');
    const bad = computedColor(group, 'var(--bad)');
    await expect(getComputedStyle(group).borderBottomColor).toEqual(sameColor(bad));
    el.focus();
    await waitFor(() => expect(getComputedStyle(group).boxShadow).toMatch(/0px 1px 0px 0px/));
    await expect(getComputedStyle(group).borderBottomColor).toEqual(sameColor(bad));
    el.blur();
  },
};

/** Out of range with `allowOutOfRange`: native validity marks it, and the rule says so. */
export const OutOfRange: Story = {
  render: () => (
    <Field validationMode="onChange">
      <FieldLabel>Daily quota</FieldLabel>
      <NumberField defaultValue={100} min={1} max={2000} allowOutOfRange unit="calls" />
      <FieldError match="rangeOverflow">The provider allows 2,000 a day</FieldError>
    </Field>
  ),
  play: async ({ canvasElement }) => {
    const el = box(canvasElement, 'Daily quota');
    await userEvent.clear(el);
    await userEvent.type(el, '2500');
    await waitFor(() =>
      expect(within(canvasElement).getByText('The provider allows 2,000 a day')).toBeVisible(),
    );
    const group = part(canvasElement, 'group');
    const bad = computedColor(group, 'var(--bad)');
    await waitFor(() => expect(getComputedStyle(group).borderBottomColor).toEqual(sameColor(bad)));
  },
};

export const Disabled: Story = {
  args: { label: 'Price per unit', currency: 'USD', defaultValue: 0.5, disabled: true },
  play: async ({ canvasElement }) => {
    const el = box(canvasElement, 'Price per unit');
    await expect(el).toBeDisabled();
    await expect(getComputedStyle(el).color).toEqual(
      sameColor(computedColor(el, 'var(--fg-disabled)')),
    );
    const group = part(canvasElement, 'group');
    await expect(getComputedStyle(group).borderBottomColor).toEqual(
      sameColor(computedColor(group, 'var(--line)')),
    );
  },
};

/** Read-only: the value stands, the rule goes dotted, and the arrows don't change it. */
export const ReadOnly: Story = {
  args: { label: 'Invoiced', currency: 'USD', defaultValue: 42, readOnly: true },
  play: async ({ canvasElement }) => {
    const el = box(canvasElement, 'Invoiced');
    await expect(getComputedStyle(part(canvasElement, 'group')).borderBottomStyle).toBe('dotted');
    await userEvent.click(el);
    await userEvent.keyboard('{ArrowUp}');
    await expect(el).toHaveValue('42.00');
    el.blur();
  },
};

/**
 * Steppers, where a field wants them (off by default — the boards draw none): a joined pair of
 * squares after the unit. They step, repeat while held, stop at the ends, and stay out of the
 * tab order (the arrow keys step).
 */
export const Steppers: Story = {
  args: { label: 'Seats', defaultValue: 1, min: 1, max: 5, steppers: true, unit: 'seats' },
  play: async ({ canvasElement }) => {
    const el = box(canvasElement, 'Seats');
    const down = part(canvasElement, 'decrement');
    const up = part(canvasElement, 'increment');
    await expect(down).toHaveAttribute('data-disabled');
    await userEvent.click(up);
    await expect(el).toHaveValue('2');
    await expect(down).not.toHaveAttribute('data-disabled');
    await expect(up.tabIndex).toBe(-1);
    // Squares of the small button height, sharing an edge.
    const [d, u] = [down.getBoundingClientRect(), up.getBoundingClientRect()];
    const sm = resolvePx(down, 'var(--size-btn-sm)');
    await expect(d.width).toBeCloseTo(sm, 1);
    await expect(d.height).toBeCloseTo(sm, 1);
    await expect(u.left).toBeCloseTo(d.right - 1, 1);
    // The field keeps the button height with steppers beside it.
    await expect(part(canvasElement, 'group').getBoundingClientRect().height).toBeCloseTo(
      resolvePx(down, 'var(--size-btn)'),
      1,
    );
  },
};

/**
 * Scrub, where a field wants it (off by default): the label is a handle — drag it sideways to
 * change the value; the pointer becomes a two-way arrow while held.
 */
export const Scrub: Story = {
  args: { label: 'Map boost', defaultValue: 0.5, step: 0.05, min: 0, max: 1, scrub: true },
  play: async ({ canvasElement }) => {
    const handle = part(canvasElement, 'scrub');
    await expect(getComputedStyle(handle).cursor).toBe('ew-resize');
    await expect(within(handle).getByText('Map boost')).toBeVisible();
    // The label still names the field.
    await expect(box(canvasElement, 'Map boost')).toHaveValue('0.5');
  },
};

/** Empty and filled fields stand the same size: a value arriving never shifts the row. */
export const EmptyKeepsItsSize: Story = {
  render: () => (
    <div className="flex flex-col gap-heading">
      <NumberField aria-label="Empty" placeholder="0.00" currency="USD" unit="/mo" />
      <NumberField aria-label="Filled" defaultValue={1250} currency="USD" unit="/mo" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const [empty, filled] = [...canvasElement.querySelectorAll('[data-slot="number-field"]')].map(
      (el) => el.getBoundingClientRect(),
    );
    await expect(must(empty).height).toBe(must(filled).height);
    await expect(must(empty).width).toBe(must(filled).width);
  },
};

// ── An edit column ────────────────────────────────────────────────────────────────────────────

const RULES = [
  { name: 'Weighted calls', value: 10000, saved: 10000, unit: 'per day' },
  { name: 'Emails', value: 120, saved: 100, unit: 'per day' },
  { name: 'Retry after', value: 15, saved: 15, unit: 'min' },
] as const;

function EditColumn() {
  return (
    <table className="w-full border-collapse">
      <tbody>
        {RULES.map((r) => (
          <tr key={r.name}>
            <th scope="row" className="text-left text-assist font-regular text-fg2">
              {r.name}
            </th>
            <td className="w-[11rem]">
              <NumberField
                aria-label={r.name}
                defaultValue={r.value}
                saved={r.saved}
                unit={r.unit}
                unitSlot="4.5em"
                align="end"
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The thresholds sheet's draft column: numbers right-aligned on one edge, each unit in a slot of
 * one width after it, so both read straight down; the changed row lights.
 */
export const EditTable: Story = {
  decorators: [(Story) => <div className="w-[22rem]">{Story()}</div>],
  render: () => <EditColumn />,
  play: async ({ canvasElement }) => {
    const groups = [...canvasElement.querySelectorAll('[data-slot="number-field-group"]')];
    const units = [...canvasElement.querySelectorAll('[data-slot="number-field-unit"]')];
    const rights = groups.map((g) => g.getBoundingClientRect().right);
    const unitLefts = units.map((u) => u.getBoundingClientRect().left);
    for (const r of rights) await expect(Math.abs(r - must(rights[0]))).toBeLessThanOrEqual(0.5);
    for (const l of unitLefts)
      await expect(Math.abs(l - must(unitLefts[0]))).toBeLessThanOrEqual(0.5);
    const changed = [...canvasElement.querySelectorAll('[data-slot="number-field"][data-changed]')];
    await expect(changed).toHaveLength(1);
    await expect(within(must(changed[0]) as HTMLElement).getByRole('textbox')).toHaveValue('120');
  },
};

// ── Matrix and four-up ────────────────────────────────────────────────────────────────────────

const ROWS = [
  { key: 'empty', label: 'Empty' },
  { key: 'filled', label: 'Filled' },
  { key: 'changed', label: 'Changed' },
  { key: 'invalid', label: 'Invalid' },
  { key: 'steppers', label: 'Steppers' },
] as const;
const STATES = [
  { key: 'rest', label: 'Rest' },
  { key: 'hover', label: 'Hover' },
  { key: 'focus', label: 'Focus' },
  { key: 'disabled', label: 'Disabled' },
] as const;

function Cell({ row, state }: { row: (typeof ROWS)[number]['key']; state: string }) {
  return (
    <NumberField
      data-state={state}
      aria-label={`${row} ${state}`}
      placeholder="0.00"
      currency="USD"
      unit="/mo"
      defaultValue={row === 'empty' ? undefined : 25}
      saved={row === 'changed' ? 20 : undefined}
      aria-invalid={row === 'invalid' || undefined}
      steppers={row === 'steppers'}
      disabled={state === 'disabled'}
    />
  );
}

export const States: Story = {
  decorators: [(Story) => Story()],
  render: () => (
    <StateMatrix
      rows={ROWS}
      states={STATES}
      cell={(row, state) => (
        <div className="w-[11rem]">
          <Cell row={row} state={state} />
        </div>
      )}
    />
  ),
  parameters: {
    pseudo: {
      ...PSEUDO_STATES.pseudo,
      hover: ['[data-state="hover"] [data-slot="number-field-group"]'],
      focus: ['[data-state="focus"] input'],
      focusWithin: ['[data-state="focus"] [data-slot="number-field-group"]'],
    },
  },
  play: async ({ canvasElement }) => {
    for (const d of within(canvasElement).getAllByRole('textbox', { name: /disabled/ })) {
      await expect(d).toBeDisabled();
    }
    const bad = box(canvasElement, 'invalid rest');
    const group = must(bad.closest<HTMLElement>('[data-slot="number-field-group"]'));
    await expect(getComputedStyle(group).borderBottomColor).toEqual(
      sameColor(computedColor(group, 'var(--bad)')),
    );
  },
};

export const FourUp: Story = {
  decorators: [(Story) => Story()],
  render: () => (
    <div className="flex w-[18rem] flex-col gap-heading">
      <NumberField label="Price per unit" currency="USD" decimals={4} defaultValue={0.0035} />
      <NumberField label="Monthly plan" currency="USD" defaultValue={25} saved={20} unit="/mo" />
      <NumberField label="Seats" defaultValue={2} min={1} max={5} steppers unit="seats" />
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      for (const g of q.querySelectorAll('[data-slot="number-field-group"]')) {
        await expect(g.getBoundingClientRect().height).toBeCloseTo(
          resolvePx(q, 'var(--size-btn)'),
          1,
        );
      }
    }
  },
};

// ── Junctions ─────────────────────────────────────────────────────────────────────────────────

/**
 * Beside a button the field stands the button's height, so their bottom edges meet one line; the
 * kicker sits `space-1_5` over the rule's box and starts on its left edge; the unit sits 7 px
 * (0.6 of its own step) after the number's rule.
 */
function Junction() {
  const [rate, setRate] = useState<number | null>(25);
  return (
    <div className="flex w-[24rem] flex-col gap-(--space-6)">
      <div data-junction="bar" className="flex items-end gap-(--space-2)">
        <NumberField
          label="Monthly plan"
          currency="USD"
          value={rate}
          onValueChange={setRate}
          unit="/mo"
        />
        <Button>Save</Button>
      </div>
      <p className={KICKER}>Fields meet buttons; units hang outside</p>
    </div>
  );
}

async function playJunction({ canvasElement }: { canvasElement: HTMLElement }) {
  const bar = must(canvasElement.querySelector<HTMLElement>('[data-junction="bar"]'));
  const group = part(bar, 'group').getBoundingClientRect();
  const save = within(bar).getByRole('button', { name: 'Save' }).getBoundingClientRect();
  await expect(Math.abs(group.height - save.height)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  await expect(Math.abs(group.bottom - save.bottom)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  const label = part(bar, 'label').getBoundingClientRect();
  const gap = resolvePx(bar, 'var(--space-1_5)');
  await expect(Math.abs(group.top - label.bottom - gap)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  await expect(Math.abs(group.left - label.left)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  // The unit's text starts 0.6 of its own step after the rule's end.
  const unitEl = part(bar, 'unit');
  const text = document.createRange();
  text.selectNodeContents(unitEl);
  const ink = text.getBoundingClientRect();
  const step = parseFloat(getComputedStyle(unitEl).fontSize);
  await expect(Math.abs(ink.left - group.right - step * 0.6)).toBeLessThanOrEqual(0.5);
}

export const JunctionAdmin: Story = {
  decorators: [(Story) => Story()],
  render: () => <Junction />,
  globals: { surface: 'admin' },
  play: playJunction,
};

export const JunctionSkater: Story = {
  decorators: [(Story) => Story()],
  render: () => <Junction />,
  globals: { surface: 'skater' },
  play: playJunction,
};

/**
 * Hover lifts a resting rule, and only a resting one: focus, an error and a disabled field keep
 * their look under the pointer. Runs under the story tests only — `:hover` needs the real pointer.
 */
export const HoverYieldsToState: Story = {
  tags: ['!dev', '!autodocs'],
  render: () => (
    <div className="flex flex-col gap-heading">
      <NumberField aria-label="Resting" defaultValue={1} />
      <NumberField aria-label="Focused" defaultValue={1} />
      <Field invalid>
        <FieldLabel>Invalid</FieldLabel>
        <NumberField defaultValue={0} />
      </Field>
      <NumberField aria-label="Disabled" defaultValue={1} disabled />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const group = (name: string) =>
      must(box(canvasElement, name).closest<HTMLElement>('[data-slot="number-field-group"]'));
    const rule = (el: HTMLElement) => () => getComputedStyle(el).borderBottomColor;
    const fg3 = sameColor(computedColor(canvasElement, 'var(--fg3)'));
    const fg = sameColor(computedColor(canvasElement, 'var(--fg)'));
    const bad = sameColor(computedColor(canvasElement, 'var(--bad)'));
    const line = sameColor(computedColor(canvasElement, 'var(--line)'));
    // The control: the pointer does lift a resting rule, so the cases after it can't pass idle.
    await expect(await underPointer(group('Resting'), rule(group('Resting')))).toEqual(fg3);
    box(canvasElement, 'Focused').focus();
    await settled(group('Focused'));
    await expect(await underPointer(group('Focused'), rule(group('Focused')))).toEqual(fg);
    box(canvasElement, 'Focused').blur();
    await expect(await underPointer(group('Invalid'), rule(group('Invalid')))).toEqual(bad);
    await expect(await underPointer(group('Disabled'), rule(group('Disabled')))).toEqual(line);
  },
};
