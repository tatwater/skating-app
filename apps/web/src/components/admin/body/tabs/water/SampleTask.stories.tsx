import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';

import { must } from '@/components/kit/storyKit';
import { ThemePair } from '../../../../../../.storybook/theme';
import { MASCOMA_POLYGON } from '../../frame/mascomaFixtures';
import { SampleTask } from './SampleTask';
import { startSampleDraft, suggest } from './sampleDraft';

/**
 * The sample-point task (B01-6b) at the inspector's width, dark beside light: Mascoma's grid at the
 * default spacing, a grid cut short at the cap, and a spacing the task won't take. No board draws
 * it; it follows the bay task's frame and waits on the founder's look pass.
 */
const OUTLINE = MASCOMA_POLYGON;
const GRID = startSampleDraft(OUTLINE, [], null);

const meta = {
  title: 'Admin/Body/Water/Sample task',
  component: SampleTask,
  globals: { surface: 'admin', mode: 'dark' },
  args: {
    draft: GRID,
    saving: false,
    onSpacing: fn(),
    onSuggest: fn(),
    onSave: fn(),
    onDiscard: fn(),
  },
  render: (args) => (
    <Inspector>
      <SampleTask {...args} />
    </Inspector>
  ),
} satisfies Meta<typeof SampleTask>;

export default meta;
type Story = StoryObj<typeof meta>;

function Inspector({ children }: { children: ReactNode }) {
  return (
    <ThemePair surface="admin" heading columns="lg">
      {() => <div className="w-inspector px-gutter py-(--space-5_5)">{children}</div>}
    </ThemePair>
  );
}

const quad = (canvas: HTMLElement) => must(canvas.querySelector<HTMLElement>('[data-theme-scope]'));

/** The default spacing: how many points, how far apart, and Save with the count. */
export const Suggested: Story = {
  play: async ({ canvasElement, args }) => {
    const q = within(quad(canvasElement));
    await expect(q.getByText('Suggested sample points')).toBeVisible();
    await expect(q.getByRole('spinbutton', { name: 'Spacing in km' })).toHaveValue(11);
    const n = GRID.points.length;
    await expect(q.getByRole('button', { name: new RegExp(`Save ${n}`) })).toBeEnabled();
    await userEvent.click(q.getByRole('button', { name: 'Suggest again' }));
    await expect(args.onSuggest).toHaveBeenCalled();
    const box = must(quad(canvasElement).querySelector<HTMLElement>('[data-slot="sample-task"]'));
    await expect(getComputedStyle(box).borderTopStyle).toBe('solid');
  },
};

/** A spacing past the bounds: said in the warning ink, and no new grid until it is one. */
export const SpacingRefused: Story = {
  args: { draft: { ...GRID, spacing: '500' } },
  play: async ({ canvasElement }) => {
    const q = within(quad(canvasElement));
    const why = q.getByText('The spacing is 1 to 100 km');
    await expect(why.className).toMatch(/text-warn/);
    await expect(q.getByRole('button', { name: 'Suggest again' })).toBeDisabled();
    // The grid on the map is still the one shown, and can still be saved.
    await expect(q.getByRole('button', { name: /Save/ })).toBeEnabled();
  },
};

/** A grid at the finest spacing, as many points as it finds on the water. */
export const Fine: Story = {
  args: { draft: suggest({ ...GRID, spacing: '1' }, OUTLINE) },
  play: async ({ canvasElement }) => {
    const q = within(quad(canvasElement));
    await expect(q.getByText(/1 km apart|the most a body can carry/)).toBeVisible();
  },
};
