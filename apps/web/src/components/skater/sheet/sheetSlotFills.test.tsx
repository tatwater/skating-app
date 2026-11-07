import { api } from '@skating/convex/api';
import { openPostSheet, type PostSheet, reportEndMs, selectedValues } from '@skating/core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getFunctionName } from 'convex/server';
import { ConvexError } from 'convex/values';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setSheet, updateSheet, useSheet } from '@/lib/sheetStore';
import { installFakeStore, reloadPage, stubObjectUrls } from '@/lib/sheetStore.fixtures';
import { useHazardDraftStore } from '@/stores/hazardDraftStore';
import { convexReact, fakes, resetFakes } from '../testMocks';

/** The fake action for a function — the same one the component's `useAction` gets. */
const actionOf = convexReact.useAction;

const h = vi.hoisted(() => ({
  flow: null as null | Record<string, unknown>,
  pick: null as null | ((c: { lat: number; lng: number }) => void),
  convexQuery: vi.fn(),
  body: null as unknown,
}));

vi.mock('@/components/photoPipeline', () => import('@/lib/sheetPhotoPipeline.fake'));
vi.mock('convex/react', () => ({
  ...convexReact,
  useConvex: () => ({ query: h.convexQuery }),
}));
vi.mock('@/lib/analytics', async (load) => ({
  ...(await load<typeof import('@/lib/analytics')>()),
  useAnalytics: () => ({ capture: fakes.capture }),
}));
vi.mock('../actions/HazardFlow', () => ({
  HazardFlow: (p: Record<string, unknown>) => {
    h.flow = p;
    return <p>hazard questions</p>;
  },
}));
vi.mock('./useSheetBody', () => ({ useSheetBody: () => h.body }));
vi.mock('./InstrumentMap', async () => {
  const { useEffect } = await import('react');
  return {
    InstrumentMap: ({
      label,
      onPick,
      onMap,
      children,
    }: {
      label: string;
      onPick: (c: { lat: number; lng: number }) => void;
      onMap?: (m: unknown) => void;
      children?: React.ReactNode;
    }) => {
      h.pick = onPick;
      useEffect(() => {
        onMap?.({
          project: ([lng, lat]: [number, number]) => ({ x: lng, y: lat }),
          unproject: ([x, y]: [number, number]) => ({ lng: x, lat: y }),
          getContainer: () => ({ clientWidth: 600, clientHeight: 400 }),
          getCenter: () => ({ lng: 0, lat: 0 }),
          on: () => {},
          off: () => {},
        });
      }, [onMap]);
      return (
        <section aria-label={label} data-testid="instrument">
          {children}
        </section>
      );
    },
  };
});

import { HazardSheetHost } from '../actions/HazardSheetHost';
import { AnotherReport, addAnotherVisit, addDifferentLake } from './AnotherReport';
import { ConsoleModeProvider, useConsoleMode } from './ConsoleMode';
import { GooglePhotosSlot } from './GooglePhotos';
import { GpxImport, ingestMessage, seedFromTrack } from './GpxImport';
import { HazardSheetFrame } from './HazardSheetFrame';
import { useInstrumentHeld } from './instrumentLease';
import { PhotoSorter } from './PhotoSorter';
import { PhotoTileMenu } from './PhotoTileMenu';
import { carryHazard, StackedHazard } from './StackedHazard';
import { SheetContainerProvider } from './sheetSlots';

const NOW = Date.UTC(2027, 0, 16, 16, 52);
let seq = 0;
const mint = () => `m-${++seq}`;
const POLY = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [-72.2, 43.6],
      [-72.1, 43.6],
      [-72.1, 43.7],
      [-72.2, 43.6],
    ],
  ],
};

beforeEach(() => {
  window.localStorage.clear();
  stubObjectUrls();
  installFakeStore();
  reloadPage('user_1');
  resetFakes();
  h.flow = null;
  h.pick = null;
  h.convexQuery = vi.fn();
  h.body = { name: 'Mascoma Lake', polygon: POLY, putIns: [], parking: [], hazards: [] };
  useHazardDraftStore.setState({ bound: false, draft: null, photoFiles: [] });
});

function lakeSheet(): PostSheet {
  return openPostSheet('body', { waterBodyId: 'mascoma', bodyName: 'Mascoma Lake' }, NOW, mint);
}

function SheetProbe({ onSheet }: { onSheet: (p: PostSheet | null) => void }) {
  onSheet(useSheet());
  return null;
}

// ── 5.10.1 / 3.1–3.8: the hazard sheet frame ──────────────────────────────────────────────────

describe('HazardSheetFrame', () => {
  type MapState = {
    mode: { mode: string; line?: string; step?: string } | null;
    draft: { key: string; data: GeoJSON.FeatureCollection } | null;
    capturing: boolean;
    onCapture: (c: unknown) => void;
    onExitMode: () => void;
  };
  const instrumentOf = () =>
    h.flow?.instrument as { onMapState: (s: MapState | null) => void; loaded: boolean };

  it('stands as a sheet: the lake on the left, J’s flow on the right, its map state drawn', async () => {
    const onClose = vi.fn();
    render(<HazardSheetFrame waterBodyId="mascoma" onClose={onClose} />);
    const dialog = await screen.findByRole('dialog', { name: 'Report a hazard' });
    expect(within(dialog).getAllByText('Mascoma Lake').length).toBeGreaterThan(0);
    expect(within(dialog).getByText('hazard questions')).toBeInTheDocument();
    expect(h.flow).toMatchObject({ waterBodyId: 'mascoma', stacked: false, onClose });
    await waitFor(() => expect(instrumentOf().loaded).toBe(true));

    const onCapture = vi.fn();
    const onExitMode = vi.fn();
    act(() =>
      instrumentOf().onMapState({
        mode: { mode: 'Placing a spot', line: 'Click the water where it is', step: '1 of 1' },
        draft: {
          key: 'k',
          data: {
            type: 'FeatureCollection',
            features: [
              { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: {} },
            ],
          },
        },
        capturing: true,
        onCapture,
        onExitMode,
      }),
    );
    expect(screen.getByText('Placing a spot')).toBeInTheDocument();
    expect(document.querySelector('[data-slot="instrument-draft"] circle')).not.toBeNull();
    act(() => h.pick?.({ lat: 43.65, lng: -72.15 }));
    expect(onCapture).toHaveBeenCalledWith({ lat: 43.65, lng: -72.15 });

    // One Esc: the flow's own way out, which ends the map's listening too.
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(onExitMode).toHaveBeenCalled());
    // The sheet's Close and the mode bar's (named Close too) leave the same way.
    fireEvent.click(dialog.querySelector('[data-attr="hazard-sheet-close"]') as HTMLElement);
    expect(onExitMode).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a click is nobody’s while the flow isn’t placing; Close leaves before the flow is ready', async () => {
    const onClose = vi.fn();
    render(<HazardSheetFrame waterBodyId="mascoma" onClose={onClose} />);
    await screen.findByRole('dialog');
    act(() => h.pick?.({ lat: 1, lng: 1 }));
    fireEvent.click(screen.getByRole('button', { name: /Close/ }));
    expect(onClose).toHaveBeenCalled();
  });

  it('waits for the lake before it draws a map', async () => {
    h.body = null;
    render(<HazardSheetFrame waterBodyId="mascoma" onClose={vi.fn()} />);
    expect(await screen.findByText('Drawing the lake…')).toBeInTheDocument();
    expect(screen.queryByTestId('instrument')).toBeNull();
  });

  it('stacked: inside the report’s element, holding the GL slot, seeding its photos once', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const seen: boolean[] = [];
    function Held() {
      seen.push(useInstrumentHeld());
      return null;
    }
    const photo = new File(['x'], 'ice.jpg');
    const { unmount } = render(
      <>
        <Held />
        <HazardSheetFrame
          waterBodyId="mascoma"
          stacked
          container={host}
          onClose={vi.fn()}
          seedPhotos={[photo]}
        />
      </>,
    );
    await waitFor(() => expect(host.querySelector('[data-slot="hazard-sheet"]')).not.toBeNull());
    expect(host.querySelector('[data-stacked]')).not.toBeNull();
    expect(h.flow).toMatchObject({ stacked: true });
    await waitFor(() => expect(seen.at(-1)).toBe(true));
    // The flow's draft for this lake arrives: the seed lands, once.
    act(() =>
      useHazardDraftStore.setState({
        bound: true,
        draft: { waterBodyId: 'mascoma' } as never,
        photoFiles: [],
      }),
    );
    await waitFor(() => expect(useHazardDraftStore.getState().photoFiles).toEqual([photo]));
    act(() => useHazardDraftStore.setState({ draft: { waterBodyId: 'mascoma', x: 1 } as never }));
    expect(useHazardDraftStore.getState().photoFiles).toHaveLength(1);
    unmount();
    host.remove();
  });
});

describe('HazardSheetHost (?act=hazard)', () => {
  it('opens the frame, and steps aside while a report sheet has the page', async () => {
    const { rerender } = render(
      <HazardSheetHost
        waterBodyId="mascoma"
        subAreaId="north"
        reportOpen={false}
        onClose={vi.fn()}
      />,
    );
    await screen.findByRole('dialog', { name: 'Report a hazard' });
    expect(h.flow).toMatchObject({ subAreaId: 'north' });
    rerender(<HazardSheetHost waterBodyId="mascoma" reportOpen onClose={vi.fn()} />);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('StackedHazard (5.10.1)', () => {
  it('a hazard filed from a Report rides on it; a nearby one confirmed does not', async () => {
    const post = lakeSheet();
    const reportId = post.reports[0]?.id as string;
    setSheet(post);
    const onClose = vi.fn();
    const onFiled = vi.fn();
    render(
      <StackedHazard
        waterBodyId="mascoma"
        reportId={reportId}
        container={null}
        onClose={onClose}
        onFiled={onFiled}
      />,
    );
    await screen.findByRole('dialog');
    const done = h.flow?.onDone as (r: { outcome: string; hazardId: string }) => void;
    act(() => done({ outcome: 'confirmed', hazardId: 'old' }));
    let sheet: PostSheet | null = null;
    render(<SheetProbe onSheet={(p) => (sheet = p)} />);
    expect((sheet as PostSheet | null)?.reports[0]?.sheet.scalars.hazardIds).toEqual([]);
    expect(onFiled).not.toHaveBeenCalled();
    act(() => done({ outcome: 'filed', hazardId: 'h1' }));
    act(() => carryHazard(reportId, 'h1'));
    render(<SheetProbe onSheet={(p) => (sheet = p)} />);
    expect((sheet as PostSheet | null)?.reports[0]?.sheet.scalars.hazardIds).toEqual(['h1']);
    expect(onFiled).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

// ── 5.16 / 5.17: Another report ───────────────────────────────────────────────────────────────

describe('Another report', () => {
  it('adds the same lake after the Report it is about, or a blank one for another lake', () => {
    const post = lakeSheet();
    const first = post.reports[0]?.id as string;
    const same = addAnotherVisit(post, first, NOW, mint);
    expect(same?.post.reports.map((r) => r.bodyName)).toEqual(['Mascoma Lake', 'Mascoma Lake']);
    expect(same?.post.reports[1]?.id).toBe(same?.reportId);
    expect(same?.post.dirty).toBe(true);
    expect(addAnotherVisit(post, 'nope', NOW, mint)).toBeNull();
    const blank = openPostSheet('page', {}, NOW, mint);
    expect(addAnotherVisit(blank, blank.reports[0]?.id as string, NOW, mint)).toBeNull();
    const other = addDifferentLake(post, NOW, mint);
    expect(other.post.reports[1]?.sheet.waterBodyId).toBeUndefined();
  });

  it('the menu adds a Report and opens its tab, by keyboard', async () => {
    const post = lakeSheet();
    setSheet(post);
    const onAdded = vi.fn();
    const user = userEvent.setup();
    render(<AnotherReport activeReportId={post.reports[0]?.id as string} onAdded={onAdded} />);
    const trigger = screen.getByRole('button', { name: /Another report/ });
    trigger.focus();
    await user.keyboard('{Enter}');
    const same = await screen.findByRole('menuitem', { name: /^Mascoma Lake, another time/ });
    expect(screen.getByText('A second visit to the lake this report is about')).toBeInTheDocument();
    await user.click(same);
    expect(onAdded).toHaveBeenCalledTimes(1);
    await user.click(trigger);
    await user.click(await screen.findByRole('menuitem', { name: /^A different lake/ }));
    expect(onAdded).toHaveBeenCalledTimes(2);
    let sheet: PostSheet | null = null;
    render(<SheetProbe onSheet={(p) => (sheet = p)} />);
    expect((sheet as PostSheet | null)?.reports).toHaveLength(3);
  });

  it('cannot offer the same lake before there is one', async () => {
    const blank = openPostSheet('page', {}, NOW, mint);
    setSheet(blank);
    render(<AnotherReport activeReportId={blank.reports[0]?.id as string} onAdded={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /Another report/ }));
    expect(
      await screen.findByRole('menuitem', { name: /^This lake, another time/ }),
    ).toHaveAttribute('aria-disabled', 'true');
  });
});

// ── 5.2: GPX import ───────────────────────────────────────────────────────────────────────────

function gpxFile(points = 30, minutesAgo = 90): File {
  const start = NOW - minutesAgo * 60_000;
  const pts = Array.from(
    { length: points },
    (_, i) =>
      `<trkpt lat="${(43.62 + i * 0.0003).toFixed(5)}" lon="${(-72.15 + i * 0.0002).toFixed(5)}"><time>${new Date(start + i * 60_000).toISOString()}</time></trkpt>`,
  ).join('');
  return new File([`<gpx><trk><trkseg>${pts}</trkseg></trk></gpx>`], 'skate.gpx');
}

describe('GPX import (flag on)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });

  it('seeds the lake and the times where the sheet is blank, never over an answer', () => {
    const blank = openPostSheet('page', {}, NOW, mint);
    const id = blank.reports[0]?.id as string;
    const seeded = seedFromTrack(
      blank,
      id,
      'a1',
      { startTime: 100, endTime: 200 },
      {
        waterBodyId: 'mascoma',
        name: 'Mascoma Lake',
      },
    );
    const r = seeded.reports[0];
    expect(r).toMatchObject({ activityId: 'a1', bodyName: 'Mascoma Lake' });
    expect(selectedValues(r?.sheet as never, 'endTime')[0]).toEqual({ ms: 200, precision: 'gps' });
    expect(r?.sheet.scalars.skateStartTime).toBe(100);
    // Already answered: the end and the lake stay as they are.
    const again = seedFromTrack(
      seeded,
      id,
      'a2',
      { startTime: 1, endTime: 2 },
      {
        waterBodyId: 'other',
        name: 'Other',
      },
    );
    expect(reportEndMs(again.reports[0] as never)).toBe(200);
    expect(again.reports[0]?.bodyName).toBe('Mascoma Lake');
    expect(seedFromTrack(blank, 'nope', 'a', { startTime: 1, endTime: 2 }, null)).toBe(blank);
  });

  it('shows the server’s refusal verbatim', () => {
    expect(ingestMessage(new ConvexError('That skate is more than 7 days old.'))).toBe(
      'That skate is more than 7 days old.',
    );
    expect(ingestMessage(new Error('network'))).toMatch(/Couldn't import that track/);
  });

  it('reads, thins and ingests a picked file, then lands the track on the Report', async () => {
    vi.useRealTimers();
    const blank = openPostSheet('page', {}, Date.now(), mint);
    setSheet(blank);
    const id = blank.reports[0]?.id as string;
    const ingest = vi.fn().mockResolvedValue('act_1');
    fakes.mutations.set('gpsActivities:ingestTrack', ingest);
    h.convexQuery.mockResolvedValue([
      { activityId: 'act_1', waterBodyId: 'mascoma', waterBodyName: 'Mascoma Lake' },
    ]);
    const onImported = vi.fn();
    render(<GpxImport reportId={id} onImported={onImported} />);
    const input = screen.getByLabelText('A GPX file') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [gpxFile(30, 90)] } });
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect(ingest.mock.calls[0]?.[0]).toMatchObject({ provider: 'gpx' });
    expect(fakes.capture).toHaveBeenCalledWith('gpx_import_started');
    expect(fakes.capture).toHaveBeenCalledWith('gpx_import_completed', {
      point_count_bucket: '1-99',
    });
    let sheet: PostSheet | null = null;
    render(<SheetProbe onSheet={(p) => (sheet = p)} />);
    expect((sheet as PostSheet | null)?.reports[0]).toMatchObject({
      activityId: 'act_1',
      bodyName: 'Mascoma Lake',
    });
  });

  it('says what was wrong with the file, or what the server refused', async () => {
    vi.useRealTimers();
    setSheet(openPostSheet('page', {}, Date.now(), mint));
    const ingest = vi.fn().mockRejectedValue(new ConvexError('That skate is in the future.'));
    fakes.mutations.set('gpsActivities:ingestTrack', ingest);
    render(<GpxImport reportId="r" onImported={vi.fn()} />);
    const input = screen.getByLabelText('A GPX file');
    fireEvent.change(input, { target: { files: [new File(['<html/>'], 'x.gpx')] } });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "That file isn't a GPX track with times in it.",
    );
    fireEvent.drop(screen.getByRole('group', { name: 'Import a GPX file' }), {
      dataTransfer: { files: [gpxFile()] },
    });
    expect(await screen.findByText('That skate is in the future.')).toBeInTheDocument();
    fireEvent.change(input, { target: { files: [] } });
  });
});

// ── 5.19 / 5.20: the tile menu ────────────────────────────────────────────────────────────────

describe('PhotoTileMenu', () => {
  function twoLakesWithPhoto(): PostSheet {
    const post = lakeSheet();
    const second = addDifferentLake(post, NOW, mint).post;
    const crystal = {
      ...second,
      reports: second.reports.map((r, i) =>
        i === 1
          ? {
              ...r,
              bodyName: 'Crystal Lake',
              sheet: { ...r.sheet, waterBodyId: 'crystal' },
            }
          : r,
      ),
    };
    return {
      ...crystal,
      reports: crystal.reports.map((r, i) =>
        i === 0
          ? {
              ...r,
              photos: [{ id: 'ph', fullUri: 'ph:full', thumbUri: 'ph:thumb', placeOnMap: false }],
            }
          : r,
      ),
    };
  }

  function ModeProbe({ onMode }: { onMode: (kind: string | null) => void }) {
    onMode(useConsoleMode().mode?.kind ?? null);
    return null;
  }

  function mount(post: PostSheet, onMode: (kind: string | null) => void = () => {}) {
    setSheet(post);
    const photo = post.reports[0]?.photos[0] as never;
    return render(
      <ConsoleModeProvider>
        <SheetContainerProvider value={document.body}>
          <PhotoTileMenu
            photo={photo}
            reportId={post.reports[0]?.id as string}
            trigger={<span>1</span>}
          />
          <ModeProbe onMode={onMode} />
        </SheetContainerProvider>
      </ConsoleModeProvider>,
    );
  }

  it('lists the lakes by tab and moves the photo to the one chosen', async () => {
    const post = twoLakesWithPhoto();
    mount(post);
    await userEvent.click(screen.getByRole('button', { name: 'This photo’s lake and options' }));
    expect(await screen.findByText('This photo is from')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: /Crystal Lake/ }));
    let sheet: PostSheet | null = null;
    render(<SheetProbe onSheet={(p) => (sheet = p)} />);
    expect((sheet as PostSheet | null)?.reports[1]?.photos.map((p) => p.id)).toEqual(['ph']);
  });

  it('places it on the lake through the instrument', async () => {
    const modes: (string | null)[] = [];
    mount(twoLakesWithPhoto(), (k) => {
      modes.push(k);
    });
    await userEvent.click(screen.getByRole('button', { name: 'This photo’s lake and options' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Place it on the lake' }));
    expect(modes.at(-1)).toBe('place');
  });

  it('leaves it out', async () => {
    mount(twoLakesWithPhoto());
    await userEvent.click(screen.getByRole('button', { name: 'This photo’s lake and options' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Leave it out' }));
    let sheet: PostSheet | null = null;
    render(<SheetProbe onSheet={(p) => (sheet = p)} />);
    expect((sheet as PostSheet | null)?.reports[0]?.photos).toEqual([]);
  });

  it('opens a hazard over the report with the photo; filed, the photo goes with it', async () => {
    mount(twoLakesWithPhoto());
    await userEvent.click(screen.getByRole('button', { name: 'This photo’s lake and options' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'This is a hazard…' }));
    expect(fakes.capture).toHaveBeenCalledWith('hazard_flow_started', { entry: 'report_sheet' });
    await screen.findByRole('dialog', { name: 'Report a hazard' });
    expect(h.flow).toMatchObject({ waterBodyId: 'mascoma', stacked: true });
    act(() =>
      ((h.flow as Record<string, unknown>).onDone as (r: unknown) => void)({
        outcome: 'filed',
        hazardId: 'hz',
      }),
    );
    let sheet: PostSheet | null = null;
    render(<SheetProbe onSheet={(p) => (sheet = p)} />);
    expect((sheet as PostSheet | null)?.reports[0]?.photos).toEqual([]);
    expect((sheet as PostSheet | null)?.reports[0]?.sheet.scalars.hazardIds).toEqual(['hz']);
  });

  it('is the bare trigger with no sheet open', () => {
    render(
      <PhotoTileMenu
        photo={{ id: 'x', fullUri: '', thumbUri: '', placeOnMap: false }}
        reportId={null}
        trigger={<span>?</span>}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('?')).toBeInTheDocument();
  });
});

// ── 5.21: Google Photos ───────────────────────────────────────────────────────────────────────

describe('Google Photos (slot)', () => {
  it('stays out of the way when the server says it isn’t available', () => {
    fakes.queries.set('googlePhotos:available', false);
    const { container } = render(<GooglePhotosSlot disabled={false} onPhotos={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('waits on Google’s window with a Cancel, then brings the picks over and counts them', async () => {
    fakes.queries.set('googlePhotos:available', true);
    const win = { location: { href: '' }, closed: false, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(win as never);
    fakes.mutations.set(
      'googlePhotos:begin',
      vi.fn().mockResolvedValue({ state: 's1', consentUrl: 'https://accounts.example/consent' }),
    );
    const onPhotos = vi.fn();
    render(<GooglePhotosSlot disabled={false} onPhotos={onPhotos} />);
    let release: (v: unknown) => void = () => {};
    (actionOf(api.googlePhotos.status) as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => (release = r)),
    );
    (actionOf(api.googlePhotos.list) as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'g1', filename: 'ice.jpg', takenAtMs: 5 },
    ]);
    (actionOf(api.googlePhotos.photo) as ReturnType<typeof vi.fn>).mockResolvedValue({
      bytes: new ArrayBuffer(4),
      mimeType: 'image/jpeg',
    });
    await userEvent.click(screen.getByRole('button', { name: 'From Google Photos' }));
    expect(await screen.findByText('Waiting for Google Photos…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    await act(async () => release({ phase: 'picked' }));
    await waitFor(() => expect(onPhotos).toHaveBeenCalled());
    expect(onPhotos.mock.calls[0]?.[0][0]).toMatchObject({ takenAtMs: 5 });
    expect(fakes.capture).toHaveBeenCalledWith('report_photos_added', {
      source: 'google_photos',
      count: 1,
    });
    expect(getFunctionName(api.googlePhotos.list)).toBe('googlePhotos:list');
  });
});

// ── 5.17.1: the sort, connected ───────────────────────────────────────────────────────────────

describe('PhotoSorter', () => {
  it('looks the pool’s places up, opens a tab per lake and day, and says so', async () => {
    const blank = openPostSheet('page', {}, NOW, mint);
    const photos = [
      {
        id: 'a',
        fullUri: 'a',
        thumbUri: 'a',
        placeOnMap: false,
        coord: { lat: 43.63, lng: -72.15 },
        takenAtMs: NOW - 3 * 3600_000,
      },
      {
        id: 'b',
        fullUri: 'b',
        thumbUri: 'b',
        placeOnMap: false,
        coord: { lat: 43.52, lng: -72.05 },
        takenAtMs: NOW - 3600_000,
      },
      { id: 'c', fullUri: 'c', thumbUri: 'c', placeOnMap: false },
    ];
    setSheet(blank);
    h.convexQuery.mockImplementation(async (_ref: unknown, args: { coord: { lat: number } }) =>
      args.coord.lat > 43.6
        ? { waterBodyId: 'mascoma', name: 'Mascoma Lake' }
        : { waterBodyId: 'crystal', name: 'Crystal Lake' },
    );
    const onActivate = vi.fn();
    function Live() {
      const current = useSheet();
      return current ? (
        <PhotoSorter
          post={current}
          activeId={blank.reports[0]?.id as string}
          onActivate={onActivate}
        />
      ) : null;
    }
    render(<Live />);
    // Photos dropped once the sheet is open are the ones sorted.
    act(() => updateSheet((p) => ({ ...p, photos })));
    expect(
      await screen.findByText(
        'Your 3 photos were taken on two lakes, so they start two reports, one per tab. A photo’s number is its tab.',
      ),
    ).toBeInTheDocument();
    expect(onActivate).toHaveBeenCalledWith(blank.reports[0]?.id);
    expect(h.convexQuery).toHaveBeenCalledTimes(2);
    let sheet: PostSheet | null = null;
    render(<SheetProbe onSheet={(p) => (sheet = p)} />);
    expect((sheet as PostSheet | null)?.reports.map((r) => r.bodyName)).toEqual([
      'Mascoma Lake',
      'Crystal Lake',
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('leaves photos with no place, and an edit, alone; a failed lookup sorts nothing', async () => {
    const blank = openPostSheet('page', {}, NOW, mint);
    const z = {
      id: 'z',
      fullUri: 'z',
      thumbUri: 'z',
      placeOnMap: false,
      coord: { lat: 1, lng: 1 },
    };
    // A restored draft's pool is the author's: not sorted on open.
    setSheet({ ...blank, photos: [{ ...z, id: 'kept' }] });
    h.convexQuery.mockRejectedValue(new Error('offline'));
    function Live() {
      const current = useSheet();
      return current ? <PhotoSorter post={current} activeId="x" onActivate={vi.fn()} /> : null;
    }
    render(<Live />);
    expect(h.convexQuery).not.toHaveBeenCalled();
    act(() => updateSheet((p) => ({ ...p, photos: [...(p.photos ?? []), z] })));
    await waitFor(() => expect(h.convexQuery).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
    const edit = { ...blank, mode: { kind: 'edit' as const, reportId: 'r' }, photos: [] };
    render(<PhotoSorter post={edit} activeId="x" onActivate={vi.fn()} />);
    const noPlace = {
      ...blank,
      photos: [{ id: 'q', fullUri: 'q', thumbUri: 'q', placeOnMap: false }],
    };
    render(<PhotoSorter post={noPlace} activeId="x" onActivate={vi.fn()} />);
    expect(h.convexQuery).toHaveBeenCalledTimes(1);
  });
});

describe('Google Photos (slot), the ways a pick ends', () => {
  async function actions() {
    return {
      status: actionOf(api.googlePhotos.status) as ReturnType<typeof vi.fn>,
      close: actionOf(api.googlePhotos.close) as ReturnType<typeof vi.fn>,
    };
  }
  beforeEach(() => {
    fakes.queries.set('googlePhotos:available', true);
    fakes.mutations.set(
      'googlePhotos:begin',
      vi.fn().mockResolvedValue({ state: 's2', consentUrl: 'https://accounts.example/consent' }),
    );
  });

  it('says so when the browser blocks the window', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    render(<GooglePhotosSlot disabled={false} onPhotos={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'From Google Photos' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/blocked the Google Photos window/);
  });

  it('ends quietly when the person cancels, and when Google closes with nothing picked', async () => {
    const win = { location: { href: '' }, closed: false, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(win as never);
    const { status } = await actions();
    status.mockImplementation(() => new Promise(() => {}));
    const onPhotos = vi.fn();
    const { unmount } = render(<GooglePhotosSlot disabled={false} onPhotos={onPhotos} />);
    await userEvent.click(screen.getByRole('button', { name: 'From Google Photos' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(win.close).toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'From Google Photos' })).toBeInTheDocument();
    status.mockResolvedValue({ phase: 'gone' });
    await userEvent.click(screen.getByRole('button', { name: 'From Google Photos' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Google Photos closed without adding anything.',
    );
    expect(onPhotos).not.toHaveBeenCalled();
    unmount();
  });
});

describe('SHEET_SLOTS', () => {
  it('fills every slot the sheet offers', async () => {
    const { SHEET_SLOTS } = await import('./slots');
    expect(Object.keys(SHEET_SLOTS).sort()).toEqual([
      'anotherReport',
      'googlePhotos',
      'gpxImport',
      'photoTileMenu',
      'stackedHazard',
    ]);
    setSheet(lakeSheet());
    fakes.queries.set('googlePhotos:available', true);
    render(
      <>
        {SHEET_SLOTS.anotherReport?.({ activeReportId: 'r', onAdded: vi.fn() })}
        {SHEET_SLOTS.gpxImport?.({ reportId: 'r', onImported: vi.fn() })}
        {SHEET_SLOTS.googlePhotos?.({ disabled: false, onPhotos: vi.fn() })}
        {SHEET_SLOTS.photoTileMenu?.({
          photo: { id: 'p', fullUri: '', thumbUri: '', placeOnMap: false },
          reportId: null,
          trigger: <span>?</span>,
        })}
        {SHEET_SLOTS.stackedHazard?.({
          waterBodyId: 'mascoma',
          reportId: 'r',
          container: null,
          onClose: vi.fn(),
        })}
      </>,
    );
    expect(await screen.findByRole('dialog', { name: 'Report a hazard' })).toBeInTheDocument();
    // Behind the modal hazard sheet, the rest is hidden from the tree but drawn.
    const hidden = { hidden: true };
    expect(screen.getByRole('button', { name: /Another report/, ...hidden })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose a file', ...hidden })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'From Google Photos', ...hidden }),
    ).toBeInTheDocument();
  });
});
