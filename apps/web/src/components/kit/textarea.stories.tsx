import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { Field, FieldDescription, FieldError, FieldLabel } from './input';
import {
  computedColor,
  contrastBetween,
  JUNCTION_TOLERANCE_PX,
  resolvePx,
  sameColor,
  shadowsIn,
} from './measure';
import { KICKER, must, PSEUDO_STATES, StateMatrix } from './storyKit';
import { Textarea } from './textarea';

const meta = {
  title: 'Kit/Textarea',
  component: Textarea,
  tags: ['autodocs'],
  args: { placeholder: 'Why?', onValueChange: fn() },
  decorators: [(Story) => <div className="w-[22rem]">{Story()}</div>],
} satisfies Meta<typeof Textarea>;

export default meta;
type Story = StoryObj<typeof meta>;

const box = (canvasElement: HTMLElement, name?: string) =>
  within(canvasElement).getByRole('textbox', name === undefined ? undefined : { name });

/**
 * The boxed text area: a hairline box in the stronger rule, the placeholder in the quiet ink.
 * Typing fills it; it starts four rem tall and drags taller, never wider.
 */
export const Rest: Story = {
  args: { 'aria-label': 'Reason' },
  play: async ({ canvasElement, args }) => {
    const el = box(canvasElement);
    await expect(el.tagName).toBe('TEXTAREA');
    const style = getComputedStyle(el);
    for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
      await expect(style[`border${side}Width`]).toBe('1px');
      await expect(style[`border${side}Color`]).toEqual(
        sameColor(computedColor(el, 'var(--line2)')),
      );
    }
    await expect(style.borderRadius).toBe('0px');
    await expect(style.resize).toBe('vertical');
    await expect(style.outlineStyle).toBe('none');
    await userEvent.type(el, 'Duplicate of the 14 Feb report');
    await expect(el).toHaveValue('Duplicate of the 14 Feb report');
    await expect(args.onValueChange).toHaveBeenCalled();
  },
};

/**
 * Focused: the edge brightens one step, to `fg2` — never the bright ink, and no ring. Nothing
 * moves, and the focused edge still clears 3:1 on the ground as a boundary.
 */
export const Focused: Story = {
  args: { 'aria-label': 'Reason', defaultValue: 'Duplicate of the 14 Feb report' },
  play: async ({ canvasElement }) => {
    const el = box(canvasElement);
    const rest = el.getBoundingClientRect();
    const step = computedColor(el, 'var(--fg2)');
    const bright = computedColor(el, 'var(--fg)');
    el.focus();
    await waitFor(() => expect(getComputedStyle(el).borderTopColor).toEqual(sameColor(step)));
    const style = getComputedStyle(el);
    await expect(style.borderTopColor).not.toEqual(sameColor(bright));
    // No ring: every shadow layer is transparent.
    for (const layer of shadowsIn(style.boxShadow)) {
      await expect(layer.color).toEqual(sameColor('rgba(0, 0, 0, 0)'));
    }
    await expect(style.outlineStyle).toBe('none');
    const focused = el.getBoundingClientRect();
    await expect([focused.width, focused.height, focused.top]).toEqual([
      rest.width,
      rest.height,
      rest.top,
    ]);
    await expect(contrastBetween(el, ['var(--bg)'], ['var(--fg2)'])).toBeGreaterThanOrEqual(3);
  },
};

/** In a kit Field: the kicker labels it, the description describes it. */
export const WithField: Story = {
  render: () => (
    <Field>
      <FieldLabel>Note</FieldLabel>
      <Textarea placeholder="What the next person should know" />
      <FieldDescription>Only admins see notes</FieldDescription>
    </Field>
  ),
  play: async ({ canvasElement }) => {
    const el = box(canvasElement, 'Note');
    await expect(el).toHaveAccessibleDescription('Only admins see notes');
  },
};

/** Invalid: the edge turns red and stays red under focus — the error outranks the focus look. */
export const Invalid: Story = {
  render: () => (
    <Field invalid>
      <FieldLabel>Reason</FieldLabel>
      <Textarea defaultValue="x" />
      <FieldError match>Say a little more, for the audit log</FieldError>
    </Field>
  ),
  play: async ({ canvasElement }) => {
    const el = box(canvasElement, 'Reason');
    const bad = computedColor(el, 'var(--bad)');
    await expect(el).toHaveAttribute('aria-invalid', 'true');
    await expect(getComputedStyle(el).borderTopColor).toEqual(sameColor(bad));
    await expect(el).toHaveAccessibleDescription('Say a little more, for the audit log');
    el.focus();
    await expect(el).toHaveFocus();
    await expect(getComputedStyle(el).borderTopColor).toEqual(sameColor(bad));
  },
};

/** `aria-invalid` alone (a server refusal outside a Field) edges it in red too. */
export const AriaInvalid: Story = {
  args: { 'aria-label': 'Reason', 'aria-invalid': true, defaultValue: 'Spam' },
  play: async ({ canvasElement }) => {
    const el = box(canvasElement);
    await expect(getComputedStyle(el).borderTopColor).toEqual(
      sameColor(computedColor(el, 'var(--bad)')),
    );
  },
};

/** Native validity flows through a Field: a required box emptied says so. */
export const Required: Story = {
  render: () => (
    <Field validationMode="onChange">
      <FieldLabel>Reply</FieldLabel>
      <Textarea required />
      <FieldError match="valueMissing">A reply needs some words</FieldError>
    </Field>
  ),
  play: async ({ canvasElement }) => {
    const el = box(canvasElement, 'Reply');
    await userEvent.type(el, 'T');
    await userEvent.clear(el);
    await waitFor(() =>
      expect(within(canvasElement).getByText('A reply needs some words')).toBeVisible(),
    );
    const bad = computedColor(el, 'var(--bad)');
    await waitFor(() => expect(getComputedStyle(el).borderTopColor).toEqual(sameColor(bad)));
  },
};

/** Disabled: the text and the edge fade; it takes no focus. */
export const Disabled: Story = {
  args: { 'aria-label': 'Reason', disabled: true, defaultValue: 'Duplicate of the 14 Feb report' },
  play: async ({ canvasElement }) => {
    const el = box(canvasElement);
    await expect(el).toBeDisabled();
    const style = getComputedStyle(el);
    await expect(style.color).toEqual(sameColor(computedColor(el, 'var(--fg-disabled)')));
    await expect(style.borderTopColor).toEqual(sameColor(computedColor(el, 'var(--line)')));
  },
};

/** `rows` sets a taller start; the four-rem floor still holds for a short one. */
export const Rows: Story = {
  render: () => (
    <div className="flex flex-col gap-heading">
      <Textarea aria-label="Short" rows={1} />
      <Textarea aria-label="Tall" rows={8} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const short = box(canvasElement, 'Short').getBoundingClientRect();
    const tall = box(canvasElement, 'Tall').getBoundingClientRect();
    await expect(short.height).toBeCloseTo(resolvePx(canvasElement, '4rem'), 1);
    await expect(tall.height).toBeGreaterThan(short.height);
  },
};

// ── Matrix and four-up ────────────────────────────────────────────────────────────────────────

const ROWS = [
  { key: 'empty', label: 'Empty' },
  { key: 'filled', label: 'Filled' },
  { key: 'invalid', label: 'Invalid' },
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
        <div className="w-[12rem]">
          <Textarea
            aria-label={`${row} ${state}`}
            data-state={state}
            placeholder="Why?"
            defaultValue={row === 'empty' ? undefined : 'Duplicate of the 14 Feb report'}
            disabled={state === 'disabled'}
            aria-invalid={row === 'invalid' || undefined}
          />
        </div>
      )}
    />
  ),
  parameters: {
    pseudo: { ...PSEUDO_STATES.pseudo, focus: ['[data-state="focus"]'] },
  },
  play: async ({ canvasElement }) => {
    // Typed text and the placeholder both pass AA on the ground.
    const el = box(canvasElement, 'filled rest');
    await expect(contrastBetween(el, ['var(--bg)'], ['var(--fg)'])).toBeGreaterThanOrEqual(4.5);
    await expect(contrastBetween(el, ['var(--bg)'], ['var(--fg3)'])).toBeGreaterThanOrEqual(4.5);
    // A disabled box doesn't light on hover.
    const off = box(canvasElement, 'empty disabled');
    await expect(getComputedStyle(off).borderTopColor).toEqual(
      sameColor(computedColor(off, 'var(--line)')),
    );
  },
};

export const FourUp: Story = {
  decorators: [(Story) => Story()],
  render: () => (
    <div className="flex w-[18rem] flex-col gap-heading">
      <Field>
        <FieldLabel>Reason</FieldLabel>
        <Textarea placeholder="Why?" />
      </Field>
      <Field invalid>
        <FieldLabel>Reply</FieldLabel>
        <Textarea defaultValue="x" />
        <FieldError match>Say a little more</FieldError>
      </Field>
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      // In every theme the focus step is a boundary (≥ 3:1) and is not the bright ink.
      const el = must(q.querySelector<HTMLElement>('[data-slot="textarea"]'));
      await expect(contrastBetween(el, ['var(--bg)'], ['var(--fg2)'])).toBeGreaterThanOrEqual(3);
      await expect(computedColor(el, 'var(--fg2)')).not.toEqual(
        sameColor(computedColor(el, 'var(--fg)')),
      );
    }
  },
};

// ── Junctions ─────────────────────────────────────────────────────────────────────────────────

/**
 * Label → box: the kicker sits `space-1_5` over the box (the Field's gap). Inside, the text starts
 * `space-2_5` in from the edge and `space-2` down from it — rem, so it scales with the font size.
 */
function BoxJunction() {
  return (
    <div className="flex w-[22rem] flex-col gap-(--space-6)">
      <Field data-junction="field">
        <FieldLabel>Reason</FieldLabel>
        <Textarea defaultValue="Duplicate of the 14 Feb report" />
      </Field>
      <p className={KICKER}>The label meets its box; the text sits inset</p>
    </div>
  );
}

async function playBoxJunction({ canvasElement }: { canvasElement: HTMLElement }) {
  const field = must(canvasElement.querySelector<HTMLElement>('[data-junction="field"]'));
  const label = must(field.querySelector('[data-slot="field-label"]')).getBoundingClientRect();
  const el = must(field.querySelector<HTMLTextAreaElement>('[data-slot="textarea"]'));
  const r = el.getBoundingClientRect();
  await expect(Math.abs(r.top - label.bottom - resolvePx(field, 'var(--space-1_5)'))).toBeLessThan(
    JUNCTION_TOLERANCE_PX,
  );
  await expect(Math.abs(r.left - label.left)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  const style = getComputedStyle(el);
  await expect(parseFloat(style.paddingLeft)).toBeCloseTo(
    resolvePx(el.parentElement ?? el, 'var(--space-2_5)'),
    2,
  );
  await expect(parseFloat(style.paddingTop)).toBeCloseTo(
    resolvePx(el.parentElement ?? el, 'var(--space-2)'),
    2,
  );
  await expect(r.height).toBeGreaterThanOrEqual(resolvePx(field, '4rem') - JUNCTION_TOLERANCE_PX);
}

export const JunctionBoxAdmin: Story = {
  decorators: [(Story) => Story()],
  render: () => <BoxJunction />,
  globals: { surface: 'admin' },
  play: playBoxJunction,
};

export const JunctionBoxSkater: Story = {
  decorators: [(Story) => Story()],
  render: () => <BoxJunction />,
  globals: { surface: 'skater' },
  play: playBoxJunction,
};
