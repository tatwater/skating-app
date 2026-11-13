import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { type LifeLineMeaning, type LifeStation, LifeStrip } from './life-strip';
import { computedColor, sameColor, sameShadow } from './measure';
import { faceLoaded, must } from './storyKit';

/** 8.3: a hidden report's life, and what a restore would do. */
const HIDDEN: LifeStation[] = [
  {
    when: 'Wed 18 Mar',
    title: 'Posted',
    sub: '2 thumbs, 1 comment',
    mark: 'dot',
    next: 'heavy',
    lasted: '1 day',
  },
  {
    when: 'Thu 19 Mar',
    title: 'Hidden',
    sub: 'As a duplicate',
    mark: 'hollow',
    next: 'thin',
    lasted: '1 day',
  },
  {
    when: 'Fri 20 Mar',
    title: 'The 17 Mar copy deleted',
    sub: 'By Rob · this one is the only copy now',
    mark: 'warn',
    next: 'thin',
    lasted: '208 days',
  },
  {
    when: '14 Oct · today',
    title: 'Still hidden',
    sub: '7 months out of sight',
    mark: 'now',
    next: 'dashed',
  },
  {
    when: 'If restored',
    title: 'Back on Mascoma Lake',
    sub: 'Dated 18 Mar 2026, last winter',
    mark: 'end',
  },
];

const HIDDEN_LINES: LifeLineMeaning[] = [
  { line: 'heavy', label: 'Visible to skaters' },
  { line: 'thin', label: 'Hidden' },
  { line: 'dashed', label: 'If restored' },
];

/** 2.6: an access alert's life, and when it would lapse. */
const ALERT: LifeStation[] = [
  {
    when: '2 Oct',
    title: 'Posted',
    sub: 'Jamie Moreau · trusted',
    mark: 'dot',
    next: 'thin',
    lasted: '1 d',
  },
  {
    when: '3 Oct',
    title: 'Pinned official',
    sub: 'Teagan · stops it lapsing',
    mark: 'square',
    next: 'heavy',
    lasted: '6 d',
  },
  {
    when: '9 Oct',
    title: 'Still closed',
    sub: 'Luc Pelletier confirmed',
    mark: 'ring',
    next: 'heavy',
    lasted: '5 d',
  },
  {
    when: '14 Oct · today',
    title: 'Flagged · reopened',
    sub: 'Kate Donovan · this flag',
    mark: 'now',
    next: 'dashed',
    lasted: '25 d',
  },
  { when: '8 Nov', title: 'Would lapse', sub: 'If unpinned and not confirmed', mark: 'end' },
];

const ALERT_LINES: LifeLineMeaning[] = [
  { line: 'thin', label: 'Active · lapses on its own' },
  { line: 'heavy', label: 'Pinned official' },
  { line: 'dashed', label: 'If no one acts' },
];

const meta = {
  title: 'Kit/Life strip',
  component: LifeStrip,
  tags: ['autodocs'],
  args: { stations: HIDDEN, lines: HIDDEN_LINES, 'aria-label': 'Its life' },
  decorators: [(Story) => <div className="w-[40rem]">{Story()}</div>],
  parameters: {
    docs: {
      description: {
        component:
          "An item's history as a strip map: one station per event, evenly spaced however many there are; the line between two stations is the state the item was in (thin, heavy, or dashed for what a staff action would do next), the time it lasted in the line's gap; a key says what each weight means here.",
      },
    },
  },
} satisfies Meta<typeof LifeStrip>;

export default meta;
type Story = StoryObj<typeof meta>;

const all = (root: ParentNode, slot: string) => [
  ...root.querySelectorAll<HTMLElement>(`[data-slot="${slot}"]`),
];
const middle = (r: DOMRect) => r.left + r.width / 2;

/**
 * 8.3: stations evenly spaced; each line runs from one mark's middle to the next one's, in its
 * state's weight, with how long it lasted centered in its gap; marks and words by meaning.
 */
export const HiddenContent: Story = {
  play: async ({ canvasElement }) => {
    const list = within(canvasElement).getByRole('list', { name: 'Its life' });
    await expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    const lasted = all(canvasElement, 'life-lasted');
    await faceLoaded(must(lasted[0]), '1 day');
    await faceLoaded(must(all(canvasElement, 'life-title')[0]), 'Posted');
    // One fresh read of the geometry, after the faces.
    const marks = all(canvasElement, 'life-mark').map((m) => middle(m.getBoundingClientRect()));
    const steps = marks.slice(1).map((x, i) => x - (marks[i] as number));
    for (const step of steps) await expect(step).toBeCloseTo(must(steps[0]), 0);
    const lines = all(canvasElement, 'life-line');
    await expect(lines.map((l) => l.dataset.line)).toEqual(['heavy', 'thin', 'thin', 'dashed']);
    for (const [i, line] of lines.entries()) {
      const r = line.getBoundingClientRect();
      await expect(Math.abs(r.left - must(marks[i]))).toBeLessThanOrEqual(0.5);
      await expect(Math.abs(r.right - must(marks[i + 1]))).toBeLessThanOrEqual(0.5);
    }
    // The time lasted sits in the line's gap, centered between the two stations.
    for (const [i, label] of lasted.slice(0, 3).entries()) {
      const want = (must(marks[i]) + must(marks[i + 1])) / 2;
      await expect(Math.abs(middle(label.getBoundingClientRect()) - want)).toBeLessThanOrEqual(0.5);
    }
    await expect(lasted.map((l) => l.textContent)).toEqual(['1 day', '1 day', '208 days', '']);

    // Weights: heavy 3 px bright, thin a faint hairline, dashed 2 px muted.
    const stroke = (line: HTMLElement) => getComputedStyle(must(line.querySelector('i')));
    const [heavy, thin, , dashed] = lines.map(stroke);
    await expect(must(heavy).borderTopWidth).toBe('3px');
    await expect(must(heavy).borderTopColor).toEqual(
      sameColor(computedColor(canvasElement, 'var(--fg)')),
    );
    await expect(must(thin).borderTopWidth).toBe('1px');
    await expect(must(thin).borderTopColor).toEqual(
      sameColor(computedColor(canvasElement, 'var(--fg3)')),
    );
    await expect(must(dashed).borderTopStyle).toBe('dashed');
    await expect(must(dashed).borderTopWidth).toBe('2px');

    // Marks: today is the larger square in a ring; the change of footing amber; the end open.
    const markEls = all(canvasElement, 'life-mark');
    const now = must(markEls[3]);
    await expect(now.getBoundingClientRect().width).toBeCloseTo(14, 1);
    await expect(getComputedStyle(now).borderRadius).toBe('0px');
    await expect(getComputedStyle(now).boxShadow).toEqual(sameShadow([0, 0, 0, 3], [0, 0, 0, 4]));
    await expect(getComputedStyle(must(markEls[2])).backgroundColor).toEqual(
      sameColor(computedColor(canvasElement, 'var(--warn)')),
    );
    await expect(getComputedStyle(must(markEls[4])).borderRadius).not.toBe('0px');
    // Words take the mark's tone.
    const titles = all(canvasElement, 'life-title');
    await expect(getComputedStyle(must(titles[3])).color).toEqual(
      sameColor(computedColor(canvasElement, 'var(--fg)')),
    );
    await expect(getComputedStyle(must(titles[2])).color).toEqual(
      sameColor(computedColor(canvasElement, 'var(--warn)')),
    );
    await expect(getComputedStyle(must(titles[4])).color).toEqual(
      sameColor(computedColor(canvasElement, 'var(--fg3)')),
    );

    // The key: each weight once, as drawn; a reader hears the meaning at every line instead.
    const key = must(canvasElement.querySelector('[data-slot="life-key"]'));
    await expect(key).toHaveAttribute('aria-hidden', 'true');
    await expect(all(key, 'life-key-item').map((k) => k.textContent)).toEqual([
      'Visible to skaters',
      'Hidden',
      'If restored',
    ]);
    await expect(must(list.querySelector('li'))).toHaveTextContent(
      'Then: Visible to skaters, 1 day',
    );
  },
};

/** 2.6: the alert's life — a pin is a staff act (square), a confirmation a ring. */
export const AccessAlert: Story = {
  args: { stations: ALERT, lines: ALERT_LINES, 'aria-label': "The alert's life" },
  play: async ({ canvasElement }) => {
    const marks = all(canvasElement, 'life-mark');
    await expect(marks.map((m) => m.parentElement?.parentElement?.dataset.mark)).toEqual([
      'dot',
      'square',
      'ring',
      'now',
      'end',
    ]);
    await expect(getComputedStyle(must(marks[1])).borderRadius).toBe('0px');
    await expect(getComputedStyle(must(marks[2])).boxShadow).toEqual(
      sameShadow({
        lengths: [0, 0, 0, 2],
        inset: true,
        color: computedColor(canvasElement, 'var(--fg)'),
      }),
    );
  },
};

/** Any number of stations fits: three spread wider, eight pack tighter, still evenly. */
export const ThreeStations: Story = {
  args: { stations: HIDDEN.slice(2), showKey: false },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-slot="life-key"]')).toBeNull();
    await expect(all(canvasElement, 'life-station')).toHaveLength(3);
  },
};

export const FourUp: Story = {
  render: () => (
    <div className="flex flex-col gap-(--space-8)">
      <LifeStrip stations={HIDDEN} lines={HIDDEN_LINES} aria-label="Its life" />
      <LifeStrip stations={ALERT} lines={ALERT_LINES} aria-label="The alert's life" />
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      // The open marks are filled with their own ground, so a line never shows through them.
      const end = must(all(q, 'life-mark')[4]);
      await expect(getComputedStyle(end).backgroundColor).toEqual(
        sameColor(computedColor(q, 'var(--bg)')),
      );
    }
  },
};
