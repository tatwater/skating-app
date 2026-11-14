import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { ChartLegend, ChartNote } from './chart-legend';
import { computedColor, JUNCTION_TOLERANCE_PX, resolvePx, sameColor } from './measure';
import { Section } from './section-slug';
import { faceLoaded, KICKER, must } from './storyKit';

const meta = {
  title: 'Kit/Chart legend',
  component: ChartLegend,
  tags: ['autodocs'],
  args: {
    items: [
      { label: 'Hours waiting', ink: 'var(--fg)', mark: 'line' },
      { label: 'Open flags', ink: 'var(--line2)' },
      { label: 'Safety', ink: 'var(--bad)' },
    ],
  },
  parameters: {
    docs: {
      description: {
        component:
          "A chart's key at the end of its section's rule — a swatch and a mono-caps name per series: a bar's an 8 px square in its fill, a line's a 16 px hairline in its stroke — and the note a chart with nothing to draw sets where its marks would be.",
      },
    },
  },
} satisfies Meta<typeof ChartLegend>;

export default meta;
type Story = StoryObj<typeof meta>;

const parts = (root: ParentNode, slot: string) => [
  ...root.querySelectorAll<HTMLElement>(`[data-slot="${slot}"]`),
];

/** A bar is an 8 px square in its fill; a line a 16 px hairline in its stroke; names in mono caps. */
export const Legend: Story = {
  play: async ({ canvasElement }) => {
    const [line, quiet, bad] = parts(canvasElement, 'chart-legend-swatch').map(must);
    const unit = resolvePx(canvasElement, 'var(--space-1)');
    const l = must(line).getBoundingClientRect();
    await expect(l.width).toBeCloseTo(4 * unit, 1);
    await expect(getComputedStyle(must(line)).borderTopWidth).toBe('1px');
    await expect(getComputedStyle(must(line)).borderTopColor).toEqual(
      sameColor(computedColor(canvasElement, 'var(--fg)')),
    );
    for (const square of [quiet, bad].map(must)) {
      const r = square.getBoundingClientRect();
      await expect(r.width).toBeCloseTo(2 * unit, 1);
      await expect(r.height).toBeCloseTo(2 * unit, 1);
      await expect(getComputedStyle(square).borderRadius).toBe('0px');
    }
    await expect(getComputedStyle(must(bad)).backgroundColor).toEqual(
      sameColor(computedColor(canvasElement, 'var(--bad)')),
    );
    // Swatch to name: space-1_5, ink to ink.
    const item = must(parts(canvasElement, 'chart-legend-item')[1]);
    await faceLoaded(item, 'OPEN');
    const style = getComputedStyle(item);
    await expect(style.textTransform).toBe('uppercase');
    await expect(style.fontFamily).toMatch(/Martian Mono/);
    await expect(parseFloat(style.columnGap)).toBeCloseTo(
      resolvePx(canvasElement, 'var(--space-1_5)'),
      1,
    );
    // Swatches are decoration: a reader hears the names.
    for (const s of parts(canvasElement, 'chart-legend-swatch')) {
      await expect(s).toHaveAttribute('aria-hidden', 'true');
    }
  },
};

/** At the end of a section's rule, where Metrics wears it. */
export const OnARule: Story = {
  render: (args) => (
    <div className="w-[36rem]">
      <Section title="Oldest open flag" end={<ChartLegend {...args} />}>
        <div className="h-[6rem]" />
      </Section>
    </div>
  ),
};

/** An empty chart says what lands here, then why it is empty — centered over its frame. */
export const Note: Story = {
  render: () => (
    <div data-frame="" className="relative h-[8rem] w-[24rem] border border-solid border-line">
      <ChartNote title="The flag queue lands here" detail="Not recorded yet" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const frame = must(canvasElement.querySelector<HTMLElement>('[data-frame]'));
    const note = must(canvasElement.querySelector<HTMLElement>('[data-slot="chart-note"]'));
    const [title, detail] = [...note.children].map((c) => c as HTMLElement);
    await faceLoaded(must(title));
    await faceLoaded(must(detail));
    // Fresh reads, after the faces: centered both ways over the frame.
    const f = frame.getBoundingClientRect();
    const t = must(note.children[0]).getBoundingClientRect();
    const d = must(note.children[1]).getBoundingClientRect();
    const middle = (r: DOMRect) => r.left + r.width / 2;
    await expect(Math.abs(middle(t) - middle(f))).toBeLessThanOrEqual(0.5);
    await expect(Math.abs(middle(d) - middle(f))).toBeLessThanOrEqual(0.5);
    const above = t.top - f.top;
    const below = f.bottom - d.bottom;
    await expect(Math.abs(above - below)).toBeLessThanOrEqual(1);
    await expect(
      Math.abs(d.top - t.bottom - resolvePx(frame, 'var(--space-1)')),
    ).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    await expect(getComputedStyle(must(title)).color).toEqual(
      sameColor(computedColor(frame, 'var(--fg2)')),
    );
    await expect(getComputedStyle(must(detail)).color).toEqual(
      sameColor(computedColor(frame, 'var(--fg3)')),
    );
    // It never takes the pointer from the chart under it.
    await expect(getComputedStyle(note).pointerEvents).toBe('none');
  },
};

/** A note with nothing to explain is its title alone. */
export const NoteAlone: Story = {
  render: () => (
    <div className="relative h-[6rem] w-[20rem]">
      <ChartNote title="None resolved this season" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const note = must(canvasElement.querySelector('[data-slot="chart-note"]'));
    await expect(note.children).toHaveLength(1);
  },
};

export const FourUp: Story = {
  render: (args) => (
    <div className="flex flex-col gap-heading">
      <span className={KICKER}>Legend</span>
      <ChartLegend {...args} />
      <span className={KICKER}>Note</span>
      <div className="relative h-[5rem] border border-solid border-line">
        <ChartNote title="Spend by month lands here" detail="Not recorded yet" />
      </div>
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const bad = must(parts(q, 'chart-legend-swatch')[2]);
      await expect(getComputedStyle(bad).backgroundColor).toEqual(
        sameColor(computedColor(q, 'var(--bad)')),
      );
    }
  },
};
