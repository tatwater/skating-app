import type { SheetReport } from '@skating/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { getFunctionName } from 'convex/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setSheet, useSheet } from '@/lib/sheetStore';
import { installFakeStore, openSheet, reloadPage, stubObjectUrls } from '@/lib/sheetStore.fixtures';
import { type ConsoleMode, ConsoleModeProvider, useConsoleMode } from './ConsoleMode';
import { InstrumentPane } from './InstrumentPane';
import type { SheetBody } from './useSheetBody';

vi.mock('@/components/photoPipeline', () => import('@/lib/sheetPhotoPipeline.fake'));
const h = vi.hoisted(() => ({
  queries: new Map<string, unknown>(),
  pick: null as null | ((c: { lat: number; lng: number }) => void),
}));
vi.mock('convex/react', () => ({
  useQuery: (ref: unknown, args: unknown) =>
    args === 'skip' ? undefined : h.queries.get(getFunctionName(ref as never)),
}));
vi.mock('./useSkateWeather', () => ({ useSkateWeather: () => [], useSkateWindowHours: () => [] }));
vi.mock('./InstrumentMap', () => ({
  InstrumentMap: ({
    label,
    onPick,
    input,
  }: {
    label: string;
    onPick: (c: { lat: number; lng: number }) => void;
    input: { hazards: unknown[]; track?: unknown[]; photos: unknown[] };
  }) => {
    h.pick = onPick;
    return (
      <section
        aria-label={label}
        data-hazards={input.hazards.length}
        data-track={input.track?.length ?? 0}
        data-photos={input.photos.length}
      />
    );
  },
}));

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
const body: SheetBody = {
  waterBodyId: 'b1',
  name: 'Mascoma Lake',
  polygon: POLY,
  silhouette: null,
  frame: null,
  bays: [],
  landmarks: [],
  putIns: [{ id: 'p1', coord: { lat: 43.61, lng: -72.15 }, name: 'Launch', kind: 'putIn' }],
  parking: [],
  hazards: [
    {
      id: 'h1',
      type: 'open_water',
      shape: { geometryKind: 'point', geometry: { type: 'Point', coordinates: [-72.15, 43.65] } },
      bbox: { minLat: 43.65, maxLat: 43.65, minLng: -72.15, maxLng: -72.15 },
      label: 'open water',
    } as unknown as SheetBody['hazards'][number],
  ],
  recentCards: [],
  sunAt: () => null,
  timeZone: 'America/New_York',
};

let mode: { set: (m: ConsoleMode | null) => void; current: ConsoleMode | null } = {
  set: () => {},
  current: null,
};
function ModeHandle() {
  const { mode: m, setMode } = useConsoleMode();
  mode = { set: setMode, current: m };
  return null;
}

function Pane({ withBody = true }: { withBody?: boolean }) {
  const post = useSheet();
  const report = post?.reports[0];
  if (!report) return null;
  return (
    <InstrumentPane
      report={report}
      ordered={post?.reports ?? []}
      body={withBody ? body : null}
      inert={false}
    />
  );
}

function renderPane(withBody = true) {
  return render(
    <ConsoleModeProvider>
      <ModeHandle />
      <Pane withBody={withBody} />
    </ConsoleModeProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  stubObjectUrls();
  installFakeStore();
  reloadPage('user_1');
  h.queries.clear();
  h.pick = null;
  setSheet(openSheet());
});

describe('InstrumentPane (5.1)', () => {
  it('names the lake and draws it with its hazards', () => {
    renderPane();
    // The Report's own name for its lake leads; the body's is the fallback.
    expect(screen.getByRole('heading', { name: 'Morey' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Morey, with your put-in/ })).toHaveAttribute(
      'data-hazards',
      '1',
    );
  });

  it('waits for the outline', () => {
    renderPane(false);
    expect(screen.getByText('Drawing the lake…')).toBeInTheDocument();
  });

  it('draws the linked track', () => {
    h.queries.set('gpsActivities:listMine', [
      {
        activityId: 'a1',
        path: {
          type: 'LineString',
          coordinates: [
            [-72.1, 43.6],
            [-72.2, 43.7],
          ],
        },
      },
    ]);
    setSheet({
      ...openSheet(),
      reports: (openSheet().reports as SheetReport[]).map((r) => ({ ...r, activityId: 'a1' })),
    });
    renderPane();
    expect(screen.getByRole('region', { name: /with your put-in/ })).toHaveAttribute(
      'data-track',
      '2',
    );
  });

  it('asks a where question over the lake, hides the hazards, and takes a click as its answer', () => {
    renderPane();
    const onChange = vi.fn();
    const onExit = vi.fn();
    act(() =>
      mode.set({ kind: 'where', label: 'Snow covered', where: undefined, onChange, onExit }),
    );
    expect(screen.getByText('Where is the snow covered?')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /with your put-in/ })).toHaveAttribute(
      'data-hazards',
      '0',
    );
    act(() => h.pick?.({ lat: 43.65, lng: -72.15 }));
    expect(onChange).toHaveBeenCalledTimes(1);
    // A sub-mode is left by a click, never Esc.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByText('Where is the snow covered?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onExit).toHaveBeenCalled();
    expect(mode.current).toBeNull();
  });

  it('asks where you got on, and where a photo was taken', () => {
    renderPane();
    const onPickShore = vi.fn();
    act(() => mode.set({ kind: 'putIn', onPickPin: vi.fn(), onPickShore }));
    expect(screen.getByText('Where did you get on?')).toBeInTheDocument();
    act(() => h.pick?.({ lat: 43.61, lng: -72.15 }));
    expect(onPickShore).toHaveBeenCalledWith({ lat: 43.61, lng: -72.15 });
    const onPlace = vi.fn();
    act(() => mode.set({ kind: 'place', photoId: 'ph', onPlace }));
    expect(screen.getByText('Where was this photo taken?')).toBeInTheDocument();
    act(() => h.pick?.({ lat: 43.62, lng: -72.15 }));
    expect(onPlace).toHaveBeenCalled();
    act(() => mode.set(null));
    act(() => h.pick?.({ lat: 43.62, lng: -72.15 }));
    expect(onPlace).toHaveBeenCalledTimes(1);
  });
});
