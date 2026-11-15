import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent } from 'storybook/test';

import { BulletList } from './bullet-list';
import { computedColor, sameColor } from './measure';
import { must } from './storyKit';

/** A short list of things to open, on hollow bullets (the Body console's *Asked of this body*). */
const meta = {
  title: 'Kit/BulletList',
  component: BulletList,
  parameters: { layout: 'padded' },
  args: { label: 'Asked of this body', items: [], onOpen: fn() },
} satisfies Meta<typeof BulletList>;

export default meta;
type Story = StoryObj<typeof meta>;

const quadsOf = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLElement>('[data-theme-scope]'),
];

const onOpen = fn();

/** Asked of this body: the hollow bullets, the open one lit; ⏎ opens the cursor's row. */
export const Bullets: Story = {
  render: () => (
    <div className="w-[18.75rem]">
      <BulletList
        label="Asked of this body"
        selectedId="b"
        onOpen={onOpen}
        items={[
          {
            id: 'a',
            kicker: 'Bay request · 3 skaters',
            title: '“Shaker cove”',
            sub: 'Near the Shaker Bridge launch',
          },
          { id: 'b', kicker: 'Place name · 12 emails', title: '“the Narrows”' },
          { id: 'c', kicker: 'Landmark proposal · 1 skater', title: '“the flats by the dam”' },
        ]}
      />
    </div>
  ),
  parameters: { fourUp: true },
  beforeEach: () => {
    onOpen.mockClear();
  },
  play: async ({ canvasElement }) => {
    for (const q of quadsOf(canvasElement)) {
      const lit = must(q.querySelector<HTMLElement>('[data-slot="bullet-row"][data-selected]'));
      await expect(lit).toHaveTextContent('the Narrows');
      const bullet = must(lit.querySelector<HTMLElement>('[data-slot="bullet"]'));
      await expect(getComputedStyle(bullet).backgroundColor).toEqual(
        sameColor(computedColor(q, 'var(--fg)')),
      );
    }
    const first = must(quadsOf(canvasElement)[0]?.querySelector<HTMLElement>('[role="listbox"]'));
    first.focus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    await expect(onOpen).toHaveBeenCalledWith('c');
  },
};
