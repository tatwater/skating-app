import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';

import { must } from '@/components/kit/storyKit';
import { ConsequenceLadder, type LadderRung } from './ConsequenceLadder';

/** Every value a person may choose, what each source says of it and what choosing it does (a kit candidate). */
const meta = {
  title: 'Admin/Corpus/Candidates/ConsequenceLadder',
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { fourUp: true },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const RUNGS: LadderRung[] = [
  {
    value: 'lakePond',
    label: 'Lake or pond',
    now: true,
    marks: { osm: 'water=pond' },
    consequence: 'Stays, as skaters read it today',
  },
  {
    value: 'wetland',
    label: 'Wetland',
    suggested: true,
    marks: { nhd: 'SwampMarsh' },
    consequence: 'Leaves the corpus next campaign, as unnamed wetland under 50 ac',
    emphasis: true,
  },
  { value: 'reservoir', label: 'Reservoir', consequence: 'Stays, as a reservoir' },
  { value: 'bay', label: 'Bay', consequence: 'Waits for a parent: no lake holds it' },
];

const COLUMNS = [
  { key: 'nhd', label: 'NHD' },
  { key: '3dhp', label: '3DHP' },
  { key: 'osm', label: 'OSM' },
];

function Ladder({
  columns = true,
  readOnly = false,
  width = 'w-[46rem]',
}: {
  columns?: boolean;
  readOnly?: boolean;
  /** The box's width: the board's pane, or an inspector at its least. */
  width?: string;
}) {
  const [value, setValue] = useState<string | null>('wetland');
  return (
    <div className={`${width} max-w-full p-(--space-5)`}>
      <ConsequenceLadder
        aria-label="Pick the class"
        valueHead="Class"
        consequenceHead="What choosing it does"
        value={readOnly ? null : value}
        onValueChange={setValue}
        readOnly={readOnly}
        rungs={RUNGS}
        {...(columns ? { columns: COLUMNS } : {})}
      />
    </div>
  );
}

/** The board's ladder: three catalogs' columns, the suggestion picked, the loss in the bright ink. */
export const WithSources: Story = {
  render: () => <Ladder />,
  play: async ({ canvasElement }) => {
    const quad = must(canvasElement.querySelector<HTMLElement>('[data-theme-scope]'));
    const s = within(quad);
    await expect(s.getByRole('radio', { name: 'Wetland' })).toBeChecked();
    // A silent source is a dash, never a vote.
    await expect(quad.querySelectorAll('[data-slot="rung-silent"]')).toHaveLength(10);
    await expect(
      quad.querySelectorAll('[data-slot="rung-consequence"][data-emphasis]'),
    ).toHaveLength(1);
    // A hairline between rows, none under the last (the group's hidden input is no row).
    const rungs = [...quad.querySelectorAll<HTMLElement>('[data-slot="ladder-rung"]')];
    await expect(getComputedStyle(must(rungs.at(-1))).borderBottomWidth).toBe('0px');
    await expect(getComputedStyle(must(rungs[2])).borderBottomWidth).not.toBe('0px');
    await userEvent.click(s.getByRole('radio', { name: 'Bay' }));
    await expect(s.getByRole('radio', { name: 'Bay' })).toBeChecked();
    await expect(s.getByRole('radio', { name: 'Bay' })).toHaveAccessibleDescription(
      'Waits for a parent: no lake holds it',
    );
  },
};

/** No sources recorded: the value, then what choosing it does. */
export const NoSources: Story = {
  render: () => <Ladder columns={false} />,
  play: async ({ canvasElement }) => {
    const quad = must(canvasElement.querySelector<HTMLElement>('[data-theme-scope]'));
    await expect(
      quad.querySelectorAll('[data-slot="rung-mark"], [data-slot="rung-silent"]'),
    ).toHaveLength(0);
  },
};

/** Read only (a decided task). */
export const ReadOnly: Story = {
  render: () => <Ladder readOnly />,
  play: async ({ canvasElement }) => {
    const quad = must(canvasElement.querySelector<HTMLElement>('[data-theme-scope]'));
    for (const r of within(quad).getAllByRole('radio')) await expect(r).not.toBeChecked();
  },
};

/** A rung's cells, measured. */
const boxOf = (rung: HTMLElement, slot: string) =>
  must(rung.querySelector<HTMLElement>(`[data-slot="${slot}"]`)).getBoundingClientRect();

/**
 * An inspector at its least (380 px, the narrowest page that keeps the task lanes' columns): each
 * consequence goes under its row's value and marks, across the row, its head gone — never a column
 * squeezed to a word a line — and a value's badge under its words, never over them.
 */
export const Narrow: Story = {
  render: () => <Ladder width="w-[23.75rem]" />,
  play: async ({ canvasElement }) => {
    const quad = must(canvasElement.querySelector<HTMLElement>('[data-theme-scope]'));
    const head = must(quad.querySelector<HTMLElement>('[data-slot="ladder-consequence-head"]'));
    await expect(head).not.toBeVisible();
    const rungs = [...quad.querySelectorAll<HTMLElement>('[data-slot="ladder-rung"]')];
    for (const rung of rungs) {
      const label = boxOf(rung, 'rung-label');
      const cell = must(rung.querySelector<HTMLElement>('[data-slot="rung-consequence"]'));
      const consequence = cell.getBoundingClientRect();
      await expect(consequence.top).toBeGreaterThanOrEqual(label.bottom - 0.5);
      // Its words start under the value's, past the dot.
      const text = consequence.left + parseFloat(getComputedStyle(cell).paddingInlineStart);
      await expect(Math.abs(text - label.left)).toBeLessThan(1);
    }
    const wetland = must(rungs[1]);
    const badge = boxOf(wetland, 'rung-suggested');
    await expect(badge.top).toBeGreaterThanOrEqual(boxOf(wetland, 'rung-label').bottom - 0.5);
  },
};

/** The board's width keeps the consequence beside its row, its head drawn (one map: a quad is narrower). */
export const WideKeepsColumns: Story = {
  parameters: { fourUp: false },
  render: () => <Ladder />,
  play: async ({ canvasElement }) => {
    const quad = canvasElement;
    await expect(
      must(quad.querySelector<HTMLElement>('[data-slot="ladder-consequence-head"]')),
    ).toBeVisible();
    for (const rung of quad.querySelectorAll<HTMLElement>('[data-slot="ladder-rung"]')) {
      await expect(boxOf(rung, 'rung-consequence').left).toBeGreaterThan(
        boxOf(rung, 'rung-label').right,
      );
    }
  },
};
