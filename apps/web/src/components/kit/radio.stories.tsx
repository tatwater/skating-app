import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { Badge, Tag } from './badge';
import { computedColor, JUNCTION_TOLERANCE_PX, resolvePx, sameColor } from './measure';
import { Radio, RadioGroup, RadioRow } from './radio';
import { must, PSEUDO_STATES, StateMatrix } from './storyKit';

const meta = {
  title: 'Kit/Radio',
  component: RadioGroup,
  tags: ['autodocs'],
  args: { 'aria-label': 'Standing', onValueChange: fn() },
} satisfies Meta<typeof RadioGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

const STANDING = [
  { value: 'listed', label: 'Listed', description: 'Shown to skaters on the map and in search' },
  { value: 'unlisted', label: 'Unlisted', description: 'Kept, but hidden from skaters' },
  { value: 'retired', label: 'Retired', description: 'Gone from the corpus; reports stay' },
] as const;

/** A list of states you can set: whole-row radios on dotted rules. Picking moves the pick. */
export const List: Story = {
  args: { defaultValue: 'listed' },
  render: (args) => (
    <RadioGroup {...args} className="w-[24rem]">
      {STANDING.map((s) => (
        <RadioRow key={s.value} {...s} />
      ))}
    </RadioGroup>
  ),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const listed = canvas.getByRole('radio', { name: /^Listed/ });
    const retired = canvas.getByRole('radio', { name: /^Retired/ });
    await expect(listed).toHaveAttribute('aria-checked', 'true');
    // Clicking anywhere on the row picks it — the sub-line too.
    await userEvent.click(canvas.getByText('Gone from the corpus; reports stay'));
    await expect(retired).toHaveAttribute('aria-checked', 'true');
    await expect(listed).toHaveAttribute('aria-checked', 'false');
    await expect(args.onValueChange).toHaveBeenCalledOnce();
    // The last row has no rule under it.
    await expect(getComputedStyle(retired).borderBottomWidth).toBe('0px');
    await expect(getComputedStyle(listed).borderBottomStyle).toBe('dotted');
  },
};

/** The Corpus choice: the current value wears Now, the suggestion wears Suggested and is the pick. */
export const Cells: Story = {
  args: { defaultValue: 'auburn' },
  render: (args) => (
    <RadioGroup {...args} aria-label="Display name" className="w-[24rem] gap-(--space-2)">
      <RadioRow
        variant="cell"
        value="auburn-lake"
        label="Auburn Lake"
        description={<Tag>GNIS</Tag>}
        aside={
          <Badge variant="outline" tone="lit">
            Now
          </Badge>
        }
      />
      <RadioRow
        variant="cell"
        value="auburn"
        label="Lake Auburn"
        description={<Tag>NHD</Tag>}
        aside={<Badge variant="outline">Suggested</Badge>}
      />
    </RadioGroup>
  ),
  play: async ({ canvasElement }) => {
    const pick = within(canvasElement).getByRole('radio', { name: /^Lake Auburn/ });
    // The chosen cell lights whole: a bright edge over a lifted ground.
    const lift = computedColor(pick, 'var(--lift-08)');
    await waitFor(() => expect(getComputedStyle(pick).backgroundColor).toEqual(sameColor(lift)));
  },
};

/** Arrow keys move the pick within the group. */
export const Keyboard: Story = {
  ...List,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const listed = canvas.getByRole('radio', { name: /^Listed/ });
    listed.focus();
    await userEvent.keyboard('{ArrowDown}');
    const unlisted = canvas.getByRole('radio', { name: /^Unlisted/ });
    await expect(unlisted).toHaveFocus();
    await expect(unlisted).toHaveAttribute('aria-checked', 'true');
  },
};

/** A bare radio (a matrix cell): the circle alone, with a grown pointer area. */
export const Bare: Story = {
  args: { defaultValue: 'b' },
  render: (args) => (
    <RadioGroup {...args} className="flex-row gap-(--space-4)">
      <Radio value="a" aria-label="A" />
      <Radio value="b" aria-label="B" />
      <Radio value="c" aria-label="C" disabled />
    </RadioGroup>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement).getByRole('radio', { name: 'C' });
    await userEvent.click(c, { pointerEventsCheck: 0 });
    await expect(c).toHaveAttribute('aria-checked', 'false');
  },
};

// ── Matrix and four-up ────────────────────────────────────────────────────────────────────────

const ROWS = [
  { key: 'off', label: 'Unpicked' },
  { key: 'on', label: 'Picked' },
  { key: 'invalid', label: 'Invalid' },
  { key: 'row', label: 'Row' },
  { key: 'cell', label: 'Cell' },
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
      cell={(row, state) => {
        const common = { 'data-state': state, disabled: state === 'disabled' };
        const picked = row !== 'off' && row !== 'invalid';
        return (
          <RadioGroup aria-label={`${row} ${state}`} defaultValue={picked ? 'x' : undefined}>
            {row === 'row' || row === 'cell' ? (
              <RadioRow
                {...common}
                variant={row === 'row' ? 'list' : 'cell'}
                value="x"
                label="Listed"
              />
            ) : (
              <Radio
                {...common}
                value="x"
                aria-label="x"
                aria-invalid={row === 'invalid' || undefined}
              />
            )}
          </RadioGroup>
        );
      }}
    />
  ),
  parameters: PSEUDO_STATES,
  play: async ({ canvasElement }) => {
    for (const el of canvasElement.querySelectorAll('[data-state="disabled"]')) {
      await expect(el).toHaveAttribute('aria-disabled', 'true');
    }
    const invalid = must(canvasElement.querySelector<HTMLElement>('[aria-invalid="true"]'));
    const dot = must(invalid.querySelector('[data-slot="radio-dot"]'));
    await expect(getComputedStyle(dot).borderTopColor).toEqual(
      sameColor(computedColor(invalid, 'var(--bad)')),
    );
  },
};

/** Keyboard focus draws the ring and brightens an unpicked rim, as hover does. */
export const FocusLights: Story = {
  render: () => (
    <RadioGroup aria-label="Focus">
      <Radio value="a" aria-label="A" />
    </RadioGroup>
  ),
  play: async ({ canvasElement }) => {
    const el = within(canvasElement).getByRole('radio');
    const dot = must(el.querySelector('[data-slot="radio-dot"]'));
    const lit = computedColor(el, 'var(--fg2)');
    el.focus();
    await waitFor(() => expect(getComputedStyle(el).boxShadow).toMatch(/3px/));
    await waitFor(() => expect(getComputedStyle(dot).borderTopColor).toEqual(sameColor(lit)));
  },
};

export const FourUp: Story = {
  render: () => (
    <RadioGroup aria-label="Standing" defaultValue="listed" className="w-[20rem]">
      {STANDING.map((s) => (
        <RadioRow key={s.value} {...s} />
      ))}
    </RadioGroup>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const dot = must(q.querySelector('[data-slot="radio-dot"]')).getBoundingClientRect();
      const kick = resolvePx(q, 'var(--type-kick)');
      await expect(dot.width).toBeCloseTo(kick, 1);
      await expect(
        getComputedStyle(must(q.querySelector('[data-slot="radio-dot"]'))).borderRadius,
      ).toBe('9999px');
    }
  },
};

// ── Junctions ─────────────────────────────────────────────────────────────────────────────────

/**
 * A choice row: the circle (one kicker) centers on the label's first line, the label starts the
 * `space-2_5` gap after it, the pick's dot sits two hairlines in, and a row is at least a table
 * row tall.
 */
function RowJunction() {
  return (
    <RadioGroup aria-label="Standing" defaultValue="listed" className="m-(--space-8) w-[22rem]">
      <RadioRow
        value="listed"
        label="Listed"
        description="Shown to skaters on the map"
        aside={
          <Badge variant="outline" tone="lit">
            Now
          </Badge>
        }
      />
      <RadioRow value="unlisted" label="Unlisted" />
    </RadioGroup>
  );
}

async function playRowJunction({ canvasElement }: { canvasElement: HTMLElement }) {
  const [listed, unlisted] = [
    ...canvasElement.querySelectorAll<HTMLElement>('[data-slot="radio-row"]'),
  ];
  const row = must(listed);
  const dot = must(row.querySelector('[data-slot="radio-dot"]')).getBoundingClientRect();
  const label = must(row.querySelector('[data-slot="radio-label"]'));
  const kick = resolvePx(row, 'var(--type-kick)');
  await expect(dot.width).toBeCloseTo(kick, 1);
  const gap = resolvePx(row, 'var(--space-2_5)');
  await expect(Math.abs(label.getBoundingClientRect().left - dot.right - gap)).toBeLessThanOrEqual(
    JUNCTION_TOLERANCE_PX,
  );
  const range = document.createRange();
  range.selectNodeContents(must(label.firstChild));
  const first = must(range.getClientRects()[0]);
  const mid = (r: DOMRect) => r.top + r.height / 2;
  await expect(Math.abs(mid(dot) - mid(first))).toBeLessThanOrEqual(1);
  // The aside shares the first line's center too.
  const aside = must(row.querySelector('[data-slot="badge"]')).getBoundingClientRect();
  await expect(Math.abs(mid(aside) - mid(first))).toBeLessThanOrEqual(1);
  // The pick's dot: two hairlines in from the rim on every side.
  const pick = must(row.querySelector('[data-slot="radio-indicator"]')).getBoundingClientRect();
  await expect(pick.left - dot.left).toBeCloseTo(3, 1); // the 1 px rim + the 2 px inset
  // A one-line row still stands a table row tall.
  await expect(must(unlisted).getBoundingClientRect().height).toBeGreaterThanOrEqual(
    resolvePx(row, 'var(--size-td)') - JUNCTION_TOLERANCE_PX,
  );
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

/** A bare radio grows its pointer area by the hit pad without touching layout. */
export const JunctionBare: Story = {
  render: () => (
    <RadioGroup aria-label="Bare" className="m-(--space-8) flex-row gap-(--space-2)">
      <Radio value="a" aria-label="A" />
      <Radio value="b" aria-label="B" />
    </RadioGroup>
  ),
  play: async ({ canvasElement }) => {
    const [a, b] = within(canvasElement).getAllByRole('radio');
    const ra = must(a).getBoundingClientRect();
    const rb = must(b).getBoundingClientRect();
    await expect(
      Math.abs(rb.left - ra.right - resolvePx(canvasElement, 'var(--space-2)')),
    ).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    const hitY = resolvePx(canvasElement, 'var(--gap-hit-y)');
    const hits = (y: number) =>
      document.elementFromPoint(ra.left + ra.width / 2, y)?.closest('[role="radio"]') === a;
    await expect(hits(ra.top - hitY + 1)).toBe(true);
    await expect(hits(ra.top - hitY - 1)).toBe(false);
  },
};
