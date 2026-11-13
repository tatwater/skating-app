import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const convex = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
}));
vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  return {
    useQuery: (ref: Parameters<typeof getFunctionName>[0]) =>
      convex.results.get(getFunctionName(ref)),
    useMutation: (ref: Parameters<typeof getFunctionName>[0]) => {
      const name = getFunctionName(ref);
      const made = convex.mutations.get(name) ?? vi.fn(async () => null);
      convex.mutations.set(name, made);
      return made;
    },
  };
});
const role = vi.hoisted(() => ({ caps: new Set<string>() }));
vi.mock('@/lib/useRole', () => ({ useRole: () => ({ can: (c: string) => role.caps.has(c) }) }));
const undo = vi.hoisted(() => ({ announce: vi.fn(async () => {}) }));
vi.mock('@/components/admin/shell/undo', () => ({ useUndo: () => undo }));
const archive = vi.hoisted(() => ({
  value: { timeline: null, loading: false, season: null, error: false, index: null } as Record<
    string,
    unknown
  >,
  calls: [] as unknown[],
}));
vi.mock('@/components/useFreezeUpTimeline', () => ({
  useFreezeUpTimeline: (args: unknown) => {
    archive.calls.push(args);
    return archive.value;
  },
}));

import type { Id } from '@skating/convex/dataModel';
import { ConvexError } from 'convex/values';
import { IMAGERY_TAB, ImageryDock, ImageryTab } from './ImageryTab';
import { granuleOf, MASCOMA_STOPS } from './imageryFixtures';

const BODY = 'k1' as Id<'waterBodies'>;
const MASCOMA = {
  _id: BODY,
  name: 'Mascoma Lake',
  states: ['NH'],
  interiorPoint: { lat: 43.6174, lng: -72.136 },
  surfaceAreaSqM: 4_620_000,
};

beforeEach(() => {
  convex.results.clear();
  convex.mutations.clear();
  undo.announce.mockClear();
  archive.calls = [];
  archive.value = {
    timeline: { stops: MASCOMA_STOPS, season: 'winter-2026-27' },
    loading: false,
    season: 'winter-2026-27',
    error: false,
    index: { frames: [{ band: 'visual' }, { band: 'vh' }] },
  };
  role.caps = new Set(['body.water']);
});

describe('ImageryTab', () => {
  it('draws nothing until the body lands, and asks the archive nothing for an unlisted one', () => {
    const { container, rerender } = render(<ImageryTab bodyId={BODY} />);
    expect(container).toBeEmptyDOMElement();
    convex.results.set('waterBodies:get', { available: false });
    rerender(<ImageryTab bodyId={BODY} />);
    expect(container).toBeEmptyDOMElement();
    expect(archive.calls.at(-1)).toEqual({ body: null, band: 'visual', enabled: false });
  });

  it('reads the app’s own timeline: the season, the passes, no call without a writer', () => {
    convex.results.set('waterBodies:get', { available: true, body: MASCOMA });
    render(<ImageryTab bodyId={BODY} />);
    expect(screen.getByText('Winter 2026–27')).toBeVisible();
    expect(screen.getAllByRole('row')).toHaveLength(8);
    expect(screen.queryByRole('button', { name: /skaters/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Copernicus Browser/ }).getAttribute('href')).toMatch(
      /^https:\/\/browser\.dataspace\.copernicus\.eu\//,
    );
  });

  it('sets the satellite link and announces it to Undo', async () => {
    convex.results.set('waterBodies:get', { available: true, body: MASCOMA });
    render(<ImageryTab bodyId={BODY} />);
    await userEvent.click(screen.getByRole('button', { name: 'Always offer' }));
    expect(convex.mutations.get('waterBodies:setSatelliteImagery')).toHaveBeenCalledWith({
      waterBodyId: BODY,
      mode: 'on',
    });
    expect(undo.announce).toHaveBeenCalledWith({
      title: 'Satellite link set',
      target: { targetType: 'waterbody', targetId: BODY },
    });
  });

  it('a refused satellite write reads in the server’s words and announces nothing', async () => {
    convex.results.set('waterBodies:get', { available: true, body: MASCOMA });
    convex.mutations.set(
      'waterBodies:setSatelliteImagery',
      vi.fn(async () => {
        throw new ConvexError('Water body not found');
      }),
    );
    render(<ImageryTab bodyId={BODY} />);
    await userEvent.click(screen.getByRole('button', { name: 'Never' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Water body not found');
    expect(undo.announce).not.toHaveBeenCalled();
  });

  it('a viewer without body.water reads the choice and can’t change it', () => {
    role.caps = new Set();
    convex.results.set('waterBodies:get', { available: true, body: MASCOMA });
    render(<ImageryTab bodyId={BODY} />);
    expect(screen.getByRole('button', { name: 'Never' })).toHaveAttribute('data-disabled');
  });

  it('the dock and the inspector share the lit pass when the frame holds it', async () => {
    convex.results.set('waterBodies:get', { available: true, body: MASCOMA });
    const onLitChange = vi.fn();
    render(
      <>
        <ImageryTab bodyId={BODY} lit={`pass:visual.${granuleOf(10)}`} onLitChange={onLitChange} />
        <ImageryDock bodyId={BODY} lit={`pass:visual.${granuleOf(10)}`} onLitChange={onLitChange} />
      </>,
    );
    const card = document.querySelector('[data-slot="pass-card"]') as HTMLElement;
    expect(within(card).getByText('10 Oct')).toBeVisible();
    expect(screen.getByRole('slider', { name: 'Pass' })).toHaveAttribute('aria-valuenow', '5');
    // The season published two bands: the switch offers both.
    expect(screen.getByRole('button', { name: 'Radar' })).toBeVisible();
    await userEvent.click(within(card).getByRole('button', { name: /Previous/ }));
    expect(onLitChange).toHaveBeenCalledWith(`pass:visual.${granuleOf(8)}`);
    // A new band opens on its own default pass, and the address carries it.
    await userEvent.click(screen.getByRole('button', { name: 'Radar' }));
    expect(onLitChange).toHaveBeenLastCalledWith('pass:vh');
  });

  it('registers its wiring and its map; the map reads the default band and keeps its identity', () => {
    convex.results.set('waterBodies:get', { available: true, body: MASCOMA });
    const seen: unknown[] = [];
    function Probe() {
      seen.push(IMAGERY_TAB.map?.useData(BODY, null));
      return null;
    }
    const { rerender } = render(<Probe />);
    rerender(<Probe />);
    expect(seen[0]).toBeDefined();
    expect(seen[1]).toBe(seen[0]);
    expect(IMAGERY_TAB.Wiring).toBe(ImageryTab);
    const scene = IMAGERY_TAB.map?.describe(seen[0] as never, null);
    expect(scene?.lit).toBe(`pass:visual.${granuleOf(13)}`);
    expect(scene?.layers).toEqual({ aerial: true });
  });

  it('the dock keeps its own pass and band when the frame doesn’t hold them, and waits for the archive', async () => {
    convex.results.set('waterBodies:get', { available: true, body: MASCOMA });
    const { rerender } = render(<ImageryDock bodyId={BODY} />);
    const slider = screen.getByRole('slider', { name: 'Pass' });
    expect(slider).toHaveAttribute('aria-valuenow', '7');
    slider.focus();
    await userEvent.keyboard('{Home}');
    expect(slider).toHaveAttribute('aria-valuenow', '1');
    await userEvent.click(screen.getByRole('button', { name: 'Radar' }));
    expect(archive.calls.at(-1)).toMatchObject({ band: 'vh', enabled: true });
    archive.value = { ...archive.value, timeline: null, index: null };
    rerender(<ImageryDock bodyId={BODY} />);
    expect(screen.queryByRole('slider')).toBeNull();
  });
});
