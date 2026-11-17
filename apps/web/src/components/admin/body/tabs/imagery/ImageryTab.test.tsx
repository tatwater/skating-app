import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubJsdomAnimations } from '../jsdomStubs';

const convex = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
}));
vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  return {
    useQueries: (
      queries: Record<string, { query: Parameters<typeof getFunctionName>[0]; args: unknown }>,
    ) =>
      Object.fromEntries(
        Object.entries(queries).map(([k, q]) => [k, convex.results.get(getFunctionName(q.query))]),
      ),
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
const toasts = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('@/components/kit/toast', async (original) => ({
  ...(await original<typeof import('@/components/kit/toast')>()),
  toast: (t: Record<string, unknown>) => toasts.push(t),
}));
const archive = vi.hoisted(() => ({
  value: { timeline: null, loading: false, season: null, error: false, index: null } as Record<
    string,
    unknown
  >,
  calls: [] as unknown[],
  /** The timeline as it answers each call, when a test drives it by the call (else `value`). */
  respond: null as ((args: { enabled: boolean }) => Record<string, unknown>) | null,
}));
const where = vi.hoisted(() => ({ archiveUrl: 'https://archive.example' }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, key) =>
        key === 'imageryArchiveUrl' ? where.archiveUrl : Reflect.get(target, key),
    }),
  };
});
vi.mock('@/components/useFreezeUpTimeline', () => ({
  useFreezeUpTimeline: (args: { enabled: boolean }) => {
    archive.calls.push(args);
    return archive.respond?.(args) ?? archive.value;
  },
}));

import type { Id } from '@skating/convex/dataModel';
import { ConvexError } from 'convex/values';
import { resetConsoleReads } from '@/components/admin/reads/consoleReads';
import { BodyTabHost } from '../../frame/BodyConsoleRoute';
import { IMAGERY_TAB, ImageryDock, ImageryTab } from './ImageryTab';
import { granuleOf, MASCOMA_STOPS } from './imageryFixtures';

beforeAll(stubJsdomAnimations);

const BODY = 'k1' as Id<'waterBodies'>;
const MASCOMA = {
  _id: BODY,
  name: 'Mascoma Lake',
  states: ['NH'],
  interiorPoint: { lat: 43.6174, lng: -72.136 },
  surfaceAreaSqM: 4_620_000,
};

beforeEach(() => {
  resetConsoleReads();
  where.archiveUrl = 'https://archive.example';
  convex.results.clear();
  convex.mutations.clear();
  undo.announce.mockClear();
  archive.calls = [];
  archive.respond = null;
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
  it('holds its place until the body lands, and asks the archive nothing for an unlisted one', () => {
    const { container, rerender } = render(<ImageryTab bodyId={BODY} />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    convex.results.set('waterBodies:get', new Error('boom'));
    rerender(<ImageryTab bodyId={BODY} />);
    expect(screen.getByText('This body couldn’t be read')).toBeVisible();
    convex.results.set('waterBodies:get', { available: false });
    rerender(<ImageryTab bodyId={BODY} />);
    expect(container).toBeEmptyDOMElement();
    expect(archive.calls.at(-1)).toEqual({ body: null, band: 'visual', enabled: false });
  });

  it('reads the app’s own timeline: the season, the passes; the call is drawn, not available yet', () => {
    convex.results.set('waterBodies:get', { available: true, body: MASCOMA });
    render(<ImageryTab bodyId={BODY} />);
    expect(screen.getByText('Winter 2026–27')).toBeVisible();
    expect(screen.getAllByRole('row')).toHaveLength(8);
    expect(screen.getByRole('button', { name: /Hide from skaters/ })).toHaveAttribute(
      'data-unavailable',
    );
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

  it('a refused satellite write is one toast naming what failed, prints nothing, and announces nothing', async () => {
    toasts.length = 0;
    convex.results.set('waterBodies:get', { available: true, body: MASCOMA });
    convex.mutations.set(
      'waterBodies:setSatelliteImagery',
      vi.fn(async () => {
        throw new ConvexError('Water body not found');
      }),
    );
    render(<ImageryTab bodyId={BODY} />);
    await userEvent.click(screen.getByRole('button', { name: 'Never' }));
    await waitFor(() =>
      expect(toasts).toEqual([
        expect.objectContaining({
          description: 'The satellite link: Water body not found',
          tone: 'bad',
          timeout: 0,
        }),
      ]),
    );
    expect(screen.queryByRole('alert')).toBeNull();
    // The server still holds Auto: the control shows it.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(undo.announce).not.toHaveBeenCalled();
  });

  it('a viewer without body.water reads the choice and can’t change it, and has no call', () => {
    role.caps = new Set();
    convex.results.set('waterBodies:get', { available: true, body: MASCOMA });
    render(<ImageryTab bodyId={BODY} />);
    expect(screen.getByRole('button', { name: 'Never' })).toHaveAttribute('data-disabled');
    expect(screen.queryByRole('button', { name: /skaters/ })).toBeNull();
  });

  it('while the archive is on its way the card holds its place; without an address it says so', () => {
    convex.results.set('waterBodies:get', { available: true, body: MASCOMA });
    archive.value = { ...archive.value, timeline: null, index: null, season: null, loading: true };
    const { rerender } = render(<ImageryTab bodyId={BODY} />);
    expect(document.querySelector('[data-slot="passes-loading"]')).not.toBeNull();
    expect(screen.queryByText(/No satellite pass/)).toBeNull();
    where.archiveUrl = '';
    rerender(<ImageryTab bodyId={BODY} />);
    expect(screen.getByText(/No imagery archive is set up for this deployment/)).toBeVisible();
  });

  it('an archive that couldn’t be read says so; Try again asks it afresh', async () => {
    convex.results.set('waterBodies:get', { available: true, body: MASCOMA });
    archive.value = { ...archive.value, timeline: null, index: null, error: true };
    render(<ImageryTab bodyId={BODY} />);
    expect(
      screen.getByText(
        'The imagery archive couldn’t be read. That is about the archive, not the lake.',
      ),
    ).toBeVisible();
    archive.calls = [];
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    // The paused commit lets go of the archive (disabled), then it is enabled again.
    await vi.waitFor(() =>
      expect(archive.calls.some((c) => (c as { enabled: boolean }).enabled === false)).toBe(true),
    );
    await vi.waitFor(() => expect(archive.calls.at(-1)).toMatchObject({ enabled: true }));
  });

  it('holds the archive’s note as Trying again… until its fresh answer lands', async () => {
    convex.results.set('waterBodies:get', { available: true, body: MASCOMA });
    archive.value = { ...archive.value, timeline: null, index: null, error: true };
    const { rerender } = render(<ImageryTab bodyId={BODY} />);
    const note = document.querySelector('[data-slot="archive-failed"]') as HTMLElement;
    // As the timeline does: let go of (disabled), then asked afresh, its failure cleared, loading.
    let letGo = false;
    archive.respond = ({ enabled }) => {
      if (!enabled) letGo = true;
      return letGo && enabled ? { ...archive.value, error: false, loading: true } : archive.value;
    };
    await userEvent.click(within(note).getByRole('button', { name: 'Try again' }));
    await vi.waitFor(() => expect(archive.calls.at(-1)).toMatchObject({ enabled: true }));
    rerender(<ImageryTab bodyId={BODY} />);
    // The note held where it stood through the fresh ask.
    expect(document.querySelector('[data-slot="archive-failed"]')).toBe(note);
    expect(within(note).getByRole('button', { name: 'Trying again…' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    // The fresh answer is a failure again: the note offers Try again once more.
    archive.respond = null;
    archive.value = { ...archive.value, error: true, loading: false };
    rerender(<ImageryTab bodyId={BODY} />);
    expect(within(note).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('a retried archive that answers draws its passes, the note gone', async () => {
    convex.results.set('waterBodies:get', { available: true, body: MASCOMA });
    const answered = archive.value;
    archive.value = { ...archive.value, timeline: null, index: null, error: true };
    const { rerender } = render(<ImageryTab bodyId={BODY} />);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await vi.waitFor(() => expect(archive.calls.at(-1)).toMatchObject({ enabled: true }));
    archive.value = { ...answered, loading: true };
    rerender(<ImageryTab bodyId={BODY} />);
    archive.value = answered;
    rerender(<ImageryTab bodyId={BODY} />);
    expect(screen.queryByText(/The imagery archive couldn’t be read/)).toBeNull();
    expect(screen.getAllByRole('row')).toHaveLength(8);
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

  describe('a switch to another body that is already read', () => {
    const OTHER = 'k2' as Id<'waterBodies'>;

    it('a write started on one body still lands after the switch, and its receipt names that body', async () => {
      convex.results.set('waterBodies:get', { available: true, body: MASCOMA });
      let land: () => void = () => {};
      convex.mutations.set(
        'waterBodies:setSatelliteImagery',
        vi.fn(
          () =>
            new Promise((resolve) => {
              land = () => resolve(null);
            }),
        ),
      );
      const { rerender } = render(
        <BodyTabHost Wiring={ImageryTab} name="Mascoma Lake" bodyId={BODY} />,
      );
      await userEvent.click(screen.getByRole('button', { name: 'Always offer' }));
      convex.results.set('waterBodies:get', {
        available: true,
        body: { ...MASCOMA, _id: OTHER, name: 'Crystal Lake' },
      });
      rerender(<BodyTabHost Wiring={ImageryTab} name="Crystal Lake" bodyId={OTHER} />);
      land();
      await new Promise((r) => setTimeout(r, 0));
      // Pressed is committed: it lands on its own body, and its receipt says whose it was.
      expect(undo.announce).toHaveBeenCalledTimes(1);
      expect(undo.announce).toHaveBeenCalledWith(
        expect.objectContaining({ subject: 'Mascoma Lake' }),
      );
      expect(screen.queryByRole('alert')).toBeNull();
      expect(convex.mutations.get('waterBodies:setSatelliteImagery')).toHaveBeenCalledTimes(1);
    });
  });

  it('the satellite link, once the record holds the mode it sent, writes nothing more for that mode', async () => {
    // `setSatelliteImagery` patches the body's `satelliteImagery` (absent for auto).
    convex.results.set('waterBodies:get', { available: true, body: MASCOMA });
    convex.mutations.set(
      'waterBodies:setSatelliteImagery',
      vi.fn(async (args: { mode: string }) => {
        convex.results.set('waterBodies:get', {
          available: true,
          body: { ...MASCOMA, ...(args.mode === 'auto' ? {} : { satelliteImagery: args.mode }) },
        });
        return null;
      }),
    );
    const { rerender } = render(<ImageryTab bodyId={BODY} />);
    await userEvent.click(screen.getByRole('button', { name: 'Always offer' }));
    rerender(<ImageryTab bodyId={BODY} />);
    await userEvent.click(screen.getByRole('button', { name: 'Always offer' }));
    expect(convex.mutations.get('waterBodies:setSatelliteImagery')).toHaveBeenCalledTimes(1);
  });
});
