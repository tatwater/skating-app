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

/** A person list's row (`row`), and the person a page is about (`head`, its name an `h2`). */
export const RowAndHead: Story = {
  parameters: { fourUp: true },
  render: () => (
    <div className="flex w-[22rem] flex-col items-start gap-(--space-4) text-fg1">
      <PersonLockup name="Rob Tremblay" handle="rtremblay" size="row" />
      <PersonLockup name="Jamie Moreau" handle="jm_ice" size="row" mark="mor" />
      <PersonLockup name="Rob Tremblay" handle="rtremblay" size="head" nameAs="h2" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const quad = must(canvasElement.querySelector('[data-theme-scope]'));
    const [row, marked, head] = [
      ...quad.querySelectorAll<HTMLElement>('[data-slot="person-lockup"]'),
    ].map(must);
    // The row's face is the lockup's own; the head's, the head's.
    await expect(must(row?.querySelector('[data-slot="avatar"]'))).toHaveAttribute(
      'data-size',
      'md',
    );
    await expect(must(head?.querySelector('[data-slot="avatar"]'))).toHaveAttribute(
      'data-size',
      'xl',
    );
    // The search is marked in place; the head's name is its page's heading.
    await expect(must(marked?.querySelector('mark'))).toHaveTextContent('Mor');
    await expect(must(head?.querySelector('h2'))).toHaveTextContent('Rob Tremblay');
    // Its handle in mono, over a dotted rule.
    const handle = must(row?.querySelector<HTMLElement>('[data-slot="person-handle"]'));
    await expect(getComputedStyle(handle).borderBottomStyle).toBe('dotted');
  },
};
