import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { computedColor, sameColor } from '@/components/kit/measure';
import { faceLoaded, must } from '@/components/kit/storyKit';
import { ThemePair } from '../../../../../../.storybook/theme';

import { ImageryDockView } from './ImageryDockView';
import { ImageryTabView, type ImageryTabViewProps } from './ImageryTabView';
import { granuleOf, MASCOMA_PASSES, MASCOMA_SATELLITE, SEASON } from './imageryFixtures';
import { selectedPass } from './imageryModel';

/**
 * Board 5.4.6, Body › Imagery: the inspector at its width and the dock at the map's, dark beside
 * light, the lit pass shared. Render one beside `body-v5.html?tab=imagery` (and `&pass=skipped`).
 */
const meta = {
  title: 'Admin/Body/Imagery',
  component: ImageryTabView,
  globals: { surface: 'admin', mode: 'dark' },
  args: {
    season: SEASON,
    rows: MASCOMA_PASSES,
    lit: null,
    onLitChange: fn(),
    onOverride: fn(async () => {}),
    satellite: MASCOMA_SATELLITE,
    onSatelliteChange: fn(async () => {}),
  },
  render: (args) => <Board {...args} />,
} satisfies Meta<typeof ImageryTabView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The inspector and the dock, sharing the lit pass, in both modes. */
function Board(args: ImageryTabViewProps) {
  return (
    <ThemePair surface="admin" heading columns="one">
      {() => <Shared {...args} />}
    </ThemePair>
  );
}

function Shared(args: ImageryTabViewProps) {
  const [lit, setLit] = useState(args.lit);
  const rows = args.rows ?? [];
  return (
    <div className="flex items-end gap-(--space-6)">
      <Frame className="w-inspector px-gutter py-(--space-5_5)">
        <ImageryTabView {...args} lit={lit} onLitChange={setLit} />
      </Frame>
      <Frame className="w-[41rem] border border-solid border-line">
        <ImageryDockView
          rows={rows}
          selected={selectedPass(rows, lit)}
          onSelect={(i) => setLit(rows[i]?.id ?? null)}
          bands={['visual', 'scl', 'vh']}
          band="visual"
          onBandChange={() => {}}
        />
      </Frame>
    </div>
  );
}

function Frame({ className, children }: { className: string; children: ReactNode }) {
  return <div className={className}>{children}</div>;
}

const quad = (canvas: HTMLElement) => must(canvas.querySelector<HTMLElement>('[data-theme-scope]'));

/** The board: 13 Oct, shown to skaters, both gates cleared; the newest of seven passes. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const q = quad(canvasElement);
    const day = must(q.querySelector<HTMLElement>('[data-slot="pass-day"]'));
    const cell = must(q.querySelector<HTMLElement>('[data-slot="table-cell"]'));
    await faceLoaded(day, '13 Oct');
    await faceLoaded(cell, '13 Oct');
    await expect(day).toHaveTextContent('13 Oct');
    // The gate is a white tick standing over the 4 px track.
    const tick = must(q.querySelector<HTMLElement>('[data-slot="meter-mark"]'));
    const track = must(q.querySelector<HTMLElement>('[data-slot="meter-track"]'));
    const fg = sameColor(computedColor(tick, 'var(--fg)'));
    await expect(getComputedStyle(tick).backgroundColor).toEqual(fg);
    await expect(track.getBoundingClientRect().height).toBeCloseTo(4, 0);
    await expect(tick.getBoundingClientRect().height).toBeCloseTo(12, 0);
    // The tick stands at 60% of the track.
    const t = track.getBoundingClientRect();
    const k = tick.getBoundingClientRect();
    await expect(Math.abs(k.left + k.width / 2 - (t.left + t.width * 0.6))).toBeLessThanOrEqual(1);
  },
};

/** `&pass=skipped`: the thumb on 10 Oct, hidden by cloud; the call flips to Show anyway. */
export const SkippedPass: Story = {
  args: { lit: granuleOf(10) },
  play: async ({ canvasElement }) => {
    const q = within(quad(canvasElement));
    await expect(q.getByText('Hidden from skaters')).toBeVisible();
    await expect(q.getByRole('button', { name: /Show to skaters anyway/ })).toBeVisible();
    await expect(q.getByRole('slider', { name: 'Pass' })).toHaveAttribute('aria-valuenow', '5');
  },
};

/** The dock and the table move the lit pass together. */
export const Scrub: Story = {
  play: async ({ canvasElement }) => {
    const q = within(quad(canvasElement));
    const slider = q.getByRole('slider', { name: 'Pass' });
    slider.focus();
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
    await waitFor(() => expect(slider).toHaveAttribute('aria-valuenow', '5'));
    const selected = must(
      quad(canvasElement).querySelector('[data-slot="table-row"][data-selected]'),
    );
    await expect(selected).toHaveAttribute('data-pass', granuleOf(10));
  },
};

/** A viewer without the writers: no call, the satellite choice read-only. */
export const ReadOnly: Story = {
  args: { onOverride: undefined, onSatelliteChange: undefined },
};
