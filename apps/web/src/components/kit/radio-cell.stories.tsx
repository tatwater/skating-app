import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { must } from '@/components/kit/storyKit';
import { computedColor, sameColor } from './measure';
import { RadioGroup } from './radio';

import { RadioCell } from './radio-cell';

/** A value you can pick, as a boxed table cell; the one in use wears Now. */
const meta = {
  title: 'Kit/RadioCell',
  component: RadioCell,
  globals: { surface: 'admin', mode: 'dark' },
  args: { value: 'survey', figure: '9.4', unit: 'm' },
} satisfies Meta<typeof RadioCell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AColumn: Story = {
  parameters: { fourUp: true },
  render: () => <Column onValueChange={fn()} />,
  play: async ({ canvasElement }) => {
    const quad = must(canvasElement.querySelector<HTMLElement>('[data-theme-scope]'));
    const cells = within(quad).getAllByRole('radio');
    await expect(cells.map((c) => c.textContent)).toEqual(['Now9.4m', '~8.1m', '12m']);
    // The chosen cell lights the whole cell; a pressable thing, so square on the console.
    const now = must(cells[0]);
    await expect(getComputedStyle(now).color).toEqual(sameColor(computedColor(now, 'var(--fg)')));
    await expect(getComputedStyle(now).borderRadius).toBe('0px');
    // Arrow keys move the pick down the column.
    now.focus();
    await userEvent.keyboard('{ArrowDown}');
    await expect(cells[1]).toBeChecked();
  },
};

/** Read-only: which is in use still shows; nothing moves. */
export const ReadOnly: Story = {
  render: () => <Column readOnly />,
  play: async ({ canvasElement }) => {
    const cells = within(canvasElement).getAllByRole('radio');
    await userEvent.click(must(cells[1]));
    await expect(cells[0]).toBeChecked();
  },
};

function Column({ readOnly, onValueChange }: { readOnly?: boolean; onValueChange?: () => void }) {
  return (
    <RadioGroup
      aria-label="Mean depth"
      defaultValue="survey"
      readOnly={readOnly}
      onValueChange={onValueChange}
      className="w-[7rem] gap-(--space-2)"
    >
      <RadioCell value="survey" figure="9.4" unit="m" now />
      <RadioCell value="modeled" figure="8.1" unit="m" estimate />
      <RadioCell value="tag" figure="12" unit="m" />
    </RadioGroup>
  );
}
