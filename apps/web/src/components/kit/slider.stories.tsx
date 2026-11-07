import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import {
  colorsIn,
  computedColor,
  contrastBetween,
  JUNCTION_TOLERANCE_PX,
  resolvePx,
  sameColor,
} from './measure';
import { Slider } from './slider';
import { must } from './storyKit';

const meta = {
  title: 'Kit/Slider',
  component: Slider,
  tags: ['autodocs'],
  args: {
    label: 'Map boost',
    min: 0,
    max: 1,
    step: 0.1,
    defaultValue: 0.3,
    ticks: true,
    ends: true,
    onValueChange: fn(),
  },
  decorators: [(Story) => <div className="w-[20rem] p-(--space-4)">{Story()}</div>],
} satisfies Meta<typeof Slider>;

export default meta;
type Story = StoryObj<typeof meta>;

const input = (canvasElement: HTMLElement) => within(canvasElement).getByRole('slider');
const readout = (root: ParentNode) =>
  must(root.querySelector<HTMLElement>('[data-slot="slider-value"]'));

/**
 * The map boost: tenths from 0 to 1, so eleven ticks — the ends and the middle taller. The value
 * reads out in mono; the label names the slider.
 */
export const MapBoost: Story = {
  play: async ({ canvasElement }) => {
    const slider = within(canvasElement).getByRole('slider', { name: 'Map boost' });
    await expect(slider).toHaveAttribute('aria-valuenow', '0.3');
    await expect(readout(canvasElement)).toHaveTextContent('0.3');
    const ticks = canvasElement.querySelectorAll('[data-slot="slider-tick"]');
    await expect(ticks).toHaveLength(11);
    await expect(
      canvasElement.querySelectorAll('[data-slot="slider-tick"][data-major]'),
    ).toHaveLength(3);
    const ends = [...canvasElement.querySelectorAll('[data-slot="slider-end"]')].map(
      (e) => e.textContent,
    );
    await expect(ends).toEqual(['0', '1']);
    // Square thumb, not a ringed knob.
    const thumb = must(canvasElement.querySelector<HTMLElement>('[data-slot="slider-thumb"]'));
    await expect(getComputedStyle(thumb).borderRadius).toBe('0px');
    await expect(getComputedStyle(readout(canvasElement)).fontFamily).toMatch(/mono/i);
  },
};

/**
 * The keyboard: arrows step a tenth, ⇧ with an arrow takes five, Home and End go to the ends. The
 * readout's slot keeps its width through every value.
 */
export const Keyboard: Story = {
  play: async ({ canvasElement, args }) => {
    const slider = input(canvasElement);
    const width = readout(canvasElement).getBoundingClientRect().width;
    slider.focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(slider).toHaveAttribute('aria-valuenow', '0.4');
    await expect(args.onValueChange).toHaveBeenLastCalledWith(0.4, expect.anything());
    await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}');
    await expect(slider).toHaveAttribute('aria-valuenow', '0.9');
    await userEvent.keyboard('{ArrowLeft}');
    await expect(slider).toHaveAttribute('aria-valuenow', '0.8');
    await userEvent.keyboard('{End}');
    await expect(readout(canvasElement)).toHaveTextContent('1.0');
    await expect(readout(canvasElement).getBoundingClientRect().width).toBe(width);
    await userEvent.keyboard('{Home}');
    await expect(slider).toHaveAttribute('aria-valuenow', '0');
  },
};

/** Keyboard focus draws the focus ring on the thumb in place of its glow. */
export const FocusRing: Story = {
  play: async ({ canvasElement }) => {
    const thumb = must(canvasElement.querySelector<HTMLElement>('[data-slot="slider-thumb"]'));
    await userEvent.tab();
    await expect(input(canvasElement)).toHaveFocus();
    await waitFor(() => expect(getComputedStyle(thumb).boxShadow).toMatch(/0px 0px 0px 4px/));
  },
};

/** Pressing the track jumps the value there. */
export const TrackPress: Story = {
  play: async ({ canvasElement, args }) => {
    const control = must(canvasElement.querySelector<HTMLElement>('[data-slot="slider-control"]'));
    const r = control.getBoundingClientRect();
    await userEvent.pointer({
      keys: '[MouseLeft]',
      target: control,
      coords: { clientX: r.left + r.width * 0.8, clientY: r.top + r.height / 2 },
    });
    await waitFor(() => expect(input(canvasElement)).toHaveAttribute('aria-valuenow', '0.8'));
    await expect(args.onValueChange).toHaveBeenCalled();
  },
};

/**
 * Disabled: the fill, rim and grip dim, the glow goes, and nothing moves it. Its label and readout
 * stay, in the disabled ink.
 */
export const Disabled: Story = {
  args: { disabled: true },
  play: async ({ canvasElement, args }) => {
    const slider = input(canvasElement);
    slider.focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(args.onValueChange).not.toHaveBeenCalled();
    const thumb = must(canvasElement.querySelector<HTMLElement>('[data-slot="slider-thumb"]'));
    // No glow: every shadow layer left is transparent.
    for (const layer of colorsIn(getComputedStyle(thumb).boxShadow)) {
      await expect(layer).toEqual(sameColor('rgba(0, 0, 0, 0)'));
    }
    await expect(getComputedStyle(thumb).borderTopColor).toEqual(
      sameColor(computedColor(thumb, 'var(--line2)')),
    );
    const fill = must(canvasElement.querySelector<HTMLElement>('[data-slot="slider-fill"]'));
    await expect(getComputedStyle(fill).backgroundColor).toEqual(
      sameColor(computedColor(fill, 'var(--fg-disabled)')),
    );
    const grip = must(canvasElement.querySelector<HTMLElement>('[data-slot="slider-grip"]'));
    await expect(getComputedStyle(grip).backgroundColor).toEqual(
      sameColor(computedColor(grip, 'var(--line2)')),
    );
  },
};

/** A wide range: no ticks (they'd be a texture, not stops); the readout and ends in percent. */
export const WideRange: Story = {
  args: {
    label: 'Cloud cover cutoff',
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: 0.35,
    format: { style: 'percent' },
  },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll('[data-slot="slider-tick"]')).toHaveLength(0);
    await expect(readout(canvasElement)).toHaveTextContent('35%');
    const ends = [...canvasElement.querySelectorAll('[data-slot="slider-end"]')].map(
      (e) => e.textContent,
    );
    await expect(ends).toEqual(['0%', '100%']);
  },
};

/** An integer step shows whole numbers, in a slot as wide as the largest. */
export const WholeNumbers: Story = {
  args: { label: 'Passes to show', min: 1, max: 12, step: 1, defaultValue: 6, ticks: true },
  play: async ({ canvasElement }) => {
    await expect(readout(canvasElement)).toHaveTextContent(/^6$/);
    await expect(canvasElement.querySelectorAll('[data-slot="slider-tick"]')).toHaveLength(12);
    // No middle stop on an odd count: only the ends are taller.
    await expect(
      canvasElement.querySelectorAll('[data-slot="slider-tick"][data-major]'),
    ).toHaveLength(2);
  },
};

// ── Four-up and junctions ─────────────────────────────────────────────────────────────────────

/**
 * In all four maps. The thumb's rim and the fill must each stand out from the ground (3:1, a
 * control's boundary); the track itself is the quiet line beneath.
 */
export const FourUp: Story = {
  parameters: { fourUp: true },
  decorators: [(Story) => <div className="w-[18rem]">{Story()}</div>],
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const thumb = must(q.querySelector<HTMLElement>('[data-slot="slider-thumb"]'));
      await expect(contrastBetween(thumb, ['var(--bg)'], ['var(--fg)'])).toBeGreaterThanOrEqual(3);
      await expect(contrastBetween(thumb, ['var(--bg)'], ['var(--fg1)'])).toBeGreaterThanOrEqual(3);
      await expect(thumb.getBoundingClientRect().height).toBeCloseTo(
        resolvePx(q, 'var(--size-btn-xs)'),
        1,
      );
    }
  },
};

/**
 * The thumb is the surface's smallest button tall and 1.4 kickers wide, centered on the track;
 * the ticks start a `stroke-run` under the track; the pointer area reaches a hit pad past the
 * thumb, and no further.
 */
async function playThumbJunction({ canvasElement }: { canvasElement: HTMLElement }) {
  const thumb = must(canvasElement.querySelector<HTMLElement>('[data-slot="slider-thumb"]'));
  const track = must(canvasElement.querySelector<HTMLElement>('[data-slot="slider-track"]'));
  const t = thumb.getBoundingClientRect();
  const k = track.getBoundingClientRect();
  await expect(t.height).toBeCloseTo(resolvePx(thumb, 'var(--size-btn-xs)'), 1);
  await expect(t.width).toBeCloseTo(resolvePx(thumb, 'var(--type-kick)') * 1.4, 1);
  await expect(k.height).toBeCloseTo(resolvePx(track, 'var(--stroke-note)'), 1);
  const mid = (r: DOMRect) => r.top + r.height / 2;
  await expect(Math.abs(mid(t) - mid(k))).toBeLessThanOrEqual(0.5);
  // The thumb's center sits on the value (0.3 of the track).
  await expect(Math.abs(t.left + t.width / 2 - (k.left + k.width * 0.3))).toBeLessThanOrEqual(1);
  const tick = must(
    canvasElement.querySelector('[data-slot="slider-tick"]'),
  ).getBoundingClientRect();
  await expect(
    Math.abs(tick.top - k.bottom - resolvePx(track, 'var(--stroke-run)')),
  ).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  const hitY = resolvePx(thumb, 'var(--gap-hit-y)');
  const hits = (x: number, y: number) =>
    document.elementFromPoint(x, y)?.closest('[data-slot="slider-thumb"]') === thumb;
  const cx = t.left + t.width / 2;
  await expect(hits(cx, t.top - hitY + 1)).toBe(true);
  await expect(hits(cx, t.top - hitY - 1)).toBe(false);
}

export const JunctionThumbAdmin: Story = {
  globals: { surface: 'admin' },
  decorators: [(Story) => <div className="py-(--space-8)">{Story()}</div>],
  play: playThumbJunction,
};

export const JunctionThumbSkater: Story = {
  globals: { surface: 'skater' },
  decorators: [(Story) => <div className="py-(--space-8)">{Story()}</div>],
  play: playThumbJunction,
};
