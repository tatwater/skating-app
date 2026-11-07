import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConvexError } from 'convex/values';
import type maplibregl from 'maplibre-gl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useHazardDraftStore } from '@/stores/hazardDraftStore';
import { effectiveMapSpec, useSkaterMapStore } from '@/stores/skaterMapStore';

import { activeMapHandlers, publishMapInstance } from '../map/useMapSpec';
import { convexReact, fakes, resetFakes } from '../testMocks';

const draw = vi.hoisted(() => ({
  control: {
    startDrawing: vi.fn(),
    startEditing: vi.fn(),
    stopDrawing: vi.fn(),
    setPolygon: vi.fn(),
    clear: vi.fn(),
    destroy: vi.fn(),
  },
  onChange: null as null | ((p: GeoJSON.Polygon | null) => void),
  fail: false,
}));

const auth = vi.hoisted(() => ({
  isLoaded: true,
  isSignedIn: true as boolean,
  userId: 'me' as string | null,
}));
vi.mock('@clerk/tanstack-react-start', () => ({ useAuth: () => auth }));
vi.mock('convex/react', () => convexReact);
vi.mock('@/lib/analytics', async (load) => ({
  ...(await load<typeof import('@/lib/analytics')>()),
  useAnalytics: () => ({ capture: fakes.capture }),
}));
vi.mock('@/lib/polygonDraw', () => ({
  createPolygonDraw: vi.fn(async (_map: unknown, options: { onChange: typeof draw.onChange }) => {
    if (draw.fail) throw new Error('chunk');
    draw.onChange = options.onChange;
    return draw.control;
  }),
}));
vi.mock('../../photoPipeline', () => ({
  processPhoto: vi.fn(async (file: File) => ({ full: file, thumb: file })),
  uploadToStorage: vi.fn(async () => 'storage_1'),
}));

import { useHazardDraftOwnerBinding } from '@/lib/hazardDraftOwner';

import { HazardFlow } from './HazardFlow';

/** The skater layout's binding, which the flow waits on. */
function Binding() {
  useHazardDraftOwnerBinding();
  return null;
}

// A square lake around Mascoma's middle, outline in lng/lat.
const RING = [
  [-72.16, 43.62],
  [-72.14, 43.62],
  [-72.14, 43.64],
  [-72.16, 43.64],
  [-72.16, 43.62],
];
const LAKE = {
  available: true,
  body: { _id: 'mascoma', name: 'Mascoma Lake', polygon: { type: 'Polygon', coordinates: [RING] } },
};

const initialDraftStore = useHazardDraftStore.getState();

beforeEach(() => {
  resetFakes();
  localStorage.clear();
  useHazardDraftStore.setState(
    {
      ...initialDraftStore,
      owner: null,
      bound: false,
      draft: null,
      restored: false,
      photoFiles: [],
    },
    true,
  );
  useSkaterMapStore.setState({ specs: { view: null, flow: null } });
  Object.assign(auth, { isLoaded: true, isSignedIn: true, userId: 'me' });
  fakes.queries.set('waterBodies:get', LAKE);
  fakes.queries.set('hazards:listForBody', []);
  draw.onChange = null;
  draw.fail = false;
  for (const fn of Object.values(draw.control)) fn.mockClear();
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview');
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => publishMapInstance(null, false));

const flowSpec = () => useSkaterMapStore.getState().specs.flow;

function mount(props: Partial<Parameters<typeof HazardFlow>[0]> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <>
      <Binding />
      <HazardFlow waterBodyId="mascoma" onClose={onClose} {...props} />
    </>,
  );
  return { ...utils, onClose };
}

const capture = (lat: number, lng: number) =>
  act(() => activeMapHandlers().onCapture?.({ lat, lng }));

describe('opening', () => {
  it('starts a fresh draft for the account and says where it came from', async () => {
    mount();
    await screen.findByRole('heading', { name: 'What did you see?' });
    expect(fakes.capture).toHaveBeenCalledWith('hazard_flow_started', { entry: 'water_body' });
    expect(useHazardDraftStore.getState().owner).toBe('me');
    expect(useHazardDraftStore.getState().draft).toMatchObject({
      waterBodyId: 'mascoma',
      stackedInReport: false,
    });
    // The flow's spec sits over the view's, the map not listening yet.
    expect(flowSpec()).toMatchObject({ id: 'hazard-flow', mode: null });
    expect(flowSpec()?.interactions.click).toBe('none');
    expect(effectiveMapSpec(useSkaterMapStore.getState().specs).id).toBe('hazard-flow');
  });

  it('waits for the account before opening', () => {
    Object.assign(auth, { isLoaded: false, isSignedIn: false, userId: null });
    mount();
    expect(screen.queryByRole('heading', { name: 'What did you see?' })).toBeNull();
    expect(flowSpec()?.id).toBe('hazard-flow');
  });

  it('brings this lake’s draft back, and says the photos didn’t come with it', async () => {
    localStorage.setItem(
      'gli-hazard-draft',
      JSON.stringify({
        owner: 'me',
        draft: {
          ...useHazardDraftStore.getState().draft,
          waterBodyId: 'mascoma',
          hazardType: 'thin_ice',
          drawKind: 'spot',
          shape: {
            geometryKind: 'point_radius',
            coord: { lat: 43.63, lng: -72.15 },
            radiusMeters: 25,
          },
          placing: true,
          note: 'soft by the point',
          photoCount: 2,
        },
      }),
    );
    mount();
    expect(
      await screen.findByText(/The 2 photos you added didn’t come with it/),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Anything worth adding?' })).toHaveValue(
      'soft by the point',
    );
    // A restored draft is never mid-placement.
    expect(flowSpec()?.mode).toBeNull();
  });

  it('a draft from another lake starts over', async () => {
    localStorage.setItem(
      'gli-hazard-draft',
      JSON.stringify({ owner: 'me', draft: { waterBodyId: 'crystal', hazardType: 'thin_ice' } }),
    );
    mount();
    await screen.findByRole('heading', { name: 'What did you see?' });
    expect(useHazardDraftStore.getState().draft).toMatchObject({
      waterBodyId: 'mascoma',
      hazardType: null,
    });
    expect(screen.queryByText(/didn’t come with it/)).toBeNull();
  });
});

describe('a spot, posted (3.1 → 3.2 → 3.7)', () => {
  it('places on one click, and posts the type, primitive and photo count', async () => {
    const create = vi.fn().mockResolvedValue('h_new');
    fakes.mutations.set('hazards:create', create);
    const { onClose } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Thin ice' }));
    expect(flowSpec()?.mode).toEqual({
      mode: 'Placing a spot',
      line: 'Click where it is',
      exitLabel: 'Close',
    });
    expect(flowSpec()?.interactions.click).toBe('capture');
    // Post sleeps until it's placed, and says why.
    expect(screen.getByRole('button', { name: 'Post hazard' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    capture(43.63, -72.15);
    expect(screen.getByText('Placed on the map.')).toBeInTheDocument();
    expect(flowSpec()?.mode).toBeNull();
    expect(flowSpec()?.overlays.draft).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Bigger' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Anything worth adding?' }), {
      target: { value: 'soft near the inlet' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Post hazard' }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      waterBodyId: 'mascoma',
      type: 'thin_ice',
      geometryKind: 'point_radius',
      description: 'soft near the inlet',
    });
    expect(fakes.capture).toHaveBeenCalledWith('hazard_reported', {
      hazard_type: 'thin_ice',
      geometry_kind: 'point_radius',
      photo_count: 0,
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(useHazardDraftStore.getState().draft).toBeNull();
  });

  it('uploads photos at Post and sends no location with them', async () => {
    const create = vi.fn().mockResolvedValue('h_new');
    const createPhoto = vi.fn().mockResolvedValue('p1');
    fakes.mutations.set('hazards:create', create);
    fakes.mutations.set('photos:create', createPhoto);
    fakes.mutations.set('photos:generateUploadUrl', vi.fn().mockResolvedValue('https://upload'));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Thin ice' }));
    capture(43.63, -72.15);
    const file = new File(['x'], 'ridge.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByTestId('hazard-photo-input'), { target: { files: [file] } });
    expect(screen.getByRole('button', { name: 'Remove ridge.jpg' })).toBeInTheDocument();
    const extra = new File(['y'], 'extra.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByTestId('hazard-photo-input'), { target: { files: [extra] } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove extra.jpg' }));
    fireEvent.change(screen.getByTestId('hazard-photo-input'), { target: { files: [] } });
    fireEvent.click(screen.getByRole('button', { name: 'Post hazard' }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(createPhoto).toHaveBeenCalledWith({
      storageId: 'storage_1',
      thumbStorageId: 'storage_1',
      placeOnMap: false,
    });
    expect(create.mock.calls[0]?.[0]).toMatchObject({ photoIds: ['p1'] });
    expect(fakes.capture).toHaveBeenCalledWith(
      'hazard_reported',
      expect.objectContaining({ photo_count: 1 }),
    );
  });

  it('a refused Post says so in amber and keeps the draft', async () => {
    fakes.mutations.set(
      'hazards:create',
      vi.fn().mockRejectedValue(new ConvexError('Minors cannot post')),
    );
    const { onClose } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Thin ice' }));
    capture(43.63, -72.15);
    fireEvent.click(screen.getByRole('button', { name: 'Post hazard' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Minors cannot post');
    expect(onClose).not.toHaveBeenCalled();
    expect(useHazardDraftStore.getState().draft).not.toBeNull();
  });

  it('a network failure reads as one', async () => {
    fakes.mutations.set('hazards:create', vi.fn().mockRejectedValue(new Error('offline')));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Thin ice' }));
    capture(43.63, -72.15);
    fireEvent.click(screen.getByRole('button', { name: 'Post hazard' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Check your connection/);
  });
});

describe('the nearby nudge (3.8)', () => {
  const NEARBY = {
    _id: 'h_old',
    type: 'thin_ice',
    geometryKind: 'point_radius',
    geometry: { type: 'Point', coordinates: [-72.15, 43.63] },
    radiusMeters: 25,
    bbox: { minLat: 43.6298, maxLat: 43.6302, minLng: -72.1503, maxLng: -72.1497 },
    firstReportedAt: Date.now() - 2 * 86_400_000,
    lastConfirmedAt: Date.now() - 2 * 86_400_000,
  };

  async function raise() {
    fakes.queries.set('hazards:listForBody', [NEARBY]);
    const utils = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Thin ice' }));
    capture(43.63, -72.15);
    fireEvent.click(screen.getByRole('button', { name: 'Post hazard' }));
    expect(await screen.findByText(/There is already a thin ice marked here/)).toBeInTheDocument();
    return utils;
  }

  it('confirming the one already here records that, not a second pin', async () => {
    const confirm = vi.fn().mockResolvedValue(null);
    fakes.mutations.set('hazardConfirmations:confirm', confirm);
    const create = vi.fn();
    fakes.mutations.set('hazards:create', create);
    const { onClose } = await raise();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm that one' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(confirm).toHaveBeenCalledWith({
      hazardId: 'h_old',
      verdict: 'still_there',
      via: 'duplicate_nudge',
    });
    expect(fakes.capture).toHaveBeenCalledWith('existing_hazard_confirmed', {
      confirmation_source: 'duplicate_nudge',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('a different hazard files in the same tap, carrying the answer', async () => {
    const create = vi.fn().mockResolvedValue('h_new');
    fakes.mutations.set('hazards:create', create);
    await raise();
    fireEvent.click(screen.getByRole('button', { name: 'No, this is a different hazard' }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]?.[0]).toMatchObject({ dismissedDuplicateOf: 'h_old' });
  });

  it('a failed confirm takes the nudge down and says so', async () => {
    fakes.mutations.set('hazardConfirmations:confirm', vi.fn().mockRejectedValue(new Error('x')));
    await raise();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm that one' }));
    expect(await screen.findByText(/File yours instead/)).toBeInTheDocument();
    expect(screen.queryByText(/There is already/)).toBeNull();
    expect(useHazardDraftStore.getState().draft?.step).toBe('details');
  });
});

describe('the other ways to draw', () => {
  it('a line: clicks append, undo steps back, Done leaves by a click', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Pressure ridge' }));
    expect(screen.getByRole('button', { name: 'Undo point' })).toBeDisabled();
    capture(43.628, -72.153);
    capture(43.629, -72.149);
    capture(43.6298, -72.146);
    expect(screen.getByText('Traced with 3 points.')).toBeInTheDocument();
    expect(flowSpec()?.mode?.step).toBe('3 points');
    fireEvent.click(screen.getByRole('button', { name: 'Undo point' }));
    expect(screen.getByText('Traced with 2 points.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(flowSpec()?.mode).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Keep tracing' }));
    expect(flowSpec()?.mode?.mode).toBe('Tracing a line');
  });

  it('an area: the drawing tool owns the map, its corners land, Done takes it off', async () => {
    const map = {} as maplibregl.Map;
    act(() => publishMapInstance(map, true));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Thin ice' }));
    fireEvent.click(screen.getByRole('button', { name: 'An area' }));
    // The map's own click stands down: terra-draw has it.
    expect(flowSpec()?.interactions.click).toBe('none');
    await waitFor(() => expect(draw.control.startDrawing).toHaveBeenCalled());
    act(() =>
      draw.onChange?.({
        type: 'Polygon',
        coordinates: [
          [
            [-72.1324, 43.6135],
            [-72.1285, 43.6128],
            [-72.1293, 43.6097],
            [-72.1324, 43.6135],
          ],
        ],
      }),
    );
    expect(screen.getByText('Drawn with 3 corners.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(draw.control.destroy).toHaveBeenCalled();
    // Adjusting hands the corners back for dragging.
    fireEvent.click(screen.getByRole('button', { name: 'Adjust corners' }));
    await waitFor(() => expect(draw.control.startEditing).toHaveBeenCalled());
    expect(draw.control.setPolygon).toHaveBeenCalled();
  });

  it('an area finished before its tool loads takes the tool down as it arrives', async () => {
    act(() => publishMapInstance({} as maplibregl.Map, true));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Thin ice' }));
    fireEvent.click(screen.getByRole('button', { name: 'An area' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(draw.control.destroy).toHaveBeenCalled());
    expect(draw.control.startDrawing).not.toHaveBeenCalled();
  });

  it('an area tool that fails to load leaves the other ways working', async () => {
    draw.fail = true;
    act(() => publishMapInstance({} as maplibregl.Map, true));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Thin ice' }));
    fireEvent.click(screen.getByRole('button', { name: 'An area' }));
    fireEvent.click(screen.getByRole('button', { name: 'A spot' }));
    expect(flowSpec()?.mode?.mode).toBe('Placing a spot');
  });

  it('along the shore: two clicks, then the toggle flips between the two ways round', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Open water / lead' }));
    fireEvent.click(screen.getByRole('button', { name: 'Along the shore' }));
    expect(flowSpec()?.mode?.mode).toBe('Along the shore');
    capture(43.62, -72.16);
    capture(43.62, -72.14);
    expect(screen.getByText(/^Following about [\d,]+ ft of shoreline\.$/)).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Long way around' });
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Shortest distance' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Narrower' }));
    expect(screen.getByText(/out from the shoreline/)).toBeInTheDocument();
  });

  it('a shore click far out on the ice is refused, in amber, with the way out', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Thin ice' }));
    fireEvent.click(screen.getByRole('button', { name: 'Along the shore' }));
    capture(43.62, -72.16);
    capture(43.7, -72.0);
    expect(screen.getByRole('alert')).toHaveTextContent(/close enough to the shore/);
  });

  it('the × goes back to every type', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Thin ice' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick a different type' }));
    expect(screen.getByRole('button', { name: 'Pressure ridge' })).toBeInTheDocument();
    expect(flowSpec()?.mode).toBeNull();
  });
});

describe('leaving', () => {
  it('Cancel discards the draft', async () => {
    const { onClose } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Thin ice' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(useHazardDraftStore.getState().draft).toBeNull();
  });

  it('the mode bar’s Esc closes the flow once, keeping the draft, mode off', async () => {
    const { onClose, unmount } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Thin ice' }));
    act(() => {
      activeMapHandlers().onExitMode?.();
      activeMapHandlers().onExitMode?.();
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(useHazardDraftStore.getState().draft).toMatchObject({
      hazardType: 'thin_ice',
      placing: false,
    });
    unmount();
    // The flow's spec goes with it, so the view's comes back.
    expect(flowSpec()).toBeNull();
  });

  it('a Post still in flight when the flow closes still clears the filed draft', async () => {
    let land: (id: string) => void = () => {};
    const create = vi.fn(() => new Promise<string>((resolve) => (land = resolve)));
    fakes.mutations.set('hazards:create', create);
    const onDone = vi.fn();
    const { onClose, unmount } = mount({ onDone });
    fireEvent.click(await screen.findByRole('button', { name: 'Thin ice' }));
    capture(43.63, -72.15);
    fireEvent.click(screen.getByRole('button', { name: 'Post hazard' }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    act(() => activeMapHandlers().onExitMode?.());
    expect(onClose).toHaveBeenCalledOnce();
    unmount();
    await act(async () => land('h_late'));
    // Never restores to be filed twice; the host that carries the result still hears of it.
    expect(useHazardDraftStore.getState().draft).toBeNull();
    expect(onDone).toHaveBeenCalledWith({ outcome: 'filed', hazardId: 'h_late' }, { open: false });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('an old Post that lands after a new draft started clears only its own draft', async () => {
    let land: (id: string) => void = () => {};
    const create = vi.fn(() => new Promise<string>((resolve) => (land = resolve)));
    fakes.mutations.set('hazards:create', create);
    const onDone = vi.fn();
    const first = mount({ onDone });
    fireEvent.click(await screen.findByRole('button', { name: 'Thin ice' }));
    capture(43.63, -72.15);
    fireEvent.click(screen.getByRole('button', { name: 'Post hazard' }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    const filed = useHazardDraftStore.getState().draft?.draftId;
    expect(filed).toEqual(expect.any(String));
    // Close while it's in flight, reopen on the same lake, throw the old draft away, start another.
    act(() => activeMapHandlers().onExitMode?.());
    first.unmount();
    const second = mount();
    // The old draft comes back (same lake, same draft); Cancel throws it away.
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(useHazardDraftStore.getState().draft).toBeNull();
    second.unmount();
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Pressure ridge' }));
    const photo = new File(['x'], 'ridge.jpg', { type: 'image/jpeg' });
    act(() => useHazardDraftStore.getState().setPhotoFiles([photo]));
    const fresh = useHazardDraftStore.getState().draft?.draftId;
    expect(fresh).toEqual(expect.any(String));
    expect(fresh).not.toBe(filed);

    // The old Post lands now.
    await act(async () => land('h_old'));
    expect(onDone).toHaveBeenCalledWith({ outcome: 'filed', hazardId: 'h_old' }, { open: false });
    // The new draft and its photo are untouched.
    expect(useHazardDraftStore.getState().draft).toMatchObject({
      draftId: fresh,
      hazardType: 'pressure_ridge',
    });
    expect(useHazardDraftStore.getState().photoFiles).toEqual([photo]);
  });
});

describe('stacked inside the report sheet (5.10.1)', () => {
  it('draws on the host’s map, never the region map, and hands the result back', async () => {
    const onMapState = vi.fn();
    const onDone = vi.fn();
    const create = vi.fn().mockResolvedValue('h_stacked');
    fakes.mutations.set('hazards:create', create);
    const { onClose, unmount } = mount({
      stacked: true,
      instrument: { map: null, loaded: false, onMapState },
      onDone,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Thin ice' }));
    // The report sheet's opener records the start; stacked, the flow doesn't record it again.
    expect(fakes.capture).not.toHaveBeenCalledWith('hazard_flow_started', expect.anything());
    expect(useHazardDraftStore.getState().draft?.stackedInReport).toBe(true);
    expect(flowSpec()).toBeNull();
    const state = onMapState.mock.calls.at(-1)?.[0];
    expect(state).toMatchObject({ capturing: true, mode: { mode: 'Placing a spot' } });
    act(() => state.onCapture({ lat: 43.63, lng: -72.15 }));
    fireEvent.click(screen.getByRole('button', { name: 'Post hazard' }));
    await waitFor(() =>
      expect(onDone).toHaveBeenCalledWith(
        { outcome: 'filed', hazardId: 'h_stacked' },
        { open: true },
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
    unmount();
    expect(onMapState).toHaveBeenLastCalledWith(null);
  });

  it('reopening a draft in a report marks it stacked', async () => {
    useHazardDraftStore.getState().bindOwner('me');
    useHazardDraftStore.getState().setDraft({
      ...(useHazardDraftStore.getState().draft ?? {}),
      step: 'what',
      waterBodyId: 'mascoma',
      hazardType: null,
      drawKind: null,
      shape: null,
      shore: null,
      placing: false,
      note: '',
      photoCount: 0,
      nearbyHazardId: null,
      dismissedDuplicateOf: null,
      stackedInReport: false,
    });
    mount({ stacked: true, instrument: { map: null, loaded: false, onMapState: vi.fn() } });
    await screen.findByRole('heading', { name: 'What did you see?' });
    expect(useHazardDraftStore.getState().draft?.stackedInReport).toBe(true);
  });
});

describe('the keyboard path', () => {
  it('a type, a way to draw and Cancel are all reachable and pressable from the keys', async () => {
    const user = userEvent.setup();
    const { onClose } = mount();
    const tile = await screen.findByRole('button', { name: 'Pressure ridge' });
    tile.focus();
    await user.keyboard('{Enter}');
    expect(useHazardDraftStore.getState().draft?.hazardType).toBe('pressure_ridge');
    screen.getByRole('button', { name: 'A spot' }).focus();
    await user.keyboard(' ');
    expect(flowSpec()?.mode?.mode).toBe('Placing a spot');
    screen.getByRole('button', { name: 'Cancel' }).focus();
    await user.keyboard('{Enter}');
    expect(onClose).toHaveBeenCalledOnce();
  });
});
