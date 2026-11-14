import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { computedColor, sameColor, sameShadow } from './measure';
import { StatusDot } from './status-dot';
import { must } from './storyKit';

const meta = {
  title: 'Kit/Status dot',
  component: StatusDot,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          "A row's status square: 6 px and square (a mark, not a person), colored only by meaning — red won't recover without a person, amber is late or retrying, gray is the quiet state, hollow hasn't run yet. Decoration beside a word that says the state.",
      },
    },
  },
} satisfies Meta<typeof StatusDot>;

export default meta;
type Story = StoryObj<typeof meta>;

const TONES = ['bad', 'warn', 'quiet', 'hollow'] as const;
const INK = { bad: 'var(--bad)', warn: 'var(--warn)', quiet: 'var(--fg2)' } as const;

function Dots() {
  return (
    <div className="flex items-center gap-(--space-3)">
      {TONES.map((tone) => (
        <StatusDot key={tone} tone={tone} />
      ))}
    </div>
  );
}

async function expectDots(scope: HTMLElement) {
  const dots = [...scope.querySelectorAll<HTMLElement>('[data-slot="status-dot"]')];
  await expect(dots.map((d) => d.dataset.tone)).toEqual([...TONES]);
  for (const dot of dots) {
    const r = dot.getBoundingClientRect();
    await expect(r.width).toBeCloseTo(6, 1);
    await expect(r.height).toBeCloseTo(6, 1);
    await expect(getComputedStyle(dot).borderRadius).toBe('0px');
    await expect(dot).toHaveAttribute('aria-hidden', 'true');
    const tone = dot.dataset.tone as (typeof TONES)[number];
    if (tone === 'hollow') {
      await expect(getComputedStyle(dot).backgroundColor).toEqual(sameColor('rgba(0, 0, 0, 0)'));
      await expect(getComputedStyle(dot).boxShadow).toEqual(
        sameShadow({ lengths: [0, 0, 0, 1], inset: true, color: computedColor(dot, 'var(--fg3)') }),
      );
    } else {
      await expect(getComputedStyle(dot).backgroundColor).toEqual(
        sameColor(computedColor(dot, INK[tone])),
      );
    }
  }
}

/** Red, amber, gray, hollow: 6 px squares, by meaning only. */
export const Tones: Story = {
  render: () => <Dots />,
  play: async ({ canvasElement }) => expectDots(canvasElement),
};

/** The default is the quiet state. */
export const Quiet: Story = {
  play: async ({ canvasElement }) => {
    const dot = must(canvasElement.querySelector<HTMLElement>('[data-slot="status-dot"]'));
    await expect(dot.dataset.tone).toBe('quiet');
  },
};

export const FourUp: Story = {
  render: () => <Dots />,
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) await expectDots(q);
  },
};
