import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { computedColor, sameColor } from '@/components/kit/measure';
import { must } from '@/components/kit/storyKit';

import { SearchMark } from './search-mark';

/** Kit candidate: the search highlight — what matched, marked in place (Bodies 5.3). */
const meta = {
  title: 'Kit candidates/SearchMark',
  component: SearchMark,
  tags: ['autodocs'],
  globals: { surface: 'admin', mode: 'dark' },
  args: { text: 'Lake Morey', query: 'mor' },
  render: (args) => (
    <p className="text-row text-fg">
      <SearchMark {...args} />
    </p>
  ),
} satisfies Meta<typeof SearchMark>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The ice mark ground, the text keeping its own ink. */
export const Marked: Story = {
  play: async ({ canvasElement }) => {
    const mark = must(canvasElement.querySelector<HTMLElement>('mark'));
    await expect(mark).toHaveTextContent('Mor');
    await expect(getComputedStyle(mark).backgroundColor).toEqual(
      sameColor(computedColor(mark, 'var(--acc-mark)')),
    );
    await expect(getComputedStyle(mark).color).toEqual(sameColor(computedColor(mark, 'var(--fg)')));
  },
};

/** Accents and case don't stop a match. */
export const Folded: Story = { args: { text: 'Lac Memphrémagog', query: 'EMAG' } };

/** In all four maps. */
export const FourUp: Story = { parameters: { fourUp: true } };
