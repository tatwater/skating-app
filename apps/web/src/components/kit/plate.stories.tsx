import * as tokens from '@skating/design/tokens';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { computedColor, contentRect, JUNCTION_TOLERANCE_PX, resolvePx } from './measure';
import { Plate } from './plate';
import { Value } from './stat-tile';
import { KICKER, must } from './storyKit';

const meta = {
  title: 'Kit/Plate',
  component: Plate,
  tags: ['autodocs'],
  args: { children: <CardBody /> },
  parameters: {
    docs: {
      description: {
        component:
          'The square container marked at its corners: a hairline `card` with 3 px ticks, or a filled `plate` with 2 px ticks. **Chosen is a 1 px lit border, never a thick top edge.** An interactive plate is a button whose ticks reach into an open corner bracket on hover or keyboard focus.',
      },
    },
  },
} satisfies Meta<typeof Plate>;

export default meta;
type Story = StoryObj<typeof meta>;

function CardBody() {
  return (
    <>
      <span data-content="" className="text-trim text-body leading-list font-medium text-fg">
        Mascoma Lake
      </span>
      <span className="text-trim text-assist leading-list text-fg3">Enfield · 1,120 acres</span>
    </>
  );
}

const plateIn = (root: ParentNode, i = 0) =>
  must(root.querySelectorAll<HTMLElement>('[data-slot="plate"]')[i]);

/** The ticks, as `::after` paints them. */
const ticks = (el: HTMLElement) => getComputedStyle(el, '::after');

/** The eight arm sizes, as `[w, h]` px pairs. */
function arms(el: HTMLElement): Array<[number, number]> {
  return ticks(el)
    .backgroundSize.split(',')
    .map((s) => s.trim().split(/\s+/).map(parseFloat) as [number, number]);
}

/** The color every arm is painted in (the gradient's stops). */
function tickColor(el: HTMLElement): string {
  const m = /linear-gradient\((rgba?\([^)]*\)|oklch\([^)]*\)|color\([^)]*\))/.exec(
    ticks(el).backgroundImage,
  );
  return must(m?.[1]);
}

/** The width a single plate story is set at. */
const narrow = [(Story: () => ReactNode) => <div className="w-[16rem]">{Story()}</div>];

/** Within a quarter pixel. */
async function near(actual: number, want: number, what: string) {
  await expect(Math.abs(actual - want), what).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
}

// ── The card ─────────────────────────────────────────────────────────────────────────────────

/**
 * The hairline card: square, a `line` border, four 3 px ticks 1 px proud of the corners in the
 * list-body gray. Content sits the padding inside the border: that inset is the junction.
 */
export const Card: Story = {
  decorators: narrow,
  play: async ({ canvasElement }) => {
    const card = plateIn(canvasElement);
    const style = getComputedStyle(card);
    await expect(style.borderRadius).toBe('0px');
    await expect(style.borderTopWidth).toBe('1px');
    await expect(style.borderTopColor).toBe(computedColor(card, 'var(--line)'));
    await expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    // Not a button.
    await expect(card).not.toHaveAttribute('role');
    await expect(card).not.toHaveAttribute('tabindex');

    // The ticks: 3 px squares (each corner's two arms overlap), over the corners.
    const t = ticks(card);
    await expect(t.content).toBe('""');
    await expect(t.position).toBe('absolute');
    // Inset from the padding box by 2 px: 1 px outside the border, the border, 1 px inside.
    await expect(t.top).toBe('-2px');
    await expect(t.left).toBe('-2px');
    for (const [w, h] of arms(card)) {
      await expect([w, h]).toEqual([3, 3]);
    }
    await expect(tickColor(card)).toBe(computedColor(card, 'var(--fg2)'));
    await expect(t.backgroundPosition.split(',')).toHaveLength(8);

    // Junction: border → content is the padding, in rem.
    const box = card.getBoundingClientRect();
    const content = contentRect(must(card.querySelector('[data-content]')));
    await near(content.left - box.left - 1, resolvePx(card, 'var(--space-4)'), 'left inset');
    await near(content.top - box.top - 1, resolvePx(card, 'var(--space-3_5)'), 'top inset');
    // Children stack on the card's gap, ink to ink (the lines are trimmed).
    const [a, b] = [...card.children].map((c) => c.getBoundingClientRect());
    await near(must(b).top - must(a).bottom, resolvePx(card, 'var(--space-2_5)'), 'row gap');
  },
};

/** The filled plate: the panel ground, no border, 2 px ticks in the rule gray, 1 px proud. */
export const FilledPlate: Story = {
  decorators: narrow,
  args: { variant: 'plate' },
  play: async ({ canvasElement }) => {
    const plate = plateIn(canvasElement);
    const style = getComputedStyle(plate);
    await expect(style.backgroundColor).toBe(computedColor(plate, 'var(--panel)'));
    await expect(style.borderTopWidth).toBe('0px');
    await expect(style.borderRadius).toBe('0px');
    const t = ticks(plate);
    await expect(t.top).toBe('-1px');
    for (const [w, h] of arms(plate)) await expect([w, h]).toEqual([2, 2]);
    await expect(tickColor(plate)).toBe(computedColor(plate, 'var(--line2)'));
    const box = plate.getBoundingClientRect();
    const content = contentRect(must(plate.querySelector('[data-content]')));
    await near(content.left - box.left, resolvePx(plate, 'var(--space-3)'), 'left inset');
    await near(content.top - box.top, resolvePx(plate, 'var(--space-2_5)'), 'top inset');
  },
};

/**
 * Chosen beside resting: the chosen card's hairline and ticks turn the lit ink. It is a 1 px border
 * all round — no thick top edge, and not a pixel of size changes.
 */
export const Chosen: Story = {
  render: () => (
    <div className="grid grid-cols-2 gap-(--space-4)">
      <Plate>
        <CardBody />
      </Plate>
      <Plate chosen>
        <CardBody />
      </Plate>
    </div>
  ),
  decorators: [(Story) => <div className="w-[30rem]">{Story()}</div>],
  play: async ({ canvasElement }) => {
    const rest = plateIn(canvasElement, 0);
    const chosen = plateIn(canvasElement, 1);
    await expect(chosen).toHaveAttribute('data-chosen');
    const s = getComputedStyle(chosen);
    for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
      await expect(s[`border${side}Width`]).toBe('1px');
      await expect(s[`border${side}Color`]).toBe(computedColor(chosen, 'var(--fg)'));
    }
    await expect(s.boxShadow).toBe('none');
    await expect(tickColor(chosen)).toBe(computedColor(chosen, 'var(--fg)'));
    const a = rest.getBoundingClientRect();
    const b = chosen.getBoundingClientRect();
    await expect([b.width, b.height]).toEqual([a.width, a.height]);
  },
};

/** Ticks by meaning: amber waits on a person, red won't recover without one. Chosen wins over a tone. */
export const Tones: Story = {
  decorators: narrow,
  render: () => (
    <div className="flex flex-col gap-(--space-4)">
      <Plate tone="warn">
        <CardBody />
      </Plate>
      <Plate tone="bad">
        <CardBody />
      </Plate>
      <Plate tone="bad" chosen>
        <CardBody />
      </Plate>
      <Plate variant="plate" tone="warn">
        <CardBody />
      </Plate>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const want = ['var(--warn)', 'var(--bad)', 'var(--fg)', 'var(--warn)'];
    for (const [i, w] of want.entries()) {
      const plate = plateIn(canvasElement, i);
      await expect(tickColor(plate)).toBe(computedColor(plate, w));
    }
    // A tone never colors the border: only the ticks carry it.
    const warn = plateIn(canvasElement, 0);
    await expect(getComputedStyle(warn).borderTopColor).toBe(computedColor(warn, 'var(--line)'));
  },
};

// ── Interactive: the hover bracket ───────────────────────────────────────────────────────────

const onOpen = fn();

/**
 * An interactive plate is a button. On hover or keyboard focus (one look) each tick reaches along
 * its edges into an open bracket — arms `stroke-tick` longer, in the lit ink — and the focus ring
 * draws. Enter and Space press it. The reach rides the fast motion token.
 */
export const Interactive: Story = {
  decorators: narrow,
  args: { interactive: true, onClick: onOpen, 'aria-label': 'Open Mascoma Lake' },
  play: async ({ canvasElement }) => {
    const plate = within(canvasElement).getByRole('button', { name: 'Open Mascoma Lake' });
    await expect(plate).toHaveAttribute('tabindex', '0');
    await expect(getComputedStyle(plate).cursor).toBe('pointer');
    for (const [w, h] of arms(plate)) await expect([w, h]).toEqual([3, 3]);

    // The reach rides the motion token.
    await expect(ticks(plate).transitionProperty).toBe('background-size');
    await expect(parseFloat(ticks(plate).transitionDuration) * 1000).toBe(tokens.duration.fast);

    // Keyboard focus lights it: brackets, the lit ink, the ring. (Resolve colors before waiting.)
    const lit = computedColor(plate, 'var(--fg)');
    const reach = 3 + resolvePx(plate, 'var(--stroke-tick)');
    plate.focus();
    await waitFor(() => {
      const sizes = arms(plate);
      expect(sizes.filter((_, i) => i % 2 === 0).every(([w, h]) => w === reach && h === 3)).toBe(
        true,
      );
      expect(sizes.filter((_, i) => i % 2 === 1).every(([w, h]) => w === 3 && h === reach)).toBe(
        true,
      );
    });
    await expect(tickColor(plate)).toBe(lit);
    await waitFor(() => expect(getComputedStyle(plate).boxShadow).toMatch(/3px/));

    // Enter and Space press it.
    onOpen.mockClear();
    await userEvent.keyboard('{Enter}');
    await expect(onOpen).toHaveBeenCalledTimes(1);
    await userEvent.keyboard(' ');
    await expect(onOpen).toHaveBeenCalledTimes(2);

    // Focus leaves: the bracket folds back into the square.
    plate.blur();
    await waitFor(() => expect(arms(plate).every(([w, h]) => w === 3 && h === 3)).toBe(true));
  },
};

/**
 * A plate that does nothing never lights: it can't take focus, and it carries no `lit:` look, so a
 * hover changes nothing either. (Hover and focus are one look, `lit:`; the browser runner can't
 * fake a CSS hover, so `Interactive` drives it through focus, as the Button stories do.)
 */
export const Resting: Story = {
  decorators: narrow,
  play: async ({ canvasElement }) => {
    const plate = plateIn(canvasElement);
    plate.focus();
    await expect(plate).not.toHaveFocus();
    await expect(plate.className).not.toMatch(/lit:/);
    await expect(getComputedStyle(plate).cursor).not.toBe('pointer');
    for (const [w, h] of arms(plate)) await expect([w, h]).toEqual([3, 3]);
    await expect(tickColor(plate)).toBe(computedColor(plate, 'var(--fg2)'));
  },
};

// ── Board and four-up ────────────────────────────────────────────────────────────────────────

function Board() {
  return (
    <div className="grid w-full max-w-[26rem] grid-cols-2 gap-(--space-4)">
      <Plate>
        <span className={KICKER}>Resting</span>
        <CardBody />
      </Plate>
      <Plate chosen>
        <span className={KICKER}>Chosen</span>
        <CardBody />
      </Plate>
      <Plate interactive aria-label="Open the rollover">
        <span className={KICKER}>Interactive</span>
        <Value value="2" unit="waiting" tone="warn" />
      </Plate>
      <Plate variant="plate" tone="bad">
        <span className={KICKER}>Plate · bad</span>
        <Value value="1" unit="failed" tone="bad" />
      </Plate>
    </div>
  );
}

/** Every register in all four maps: square everywhere, ticks on every ground. */
export const FourUp: Story = {
  render: () => <Board />,
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    const ticksSeen = new Set<string>();
    for (const q of quads) {
      const plates = [...q.querySelectorAll<HTMLElement>('[data-slot="plate"]')];
      await expect(plates).toHaveLength(4);
      for (const p of plates) await expect(getComputedStyle(p).borderRadius).toBe('0px');
      ticksSeen.add(tickColor(must(plates[0])));
      await expect(within(q).getAllByRole('button')).toHaveLength(1);
    }
    // The tick gray is the map's: light on dark, dark on light.
    await expect(ticksSeen.size).toBeGreaterThan(1);
  },
};
