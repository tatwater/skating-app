import { tokens } from '@skating/design';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { Badge, Tag, TagRun } from './badge';
import { computedColor, contrastBetween, JUNCTION_TOLERANCE_PX } from './measure';
import { KICKER, must, rootPx } from './storyKit';

const meta = {
  title: 'Kit/Badge',
  component: Badge,
  tags: ['autodocs'],
  args: { children: 'Open' },
  argTypes: {
    variant: { control: 'inline-radio', options: ['solid', 'outline', 'live'] },
    tone: { control: 'inline-radio', options: ['default', 'lit', 'dim', 'warn', 'bad', 'acc'] },
  },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

const badge = (canvasElement: HTMLElement) =>
  must(canvasElement.querySelector<HTMLElement>('[data-slot="badge"]'));

/** A state: mono caps on a filled square — never a pill. */
export const Solid: Story = {
  play: async ({ canvasElement, globals }) => {
    const el = badge(canvasElement);
    const style = getComputedStyle(el);
    await expect(style.borderRadius).toBe('0px');
    await expect(style.textTransform).toBe('uppercase');
    await expect(style.fontFamily).toMatch(/Martian Mono/);
    const surface = globals.surface as tokens.Surface;
    await expect(el.getBoundingClientRect().height).toBeCloseTo(
      tokens.size[surface].badge.value * rootPx(),
      1,
    );
  },
};

/** A fading state (Stale): the dimmer solid badge. */
export const SolidDim: Story = { args: { tone: 'dim', children: 'Stale' } };

/** Needs a person. */
export const SolidWarn: Story = { args: { tone: 'warn', children: '1 day left' } };

/** Failed. */
export const SolidBad: Story = { args: { tone: 'bad', children: 'Failed' } };

/** The current value: a hairline box in the bright ink (Now). */
export const OutlineNow: Story = {
  args: { variant: 'outline', tone: 'lit', children: 'Now' },
  play: async ({ canvasElement, globals }) => {
    const el = badge(canvasElement);
    await expect(getComputedStyle(el).borderTopStyle).toBe('solid');
    const surface = globals.surface as tokens.Surface;
    await expect(el.getBoundingClientRect().height).toBeCloseTo(
      tokens.size[surface].pill.value * rootPx(),
      1,
    );
  },
};

/** The alternative the queue suggests: the gray hairline. */
export const OutlineSuggested: Story = { args: { variant: 'outline', children: 'Suggested' } };

/** A muted claim: dashed. */
export const OutlineDim: Story = {
  args: { variant: 'outline', tone: 'dim', children: 'Unverified' },
  play: async ({ canvasElement }) => {
    await expect(getComputedStyle(badge(canvasElement)).borderTopStyle).toBe('dashed');
  },
};

/** A running state: no box, the LED glows and breathes. */
export const Live: Story = {
  args: { variant: 'live', children: 'Running' },
  play: async ({ canvasElement }) => {
    const el = badge(canvasElement);
    await expect(getComputedStyle(el).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    const led = getComputedStyle(el, '::before');
    await expect(led.backgroundColor).toBe(computedColor(el, 'var(--fg)'));
    // It breathes — unless the reader asked for less motion.
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    await expect(led.animationName).toBe(reduced ? 'none' : 'kit-led');
  },
};

/** An idle lamp: the LED holds still and dark. */
export const LiveIdle: Story = {
  args: { variant: 'live', tone: 'dim', children: 'Nothing running' },
  play: async ({ canvasElement }) => {
    const led = getComputedStyle(badge(canvasElement), '::before');
    await expect(led.animationName).toBe('none');
    // No halo: every shadow layer (Tailwind stacks several) is transparent.
    const layers = led.boxShadow.split(/,(?![^(]*\))/);
    await expect(layers.every((s) => s.includes('rgba(0, 0, 0, 0)'))).toBe(true);
  },
};

/** Catalog tags vouch for the value they follow: mono caps, no box, joined by a tight dot. */
export const Tags: Story = {
  render: () => (
    <p className="flex items-baseline gap-(--space-1_5) text-row text-fg1">
      Mascoma Lake
      <TagRun>
        <Tag>NHD</Tag>
        <Tag>OSM</Tag>
        <Tag>GNIS</Tag>
      </TagRun>
    </p>
  ),
  play: async ({ canvasElement }) => {
    const run = must(canvasElement.querySelector('[data-slot="tag-run"]'));
    await expect(run).toHaveTextContent('NHD·OSM·GNIS');
    const dots = run.querySelectorAll('[data-slot="tag-dot"]');
    await expect(dots).toHaveLength(2);
    for (const dot of dots) await expect(dot).toHaveAttribute('aria-hidden', 'true');
    // The dot sits 0.3 em each side: equal air either way.
    const [a, dot, b] = [...run.children].map((el) => el.getBoundingClientRect());
    await expect(
      Math.abs(must(dot).left - must(a).right - (must(b).left - must(dot).right)),
    ).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  },
};

// ── Matrix and four-up ────────────────────────────────────────────────────────────────────────

const TONES = ['default', 'lit', 'dim', 'warn', 'bad', 'acc'] as const;
const LABEL = {
  default: 'Open',
  lit: 'Known',
  dim: 'Stale',
  warn: 'Waiting',
  bad: 'Failed',
  acc: 'Live',
};

function Matrix() {
  return (
    <table className="border-separate border-spacing-x-6 border-spacing-y-4 text-left">
      <thead>
        <tr>
          <th />
          {TONES.map((tone) => (
            <th key={tone} scope="col" className={KICKER}>
              {tone}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {(['solid', 'outline', 'live'] as const).map((variant) => (
          <tr key={variant}>
            <th scope="row" className={KICKER}>
              {variant}
            </th>
            {TONES.map((tone) => (
              <td key={tone}>
                <Badge variant={variant} tone={tone}>
                  {LABEL[tone]}
                </Badge>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Every variant × tone. A badge is not interactive, so its states are its tones. Each label must
 * pass AA on what it sits on: a solid badge's ink on its fill, the rest on the field.
 */
export const Tones: Story = {
  render: () => <Matrix />,
  play: async ({ canvasElement }) => {
    for (const el of canvasElement.querySelectorAll<HTMLElement>('[data-slot="badge"]')) {
      const style = getComputedStyle(el);
      const ground =
        style.backgroundColor === 'rgba(0, 0, 0, 0)'
          ? ['var(--bg)']
          : ['var(--bg)', style.backgroundColor];
      const ratio = contrastBetween(el, ground, [...ground, style.color]);
      await expect(ratio, `${el.textContent} (${el.className})`).toBeGreaterThanOrEqual(4.5);
    }
  },
};

export const FourUp: Story = {
  render: () => (
    <div className="flex flex-col gap-heading">
      {(['solid', 'outline', 'live'] as const).map((variant) => (
        <div key={variant} className="flex flex-wrap items-center gap-(--space-2)">
          {TONES.map((tone) => (
            <Badge key={tone} variant={variant} tone={tone}>
              {LABEL[tone]}
            </Badge>
          ))}
        </div>
      ))}
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      for (const el of q.querySelectorAll('[data-slot="badge"]')) {
        await expect(getComputedStyle(el).borderRadius).toBe('0px');
      }
    }
  },
};
