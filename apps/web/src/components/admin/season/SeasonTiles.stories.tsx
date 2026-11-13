import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { computedColor, sameColor } from '@/components/kit/measure';
import { faceLoaded, must } from '@/components/kit/storyKit';

import { FirstSkatedTile, IceWatchTile, ImageryTile, WinterTile } from './SeasonTiles';

/** The season's four stats, as Home's strip and the Seasons page draw them. */
const meta = {
  title: 'Admin/Season/Tiles',
  globals: { surface: 'admin', mode: 'dark' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const day = (m: number, d: number, y = 2026) => new Date(y, m, d).getTime();

/** Board 1.1's strip: the watch open, a one-night winter (amber), imagery running, no skate yet. */
export const Strip: Story = {
  parameters: { fourUp: true },
  render: () => (
    <div className="grid w-[56rem] grid-cols-4 gap-x-(--space-5)">
      <IceWatchTile
        data={{ state: 'open', since: day(9, 3), sentinels: 2, of: 3, byRegion: false }}
      />
      <WinterTile
        data={{ state: 'set', from: day(9, 7), nights: 1, frozen: 11, reporting: 25, needs: 13 }}
      />
      <ImageryTile data={{ state: 'running', granules: 0, cutterPinnedAt: day(9, 11) }} />
      <FirstSkatedTile
        data={{ at: null, body: null, lastWinter: { at: day(11, 6, 2025), body: 'Crystal Lake' } }}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const quad = must(canvasElement.querySelector('[data-theme-scope]'));
    const tiles = [...quad.querySelectorAll<HTMLElement>('[data-slot="stat-tile"]')];
    await faceLoaded(must(tiles[0]?.querySelector('[data-slot="value-figure"]')));
    await expect(tiles.map((t) => t.querySelector('[data-slot="value"]')?.textContent)).toEqual([
      'Open Since 3 Oct',
      'One night',
      'Running 0 granules',
      '—',
    ]);
    // A one-night winter waits on a person: amber. Never the ice accent for a value.
    const winter = must(tiles[1]?.querySelector<HTMLElement>('[data-slot="value"]'));
    await expect(getComputedStyle(winter).color).toEqual(
      sameColor(computedColor(winter, 'var(--warn)')),
    );
    const open = must(tiles[0]?.querySelector<HTMLElement>('[data-slot="value"]'));
    await expect(getComputedStyle(open).color).toEqual(sameColor(computedColor(open, 'var(--fg)')));
  },
};

/** Before the watch opens, after it closes, and loading — each tile keeps its box. */
export const States: Story = {
  render: () => (
    <div className="grid w-[56rem] grid-cols-4 gap-x-(--space-5) gap-y-(--space-6)">
      <IceWatchTile data={{ state: 'waiting', countsFrom: day(9, 1) }} />
      <WinterTile data={{ state: 'not-yet' }} />
      <ImageryTile data={{ state: 'not-started', granules: 0 }} />
      <FirstSkatedTile data={{ at: day(11, 4), body: 'Post Pond' }} />
      <IceWatchTile data={{ state: 'closed', since: day(3, 12, 2027) }} />
      <WinterTile
        data={{ state: 'set', from: day(10, 20), nights: 3, frozen: 18, reporting: 25, needs: 13 }}
      />
      <ImageryTile data={{ state: 'paused', granules: 1204, lastLandedAt: day(11, 30) }} />
      <IceWatchTile data={undefined} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const tiles = [...canvasElement.querySelectorAll<HTMLElement>('[data-slot="stat-tile"]')];
    await expect(tiles).toHaveLength(8);
    await expect(tiles[7]).toHaveAttribute('aria-busy', 'true');
    await expect(tiles[5]).toHaveTextContent('Set in');
  },
};
