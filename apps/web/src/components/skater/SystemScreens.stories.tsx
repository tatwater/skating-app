import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';

import { must } from '../kit/storyKit';
import {
  BACKDROP_FILL,
  BACKDROP_UNDER_TOP_BAR,
  CrashView,
  NotFoundView,
  OfflinePlate,
  OfflineView,
  SplashView,
} from './SystemScreens';
import { SkaterPair, StoryRegion } from './storySupport';

/** Row 8's system screens (8.10–8.14, 8.17), on the region. `RegionBackdrop` is stood in for here. */
const meta = {
  title: 'Skater/System screens',
  component: CrashView,
  globals: { surface: 'skater', mode: 'light' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof CrashView>;

export default meta;
type Story = StoryObj<typeof meta>;

const fill = <StoryRegion className={BACKDROP_FILL} />;
const AT = new Date('2027-01-16T14:42:00Z').getTime();

async function cardChecks(root: HTMLElement) {
  for (const q of root.querySelectorAll<HTMLElement>('[data-theme-scope]')) {
    const card = must(q.querySelector<HTMLElement>('[data-slot="system-message"]'));
    await expect(getComputedStyle(card).borderRadius).toBe('0px');
    await expect(card.getBoundingClientRect().width).toBe(440);
    // Centered on the stage.
    const s = must(
      q.querySelector<HTMLElement>('[data-slot="system-stage"]'),
    ).getBoundingClientRect();
    const c = card.getBoundingClientRect();
    await expect(Math.abs(c.left + c.width / 2 - (s.left + s.width / 2))).toBeLessThanOrEqual(1);
    await expect(Math.abs(c.top + c.height / 2 - (s.top + s.height / 2))).toBeLessThanOrEqual(1);
  }
}

/** 8.11: something broke. */
export const SomethingBroke: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="40rem">
      {() => <CrashView backdrop={fill} onRetry={() => {}} onReload={() => {}} />}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    await cardChecks(canvasElement);
    const q = must(canvasElement.querySelector<HTMLElement>('[data-theme-scope]'));
    await expect(within(q).getByRole('heading', { name: 'Something broke' })).toBeInTheDocument();
    await expect(within(q).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  },
};

/** 8.12: a first load that never reached the server. */
export const OfflineFirstLoad: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="40rem">
      {() => <OfflineView backdrop={fill} lastTriedAt={AT} onRetry={() => {}} />}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    await cardChecks(canvasElement);
    await expect(within(canvasElement).getAllByText(/says nothing about the ice/)).toHaveLength(2);
  },
};

/** 8.14: not found, under the top bar (drawn here as a stand-in bar), the region running past every edge. */
export const NotFound: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="40rem">
      {() => (
        <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
          <div className="relative z-1 h-top border-0 border-b border-solid border-line bg-bg" />
          <div className="relative min-h-0">
            <NotFoundView
              backdrop={<StoryRegion className={BACKDROP_UNDER_TOP_BAR} />}
              address="/water/mascoma-lake-north"
              onBack={() => {}}
            />
          </div>
        </div>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    await cardChecks(canvasElement);
    const q = must(canvasElement.querySelector<HTMLElement>('[data-theme-scope]'));
    await expect(
      q.querySelector('[data-slot="system-stage"] > img + img, [data-slot="system-stage"] > img'),
    ).not.toBeNull();
    await expect(within(q).queryByAltText('Gli')).toBeNull();
  },
};

/** 8.13 / 8.17: offline mid-session — the page stays (a stand-in here), one plate over the map. */
export const OfflineOverExplore: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="20rem">
      {() => (
        <div className="relative flex h-full">
          <div className="w-(--size-sidebar) shrink-0 border-0 border-r border-solid border-line bg-bg" />
          <div className="flex-1 bg-raise" />
          <OfflinePlate
            since={AT}
            onRetry={() => {}}
            className="absolute top-(--space-4) left-[calc(var(--size-sidebar)+(100%-var(--size-sidebar))/2)] -translate-x-1/2"
          />
        </div>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    for (const q of canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')) {
      const plate = must(q.querySelector<HTMLElement>('[data-slot="offline-plate"]'));
      await expect(getComputedStyle(plate).borderRadius).toBe('0px');
      await expect(getComputedStyle(plate).borderLeftWidth).toBe('2px');
      await expect(within(plate).getByText(/What’s on screen is from/)).toBeInTheDocument();
    }
  },
};

/** 8.10: loading — the kit's seven cells, filling middle-out (1, 3, 5, 7, starting with the 4th). */
export const Loading: Story = {
  args: {} as never,
  render: () => <SkaterPair height="30rem">{() => <SplashView backdrop={fill} />}</SkaterPair>,
  play: async ({ canvasElement }) => {
    const loader = within(canvasElement).getAllByRole('progressbar', {
      name: 'Loading',
    })[0] as HTMLElement;
    const lit = () =>
      [...loader.querySelectorAll('[data-slot="cell"]')].map((c) => c.hasAttribute('data-lit'));
    const seen = new Set<string>();
    await waitFor(
      () => {
        seen.add(lit().map(Number).join(''));
        expect(seen.has('0011100')).toBe(true);
      },
      { timeout: 4000 },
    );
    // Every frame is a run centered on the 4th cell.
    for (const frame of seen)
      await expect(['0000000', '0001000', '0011100', '0111110', '1111111']).toContain(frame);
    const cell = must(
      loader.querySelector<HTMLElement>('[data-slot="cell"]'),
    ).getBoundingClientRect();
    await expect(cell.width).toBe(22);
    await expect(cell.height).toBe(6);
  },
};
