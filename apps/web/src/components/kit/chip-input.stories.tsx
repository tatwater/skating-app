import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { ChipInput, type ChipInputProps } from './chip-input';
import { Field, FieldLabel } from './input';
import {
  computedColor,
  contrastBetween,
  horizontalGaps,
  JUNCTION_TOLERANCE_PX,
  resolvePx,
} from './measure';
import { must } from './storyKit';

const meta = {
  title: 'Kit/ChipInput',
  component: ChipInput,
  tags: ['autodocs'],
  decorators: [(Story) => <div className="w-[26rem]">{Story()}</div>],
} satisfies Meta<typeof ChipInput>;

export default meta;
type Story = StoryObj<typeof meta>;

const ALIASES = ['Mascoma Lake Reservoir', 'Lake Mascoma'];
/** What the server knows by name; the story's search narrows it as Convex would. */
const KNOWN = ['Mascoma Pond', 'Mascoma Reservoir', 'Mascoma North', 'Masc Lake', 'Crystal Lake'];

/** A labeled alias field fed by a server search (narrowed to the query, empty until one). */
function Aliases({ onValueChange, ...props }: Partial<ChipInputProps>) {
  const [value, setValue] = useState<string[]>(ALIASES);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const suggestions = q === '' ? [] : KNOWN.filter((k) => k.toLowerCase().includes(q));
  return (
    <Field data-junction="field">
      <FieldLabel>Aliases</FieldLabel>
      <ChipInput
        value={value}
        onValueChange={(next) => {
          setValue(next);
          onValueChange?.(next);
        }}
        suggestions={suggestions}
        onQueryChange={setQuery}
        {...props}
      />
    </Field>
  );
}

const field = (scope: HTMLElement) => within(scope).getByRole('combobox');
const chips = (scope: ParentNode) => [...scope.querySelectorAll<HTMLElement>('[data-slot="chip"]')];
const chipText = (scope: ParentNode) => chips(scope).map((c) => c.textContent);
const list = () => document.querySelector<HTMLElement>('[data-slot="chip-input-list"]');
const highlighted = () =>
  document.querySelector<HTMLElement>('[data-slot="chip-input-list"] [data-highlighted]');

/**
 * Aliases: square chips in the badge's register on one rule with the field; the kicker label
 * names the field. One row of chips stands the surface's button height.
 */
export const Default: Story = {
  render: () => <Aliases />,
  play: async ({ canvasElement }) => {
    const input = field(canvasElement);
    await expect(input).toHaveAccessibleName('Aliases');
    await expect(chipText(canvasElement)).toEqual(ALIASES);
    const root = must(canvasElement.querySelector<HTMLElement>('[data-slot="chip-input"]'));
    await expect(getComputedStyle(root).borderBottomColor).toBe(
      computedColor(root, 'var(--line2)'),
    );
    await expect(getComputedStyle(root).borderTopWidth).toBe('0px');
    const chip = must(chips(canvasElement)[0]);
    const style = getComputedStyle(chip);
    await expect(style.borderRadius).toBe('0px');
    await expect(style.backgroundColor).toBe(computedColor(chip, 'var(--raise)'));
    await expect(style.textTransform).toBe('none');
    await expect(chip.getBoundingClientRect().height).toBeCloseTo(
      resolvePx(chip, 'var(--size-badge)'),
      1,
    );
    await expect(root.getBoundingClientRect().height).toBeCloseTo(
      resolvePx(root, 'var(--size-btn)'),
      1,
    );
    // Focus brightens the rule and doubles it, as the standard input does.
    await userEvent.click(input);
    const bright = computedColor(root, 'var(--fg)');
    await waitFor(() => expect(getComputedStyle(root).borderBottomColor).toBe(bright));
    await expect(getComputedStyle(root).boxShadow).toMatch(/0px 1px 0px 0px/);
    input.blur();
  },
};

/**
 * Free text: typing something new opens the list with the create row first and selected, its ⏎
 * showing. ⏎ adds the chip from that row and clears the field. It's never silent: no row, no add.
 */
export const CreateFromText: Story = {
  args: { onValueChange: fn() },
  render: (args) => <Aliases onValueChange={args.onValueChange} />,
  play: async ({ canvasElement, args }) => {
    const input = field(canvasElement);
    await userEvent.type(input, 'Shaker Lake');
    const create = await waitFor(() =>
      must(document.querySelector<HTMLElement>('[data-slot="chip-input-create"]')),
    );
    await expect(create).toHaveTextContent('Add “Shaker Lake”');
    await waitFor(() => expect(highlighted()).toBe(create));
    await expect(must(create.querySelector('[data-slot="kbd"]'))).toBeVisible();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(chipText(canvasElement)).toEqual([...ALIASES, 'Shaker Lake']));
    await expect(args.onValueChange).toHaveBeenCalledWith([...ALIASES, 'Shaker Lake']);
    await expect(input).toHaveValue('');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(list()).toBeNull());
  },
};

/**
 * Suggestions from the caller: the create row leads, then what the server knows (less what's
 * already a chip); ↓ reaches a suggestion and ⏎ adds it. A query that is exactly a suggestion
 * offers no create row.
 */
export const Suggestions: Story = {
  render: () => <Aliases />,
  play: async ({ canvasElement }) => {
    const input = field(canvasElement);
    await userEvent.type(input, 'masc');
    await waitFor(() =>
      expect(document.querySelector('[data-slot="chip-input-create"]')).not.toBeNull(),
    );
    const options = () =>
      [...document.querySelectorAll('[data-slot="chip-input-option"]')].map((o) => o.textContent);
    await expect(options()).toEqual([
      'Mascoma Pond⏎',
      'Mascoma Reservoir⏎',
      'Mascoma North⏎',
      'Masc Lake⏎',
    ]);
    // Only the selected row shows its key.
    const caps = [
      ...document.querySelectorAll<HTMLElement>('[data-slot="chip-input-list"] [data-slot="kbd"]'),
    ];
    await expect(caps.filter((c) => getComputedStyle(c).visibility === 'visible')).toHaveLength(1);
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(highlighted()).toHaveTextContent('Mascoma Pond'));
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(chipText(canvasElement)).toContain('Mascoma Pond'));
    // Exactly a suggestion: no create row.
    await userEvent.type(input, 'Crystal Lake');
    await waitFor(() => expect(highlighted()).toHaveTextContent('Crystal Lake'));
    await expect(document.querySelector('[data-slot="chip-input-create"]')).toBeNull();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(list()).toBeNull());
  },
};

/** An alias that's already a chip (in any case) says so; ⏎ adds nothing. */
export const Duplicate: Story = {
  render: () => <Aliases />,
  play: async ({ canvasElement }) => {
    const input = field(canvasElement);
    await userEvent.type(input, 'lake mascoma');
    const note = await waitFor(() =>
      must(document.querySelector<HTMLElement>('[data-slot="chip-input-note"]')),
    );
    await expect(note).toHaveTextContent('Already added');
    await expect(document.querySelector('[data-slot="chip-input-create"]')).toBeNull();
    await userEvent.keyboard('{Enter}');
    await expect(chipText(canvasElement)).toEqual(ALIASES);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(list()).toBeNull());
  },
};

/**
 * ⌫ in an empty field takes off the last chip; with text in the field it deletes text, never a
 * chip. ← walks into the chips, and ⌫ removes the one focused.
 */
export const Backspace: Story = {
  render: () => <Aliases />,
  play: async ({ canvasElement }) => {
    const input = field(canvasElement);
    await userEvent.click(input);
    await userEvent.type(input, 'ab');
    await userEvent.keyboard('{Backspace}{Backspace}');
    await expect(chipText(canvasElement)).toEqual(ALIASES);
    await expect(input).toHaveValue('');
    await userEvent.keyboard('{Backspace}');
    await waitFor(() => expect(chipText(canvasElement)).toEqual(['Mascoma Lake Reservoir']));
    await userEvent.keyboard('{ArrowLeft}');
    const chip = must(chips(canvasElement)[0]);
    await waitFor(() => expect(chip).toHaveFocus());
    await expect(getComputedStyle(chip).boxShadow).toMatch(/inset/);
    await userEvent.keyboard('{Backspace}');
    await waitFor(() => expect(chips(canvasElement)).toHaveLength(0));
    // Empty: the placeholder returns.
    await expect(input).toHaveAttribute('placeholder', 'Add a name skaters use');
    input.blur();
  },
};

/** The × on a chip removes it; it's named for the chip it removes. */
export const Remove: Story = {
  render: () => <Aliases />,
  play: async ({ canvasElement }) => {
    const remove = within(canvasElement).getByRole('button', { name: 'Remove Lake Mascoma' });
    await userEvent.click(remove);
    await waitFor(() => expect(chipText(canvasElement)).toEqual(['Mascoma Lake Reservoir']));
  },
};

/** Empty: just the field and its placeholder over the rule, the button height. */
export const Empty: Story = {
  render: () => <ChipInput aria-label="Other spellings" placeholder="Add a spelling skaters use" />,
  play: async ({ canvasElement }) => {
    const input = field(canvasElement);
    await expect(input).toHaveAccessibleName('Other spellings');
    await expect(input).toHaveAttribute('placeholder', 'Add a spelling skaters use');
    const root = must(canvasElement.querySelector<HTMLElement>('[data-slot="chip-input"]'));
    await expect(root.getBoundingClientRect().height).toBeCloseTo(
      resolvePx(root, 'var(--size-btn)'),
      1,
    );
    // The placeholder is the quiet ink, and passes AA on the field, so an empty one still reads.
    await expect(getComputedStyle(input, '::placeholder').color).toBe(
      computedColor(input, 'var(--fg3)'),
    );
    await expect(contrastBetween(input, ['var(--bg)'], ['var(--fg3)'])).toBeGreaterThanOrEqual(4.5);
  },
};

/** A search in flight with nothing typed yet: the list says so in one quiet row. */
export const Searching: Story = {
  render: () => <ChipInput aria-label="Aliases" loading />,
  play: async ({ canvasElement }) => {
    await userEvent.click(field(canvasElement));
    await userEvent.keyboard('{ArrowDown}');
    const note = await waitFor(() =>
      must(document.querySelector<HTMLElement>('[data-slot="chip-input-note"]')),
    );
    await expect(note).toHaveTextContent('Searching');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(list()).toBeNull());
    field(canvasElement).blur();
  },
};

/** Disabled: the rule quiets, the chips' words dim and nothing removes them. */
export const Disabled: Story = {
  render: () => <ChipInput aria-label="Aliases" defaultValue={ALIASES} disabled />,
  play: async ({ canvasElement }) => {
    await expect(field(canvasElement)).toBeDisabled();
    const root = must(canvasElement.querySelector<HTMLElement>('[data-slot="chip-input"]'));
    await expect(getComputedStyle(root).borderBottomColor).toBe(computedColor(root, 'var(--line)'));
    const chip = must(chips(canvasElement)[0]);
    await expect(getComputedStyle(chip).color).toBe(computedColor(chip, 'var(--fg-disabled)'));
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: 'Remove Lake Mascoma' }),
    );
    await expect(chipText(canvasElement)).toEqual(ALIASES);
  },
};

/**
 * Many chips wrap onto more rows: each row is `space-1_5` apart and chips `space-1_5` apart in a
 * row; the label sits `space-1_5` over the first chip and the first chip starts on the label's
 * edge.
 */
export const Junctions: Story = {
  render: () => (
    <Field data-junction="field">
      <FieldLabel>Aliases</FieldLabel>
      <ChipInput
        defaultValue={[
          'Mascoma Lake Reservoir',
          'Lake Mascoma',
          'Mascoma Pond',
          'The Reservoir',
          'Enfield Lake',
          'Shaker Lake',
        ]}
      />
    </Field>
  ),
  play: async ({ canvasElement }) => {
    const near = (a: number, b: number) =>
      expect(Math.abs(a - b)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    const scope = must(canvasElement.querySelector<HTMLElement>('[data-junction="field"]'));
    const gap = resolvePx(scope, 'var(--space-1_5)');
    const label = must(scope.querySelector('[data-slot="field-label"]')).getBoundingClientRect();
    const root = must(scope.querySelector<HTMLElement>('[data-slot="chip-input"]'));
    const all = chips(scope);
    const first = must(all[0]).getBoundingClientRect();
    await near(first.left, label.left);
    const inset = (resolvePx(root, 'var(--size-btn)') - resolvePx(root, 'var(--size-badge)')) / 2;
    await near(first.top - label.bottom, gap + inset);
    // Within a row, chips sit one gap apart.
    const rowOne = all.filter((c) => Math.abs(c.getBoundingClientRect().top - first.top) < 1);
    await expect(rowOne.length).toBeGreaterThan(1);
    for (const g of horizontalGaps(rowOne)) await near(g, gap);
    // It wrapped, and the rows sit one gap apart.
    const second = all.find((c) => c.getBoundingClientRect().top > first.bottom);
    await near(must(second).getBoundingClientRect().top - first.bottom, gap);
  },
};

export const FourUp: Story = {
  decorators: [(Story) => Story()],
  render: () => (
    <div className="w-[20rem]">
      <ChipInput aria-label="Aliases" defaultValue={['Lake Mascoma']} />
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    const rows: Array<{ surface?: string; chip: number }> = [];
    for (const q of quads) {
      const chip = must(chips(q)[0]).getBoundingClientRect();
      await expect(chip.height).toBeCloseTo(resolvePx(q, 'var(--size-badge)'), 1);
      const root = must(q.querySelector('[data-slot="chip-input"]')).getBoundingClientRect();
      await expect(root.height).toBeCloseTo(resolvePx(q, 'var(--size-btn)'), 1);
      rows.push({ surface: q.dataset.surface, chip: root.height });
    }
    const admin = rows.filter((r) => r.surface === 'admin').map((r) => r.chip);
    const skater = rows.filter((r) => r.surface === 'skater').map((r) => r.chip);
    await expect(Math.max(...admin)).toBeLessThan(Math.min(...skater));
  },
};
