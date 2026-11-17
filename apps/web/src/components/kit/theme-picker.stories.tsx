import type { ThemePreference } from '@skating/design';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';

import { computedColor, sameColor } from './measure';
import { must } from './storyKit';
import { THEME_CHOICES, ThemePicker } from './theme-picker';

const meta = {
  title: 'Kit/ThemePicker',
  component: ThemePicker,
  tags: ['autodocs'],
  args: { value: 'system', onValueChange: fn() },
} satisfies Meta<typeof ThemePicker>;

export default meta;
type Story = StoryObj<typeof meta>;

function Picker({ initial, onValueChange }: { initial: ThemePreference; onValueChange?: (v: ThemePreference) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <div className="w-[13rem]">
      <ThemePicker
        value={value}
        onValueChange={(v) => {
          setValue(v);
          onValueChange?.(v);
        }}
      />
    </div>
  );
}

/** System · Light · Dark, the stored one filled; a choice is handed back, a re-press is not. */
export const Default: Story = {
  render: (args) => <Picker initial={args.value} onValueChange={args.onValueChange} />,
  play: async ({ canvasElement, args }) => {
    const group = within(canvasElement).getByRole('group', { name: 'Theme' });
    await expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(
      THEME_CHOICES.map((c) => c.label),
    );
    const system = within(group).getByRole('button', { name: 'System' });
    await expect(system).toHaveAttribute('aria-pressed', 'true');
    await expect(getComputedStyle(system).backgroundColor).toEqual(
      sameColor(computedColor(system, 'var(--fg1)')),
    );
    await userEvent.click(within(group).getByRole('button', { name: 'Dark' }));
    await expect(args.onValueChange).toHaveBeenCalledWith('dark');
    await userEvent.click(within(group).getByRole('button', { name: 'Dark' }));
    await expect(args.onValueChange).toHaveBeenCalledOnce();
  },
};

/** Both surfaces, both modes: the chosen segment filled in each map's second ink. */
export const FourUp: Story = {
  parameters: { fourUp: true },
  render: () => <Picker initial="light" />,
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const light = within(q).getByRole('button', { name: 'Light' });
      await expect(light).toHaveAttribute('aria-pressed', 'true');
      await expect(getComputedStyle(light).backgroundColor).toEqual(
        sameColor(computedColor(must(light.parentElement), 'var(--fg1)')),
      );
    }
  },
};
