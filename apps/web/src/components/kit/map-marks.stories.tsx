import type { Meta, StoryObj } from '@storybook/react-vite';
import type { CSSProperties, ReactNode } from 'react';
import { expect } from 'storybook/test';

import { HazardMark, LotMark, MARK_BOX, PhotoMark, PutInMark } from './map-marks';
import { computedColor, sameColor } from './measure';
import { must, StateMatrix } from './storyKit';

const meta = {
  title: 'Kit/MapMarks',
  component: PutInMark,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'The point marks every map draws: a put-in (ice, a dot), a lot (gray, a P), a photo (light, a lens) and a hazard (its tone: a warning, one healing over, or a reported crossing). Each is a 14–16 px square on a 2 px halo in the map’s ground (`--map-ground`, which the map sets), centered on its point. `big` is the one being talked about; `dim` recedes behind a chosen one, never below half; `highlight` (or a hazard’s `selected`) adds the corner brackets; `glyph` is the map key’s 12 px face, no halo and no state.',
      },
    },
  },
} satisfies Meta<typeof PutInMark>;

export default meta;
type Story = StoryObj<typeof meta>;

const MARKS = [
  { key: 'putIn', label: 'Put-in' },
  { key: 'lot', label: 'Lot' },
  { key: 'photo', label: 'Photo' },
  { key: 'hazard', label: 'Hazard' },
  { key: 'healing', label: 'Healing' },
  { key: 'passage', label: 'Crossing' },
] as const;
type MarkKey = (typeof MARKS)[number]['key'];

const STATES = [
  { key: 'rest', label: 'Rest' },
  { key: 'big', label: 'Big' },
  { key: 'dim', label: 'Dim' },
  { key: 'highlight', label: 'Highlight' },
  { key: 'glyph', label: 'Glyph' },
] as const;
type StateKey = (typeof STATES)[number]['key'];

function Mark({ mark, state }: { mark: MarkKey; state: StateKey }) {
  const props = {
    dim: state === 'dim',
    highlight: state === 'highlight',
    glyph: state === 'glyph',
  };
  const big = state === 'big';
  const drawn: Record<MarkKey, ReactNode> = {
    putIn: <PutInMark big={big} {...props} />,
    lot: <LotMark big={big} {...props} />,
    photo: <PhotoMark big={big} {...props} />,
    // A hazard has no `big`: it is always 16 px. Its "big" cell is the one an inset card is open on.
    hazard: <HazardMark selected={big} {...props} />,
    healing: <HazardMark tone="healing" selected={big} {...props} />,
    passage: <HazardMark tone="passage" selected={big} {...props} />,
  };
  return (
    <span data-mark={mark} data-state={state} className="inline-grid place-items-center">
      {drawn[mark]}
    </span>
  );
}

/** The marks on a map's ground, the halo reading it. */
function Board() {
  return (
    <div
      className="w-fit bg-bg p-(--space-2)"
      style={{ '--map-ground': 'var(--bg)' } as CSSProperties}
    >
      <StateMatrix
        rows={MARKS}
        states={STATES}
        cell={(mark, state) => <Mark mark={mark} state={state} />}
      />
    </div>
  );
}

const cell = (root: ParentNode, mark: MarkKey, state: StateKey) =>
  must(root.querySelector<HTMLElement>(`[data-mark="${mark}"][data-state="${state}"] svg`));

/** Every mark in every state. */
export const Matrix: Story = {
  render: () => <Board />,
  play: async ({ canvasElement }) => {
    for (const { key } of MARKS) {
      const rest = cell(canvasElement, key, 'rest');
      await expect(rest.getBoundingClientRect().width).toBe(MARK_BOX);
      // The halo is the map's ground; the brackets only when pointed at.
      await expect(getComputedStyle(must(rest.querySelector('rect'))).fill).toEqual(
        sameColor(computedColor(rest, 'var(--bg)')),
      );
      await expect(rest.querySelector('[data-slot$="-brackets"]')).toBeNull();
      await expect(
        cell(canvasElement, key, 'highlight').querySelector('[data-slot$="-brackets"]'),
      ).not.toBeNull();
      // Dim recedes, never below half.
      const dim = cell(canvasElement, key, 'dim');
      await expect(Number(getComputedStyle(dim).opacity)).toBeGreaterThanOrEqual(0.5);
      await expect(Number(getComputedStyle(dim).opacity)).toBeLessThan(1);
      // The key's glyph: 12 px, the face alone.
      const glyph = cell(canvasElement, key, 'glyph');
      await expect(glyph.getBoundingClientRect().width).toBe(12);
      await expect(glyph.querySelectorAll('rect')).toHaveLength(1);
    }
    // A hazard's face is its tone.
    const face = (mark: MarkKey) =>
      getComputedStyle(must(cell(canvasElement, mark, 'glyph').querySelector('rect'))).fill;
    await expect(face('hazard')).toEqual(sameColor(computedColor(canvasElement, 'var(--bad)')));
    await expect(face('healing')).toEqual(sameColor(computedColor(canvasElement, 'var(--warn)')));
    await expect(face('passage')).toEqual(sameColor(computedColor(canvasElement, 'var(--acc)')));
    await expect(face('putIn')).toEqual(sameColor(computedColor(canvasElement, 'var(--acc)')));
  },
};

/** The marks in all four maps. */
export const FourUp: Story = {
  render: () => <Board />,
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const lot = cell(q, 'lot', 'rest');
      await expect(getComputedStyle(must(lot.querySelectorAll('rect')[1])).fill).toEqual(
        sameColor(computedColor(q, 'var(--fg2)')),
      );
    }
  },
};
