import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { Logo } from './logo';
import { must } from './storyKit';

const meta = {
  title: 'Kit/Logo',
  component: Logo,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'The Gli duotone mark: white on a dark map, black on a light one, picked by the nearest `data-mode` so a scoped theme wears its own. One image to a reader, named Gli; sized by its height.',
      },
    },
  },
} satisfies Meta<typeof Logo>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Which of the two files paints here: exactly one, or the story fails. */
function shown(scope: ParentNode): 'dark' | 'light' {
  const dark = must(scope.querySelector<HTMLElement>('[data-slot="logo-on-dark"]'));
  const light = must(scope.querySelector<HTMLElement>('[data-slot="logo-on-light"]'));
  const on = [dark, light].filter((img) => getComputedStyle(img).display !== 'none');
  if (on.length !== 1) throw new Error(`${on.length} logo files paint; one must.`);
  return on[0] === dark ? 'dark' : 'light';
}

/** One image named Gli, at the default 16 px, its width the mark's own proportion. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const logo = within(canvasElement).getByRole('img', { name: 'Gli' });
    for (const img of logo.querySelectorAll('img')) await expect(img).toHaveAttribute('alt', '');
    const r = logo.getBoundingClientRect();
    await expect(r.height).toBeCloseTo(16, 1);
    // The files' 303 × 118 drawing.
    await expect(r.width / r.height).toBeCloseTo(303 / 118, 1);
  },
};

/** A scope inside a scope wears its own mode: a light card on a dark field, and the reverse. */
export const NestedScopes: Story = {
  render: () => (
    <div className="flex gap-(--space-4)">
      <div data-mode="dark" data-case="dark-in-light" className="bg-bg p-(--space-3)">
        <div data-mode="light" data-case="light-in-dark" className="bg-bg p-(--space-3)">
          <Logo />
        </div>
      </div>
      <div data-mode="light" className="bg-bg p-(--space-3)">
        <div data-mode="dark" data-case="dark-inner" className="bg-bg p-(--space-3)">
          <Logo />
        </div>
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    await expect(shown(must(canvasElement.querySelector('[data-case="light-in-dark"]')))).toBe(
      'light',
    );
    await expect(shown(must(canvasElement.querySelector('[data-case="dark-inner"]')))).toBe('dark');
  },
};

export const FourUp: Story = {
  args: { className: 'h-(--space-6)' },
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) await expect(shown(q)).toBe(q.dataset.mode);
  },
};
