import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faLink, faMagnifyingGlass } from '@fortawesome/sharp-regular-svg-icons';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ComponentProps, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { Button } from './button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  InputGroup,
  InputGroupIcon,
  InputGroupKbd,
  type InputStatus,
} from './input';
import {
  computedColor,
  contrastBetween,
  JUNCTION_TOLERANCE_PX,
  resolvePx,
  sameColor,
} from './measure';
import { KICKER, must, PSEUDO_STATES, StateMatrix, settled, underPointer } from './storyKit';

const meta = {
  title: 'Kit/Input',
  component: Input,
  tags: ['autodocs'],
  args: { placeholder: 'Add what a sign says', onValueChange: fn() },
  decorators: [(Story) => <div className="w-[20rem]">{Story()}</div>],
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

const textbox = (canvasElement: HTMLElement, name?: string) =>
  within(canvasElement).getByRole('textbox', name === undefined ? undefined : { name });

/**
 * The standard input: text over one rule, the placeholder in the quiet ink. Typing fills it; focus
 * turns the rule bright — no ring, no box.
 */
export const Rest: Story = {
  args: { 'aria-label': 'Sign text' },
  play: async ({ canvasElement, args }) => {
    const el = textbox(canvasElement);
    const style = getComputedStyle(el);
    await expect(style.borderTopWidth).toBe('0px');
    await expect(style.borderBottomStyle).toBe('solid');
    await expect(style.borderBottomColor).toEqual(sameColor(computedColor(el, 'var(--line2)')));
    await expect(style.outlineStyle).toBe('none');
    await userEvent.type(el, 'No skating past the buoys');
    await expect(el).toHaveValue('No skating past the buoys');
    await expect(args.onValueChange).toHaveBeenCalled();
  },
};

/**
 * Focused: the rule turns to the bright ink and doubles (a shadow, so nothing moves). The rule is
 * the field's only boundary, so the focused one must pass 3:1 on the field — it does by far.
 */
export const Focused: Story = {
  args: { 'aria-label': 'Sign text', defaultValue: 'No skating past the buoys' },
  play: async ({ canvasElement }) => {
    const el = textbox(canvasElement);
    const rest = el.getBoundingClientRect();
    const bright = computedColor(el, 'var(--fg)');
    el.focus();
    await waitFor(() => expect(getComputedStyle(el).borderBottomColor).toEqual(sameColor(bright)));
    await waitFor(() => expect(getComputedStyle(el).boxShadow).toMatch(/0px 1px 0px 0px/));
    // Nothing moved.
    const focused = el.getBoundingClientRect();
    await expect([focused.height, focused.top]).toEqual([rest.height, rest.top]);
    await expect(contrastBetween(el, ['var(--bg)'], ['var(--fg)'])).toBeGreaterThanOrEqual(3);
    // (The resting rule is quieter by design — see the doc; the label and placeholder carry it.)
    await expect(contrastBetween(el, ['var(--bg)'], ['var(--line2)'])).toBeLessThan(3);
  },
};

/** A labeled field: the kicker over the control, the description under it, wired to it. */
export const WithField: Story = {
  render: () => (
    <Field>
      <FieldLabel>Sign text</FieldLabel>
      <Input placeholder="Add what a sign says" />
      <FieldDescription>Copied as written, spelling and all</FieldDescription>
    </Field>
  ),
  play: async ({ canvasElement }) => {
    const el = textbox(canvasElement, 'Sign text');
    await expect(el).toHaveAccessibleDescription('Copied as written, spelling and all');
    const label = must(canvasElement.querySelector('[data-slot="field-label"]'));
    await expect(getComputedStyle(label).textTransform).toBe('uppercase');
  },
};

/** Invalid: the rule and the message turn red, and the message is the control's description. */
export const Invalid: Story = {
  render: () => (
    <Field invalid>
      <FieldLabel>Link</FieldLabel>
      <Input defaultValue="mascoma lake" />
      <FieldError match>That isn't a link</FieldError>
    </Field>
  ),
  play: async ({ canvasElement }) => {
    const el = textbox(canvasElement, 'Link');
    await expect(el).toHaveAttribute('aria-invalid', 'true');
    await expect(getComputedStyle(el).borderBottomColor).toEqual(
      sameColor(computedColor(el, 'var(--bad)')),
    );
    await expect(el).toHaveAccessibleDescription("That isn't a link");
    // Focus keeps it red: the error outranks the focus look.
    el.focus();
    await waitFor(() => expect(getComputedStyle(el).boxShadow).toMatch(/0px 1px 0px 0px/));
    await expect(getComputedStyle(el).borderBottomColor).toEqual(
      sameColor(computedColor(el, 'var(--bad)')),
    );
  },
};

/** Native validity flows through Field too: a required field emptied says so. */
export const Required: Story = {
  render: () => (
    <Field validationMode="onChange">
      <FieldLabel>Name</FieldLabel>
      <Input required />
      <FieldError match="valueMissing">A name is needed</FieldError>
    </Field>
  ),
  play: async ({ canvasElement }) => {
    const el = textbox(canvasElement, 'Name');
    await userEvent.type(el, 'M');
    await userEvent.clear(el);
    await waitFor(() => expect(within(canvasElement).getByText('A name is needed')).toBeVisible());
    await expect(el).toHaveAttribute('aria-invalid', 'true');
    const bad = computedColor(el, 'var(--bad)');
    await waitFor(() => expect(getComputedStyle(el).borderBottomColor).toEqual(sameColor(bad)));
  },
};

export const Disabled: Story = {
  args: { 'aria-label': 'Sign text', disabled: true, defaultValue: 'No skating past the buoys' },
  play: async ({ canvasElement }) => {
    const el = textbox(canvasElement);
    await expect(el).toBeDisabled();
    await expect(getComputedStyle(el).color).toEqual(
      sameColor(computedColor(el, 'var(--fg-disabled)')),
    );
  },
};

/**
 * An input that finds something leads with its icon. Its ⏎ shows only while it has focus;
 * clicking the icon focuses the field.
 */
export const Search: Story = {
  render: () => (
    <InputGroup>
      <InputGroupIcon>
        <FontAwesomeIcon icon={faMagnifyingGlass} />
      </InputGroupIcon>
      <Input aria-label="Find a body" placeholder="Find a body or a person" />
      <InputGroupKbd>⏎</InputGroupKbd>
    </InputGroup>
  ),
  play: async ({ canvasElement }) => {
    const el = textbox(canvasElement, 'Find a body');
    const key = must(canvasElement.querySelector<HTMLElement>('[data-slot="kbd"]'));
    await expect(key).not.toBeVisible();
    await userEvent.click(
      must(canvasElement.querySelector<HTMLElement>('[data-slot="input-icon"]')),
    );
    await expect(el).toHaveFocus();
    await waitFor(() => expect(key).toBeVisible());
    const group = must(canvasElement.querySelector<HTMLElement>('[data-slot="input-group"]'));
    const bright = computedColor(group, 'var(--fg)');
    await waitFor(() =>
      expect(getComputedStyle(group).borderBottomColor).toEqual(sameColor(bright)),
    );
    el.blur();
    await waitFor(() => expect(key).not.toBeVisible());
  },
};

/** The key that puts focus here ("/") shows at rest too. */
export const SlashToFocus: Story = {
  render: () => (
    <InputGroup>
      <InputGroupIcon>
        <FontAwesomeIcon icon={faMagnifyingGlass} />
      </InputGroupIcon>
      <Input aria-label="Filter" placeholder="Filter the list" aria-keyshortcuts="/" />
      <InputGroupKbd always>/</InputGroupKbd>
    </InputGroup>
  ),
  play: async ({ canvasElement }) => {
    await expect(must(canvasElement.querySelector('[data-slot="kbd"]'))).toBeVisible();
  },
};

function Autosave() {
  const [status, setStatus] = useState<InputStatus>('saved');
  return (
    <div className="flex flex-col gap-heading">
      <InputGroup status={status}>
        <InputGroupIcon>
          <FontAwesomeIcon icon={faLink} />
        </InputGroupIcon>
        <Input aria-label="Website" defaultValue="mascomalake.org" />
      </InputGroup>
      <div className="flex gap-(--space-2)">
        {(['typing', 'saving', 'saved', 'failed'] as const).map((s) => (
          <Button key={s} size="xs" onClick={() => setStatus(s)}>
            {s}
          </Button>
        ))}
      </div>
    </div>
  );
}

/**
 * Autosave: typing, saving, saved, not saved — in a slot as wide as the longest, so the field
 * never moves while the value saves. A failed save turns the rule red.
 */
export const AutosaveKeepsItsSize: Story = {
  render: () => <Autosave />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const el = textbox(canvasElement, 'Website');
    const group = must(canvasElement.querySelector<HTMLElement>('[data-slot="input-group"]'));
    await document.fonts.ready; // the mono status face changes the slot's width as it loads
    const width = el.getBoundingClientRect().width;
    for (const s of ['typing', 'saving', 'saved', 'failed'] as const) {
      await userEvent.click(canvas.getByRole('button', { name: s }));
      await expect(group).toHaveAttribute('data-status', s);
      await expect(el.getBoundingClientRect().width).toBe(width);
    }
    await expect(canvas.getByText('Not saved', { selector: '[aria-live]' })).toBeInTheDocument();
    const bad = computedColor(group, 'var(--bad)');
    await waitFor(() => expect(getComputedStyle(group).borderBottomColor).toEqual(sameColor(bad)));
  },
};

// ── Matrix and four-up ────────────────────────────────────────────────────────────────────────

const ROWS = [
  { key: 'empty', label: 'Empty' },
  { key: 'filled', label: 'Filled' },
  { key: 'invalid', label: 'Invalid' },
  { key: 'group', label: 'With icon' },
] as const;
const STATES = [
  { key: 'rest', label: 'Rest' },
  { key: 'hover', label: 'Hover' },
  { key: 'focus', label: 'Focus' },
  { key: 'disabled', label: 'Disabled' },
] as const;

function Cell({ row, state }: { row: (typeof ROWS)[number]['key']; state: string }) {
  const props: ComponentProps<typeof Input> = {
    'aria-label': `${row} ${state}`,
    placeholder: 'Add what a sign says',
    defaultValue: row === 'empty' ? undefined : 'No skating past the buoys',
    disabled: state === 'disabled',
    'aria-invalid': row === 'invalid' || undefined,
  };
  if (row === 'group')
    return (
      <InputGroup data-state={state}>
        <InputGroupIcon>
          <FontAwesomeIcon icon={faMagnifyingGlass} />
        </InputGroupIcon>
        <Input {...props} />
      </InputGroup>
    );
  return <Input {...props} data-state={state} />;
}

export const States: Story = {
  decorators: [(Story) => Story()],
  render: () => (
    <StateMatrix
      rows={ROWS}
      states={STATES}
      cell={(row, state) => (
        <div className="w-[12rem]">
          <Cell row={row} state={state} />
        </div>
      )}
    />
  ),
  parameters: {
    pseudo: {
      ...PSEUDO_STATES.pseudo,
      focus: ['[data-state="focus"]'],
      focusWithin: ['[data-state="focus"]'],
    },
  },
  play: async ({ canvasElement }) => {
    // Typed text and the placeholder both pass AA on the field.
    const el = textbox(canvasElement, 'filled rest');
    await expect(contrastBetween(el, ['var(--bg)'], ['var(--fg)'])).toBeGreaterThanOrEqual(4.5);
    await expect(contrastBetween(el, ['var(--bg)'], ['var(--fg3)'])).toBeGreaterThanOrEqual(4.5);
    for (const d of within(canvasElement).getAllByRole('textbox', { name: /disabled/ })) {
      await expect(d).toBeDisabled();
    }
    // Pressing a disabled group's icon doesn't reach for its input.
    const off = textbox(canvasElement, 'group disabled');
    const icon = must(
      off.closest('[data-slot="input-group"]')?.querySelector('[data-slot="input-icon"]'),
    );
    icon.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    await expect(off).not.toHaveFocus();
  },
};

export const FourUp: Story = {
  decorators: [(Story) => Story()],
  render: () => (
    <div className="flex w-[18rem] flex-col gap-heading">
      <Field>
        <FieldLabel>Sign text</FieldLabel>
        <Input placeholder="Add what a sign says" />
      </Field>
      <InputGroup status="saved">
        <InputGroupIcon>
          <FontAwesomeIcon icon={faLink} />
        </InputGroupIcon>
        <Input aria-label="Website" defaultValue="mascomalake.org" />
      </InputGroup>
      <Field invalid>
        <FieldLabel>Link</FieldLabel>
        <Input defaultValue="mascoma lake" />
        <FieldError match>That isn't a link</FieldError>
      </Field>
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const input = must(q.querySelector('[data-slot="input"]')).getBoundingClientRect();
      await expect(input.height).toBeCloseTo(resolvePx(q, 'var(--size-btn)'), 1);
    }
  },
};

// ── Junctions ─────────────────────────────────────────────────────────────────────────────────

/**
 * Label → control: the kicker sits `space-1_5` over the field and its text starts on the label's
 * left edge (no inset). Beside a button, the input stands the button's height, so their bottom
 * edges meet one line. In a group, the icon starts on the left edge and the input `space-1_5`
 * after it.
 */
function FieldJunction() {
  return (
    <div className="flex w-[22rem] flex-col gap-(--space-6)">
      <Field data-junction="field">
        <FieldLabel>Sign text</FieldLabel>
        <Input defaultValue="No skating past the buoys" />
      </Field>
      <div data-junction="bar" className="flex items-end gap-(--space-2)">
        <Input aria-label="Reason" placeholder="Why" />
        <Button>Hide</Button>
      </div>
      <InputGroup data-junction="group">
        <InputGroupIcon>
          <FontAwesomeIcon icon={faMagnifyingGlass} />
        </InputGroupIcon>
        <Input aria-label="Find" placeholder="Find a body" />
      </InputGroup>
      <p className={KICKER}>Labels meet their fields; inputs meet buttons</p>
    </div>
  );
}

async function playFieldJunction({ canvasElement }: { canvasElement: HTMLElement }) {
  const field = must(canvasElement.querySelector<HTMLElement>('[data-junction="field"]'));
  const label = must(field.querySelector('[data-slot="field-label"]')).getBoundingClientRect();
  const input = must(field.querySelector<HTMLInputElement>('[data-slot="input"]'));
  const box = input.getBoundingClientRect();
  const gap = resolvePx(field, 'var(--space-1_5)');
  await expect(Math.abs(box.top - label.bottom - gap)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  await expect(getComputedStyle(input).paddingLeft).toBe('0px');
  await expect(Math.abs(box.left - label.left)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  // Input beside a button: one height, one bottom edge.
  const bar = must(canvasElement.querySelector('[data-junction="bar"]'));
  const [reason, hide] = [...bar.children].map((el) => el.getBoundingClientRect());
  await expect(Math.abs(must(reason).height - must(hide).height)).toBeLessThanOrEqual(
    JUNCTION_TOLERANCE_PX,
  );
  await expect(Math.abs(must(reason).bottom - must(hide).bottom)).toBeLessThanOrEqual(
    JUNCTION_TOLERANCE_PX,
  );
  // Group: the icon on the left edge, the input `space-1_5` after it, the rule the button height.
  const group = must(canvasElement.querySelector<HTMLElement>('[data-junction="group"]'));
  const g = group.getBoundingClientRect();
  const icon = must(group.querySelector('[data-slot="input-icon"]')).getBoundingClientRect();
  const find = must(group.querySelector('[data-slot="input"]')).getBoundingClientRect();
  await expect(Math.abs(icon.left - g.left)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  await expect(Math.abs(find.left - icon.right - gap)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  await expect(g.height).toBeCloseTo(resolvePx(group, 'var(--size-btn)'), 1);
}

export const JunctionFieldAdmin: Story = {
  decorators: [(Story) => Story()],
  render: () => <FieldJunction />,
  globals: { surface: 'admin' },
  play: playFieldJunction,
};

export const JunctionFieldSkater: Story = {
  decorators: [(Story) => Story()],
  render: () => <FieldJunction />,
  globals: { surface: 'skater' },
  play: playFieldJunction,
};

/**
 * Hover lifts a resting rule, and only a resting one: focus, an error and a failed save each keep
 * their look under the pointer. Runs under the story tests only — `:hover` needs the real pointer.
 */
export const HoverYieldsToState: Story = {
  tags: ['!dev', '!autodocs'],
  render: () => (
    <div className="flex flex-col gap-heading">
      <Input aria-label="Resting" />
      <Input aria-label="Focused" />
      <Input aria-label="Invalid" aria-invalid />
      <InputGroup status="failed">
        <Input aria-label="Failed save" />
      </InputGroup>
      <InputGroup>
        <Input aria-label="Grouped" />
      </InputGroup>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const box = (name: string) => textbox(canvasElement, name);
    const group = (name: string) =>
      must(box(name).closest<HTMLElement>('[data-slot="input-group"]'));
    const rule = (el: HTMLElement) => () => getComputedStyle(el).borderBottomColor;
    const fg3 = sameColor(computedColor(canvasElement, 'var(--fg3)'));
    const fg = sameColor(computedColor(canvasElement, 'var(--fg)'));
    const bad = sameColor(computedColor(canvasElement, 'var(--bad)'));
    // The control: the pointer does lift a resting rule, so the cases after it can't pass idle.
    await expect(await underPointer(box('Resting'), rule(box('Resting')))).toEqual(fg3);
    const focused = box('Focused');
    focused.focus();
    await settled(focused);
    await expect(await underPointer(focused, rule(focused))).toEqual(fg);
    await expect(await underPointer(box('Invalid'), rule(box('Invalid')))).toEqual(bad);
    const failed = group('Failed save');
    await expect(await underPointer(failed, rule(failed))).toEqual(bad);
    const grouped = group('Grouped');
    box('Grouped').focus();
    await settled(grouped);
    await expect(await underPointer(grouped, rule(grouped))).toEqual(fg);
    box('Grouped').blur();
  },
};
