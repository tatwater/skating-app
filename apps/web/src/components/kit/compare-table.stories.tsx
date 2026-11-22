import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import { ThemePair } from '../../../.storybook/theme';
import { CompareTable } from './compare-table';
import { computedColor, sameColor } from './measure';
import { must } from './storyKit';

/**
 * The compare table (the Inbox's 2.4) — four-up: dark and light, at the board's part
 * width and at a phone's, where the label column narrows and a long cell wraps rather than clip.
 */

const meta = {
  title: 'Kit/CompareTable',
  component: CompareTable,
  parameters: { layout: 'fullscreen' },
  globals: { surface: 'admin' },
  args: {
    'aria-label': 'Same place?',
    columns: [
      { label: 'The ask', tone: 'lit' },
      { label: 'The Narrows · OpenStreetMap', tone: 'warn' },
    ],
    rows: [
      {
        label: 'Name',
        cells: [
          { value: '“the Narrows”', same: true },
          { value: 'The Narrows', same: true },
        ],
      },
      { label: 'Kind', cells: [{ value: 'Landmark' }, { value: 'Narrows' }] },
      {
        label: 'Point',
        cells: [
          { value: '43.6702 −71.7588', mono: true },
          { value: '43.6760 −71.7571', mono: true },
        ],
      },
      { label: 'Also called', cells: [{ value: 'Nothing yet' }, { value: 'No aliases' }] },
      { label: 'Used by', cells: [{ value: '1 report' }, { value: 'No reports yet' }] },
    ],
  },
} satisfies Meta<typeof CompareTable>;

export default meta;
type Story = StoryObj<typeof meta>;

const WIDTHS = [
  { key: 'wide', px: 748 },
  { key: 'narrow', px: 328 },
] as const;

/** The board's table, both modes, both widths. */
export const FourUp: Story = {
  render: (args) => (
    <ThemePair surface="admin" columns="lg" heading>
      {() => (
        <div className="flex flex-col gap-(--space-6)">
          {WIDTHS.map((w) => (
            <div key={w.key} data-width={w.key} style={{ width: w.px, maxWidth: '100%' }}>
              <CompareTable {...args} />
            </div>
          ))}
        </div>
      )}
    </ThemePair>
  ),
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(2);
    for (const q of quads) {
      const fg = computedColor(q, 'var(--fg)');
      const warn = computedColor(q, 'var(--warn)');
      const fg2 = computedColor(q, 'var(--fg2)');
      for (const w of WIDTHS) {
        const box = must(q.querySelector<HTMLElement>(`[data-width="${w.key}"]`));
        const heads = [...box.querySelectorAll<HTMLElement>('[data-slot="compare-head"]')];
        await expect(getComputedStyle(must(heads[0])).color).toEqual(sameColor(fg));
        await expect(getComputedStyle(must(heads[1])).color).toEqual(sameColor(warn));
        const cells = [...box.querySelectorAll<HTMLElement>('[data-slot="compare-cell"]')];
        await expect(getComputedStyle(must(cells[0])).color).toEqual(sameColor(fg));
        await expect(getComputedStyle(must(cells[2])).color).toEqual(sameColor(fg2));
        // Layout, read until it settles: a measure taken before the fonts land is a fallback's.
        await waitFor(() => {
          // The two value columns share the room equally, and nothing runs out of the box.
          const a = must(cells[2]).getBoundingClientRect().width;
          const b = must(cells[3]).getBoundingClientRect().width;
          expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
          expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
          // The board's 30 px rows (a cell that wraps may grow past them, never short of them).
          for (const row of box.querySelectorAll<HTMLElement>('[data-slot="compare-row"]'))
            expect(row.getBoundingClientRect().height).toBeGreaterThanOrEqual(29.5);
        });
      }
    }
  },
};
