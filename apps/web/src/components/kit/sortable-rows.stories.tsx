import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { computedColor, sameColor } from './measure';
import { SortableRows } from './sortable-rows';
import { faceLoaded, must, settled } from './storyKit';

/**
 * Rows that reorder by a grip, in all four maps. Generic — rows and an order
 * callback — so a promotion into the kit is a file move.
 */
const meta = {
  title: 'Kit/SortableRows',
  parameters: { fourUp: true },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const START = [
  { id: 'a', name: 'Mascoma Lake Association' },
  { id: 'b', name: 'Lake level at Mascoma Lake Dam' },
  { id: 'c', name: 'Enfield town page' },
];

function Bench() {
  const [items, setItems] = useState(START);
  return (
    <SortableRows
      aria-label="Links"
      className="w-[21.25rem]"
      items={items}
      idOf={(i) => i.id}
      labelOf={(i) => i.name}
      onReorder={(ids) => setItems(ids.map((id) => must(items.find((i) => i.id === id))))}
      renderRow={(item, { grip }) => (
        <div className="flex items-center gap-(--space-2_5) border-b border-dotted border-line py-(--space-2_5)">
          {grip}
          <span data-slot="row-name" className="text-body text-fg">
            {item.name}
          </span>
        </div>
      )}
    />
  );
}

/** Lift, move and drop from the keyboard; the lifted row rises a step. */
export const Rows: Story = {
  render: () => <Bench />,
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    const q = must(quads[0]);
    await faceLoaded(must(q.querySelector('[data-slot="row-name"]')), 'Mascoma');
    await faceLoaded(must(quads[1]?.querySelector('[data-slot="row-name"]')), 'Mascoma');
    const grip = within(q).getByRole('button', { name: 'Move Enfield town page' });
    grip.focus();
    await userEvent.keyboard(' ');
    const lifted = await waitFor(() => must(q.querySelector<HTMLElement>('[data-lifted]')));
    // The probe resolves before the wait, never inside it (it would loop).
    const lift = sameColor(computedColor(lifted, 'var(--lift-08)'));
    await settled(lifted);
    await expect(getComputedStyle(lifted).backgroundColor).toEqual(lift);
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    await waitFor(() =>
      expect(within(q).getByRole('button', { name: 'Move Enfield town page' })).toHaveFocus(),
    );
    await userEvent.keyboard(' ');
    const names = [...q.querySelectorAll('[data-slot="row-name"]')].map((n) => n.textContent);
    await expect(names[0]).toBe('Enfield town page');
    await expect(must(q.querySelector('[data-slot="sortable-status"]'))).toHaveTextContent(
      'Dropped Enfield town page at 1 of 3.',
    );
  },
};
