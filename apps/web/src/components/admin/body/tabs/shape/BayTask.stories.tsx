import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { expect, fn, within } from 'storybook/test';

import { must } from '@/components/kit/storyKit';
import { ThemePair } from '../../../../../../.storybook/theme';
import { BayTask } from './BayTask';
import { startDraft, withPaste } from './bayDraft';

/**
 * The bay task (B01-6a) at the inspector's width, dark beside light: `body-v5.html`'s task block —
 * an Inbox ask arriving filled, a redraw, and a paste that isn't a polygon. No board draws the
 * redraw or the paste; they follow the ask's pattern and wait on the founder's look pass.
 */
const meta = {
  title: 'Admin/Body/Shape/Bay task',
  component: BayTask,
  globals: { surface: 'admin', mode: 'dark' },
  args: {
    draft: startDraft(
      { kind: 'new', request: { requestId: 'rq1', asks: 3 } },
      { name: 'Shaker cove', aliases: [] },
    ),
    saving: false,
    onName: fn(),
    onAliases: fn(),
    onWay: fn(),
    onPaste: fn(),
    onSave: fn(),
    onDiscard: fn(),
  },
  render: (args) => (
    <Inspector>
      <BayTask {...args} />
    </Inspector>
  ),
} satisfies Meta<typeof BayTask>;

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

/** An Inbox ask: the name filled, three asks answered by the save, the chord not drawn yet. */
export const FromTheInbox: Story = {
  play: async ({ canvasElement }) => {
    const q = within(quad(canvasElement));
    await expect(q.getByText('Bay request · from the Inbox')).toBeVisible();
    await expect(q.getByText('Saving answers all 3 asks for this bay.')).toBeVisible();
    await expect(q.getByText('The mouth isn’t drawn yet')).toBeVisible();
    await expect(q.getByRole('button', { name: /Save/ })).toBeDisabled();
    // The task's frame is the mode's ice, as the map's mode bar is.
    const box = must(quad(canvasElement).querySelector<HTMLElement>('[data-slot="bay-task"]'));
    await expect(getComputedStyle(box).borderTopStyle).toBe('solid');
  },
};

/** A bay's outline redrawn: no name to fill, freehand or paste. */
export const Redraw: Story = {
  args: {
    draft: startDraft({
      kind: 'redraw',
      subAreaId: 's1',
      name: 'Mascoma North',
      polygon: null,
      bbox: null,
    }),
  },
  play: async ({ canvasElement }) => {
    const q = within(quad(canvasElement));
    await expect(q.getByText('Redraw · Mascoma North')).toBeVisible();
    await expect(q.queryByPlaceholderText('What skaters call it')).toBeNull();
    await expect(q.queryByRole('button', { name: 'Chord' })).toBeNull();
  },
};

/** A paste that isn't a polygon says why, in the warning ink, and the save waits. */
export const PasteRefused: Story = {
  args: {
    draft: withPaste(
      startDraft({ kind: 'new' }, { way: 'paste', name: 'Fish bay' }),
      '{"type":"LineString","coordinates":[]}',
    ),
  },
  play: async ({ canvasElement }) => {
    const q = within(quad(canvasElement));
    const why = q.getByText(/not a LineString/);
    await expect(why).toBeVisible();
    await expect(why.className).toMatch(/text-warn/);
    await expect(q.getByRole('button', { name: /Save/ })).toBeDisabled();
  },
};
