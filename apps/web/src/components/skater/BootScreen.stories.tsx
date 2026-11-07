import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { BootScreen } from './BootScreen';

/**
 * The hold a **returning** load shows while auth and the profile resolve — the second load of a
 * browser session onward (`lib/boot.ts`). The splash (8.10) is the cold start's and stays that
 * way; this is what replaces it everywhere else, so a reload reads as a page loading rather than
 * as the app restarting.
 *
 * Nothing here reads anything: it takes a pathname and draws that page's shape. Explore's and a
 * lake's are the pages' own skeletons, borrowed whole, so the hold and the page cannot drift.
 */
const meta = {
  title: 'Skater/Boot screen',
  component: BootScreen,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The shell with the page’s skeletons, shown while auth resolves on every load after the first of a browser session. The map’s half stays empty: nothing here knows anything about any lake.',
      },
    },
  },
} satisfies Meta<typeof BootScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

/** `/` — the In view list's own loading frame beside the empty map. */
export const Explore: Story = {
  args: { pathname: '/' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    await expect(canvas.getByRole('complementary', { name: 'Lakes in view' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
  },
};

/** `/water/$id` — the lake sidebar's own skeleton; the map beside it is still empty. */
export const Lake: Story = {
  args: { pathname: '/water/mascoma' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('complementary', { name: 'Loading the lake' }),
    ).toBeInTheDocument();
  },
};

/** `/latest` — the three columns (4.1); the right one steps out below `xl`, as it does in the page. */
export const Latest: Story = { args: { pathname: '/latest' } };

/** Settings, a profile, About: one column. */
export const Column: Story = { args: { pathname: '/settings/account' } };
