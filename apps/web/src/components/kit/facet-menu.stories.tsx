import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { Button } from './button';
import { FacetMenu } from './facet-menu';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

/** The facet menu behind a list's *Filter* (Bodies 5.2). */
const FACETS = [
  {
    id: 'class',
    label: 'Class',
    options: [
      { id: 'lake', label: 'Lake or pond', count: 138 },
      { id: 'reservoir', label: 'Reservoir', count: 39 },
      { id: 'bay', label: 'Bay', count: 10 },
    ],
  },
  {
    id: 'size',
    label: 'Size',
    options: [
      { id: 'under-10', label: 'Under 10 ac', count: 412 },
      { id: '10-100', label: '10–100', count: 561 },
      { id: '100-1000', label: '100–1,000', count: 252 },
      { id: '1000-up', label: '1,000 and up', count: 187 },
    ],
  },
  {
    id: 'reports',
    label: 'Reports',
    options: [
      { id: 'season', label: 'Reported this season', count: 3 },
      { id: 'never', label: 'Never reported', count: 61 },
    ],
  },
  {
    id: 'outline',
    label: 'Outline',
    options: [
      { id: 'catalog', label: 'From a catalog', disabled: true },
      { id: 'drawn', label: 'Drawn by staff', disabled: true },
    ],
  },
  {
    id: 'age',
    label: 'Age',
    options: [
      // A count the read stopped short on: a floor, "200+".
      { id: '1d', label: '1 day or more', count: { count: 200, capped: true } },
      { id: '7d', label: '7 days or more', count: { count: 41, capped: false } },
    ],
  },
];

function Menu({ onToggle }: { onToggle: (facet: string, option: string) => void }) {
  const [selected, setSelected] = useState<Record<string, string[]>>({ size: ['1000-up'] });
  return (
    <Popover>
      <PopoverTrigger render={<Button size="sm">Filter</Button>} />
      <PopoverContent className="w-[31.25rem]" aria-label="Filter">
        <FacetMenu
          facets={FACETS}
          selected={selected}
          onToggle={(f, o) => {
            onToggle(f, o);
            setSelected((s) => {
              const cur = s[f] ?? [];
              return { ...s, [f]: cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o] };
            });
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

const meta = {
  title: 'Kit/FacetMenu',
  component: Menu,
  globals: { surface: 'admin', mode: 'dark' },
  args: { onToggle: fn() },
} satisfies Meta<typeof Menu>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Open it, ↓ to Reports, ← to its first option, Space applies. */
export const TwoWayKeys: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Filter' }));
    const menu = await within(document.body).findByRole('dialog', { name: 'Filter' });
    await waitFor(() => expect(document.activeElement).toHaveTextContent('1,000 and up'));
    await userEvent.keyboard('{ArrowDown}{Home}{ }');
    await expect(args.onToggle).toHaveBeenLastCalledWith('reports', 'season');
    await expect(
      within(menu).getByRole('button', { name: /^Reported this season/ }),
    ).toHaveAttribute('aria-pressed', 'true');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(within(document.body).queryByRole('dialog')).toBeNull());
  },
};

/** A capped count is a floor: "200+", marked; an exact one reads as the number. */
export const CappedCount: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Filter' }));
    const menu = await within(document.body).findByRole('dialog', { name: 'Filter' });
    const count = (name: RegExp) =>
      within(menu)
        .getByRole('button', { name })
        .querySelector<HTMLElement>('[data-slot="facet-menu-count"]');
    await expect(count(/^1 day or more/)).toHaveTextContent('200+');
    await expect(count(/^1 day or more/)).toHaveAttribute('data-capped');
    await expect(count(/^7 days or more/)).toHaveTextContent('41');
    await expect(count(/^7 days or more/)).not.toHaveAttribute('data-capped');
    await expect(count(/^Bay/)).toHaveTextContent('10');
    await userEvent.keyboard('{Escape}');
  },
};

/** The menu, open, in all four maps. */
export const FourUp: Story = {
  parameters: { fourUp: true },
  render: (args) => (
    <div className="w-[31.25rem] border border-solid border-line2 bg-panel">
      <FacetMenu facets={FACETS} selected={{ size: ['1000-up'] }} onToggle={args.onToggle} />
    </div>
  ),
};
