import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { PersonLockup } from './person-lockup';

/**
 * A kit candidate (People, B01): the person lockup — a circle face, the real name, and the handle,
 * the link to the public profile where the lockup isn't itself inside a control.
 */
const meta = {
  title: 'Kit candidates/PersonLockup',
  component: PersonLockup,
  tags: ['autodocs'],
  globals: { surface: 'admin', mode: 'dark' },
  args: { name: 'Rob Tremblay', handle: 'rtremblay' },
} satisfies Meta<typeof PersonLockup>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A list row's lockup: the handle in the link's look, but text — the row is the control. */
export const Row: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Rob Tremblay')).toBeInTheDocument();
    // The face is hidden beside the written name; the handle is no link here.
    await expect(canvas.queryByRole('img')).toBeNull();
    await expect(canvas.queryByRole('link')).toBeNull();
  },
};

/** With a profile: the handle is the link, opened in a new tab. */
export const Linked: Story = {
  args: { href: '/u/rtremblay' },
  play: async ({ canvasElement }) => {
    const link = within(canvasElement).getByRole('link', { name: '@rtremblay' });
    await expect(link).toHaveAttribute('target', '_blank');
  },
};

/** Its sizes and states side by side: a row's, a feed's, a search's marks, a profile's link. */
export const States: Story = {
  render: (args) => (
    <div className="flex w-[22rem] flex-col gap-(--space-4) text-row text-fg1">
      <PersonLockup {...args} />
      <span>
        <PersonLockup name="Sarah Berman" handle="sarah" size="sm" /> restricted comments
      </span>
      <PersonLockup name="Jamie Moreau" handle="jm_ice" mark="mor" />
      <PersonLockup name="Kate Donovan" handle="kdonovan" href="/u/kdonovan" />
    </div>
  ),
};

/** The states in all four maps. */
export const FourUp: Story = { ...States, parameters: { fourUp: true } };
