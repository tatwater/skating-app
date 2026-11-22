import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { must } from '@/components/kit/storyKit';

import { computedColor, sameColor } from './measure';
import { Quote } from './note';
import { PersonByline, PersonLockup } from './person-lockup';

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

/** Where an element's first line of text sits: an empty inline-block's foot is on the baseline. */
function baselineOf(el: HTMLElement): number {
  const probe = document.createElement('span');
  probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
  el.append(probe);
  const y = probe.getBoundingClientRect().bottom;
  probe.remove();
  return y;
}

/**
 * The byline under a flag's quote (2.1, 2.6, 2.7): the lockup at the body step, its standing and
 * when at the line's far end, on one baseline. A long name truncates; the standing never does.
 */
export const Byline: Story = {
  parameters: { fourUp: true },
  render: () => (
    <div className="flex w-[20rem] flex-col gap-(--space-2)">
      <Quote>
        He was on about 2 inches. I measured 1¾ at the beach an hour later and it was cracking under
        the kids.
      </Quote>
      <PersonByline name="Sarah Berman" handle="sarah" meta="Trusted · 58 pts" />
      <PersonByline
        name="Bartholomew Featherstonehaugh-Whitlock"
        handle="bfw"
        meta="Trusted · 22 pts · 14 Oct 08:52"
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const [short, long] = [...q.querySelectorAll<HTMLElement>('[data-slot="person-byline"]')].map(
        must,
      );
      const meta = must(short?.querySelector<HTMLElement>('[data-slot="person-byline-meta"]'));
      const name = must(short?.querySelector<HTMLElement>('[data-slot="person-name"]'));
      // The standing sits at the line's far end, in the faint ink.
      await expect(
        Math.abs(meta.getBoundingClientRect().right - must(short).getBoundingClientRect().right),
      ).toBeLessThanOrEqual(0.5);
      await expect(getComputedStyle(meta).color).toEqual(sameColor(computedColor(q, 'var(--fg3)')));
      // One baseline: the name's and the standing's text sit on the same line.
      await expect(Math.abs(baselineOf(meta) - baselineOf(name))).toBeLessThanOrEqual(1);
      // The long name gives way; the standing is whole.
      const longMeta = must(long?.querySelector<HTMLElement>('[data-slot="person-byline-meta"]'));
      await expect(longMeta.scrollWidth).toBeLessThanOrEqual(longMeta.clientWidth + 1);
      await expect(within(must(long)).getByText(/Trusted · 22 pts/)).toBeVisible();
      await expect(must(long).getBoundingClientRect().width).toBeLessThanOrEqual(
        q.querySelector<HTMLElement>('[data-slot="quote"]')?.getBoundingClientRect().width ?? 0,
      );
    }
  },
};
