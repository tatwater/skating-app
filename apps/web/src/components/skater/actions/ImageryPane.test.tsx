import type { TimelineStop } from '@skating/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSkaterMapStore } from '@/stores/skaterMapStore';

import { convexReact, fakes, resetFakes } from '../testMocks';

const hooks = vi.hoisted(() => ({
  timeline: {
    timeline: null as null | { season: string; stops: unknown[] },
    loading: false,
    season: null as string | null,
    error: false,
    index: null,
  },
  frames: [] as Array<{ frame: unknown; slot?: string }>,
  seams: [] as unknown[],
  env: { imageryArchiveUrl: 'https://archive.example' },
  prefetch: vi.fn(async () => {}),
}));

vi.mock('convex/react', () => convexReact);
vi.mock('@/lib/analytics', async (load) => ({
  ...(await load<typeof import('@/lib/analytics')>()),
  useAnalytics: () => ({ capture: fakes.capture }),
}));
vi.mock('@/lib/env', () => ({ env: hooks.env }));
vi.mock('../../useFreezeUpTimeline', () => ({ useFreezeUpTimeline: () => hooks.timeline }));
vi.mock('../../useFreezeUpFrame', () => ({
  useFreezeUpFrame: (args: { frame: unknown; slot?: string }) => hooks.frames.push(args),
}));
vi.mock('../../useFreezeUpSeam', () => ({
  useFreezeUpSeam: (args: unknown) => hooks.seams.push(args),
}));
vi.mock('@skating/core', async (load) => ({
  ...(await load<typeof import('@skating/core')>()),
  prefetchFrames: hooks.prefetch,
}));

import { ImageryPane } from './ImageryPane';
import { captionOf, dayStep, tickAt } from './ImageryTimeline';

const DAY = 86_400_000;
const START = Date.UTC(2026, 10, 16, 15, 30);
function stop(dayOffset: number, landable: boolean, band = 'visual'): TimelineStop {
  return {
    frame: {
      granuleId: `g${dayOffset}`,
      capturedAt: new Date(START + dayOffset * DAY).toISOString(),
      cloudCoverPct: landable ? 3 : 94,
      bodies: 1,
      band,
      key: `k${dayOffset}`,
      footprint: { type: 'Polygon', coordinates: [] },
    } as unknown as TimelineStop['frame'],
    landable,
    basis: 'inferred',
    ...(landable ? {} : { blockedBy: 'cloud' as const }),
  };
}
const STOPS = [stop(0, false), stop(1, true), stop(4, true), stop(9, false), stop(12, true)];

beforeEach(() => {
  resetFakes();
  Element.prototype.animate ??= (() => ({ cancel: () => {} })) as unknown as Element['animate'];
  hooks.env.imageryArchiveUrl = 'https://archive.example';
  hooks.timeline = {
    timeline: { season: 'winter-2026-27', stops: STOPS },
    loading: false,
    season: 'winter-2026-27',
    error: false,
    index: null,
  };
  hooks.frames = [];
  hooks.prefetch.mockClear();
  fakes.queries.set('waterBodies:get', {
    available: true,
    body: { _id: 'mascoma', polygon: { type: 'Polygon', coordinates: [] } },
  });
  useSkaterMapStore.setState({ specs: { view: null, flow: null } });
});

function mount(props: Partial<Parameters<typeof ImageryPane>[0]> = {}) {
  const onSearch = vi.fn();
  const utils = render(<ImageryPane waterBodyId="mascoma" onSearch={onSearch} {...props} />);
  return { ...utils, onSearch };
}

describe('true color (3.14)', () => {
  it('opens on the latest usable pass, paints it, and stands the contours down', () => {
    const { unmount } = mount();
    const slider = screen.getByRole('slider', { name: 'Freeze-up timeline' });
    expect(slider).toHaveAttribute('aria-valuenow', '4');
    expect(
      screen.getByText(/Sentinel-2 true color — 3% cloud over the region/),
    ).toBeInTheDocument();
    expect(hooks.frames.at(-2)).toMatchObject({ frame: { key: 'k12' } });
    // Contours stand down: in the flow spec, and the map's imagery switch (in memory only).
    expect(useSkaterMapStore.getState().specs.flow).toMatchObject({ id: 'imagery' });
    expect(useSkaterMapStore.getState().specs.flow?.layers.depth).toBe(false);
    expect(useSkaterMapStore.getState().layers.imagery).toBe(true);
    expect(hooks.prefetch).toHaveBeenCalledWith(
      'https://archive.example',
      ['k0', 'k1', 'k4', 'k9', 'k12'],
      expect.anything(),
    );
    // Tall ticks for usable days, short for hidden ones.
    const ticks = [...document.querySelectorAll('[data-tick]')].map((t) =>
      t.getAttribute('data-tick'),
    );
    expect(ticks).toEqual(['short', 'tall', 'tall', 'short', 'tall']);
    expect(screen.getByText(/true color can’t tell them apart/)).toBeInTheDocument();
    expect(screen.getByText('Copernicus Sentinel data 2026–2027')).toBeInTheDocument();
    unmount();
    expect(useSkaterMapStore.getState().layers.imagery).toBe(false);
    expect(useSkaterMapStore.getState().specs.flow).toBeNull();
  });

  it('the URL’s day is the one shown', () => {
    mount({ frame: '2026-11-20' });
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '2');
  });

  it('the keys step between usable days and write the day to the URL', async () => {
    const user = userEvent.setup();
    const { onSearch } = mount({ frame: '2026-11-20' });
    screen.getByRole('slider').focus();
    await user.keyboard('{ArrowLeft}');
    expect(onSearch).toHaveBeenLastCalledWith({ frame: '2026-11-17' });
    await user.keyboard('{ArrowRight}');
    expect(onSearch).toHaveBeenLastCalledWith({ frame: '2026-11-28' });
    await user.keyboard('{Home}');
    expect(onSearch).toHaveBeenLastCalledWith({ frame: '2026-11-17' });
    await user.keyboard('{End}');
    expect(onSearch).toHaveBeenLastCalledWith({ frame: '2026-11-28' });
    onSearch.mockClear();
    await user.keyboard('{ArrowUp}a');
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('hovering a hidden day says why; a click on it lands on the nearest usable day', () => {
    const { onSearch } = mount();
    const slider = screen.getByRole('slider');
    slider.getBoundingClientRect = () => ({ left: 0 }) as DOMRect;
    fireEvent.pointerMove(slider, { clientX: 4 });
    expect(screen.getByRole('tooltip')).toHaveTextContent('Nov 16 · Too cloudy to show');
    fireEvent.click(slider, { clientX: 4 });
    expect(onSearch).toHaveBeenLastCalledWith({ frame: '2026-11-17' });
    fireEvent.pointerLeave(slider);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('radar (3.15)', () => {
  it('switching keeps the day, counts the band, and draws no short tick', () => {
    const { onSearch, rerender } = mount({ frame: '2026-11-20' });
    fireEvent.click(screen.getByRole('button', { name: 'Sentinel-1 radar (VH)' }));
    expect(fakes.capture).toHaveBeenCalledWith('imagery_opened', { band: 'vh' });
    expect(onSearch).toHaveBeenLastCalledWith({ band: 'vh', frame: '2026-11-20' });
    hooks.timeline = {
      ...hooks.timeline,
      timeline: {
        season: 'winter-2026-27',
        stops: [stop(0, true, 'vh'), stop(3, false, 'vh'), stop(6, true, 'vh')],
      },
    };
    rerender(
      <ImageryPane waterBodyId="mascoma" onSearch={onSearch} band="vh" frame="2026-11-20" />,
    );
    const ticks = [...document.querySelectorAll('[data-tick]')].map((t) =>
      t.getAttribute('data-tick'),
    );
    expect(ticks).toEqual(['tall', 'tall']);
    expect(screen.getByText('Smooth ice — or open water')).toBeInTheDocument();
    // Back to true color drops the band param; the chosen band again is a no-op.
    fireEvent.click(screen.getByRole('button', { name: 'Sentinel-1 radar (VH)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sentinel-2 true color' }));
    expect(onSearch).toHaveBeenLastCalledWith({ band: null, frame: '2026-11-22' });
  });
});

describe('the honest states', () => {
  it('no archive configured', () => {
    hooks.env.imageryArchiveUrl = '';
    mount();
    expect(screen.getByText('Imagery isn’t available here yet.')).toBeInTheDocument();
    expect(hooks.prefetch).not.toHaveBeenCalled();
  });

  it('an unreadable archive is about the archive, not the lake', () => {
    hooks.timeline = { ...hooks.timeline, error: true };
    mount();
    expect(screen.getByText(/Couldn’t read the imagery archive/)).toBeInTheDocument();
  });

  it('loading, then no passes at all', () => {
    hooks.timeline = { ...hooks.timeline, timeline: null, season: null };
    const { rerender, onSearch } = mount();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    hooks.timeline = { ...hooks.timeline, timeline: { season: 's', stops: [] }, loading: true };
    rerender(<ImageryPane waterBodyId="mascoma" onSearch={onSearch} />);
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    hooks.timeline = { ...hooks.timeline, loading: false };
    rerender(<ImageryPane waterBodyId="mascoma" onSearch={onSearch} />);
    expect(
      screen.getByText('No satellite passes recorded over this lake this season.'),
    ).toBeInTheDocument();
  });

  it('every pass hidden: the track still draws, nothing is chosen', () => {
    hooks.timeline = {
      ...hooks.timeline,
      timeline: { season: 's', stops: [stop(0, false), stop(2, false)] },
    };
    const { onSearch } = mount();
    expect(screen.getByText('No usable picture this season.')).toBeInTheDocument();
    screen.getByRole('slider').focus();
    act(() => {
      fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' });
    });
    expect(onSearch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('slider'), { clientX: 0 });
    expect(onSearch).not.toHaveBeenCalled();
  });

  it('a delisted lake reads as no lake', () => {
    fakes.queries.set('waterBodies:get', { available: false });
    mount();
    expect(screen.getByRole('slider')).toBeInTheDocument();
  });
});

describe('the track’s geometry', () => {
  it('fits the days to the width, capped', () => {
    expect(dayStep(372, 1)).toBe(0);
    expect(dayStep(372, 62)).toBeCloseTo(6.0, 1);
    expect(dayStep(372, 5)).toBe(12);
    expect(tickAt([], 10, 6)).toBeNull();
  });

  it('captions without a caveat when nothing was in the way', () => {
    const clear = {
      ...stop(1, true),
      frame: { ...stop(1, true).frame, cloudCoverPct: null },
    } as TimelineStop;
    expect(captionOf(clear)).toEqual({ date: 'Nov 17, 2026', rest: 'Sentinel-2 true color' });
  });
});
