import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor } from 'storybook/test';

import { Toolbar } from '@/components/kit/toolbar';

import { NOW, ROB } from '../../people/person/personFixtures';
import { AuthorMenuView, menuLevers } from './AuthorMenu';

/**
 * The author menu in a bar (2.1's *Author* control): the person's circle and name; opened, People's
 * levers for them as `can` allows, then *Open in People →*. Esc closes it.
 */
const meta = {
  title: 'Admin/Inbox/Author menu',
  component: AuthorMenuView,
  globals: { surface: 'admin', mode: 'dark' },
  args: {
    name: 'Rob Tremblay',
    levers: menuLevers(ROB, NOW),
    onPick: fn(),
    peopleHref: '/admin/people/p_rob',
  },
  render: (args) => (
    <Toolbar aria-label="Flag actions">
      <AuthorMenuView {...args} />
    </Toolbar>
  ),
} satisfies Meta<typeof AuthorMenuView>;

export default meta;
type Story = StoryObj<typeof meta>;

const menu = () => document.querySelector<HTMLElement>('[data-slot="author-menu-content"]');

export const Levers: Story = {
  play: async ({ canvasElement, args }) => {
    const trigger = canvasElement.querySelector<HTMLElement>('[data-slot="author-menu"]');
    await expect(trigger).toHaveTextContent('Rob Tremblay');
    await expect(menu()).toBeNull();
    await userEvent.click(trigger as HTMLElement);
    await waitFor(() => expect(menu()).not.toBeNull());
    const people = document.querySelector<HTMLElement>('[data-slot="author-menu-people"]');
    await expect(people).toHaveAttribute('href', '/admin/people/p_rob');
    const first = document.querySelector<HTMLElement>('[data-lever]');
    await userEvent.click(first as HTMLElement);
    await waitFor(() => expect(args.onPick).toHaveBeenCalled());
    // Picking closes the menu; open it again and leave with Esc.
    await waitFor(() => expect(menu()).toBeNull());
    await userEvent.click(trigger as HTMLElement);
    await waitFor(() => expect(menu()).not.toBeNull());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(menu()).toBeNull());
  },
};

export const NothingToChange: Story = {
  args: { levers: [] },
  play: async ({ canvasElement }) => {
    await userEvent.click(canvasElement.querySelector('[data-slot="author-menu"]') as HTMLElement);
    await waitFor(() => expect(menu()).toHaveTextContent('Nothing you can change here'));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(menu()).toBeNull());
  },
};
