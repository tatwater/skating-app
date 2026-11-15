import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { must } from '@/components/kit/storyKit';

import { BodyGoneBoard } from './bodyBoard';
import { BODY_NOW, CAPPED_HISTORY } from './bodyFixtures';

/**
 * A body the console can't open, in the console's frame at the boards' 1440 × 900: a rejected body
 * says it has been removed and what the record still holds; a merged one points at the body that
 * took it in. Never an empty console, never *No body open*. No board draws these yet.
 */
const meta = {
  title: 'Admin/Body/Console · Removed',
  component: BodyGoneBoard,
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
  args: {
    survivor: null,
    removal: {
      verb: 'Rejected',
      when: '2 Oct 2026',
      who: 'Teagan',
      reason: 'Drawn over the town beach, not a pond',
    },
    towns: ['Enfield, NH'],
    reports: { count: 3, capped: false },
    record: { name: 'Shaker Pond', kind: 'Lake or pond', states: ['NH'], area: '12 ac' },
    history: {
      entries: [
        { id: 'r', at: BODY_NOW - 12 * 86_400_000, who: 'Teagan', what: 'Rejected a body' },
        { id: 'c', at: BODY_NOW - 13 * 86_400_000, who: null, what: 'Drew a body' },
      ],
      capped: false,
    },
  },
} satisfies Meta<typeof BodyGoneBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A body a moderator rejected: removed, and what the record still holds about it. */
export const Rejected: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(page.getByText(/This body has been removed/)).toBeVisible();
    await expect(page.getByText('“Drawn over the town beach, not a pond”')).toBeVisible();
    await expect(page.getByText('3 since the record began')).toBeVisible();
    // The person who rejected it wears a circle.
    const avatar = must(canvasElement.querySelector<HTMLElement>('[data-slot="avatar"]'));
    await expect(getComputedStyle(avatar).borderRadius).not.toBe('0px');
    await expect(page.queryByRole('tab')).toBeNull();
  },
};

/** The same, in the light map. */
export const RejectedLight: Story = {
  name: 'Rejected · Light',
  globals: { surface: 'admin', mode: 'light' },
};

/** A merged body: it points at the body that took it in, whose console holds everything now. */
export const Merged: Story = {
  args: {
    survivor: { id: 'k57survivor000000000000000000000', name: 'Mascoma Lake' },
    removal: { verb: 'Merged', when: '9 Oct 2026', who: 'Matt', reason: null },
    towns: null,
    reports: null,
    // A merged body's record went with it to the survivor.
    record: null,
    // biome-ignore lint/a11y/useAnchorContent: the link takes its words from what renders it.
    survivorLink: (id) => <a href={`#body-${id}`} />,
    history: CAPPED_HISTORY,
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(page.getByText(/This body was merged into/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open Mascoma Lake' })).toBeVisible();
    await expect(page.getByText('More history exists than is shown here.')).toBeVisible();
  },
};
