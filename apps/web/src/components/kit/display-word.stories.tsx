import * as tokens from '@skating/design/tokens';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { DisplayWord } from './display-word';
import { computedColor, sameColor } from './measure';
import { KICKER, must, rootPx } from './storyKit';

const meta = {
  title: 'Kit/Display word',
  component: DisplayWord,
  tags: ['autodocs'],
  args: { children: 'Overview' },
  argTypes: { size: { control: 'inline-radio', options: ['page', 'column'] } },
  parameters: {
    docs: {
      description: {
        component:
          "The one word a page or a column stands under: semibold sans caps in the bright ink, widely tracked, one line. `page` is the page's word (*Overview*), `column` a column's head (*Keeping up*). Type only — the heading level is the caller's (`render={<h1 />}`).",
      },
    },
  },
} satisfies Meta<typeof DisplayWord>;

export default meta;
type Story = StoryObj<typeof meta>;

const word = (root: ParentNode) =>
  must(root.querySelector<HTMLElement>('[data-slot="display-word"]'));

async function expectType(el: HTMLElement, surface: tokens.Surface, size: 'page' | 'column') {
  const style = getComputedStyle(el);
  const step = size === 'page' ? 'disp-lg' : 'logo';
  const track = size === 'page' ? 'label' : 'head';
  const px = tokens.fontSize[surface][step].value * rootPx();
  await expect(parseFloat(style.fontSize)).toBeCloseTo(px, 1);
  await expect(parseFloat(style.letterSpacing)).toBeCloseTo(tokens.tracking[track].value * px, 1);
  await expect(style.fontWeight).toBe('600');
  await expect(style.textTransform).toBe('uppercase');
  await expect(style.whiteSpace).toBe('nowrap');
  await expect(style.marginTop).toBe('0px');
  await expect(style.color).toEqual(sameColor(computedColor(el, 'var(--fg)')));
}

/** The page's word: the console's display size, tracked wide, as its own heading. */
export const Page: Story = {
  args: { render: (props) => <h1 {...props} /> },
  play: async ({ canvasElement, globals }) => {
    const el = word(canvasElement);
    await expect(el.tagName).toBe('H1');
    await expectType(el, globals.surface as tokens.Surface, 'page');
  },
};

/** A column's head: the wordmark step, tracked as a head. */
export const Column: Story = {
  args: { size: 'column', render: (props) => <h2 {...props} />, children: 'Keeping up' },
  play: async ({ canvasElement, globals }) => {
    const el = word(canvasElement);
    await expect(el.tagName).toBe('H2');
    await expectType(el, globals.surface as tokens.Surface, 'column');
  },
};

export const FourUp: Story = {
  render: () => (
    <div className="flex flex-col gap-heading">
      <span className={KICKER}>Page</span>
      <DisplayWord>Overview</DisplayWord>
      <span className={KICKER}>Column</span>
      <DisplayWord size="column">Keeping up</DisplayWord>
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const [page, column] = [...q.querySelectorAll<HTMLElement>('[data-slot="display-word"]')];
      const surface = q.dataset.surface as tokens.Surface;
      await expectType(must(page), surface, 'page');
      await expectType(must(column), surface, 'column');
    }
  },
};
