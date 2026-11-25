import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';

import { FactList } from '@/components/kit/fact-list';
import { must } from '@/components/kit/storyKit';
import { type Choice, ChoiceRows } from './ChoiceRows';

/** A choice between a few values, each a card with a radio; the one in use wears Now (a kit candidate). */
const meta = {
  title: 'Admin/Corpus/Candidates/ChoiceRows',
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { fourUp: true },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const CHOICES: Choice[] = [
  {
    value: 'basin',
    label: 'The Basin',
    name: 'The Basin',
    now: true,
    aside: <span className="text-kick text-fg2">GNIS · NHD</span>,
    children: <FactList rows={[{ label: 'From', value: 'USGS Geographic Names' }]} />,
  },
  {
    value: 'auburn',
    label: 'Lake Auburn',
    name: 'Lake Auburn',
    suggested: true,
    aside: <span className="text-kick text-fg2">OSM</span>,
    children: <FactList rows={[{ label: 'From', value: 'OpenStreetMap' }]} />,
  },
];

function Picker({
  readOnly = false,
  disabled = false,
}: {
  readOnly?: boolean;
  disabled?: boolean;
}) {
  const [value, setValue] = useState<string | null>('auburn');
  return (
    <div className="w-[44rem] max-w-full p-(--space-5)">
      <ChoiceRows
        aria-label="Pick the name"
        nowLabel="Shown now"
        value={readOnly ? null : value}
        onValueChange={setValue}
        readOnly={readOnly}
        choices={CHOICES.map((c) => ({ ...c, disabled: disabled && !c.now }))}
      />
    </div>
  );
}

/** Two cards side by side, the suggestion picked; picking moves the pick, arrow keys too. */
export const Pick: Story = {
  render: () => <Picker />,
  play: async ({ canvasElement }) => {
    const quad = must(canvasElement.querySelector<HTMLElement>('[data-theme-scope]'));
    const s = within(quad);
    await expect(s.getByRole('radio', { name: 'Lake Auburn' })).toBeChecked();
    await expect(s.getByText('Shown now')).toBeVisible();
    await expect(s.getByText('Suggested')).toBeVisible();
    await userEvent.click(s.getByRole('radio', { name: 'The Basin' }));
    await expect(s.getByRole('radio', { name: 'The Basin' })).toBeChecked();
    await userEvent.keyboard('{ArrowRight}');
    await expect(s.getByRole('radio', { name: 'Lake Auburn' })).toBeChecked();
  },
};

/** Read only (a decided task): the marks show, nothing is picked or pickable. */
export const ReadOnly: Story = {
  render: () => <Picker readOnly />,
  play: async ({ canvasElement }) => {
    const quad = must(canvasElement.querySelector<HTMLElement>('[data-theme-scope]'));
    for (const r of within(quad).getAllByRole('radio')) await expect(r).not.toBeChecked();
  },
};

/** A choice whose verb is refused: drawn, not pickable. */
export const Disabled: Story = {
  render: () => <Picker disabled />,
  play: async ({ canvasElement }) => {
    const quad = must(canvasElement.querySelector<HTMLElement>('[data-theme-scope]'));
    await expect(within(quad).getByRole('radio', { name: 'Lake Auburn' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  },
};
