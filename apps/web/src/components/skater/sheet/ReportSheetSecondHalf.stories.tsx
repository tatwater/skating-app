import {
  type DraftPhoto,
  openPostSheet,
  type PostSheet,
  type SilhouetteData,
  sheetReducer,
  silhouetteRings,
  type Where,
} from '@skating/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { Polygon } from 'geojson';
import { useEffect, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { setSheet } from '@/lib/sheetStore';
import { must } from '../../kit/storyKit';
import { HazardFlowView } from '../actions/HazardFlowView';
import { chooseType, startDraft } from '../actions/hazardFlowModel';
import { MASCOMA_INTERIOR, MASCOMA_PUT_INS, MASCOMA_RINGS } from '../map/mapStoryData';
import { SkaterPair } from '../storySupport';
import { AnotherReport } from './AnotherReport';
import { type ConsoleMode, ConsoleModeProvider, useConsoleMode } from './ConsoleMode';
import { GooglePhotosView } from './GooglePhotos';
import { GpxImportView } from './GpxImport';
import { HazardSheetChrome } from './HazardSheetFrame';
import { InstrumentOverlay, type OverlayMap } from './InstrumentOverlay';
import type { InstrumentPin } from './instrumentFeatures';
import { PhotoSortNote } from './PhotoSorter';
import { PhotoTileMenu } from './PhotoTileMenu';
import { SheetContainerProvider } from './sheetSlots';
import type { SheetBody } from './useSheetBody';
import { WeatherCorrection } from './WeatherCorrection';
import { type WhereCard, WhereCards } from './WhereCards';

/**
 * The New report sheet's second half (row 5: 5.10.1, 5.13–5.22) on the skater surface, dark and
 * light: the where and put-in modes over the instrument, Another report, the photo tile menu,
 * Google Photos, the photo sort's line, the GPX drop zone, the weather correction, and Report a
 * hazard stacked in the sheet's frame. Convex-free views of the connected pieces; the instrument's
 * map stands in as a flat projection of Mascoma's real outline (no tiles in a story).
 */
const meta = {
  title: 'Skater/New report — second half',
  globals: { surface: 'skater', mode: 'light' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

// ── Fixtures: Mascoma, Saturday 16 January 2027 ───────────────────────────────────────────────

const NOW = Date.UTC(2027, 0, 16, 16, 52);
const POLY: Polygon = {
  type: 'Polygon',
  coordinates: MASCOMA_RINGS.map((r) => r.map(([lng, lat]) => [lng, lat])),
};
const SILHOUETTE: SilhouetteData = { ...silhouetteRings(POLY), origin: MASCOMA_INTERIOR };
const PINS: InstrumentPin[] = MASCOMA_PUT_INS.flatMap((p, i) =>
  p.name ? [{ id: `p${i}`, coord: { lat: p.lat, lng: p.lng }, name: p.name, kind: 'putIn' }] : [],
);
const W = 560;
const H = 380;

/**
 * Mascoma fitted into the pane: a flat map with the instrument's projection. It moves the way the
 * where mode asks (`jumpTo`), so the ring frames the lake as it does over the real map.
 */
function fittedMap(): OverlayMap {
  const { bbox } = SILHOUETTE;
  const k = Math.cos((43.62 * Math.PI) / 180);
  const pad = 24;
  const base = Math.min(
    (W - 2 * pad) / ((bbox.maxLng - bbox.minLng) * k),
    (H - 2 * pad) / (bbox.maxLat - bbox.minLat),
  );
  let center = { lng: (bbox.minLng + bbox.maxLng) / 2, lat: (bbox.minLat + bbox.maxLat) / 2 };
  let zoom = 0;
  const scale = () => base * 2 ** zoom;
  const container = { clientWidth: W, clientHeight: H } as HTMLElement;
  const listeners = new Set<() => void>();
  return {
    project: ([lng, lat]) => ({
      x: W / 2 + (lng - center.lng) * k * scale(),
      y: H / 2 - (lat - center.lat) * scale(),
    }),
    unproject: ([x, y]) => ({
      lng: center.lng + (x - W / 2) / (k * scale()),
      lat: center.lat - (y - H / 2) / scale(),
    }),
    getContainer: () => container,
    getCenter: () => center,
    getZoom: () => zoom,
    jumpTo: (camera) => {
      center = camera.center;
      zoom = camera.zoom;
      for (const l of listeners) l();
    },
    on: (_type, l) => listeners.add(l),
    off: (_type, l) => listeners.delete(l),
  };
}

/** The lake under the overlay, standing in for the tiles; it follows the camera. */
function LakeGround({ map }: { map: OverlayMap }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    map.on('move', bump);
    return () => {
      map.off('move', bump);
    };
  }, [map]);
  const d = SILHOUETTE.rings
    .map(
      (ring) =>
        `${ring
          .map(([lng, lat], i) => {
            const p = map.project([lng, lat]);
            return `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
          })
          .join(' ')} Z`,
    )
    .join(' ');
  return (
    <svg aria-hidden width={W} height={H} className="absolute inset-0">
      <path d={d} fill="var(--panel)" stroke="var(--fg2)" strokeWidth={1.2} fillRule="evenodd" />
    </svg>
  );
}

function Instrument({ chosenPinId }: { chosenPinId?: string }) {
  const { mode } = useConsoleMode();
  const [map] = useState(fittedMap);
  return (
    <div
      data-slot="story-instrument"
      className="relative shrink-0 overflow-hidden bg-bg"
      style={{ width: W, height: H }}
    >
      <LakeGround map={map} />
      <InstrumentOverlay
        map={map}
        mode={mode}
        silhouette={SILHOUETTE}
        pins={PINS}
        {...(chosenPinId !== undefined ? { chosenPinId } : {})}
      />
    </div>
  );
}

const BODY: SheetBody = {
  waterBodyId: 'mascoma',
  name: 'Mascoma Lake',
  polygon: POLY,
  silhouette: SILHOUETTE,
  frame: null,
  bays: [
    { id: 'north', name: 'Mascoma North' },
    { id: 'south', name: 'Mascoma South' },
  ],
  landmarks: [],
  putIns: [],
  parking: [],
  hazards: [],
  recentCards: [],
  sunAt: () => null,
  timeZone: 'America/New_York',
};

function WhereDemo() {
  const [where, setWhere] = useState<Where | undefined>({ extent: 'patches', sector: 'S' });
  const [open, setOpen] = useState(true);
  const cards: WhereCard[] = [{ id: 'ice:snow', label: 'Snow covered', where, onChange: setWhere }];
  return (
    <div className="flex gap-(--space-6) p-(--space-6)">
      <Instrument />
      <div className="w-[25rem]">
        <WhereCards
          cards={cards}
          body={BODY}
          open={open}
          onClose={() => setOpen(false)}
          activeId="ice:snow"
          onActivate={() => {}}
        />
      </div>
    </div>
  );
}

/** 5.13 / 5.14: the where mode — the ring around the lake, the chip's sector lit and washed. */
export const WhereMode: Story = {
  render: () => (
    <SkaterPair height="30rem">
      {() => (
        <ConsoleModeProvider>
          <WhereDemo />
        </ConsoleModeProvider>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const quad = must(canvasElement.querySelector<HTMLElement>('[data-mode="dark"]'));
    const q = within(quad);
    await expect(q.getByText('Where is the snow covered?')).toBeVisible();
    await waitFor(() =>
      expect(quad.querySelectorAll('[data-slot="instrument-ring"] [data-sector]')).toHaveLength(8),
    );
    await expect(quad.querySelector('[data-slot="instrument-wash"]')).not.toBeNull();
    // The keyboard's way is the chips: East side by Tab and Enter lights the E arc.
    const east = q.getByRole('button', { name: 'East side' });
    east.focus();
    await userEvent.keyboard('{Enter}');
    await expect(east).toHaveAttribute('aria-pressed', 'true');
    await expect(q.getByRole('button', { name: 'South end' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  },
};

function PutInDemo() {
  const { setMode } = useConsoleMode();
  useEffect(() => {
    const mode: ConsoleMode = { kind: 'putIn', onPickPin: fn(), onPickShore: fn() };
    setMode(mode);
  }, [setMode]);
  return (
    <div className="p-(--space-6)">
      <Instrument chosenPinId="p1" />
    </div>
  );
}

/** 5.15: the put-in mode — every launch lit, the chosen one solid and named. */
export const PutInMode: Story = {
  render: () => (
    <SkaterPair height="28rem">
      {() => (
        <ConsoleModeProvider>
          <PutInDemo />
        </ConsoleModeProvider>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const quad = must(canvasElement.querySelector<HTMLElement>('[data-mode="light"]'));
    await waitFor(() => expect(quad.querySelector('[data-slot="instrument-lit"]')).not.toBeNull());
    await expect(quad.querySelector('[data-pin="p1"]')).toHaveAttribute('data-chosen');
    await expect(quad.textContent).toContain('PUT-IN · YOURS');
  },
};

// ── 5.16–5.20: the sheet's tabs and photos ───────────────────────────────────────────────────

let n = 0;
const mint = () => `story-${++n}`;
const photo = (id: string): DraftPhoto => ({
  id,
  fullUri: `${id}:full`,
  thumbUri: `${id}:thumb`,
  placeOnMap: false,
});

function twoLakes(): PostSheet {
  const post = openPostSheet(
    'body',
    { waterBodyId: 'mascoma', bodyName: 'Mascoma Lake' },
    NOW,
    mint,
  );
  const crystal = openPostSheet(
    'body',
    { waterBodyId: 'crystal', bodyName: 'Crystal Lake' },
    NOW,
    mint,
  ).reports[0];
  const timed = (ms: number, start: number) => (r: PostSheet['reports'][number]) => ({
    ...r,
    sheet: sheetReducer(
      sheetReducer(r.sheet, {
        type: 'select',
        field: 'endTime',
        key: 'chosen',
        value: { ms, precision: 'minute' },
      }),
      { type: 'setScalar', key: 'skateStartTime', value: start },
    ),
  });
  const first = post.reports[0];
  if (!first || !crystal) return post;
  return {
    ...post,
    reports: [
      { ...timed(NOW - 20 * 60_000, NOW - 140 * 60_000)(first), photos: [photo('a')] },
      timed(NOW + 140 * 60_000, NOW + 65 * 60_000)(crystal),
    ],
  };
}

/** One Post for both quads: the sheet store is the page's, and the pair shares the page. */
const TWO = twoLakes();

function TopStrip() {
  const [post] = useState(() => {
    setSheet(TWO);
    return TWO;
  });
  const [added, setAdded] = useState<string | null>(null);
  return (
    <div className="flex h-13 items-stretch border-0 border-b border-solid border-line pl-(--space-5_5)">
      <span className="mr-(--space-5_5) self-center text-kick leading-none font-medium tracking-head text-fg2 uppercase">
        New report
      </span>
      <AnotherReport activeReportId={post.reports[0]?.id ?? ''} onAdded={setAdded} />
      <span className="ml-auto self-center pr-(--space-4) text-assist text-fg3">
        {added ? 'Added a report' : ''}
      </span>
    </div>
  );
}

/** 5.16 / 5.17: Another report — the same lake another time, or a different lake. */
export const AnotherReportMenu: Story = {
  render: () => <SkaterPair height="16rem">{() => <TopStrip />}</SkaterPair>,
  play: async ({ canvasElement }) => {
    const quad = must(canvasElement.querySelector<HTMLElement>('[data-mode="dark"]'));
    const trigger = within(quad).getByRole('button', { name: /Another report/ });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const body = within(document.body);
    // The plate fades in: read it once it has.
    const same = await body.findByRole('menuitem', { name: /^Mascoma Lake, another time/ });
    await waitFor(() => expect(same).toBeVisible());
    await expect(body.getByRole('menuitem', { name: /^A different lake/ })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  },
};

function TileDemo({ container }: { container: HTMLElement | null }) {
  const [post] = useState(() => {
    setSheet(TWO);
    return TWO;
  });
  const report = post.reports[0];
  return (
    <SheetContainerProvider value={container}>
      <ConsoleModeProvider>
        <div className="p-(--space-6)">
          <div className="relative size-15.5 rounded-control border border-solid border-line bg-raise">
            <PhotoTileMenu
              photo={report?.photos[0] ?? photo('a')}
              reportId={report?.id ?? null}
              trigger={
                <span className="absolute top-1 left-1 h-3.5 min-w-3.5 bg-fg1 px-0.5 text-center font-(family-name:--family-mono) text-[0.5625rem] leading-3.5 text-bg">
                  1
                </span>
              }
            />
          </div>
        </div>
      </ConsoleModeProvider>
    </SheetContainerProvider>
  );
}

/** 5.19 / 5.20: a tile's menu — which lake, place it, this is a hazard, leave it out. */
export const PhotoTile: Story = {
  render: () => (
    <SkaterPair height="22rem">
      {(_mode, container) => <TileDemo container={container} />}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const quad = must(canvasElement.querySelector<HTMLElement>('[data-mode="light"]'));
    const trigger = within(quad).getByRole('button', { name: 'This photo’s lake and options' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const menu = within(quad);
    const crystal = await menu.findByRole('menuitem', { name: /Crystal Lake/ });
    await waitFor(() => expect(crystal).toBeVisible());
    await expect(menu.getByText('This photo is from')).toBeInTheDocument();
    await expect(menu.getByRole('menuitem', { name: 'This is a hazard…' })).toBeVisible();
    await userEvent.keyboard('{Escape}');
  },
};

// ── 5.21, 5.17.1, 5.2, 5.22 ──────────────────────────────────────────────────────────────────

/** 5.21: From Google Photos, idle, then waiting on Google's window with its Cancel. */
export const GooglePhotos: Story = {
  render: () => (
    <SkaterPair height="12rem">
      {() => (
        <div className="flex w-[29.25rem] flex-wrap items-center gap-(--space-1_5) p-(--space-6)">
          <GooglePhotosView phase="idle" error={null} onStart={fn()} onCancel={fn()} />
          <GooglePhotosView phase="waiting" error={null} onStart={fn()} onCancel={fn()} />
        </div>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const q = within(must(canvasElement.querySelector<HTMLElement>('[data-mode="dark"]')));
    await expect(q.getByText('Waiting for Google Photos…')).toBeVisible();
    await userEvent.tab();
    await expect(document.activeElement?.getAttribute('data-attr')).toBe('google-photos');
    await userEvent.tab();
    await expect(document.activeElement?.getAttribute('data-attr')).toBe('google-photos-cancel');
  },
};

/** 5.17.1: photos from several lakes and days — the line over the tabs they started. */
export const SortedIntoTabs: Story = {
  render: () => (
    <SkaterPair height="10rem">
      {() => (
        <div className="w-[29.25rem] p-(--space-6)">
          <PhotoSortNote
            note="Your 8 photos were taken on three lakes over two days, so they start three reports, one per tab. A photo’s number is its tab."
            onDismiss={fn()}
          />
        </div>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const q = within(must(canvasElement.querySelector<HTMLElement>('[data-mode="light"]')));
    const note = q.getByRole('status');
    await expect(getComputedStyle(note).borderRadius).toBe('0px');
    await userEvent.tab();
    await expect(document.activeElement?.getAttribute('aria-label')).toBe('Dismiss');
  },
};

/** 5.2, GPX on: choose a file; reading; the server's refusal in its own words. */
export const GpxDropZone: Story = {
  render: () => (
    <SkaterPair height="12rem">
      {() => (
        <div className="flex gap-(--space-8) p-(--space-6)">
          <GpxImportView busy={false} error={null} onFile={fn()} />
          <GpxImportView busy error={null} onFile={fn()} />
          <GpxImportView
            busy={false}
            error="That skate ended more than 7 days ago, so it can't become a report."
            onFile={fn()}
          />
        </div>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const q = within(must(canvasElement.querySelector<HTMLElement>('[data-mode="dark"]')));
    await expect(q.getByRole('alert')).toHaveTextContent(/more than 7 days ago/);
    await userEvent.tab();
    await expect(document.activeElement?.getAttribute('data-attr')).toBe('gpx-choose');
  },
};

/** 5.22: the weather, corrected — the archive's hour as the start, the author's words over it. */
export const WeatherCorrect: Story = {
  render: () => (
    <SkaterPair height="16rem">
      {() => (
        <div className="w-[34rem] p-(--space-6)">
          <WeatherCorrection
            initial={{
              airTempC: -8.9,
              windSpeedKph: 22.5,
              windDir: 'NW',
              sky: 'partly_cloudy',
              precip: 'snow',
              source: 'user',
            }}
            onChange={fn()}
            onDone={fn()}
          />
        </div>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const q = within(must(canvasElement.querySelector<HTMLElement>('[data-mode="light"]')));
    await expect(q.getByLabelText('Air °F')).toHaveValue('16');
    await expect(q.getByRole('button', { name: 'Snow' })).toHaveAttribute('aria-pressed', 'true');
    const panel = must(
      canvasElement.querySelector<HTMLElement>('[data-slot="weather-correction"]'),
    );
    await expect(getComputedStyle(panel).borderRadius).toBe('0px');
    await userEvent.tab();
    await expect(document.activeElement).toBe(
      canvasElement.querySelector('[data-mode="dark"] input'),
    );
  },
};

// ── 5.10.1: Report a hazard, stacked in the report ───────────────────────────────────────────

/** 5.10.1 (and 3.1's frame): the hazard's sheet inset in the report, over the report's header. */
export const HazardStacked: Story = {
  render: () => (
    <SkaterPair height="40rem">
      {() => (
        <div className="relative size-full bg-bg">
          <div className="flex h-13 items-center border-0 border-b border-solid border-line pl-(--space-5_5) text-kick font-medium tracking-head text-fg2 uppercase">
            New report
          </div>
          <div className="absolute inset-0 bg-scrim" />
          <div
            data-slot="hazard-sheet"
            data-stacked=""
            className="absolute top-3.5 right-4.5 bottom-3.5 left-4.5 overflow-hidden border border-solid border-line2 bg-bg shadow-modal"
          >
            <HazardSheetChrome
              name="Mascoma Lake"
              onClose={fn()}
              map={<div className="absolute inset-0 bg-panel" />}
            >
              <HazardFlowView
                draft={chooseType(startDraft('mascoma', true), 'thin_ice')}
                photos={[]}
                lostPhotos={0}
                nudge={null}
                error={null}
                submitting={false}
                onChooseType={fn()}
                onClearType={fn()}
                onChooseDrawKind={fn()}
                onStopPlacing={fn()}
                onUndo={fn()}
                onFlipShore={fn()}
                onResize={fn()}
                onNoteChange={fn()}
                onAddPhotos={fn()}
                onRemovePhoto={fn()}
                onConfirmNearby={fn()}
                onFileDistinct={fn()}
                onPost={fn()}
                onCancel={fn()}
              />
            </HazardSheetChrome>
          </div>
        </div>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const quad = must(canvasElement.querySelector<HTMLElement>('[data-mode="dark"]'));
    const q = within(quad);
    await expect(q.getByText('Report a hazard')).toBeVisible();
    // The stacked sheet covers the report's header (Review 4).
    const top = must(quad.querySelector<HTMLElement>('[data-slot="hazard-sheet"]'));
    await expect(top.getBoundingClientRect().top).toBeLessThan(
      quad.getBoundingClientRect().top + 52,
    );
    await expect(getComputedStyle(top).borderRadius).toBe('0px');
    await userEvent.tab();
    await expect(document.activeElement?.getAttribute('data-attr')).toBe('hazard-sheet-close');
  },
};
