import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { must } from '@/components/kit/storyKit';
import { ThemePair } from '../../../../../.storybook/theme';
import { retryAll } from '../../reads/consoleReads';
import { InboxMapStill } from './InboxMap';
import { ItemMapView } from './ItemMap';
import {
  ADMIT_MAP,
  ADMIT_MAP_NO_TRACK,
  ADMIT_MATCH,
  DRAWN,
  DRAWN_MAP,
  DRAWN_MAP_NO_TRACK,
  EMPTY_MAP,
  PERSON_FLAG,
  SAFETY,
  SAFETY_MAP,
  SIMPLIFIED,
} from './itemMapFixtures';

/**
 * The item map's states over the still, in both modes: the embed, a simplified outline said on its
 * caption, loading (the embed's box held), failed (Try again), and nothing to place (collapsed).
 */
const meta = {
  title: 'Admin/Inbox/Map/ItemMap',
  parameters: { layout: 'fullscreen' },
  globals: { surface: 'admin' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const still = (width: number) => (view: Parameters<typeof InboxMapStill>[0]['view']) => (
  <InboxMapStill view={view} width={width} />
);

export const States: Story = {
  render: () => (
    <ThemePair surface="admin" columns="one">
      {() => (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(20rem,1fr))] gap-(--space-4) p-(--space-4)">
          <div data-case="map">
            <ItemMapView
              item={SAFETY}
              state={{ map: SAFETY_MAP, pending: false }}
              renderMap={still(320)}
            />
          </div>
          <div data-case="simplified">
            <ItemMapView
              item={DRAWN}
              state={{ map: SIMPLIFIED(DRAWN_MAP), pending: false }}
              // The board's zone: a date on the map reads the same in every runner.
              timeZone="America/New_York"
              renderMap={still(320)}
            />
          </div>
          <div data-case="loading">
            <ItemMapView item={SAFETY} state={undefined} renderMap={still(320)} />
          </div>
          <div data-case="failed">
            <ItemMapView
              item={SAFETY}
              state={retryAll([])}
              renderMap={still(320)}
              onRetry={() => {}}
            />
          </div>
          <div data-case="none">
            <ItemMapView
              item={PERSON_FLAG}
              state={{ map: EMPTY_MAP('flag'), pending: false }}
              renderMap={still(320)}
            />
          </div>
        </div>
      )}
    </ThemePair>
  ),
  play: async ({ canvasElement }) => {
    for (const q of canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')) {
      const box = (c: string) => must(q.querySelector<HTMLElement>(`[data-case="${c}"]`));
      await expect(box('map').querySelector('[data-mark="reticle"]')).not.toBeNull();
      await expect(
        must(box('simplified').querySelector('[data-slot="inbox-map-caption"]')),
      ).toHaveTextContent('Outline simplified');
      await expect(
        must(
          box('loading').querySelector<HTMLElement>('[data-slot="item-map-loading"]'),
        ).getBoundingClientRect().height,
      ).toBeCloseTo(300, 0);
      await expect(within(box('failed')).getByRole('button', { name: /Try again/ })).toBeVisible();
      await expect(box('none')).toBeEmptyDOMElement();
    }
  },
};

/**
 * The skates behind 2.3 and 2.5 (`tracks`): an admit with its asker's skate and without one, and a
 * drawing with the skate it was drawn from and without one — the track gray, named on the legend as
 * the board names it, and nothing drawn where the server sent none.
 */
export const Tracks: Story = {
  render: () => (
    <ThemePair surface="admin" columns="one">
      {() => (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(20rem,1fr))] gap-(--space-4) p-(--space-4)">
          {(
            [
              ['admit-track', ADMIT_MATCH, ADMIT_MAP],
              ['admit-none', ADMIT_MATCH, ADMIT_MAP_NO_TRACK],
              ['drawn-track', DRAWN, DRAWN_MAP],
              ['drawn-none', DRAWN, DRAWN_MAP_NO_TRACK],
            ] as const
          ).map(([key, item, map]) => (
            <div key={key} data-case={key}>
              <ItemMapView
                item={item}
                state={{ map, pending: false }}
                timeZone="America/New_York"
                renderMap={still(320)}
              />
            </div>
          ))}
        </div>
      )}
    </ThemePair>
  ),
  play: async ({ canvasElement }) => {
    for (const q of canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')) {
      const box = (c: string) => must(q.querySelector<HTMLElement>(`[data-case="${c}"]`));
      await expect(box('admit-track').querySelector('[data-id="track:kd"]')).not.toBeNull();
      await expect(box('admit-track')).toHaveTextContent('Kate Donovan’s skate');
      await expect(box('admit-none').querySelector('[data-id^="track:"]')).toBeNull();
      await expect(box('admit-none')).not.toHaveTextContent('skate');
      await expect(box('drawn-track').querySelector('[data-id="track:kd-11oct"]')).not.toBeNull();
      await expect(box('drawn-track')).toHaveTextContent('The recorded skate · 11 Oct');
      await expect(box('drawn-none').querySelector('[data-id^="track:"]')).toBeNull();
      await expect(box('drawn-none')).not.toHaveTextContent('recorded skate');
    }
  },
};
