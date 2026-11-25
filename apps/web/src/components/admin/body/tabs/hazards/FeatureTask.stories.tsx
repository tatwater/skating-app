import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { expect, fn, within } from 'storybook/test';

import { must } from '@/components/kit/storyKit';
import { ThemePair } from '../../../../../../.storybook/theme';
import { FeatureTask } from './FeatureTask';
import {
  redrawTarget,
  startFeatureDraft,
  startRedrawDraft,
  withPaste,
  withPoint,
  withWay,
} from './featureDraft';

/**
 * The known-feature task (B01-6b) at the inspector's width, dark beside light: a new feature placed
 * as a point, a line feature redrawn, a feature stored in parts, and a paste that isn't a shape. No
 * board draws it; it follows the bay task's pattern and waits on the founder's look pass.
 */
const meta = {
  title: 'Admin/Body/Hazards/Feature task',
  component: FeatureTask,
  globals: { surface: 'admin', mode: 'dark' },
  args: {
    draft: withPoint(startFeatureDraft(), { lat: 43.6385, lng: -72.1502 }),
    saving: false,
    onType: fn(),
    onNote: fn(),
    onWay: fn(),
    onRadius: fn(),
    onBand: fn(),
    onPaste: fn(),
    onSave: fn(),
    onDiscard: fn(),
  },
  render: (args) => (
    <Inspector>
      <FeatureTask {...args} />
    </Inspector>
  ),
} satisfies Meta<typeof FeatureTask>;

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

/** A new spring, placed: its type and note, the radius, and Save ready. */
export const NewPoint: Story = {
  play: async ({ canvasElement, args }) => {
    const q = within(quad(canvasElement));
    await expect(q.getByText('New known feature')).toBeVisible();
    await expect(q.getByRole('combobox', { name: 'What it is' })).toHaveTextContent(
      'Spring / current',
    );
    await expect(q.getByRole('spinbutton', { name: 'Radius in meters' })).toHaveValue(30);
    const save = q.getByRole('button', { name: /Save/ });
    await expect(save).toBeEnabled();
    save.click();
    await expect(args.onSave).toHaveBeenCalled();
    // The task's frame is the mode's ice, as the bay task's is.
    const box = must(quad(canvasElement).querySelector<HTMLElement>('[data-slot="feature-task"]'));
    await expect(getComputedStyle(box).borderTopStyle).toBe('solid');
  },
};

/** A line feature redrawn: no type or note, the band, and the line ready to edit. */
export const RedrawLine: Story = {
  args: {
    draft: startRedrawDraft(
      redrawTarget({
        _id: 'f-narrows',
        type: 'bridge_narrows',
        geometryKind: 'line',
        geometry: {
          type: 'LineString',
          coordinates: [
            [-72.1581, 43.6312],
            [-72.1566, 43.6322],
          ],
        },
        bufferMeters: 40,
      }),
    ),
  },
  play: async ({ canvasElement }) => {
    const q = within(quad(canvasElement));
    await expect(q.getByText('Redraw · Bridge narrows')).toBeVisible();
    await expect(q.queryByRole('combobox', { name: 'What it is' })).toBeNull();
    await expect(q.getByRole('spinbutton', { name: /Band/ })).toHaveValue(40);
    await expect(q.getByRole('button', { name: 'Line' })).toHaveAttribute('aria-pressed', 'true');
  },
};

/** A feature stored in parts: drawn again from nothing, and the note says so. */
export const RedrawInParts: Story = {
  args: {
    draft: startRedrawDraft(
      redrawTarget({
        _id: 'f-delta',
        type: 'delta',
        geometryKind: 'polygon',
        geometry: { type: 'MultiPolygon', coordinates: [] },
      }),
    ),
  },
  play: async ({ canvasElement }) => {
    const q = within(quad(canvasElement));
    await expect(q.getByText(/stored in several parts/)).toBeVisible();
    await expect(q.getByText('Nothing drawn yet')).toBeVisible();
    await expect(q.getByRole('button', { name: /Save/ })).toBeDisabled();
  },
};

/** A paste that isn't a shape says why, in the warning ink, and the save waits. */
export const PasteRefused: Story = {
  args: {
    draft: withPaste(withWay(startFeatureDraft(), 'paste'), '{"type":"Point","coordinates":[0,0]}'),
  },
  play: async ({ canvasElement }) => {
    const q = within(quad(canvasElement));
    const why = q.getByText(/not a Point/);
    await expect(why).toBeVisible();
    await expect(why.className).toMatch(/text-warn/);
    await expect(q.queryByRole('spinbutton')).toBeNull();
    await expect(q.getByRole('button', { name: /Save/ })).toBeDisabled();
  },
};
