import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { must } from '@/components/kit/storyKit';

import { PersonLockup } from './person-lockup';

/** The person lockup — a circle, the real name, the @handle. */
const meta = {
  title: 'Kit/PersonLockup',
  component: PersonLockup,
  globals: { surface: 'admin', mode: 'dark' },
  args: { name: 'Kate Donovan', handle: 'kdonovan' },
} satisfies Meta<typeof PersonLockup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Lockups: Story = {
  parameters: { fourUp: true },
  render: (args) => (
    <div className="flex flex-col items-start gap-(--space-2_5)">
      <PersonLockup {...args} />
      <PersonLockup name="Rob Tremblay" handle="rtremblay" href="#people" />
      <PersonLockup name="Teagan" size="md" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const quad = must(canvasElement.querySelector('[data-theme-scope]'));
    const [first, linked, staff] = [
      ...quad.querySelectorAll<HTMLElement>('[data-slot="person-lockup"]'),
    ].map(must);
    // A circle for a person, said once: the name is the accessible name, the avatar is hidden.
    const avatar = must(first?.querySelector<HTMLElement>('[data-slot="avatar"]'));
    await expect(getComputedStyle(avatar).borderRadius).not.toBe('0px');
    await expect(avatar).toHaveAttribute('aria-hidden', 'true');
    await expect(first).toHaveTextContent('Kate Donovan@kdonovan');
    await expect(must(linked?.querySelector('a'))).toHaveAttribute('href', '#people');
    await expect(staff?.querySelector('[data-slot="person-handle"]')).toBeNull();
  },
};
