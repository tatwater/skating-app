import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';

import { must } from '@/components/kit/storyKit';
import { ThemePair } from '../../../../../../.storybook/theme';
import { AccessTask } from './AccessTask';
import { startLink, startLot, startPutIn, withPick } from './accessDraft';
import { MASCOMA_ACCESS } from './accessFixtures';

/**
 * Access's map tasks (B01-6b) at the inspector's width, dark beside light: a put-in being placed, a
 * lot placed and named, a lot linked to a put-in, and a link past the hike-in line. No board draws
 * the put-in task or the link's fields; they follow parking mode's pattern and wait on the
 * founder's look pass.
 */
const LOTS = MASCOMA_ACCESS.lots;
const LAUNCH = {
  id: 'pi-dam',
  name: 'NW launch',
  at: { lat: 43.6489, lng: -72.1793 },
  lotId: null,
  hikeIn: false,
};
const SMITH = must(LOTS.find((l) => l.id === 'lot-smith'));

const meta = {
  title: 'Admin/Body/Access/Map task',
  component: AccessTask,
  globals: { surface: 'admin', mode: 'dark' },
  args: {
    draft: startPutIn(),
    lots: LOTS,
    saving: false,
    onName: fn(),
    onNoParking: fn(),
    onHikeIn: fn(),
    onSave: fn(),
    onDiscard: fn(),
  },
  render: (args) => (
    <Inspector>
      <AccessTask {...args} />
    </Inspector>
  ),
} satisfies Meta<typeof AccessTask>;

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

/** A put-in not placed yet: the next step said, the save waiting, the name optional and capped. */
export const PlaceAPutIn: Story = {
  play: async ({ canvasElement, args }) => {
    const q = within(quad(canvasElement));
    await expect(q.getByText('New put-in')).toBeVisible();
    await expect(q.getByText('Click the shore where people get on the ice')).toBeVisible();
    await expect(q.getByRole('button', { name: /Save/ })).toBeDisabled();
    const name = q.getByPlaceholderText('Optional, what skaters call it');
    await expect(name).toHaveAttribute('maxLength', '60');
    await userEvent.type(name, 'T');
    await expect(args.onName).toHaveBeenCalledWith('T');
    // The task's frame is the mode's ice, as the map's mode bar is.
    const box = must(quad(canvasElement).querySelector<HTMLElement>('[data-slot="access-task"]'));
    await expect(getComputedStyle(box).borderTopStyle).toBe('solid');
  },
};

/** A lot placed and named: nothing in the save's way, ⌘S saves. */
export const PlaceALot: Story = {
  args: {
    draft: { ...withPick(startLot(), { lat: 43.629, lng: -72.159 }, LOTS), name: 'Town lot' },
  },
  play: async ({ canvasElement, args }) => {
    const q = within(quad(canvasElement));
    await expect(q.getByText('New lot')).toBeVisible();
    await expect(q.getByText(/any distance from the ice/)).toBeVisible();
    await expect(q.queryByText(/Click where/)).toBeNull();
    await userEvent.click(q.getByPlaceholderText('Optional, as the sign says'));
    await userEvent.keyboard('{Meta>}s{/Meta}');
    await expect(args.onSave).toHaveBeenCalled();
  },
};

/** A lot picked for a put-in: its name, how far in a straight line, No parking and the hike-in. */
export const LinkALot: Story = {
  args: { draft: withPick(startLink(LAUNCH), { lat: 43.64954, lng: -72.17899 }, LOTS) },
  play: async ({ canvasElement, args }) => {
    const q = within(quad(canvasElement));
    await expect(q.getByText('Link a lot · NW launch')).toBeVisible();
    await expect(q.getByText('Unnamed lot')).toBeVisible();
    await expect(q.getByText(/m from the put-in in a straight line/)).toBeVisible();
    await expect(q.getByRole('button', { name: /Save/ })).toBeEnabled();
    await userEvent.click(q.getByRole('button', { name: 'No parking' }));
    await expect(args.onNoParking).toHaveBeenCalled();
    await userEvent.click(q.getByRole('checkbox', { name: /It’s a hike-in/ }));
    await expect(args.onHikeIn).toHaveBeenCalledWith(true);
  },
};

/** A trailhead past the hike-in line: the warning ink says it must be marked before it links. */
export const LinkPastTheHikeInLine: Story = {
  args: { draft: withPick(startLink(LAUNCH), SMITH.at, LOTS) },
  play: async ({ canvasElement }) => {
    const q = within(quad(canvasElement));
    const why = q.getByText(/has to be marked a hike-in/);
    await expect(why).toBeVisible();
    await expect(why.className).toMatch(/text-warn/);
  },
};

/** No parking chosen: said, and the hike-in isn't asked. */
export const NoParking: Story = {
  args: { draft: { ...startLink({ ...LAUNCH, lotId: 'lot-5' }), choice: 'none' } },
  play: async ({ canvasElement }) => {
    const q = within(quad(canvasElement));
    await expect(
      q.getByText('No parking', { selector: '[data-slot="access-task-lot"]' }),
    ).toBeVisible();
    await expect(q.queryByRole('checkbox')).toBeNull();
    await expect(q.getByRole('button', { name: 'No parking' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  },
};
