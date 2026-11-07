import type { LatLng, TimelineStop } from '@skating/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { Polygon } from 'geojson';
import { type ReactNode, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import type { HazardDraft } from '@/stores/hazardDraftStore';

import { must } from '../../kit/storyKit';
import { ActionPane } from '../lake/ActionPane';
import { LakeSidebar, SidebarBody } from '../lake/LakeSidebar';
import { MASCOMA_RINGS } from '../map/mapStoryData';
import { type Mode, SkaterPair } from '../storySupport';
import { BountyView, type BountyViewProps } from './BountyPane';
import { HazardFlowView } from './HazardFlowView';
import {
  applyAreaRing,
  applyMapClick,
  chooseDrawKind,
  chooseType,
  clearType,
  flipShore,
  resize,
  startDraft,
  stopPlacing,
  undoPlacement,
} from './hazardFlowModel';
import { ImageryView } from './ImageryPane';
import { buildImageryAxis, type ImageryUrlBand, selectedStopFor } from './imageryTicks';
import { RequestLakeView } from './RequestLakePane';

/**
 * The Explore actions (row 3: boards 3.1–3.15) on the skater surface, dark and light. The panes are
 * the real compositions driven by the flow's own model; the map beside them is the map's stories
 * (the flow drives it through its spec). Real data: Mascoma Lake's outline and its two bays; the
 * people, the nearby hazard and the passes are invented; "today" is Saturday 16 January 2027.
 */
const meta = {
  title: 'Skater/Explore actions',
  globals: { surface: 'skater', mode: 'light' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────

const OUTER = (MASCOMA_RINGS[0] ?? []) as unknown as number[][];
const POLY: Polygon = { type: 'Polygon', coordinates: [OUTER] };
const shore = (i: number): LatLng => {
  const p = OUTER[Math.floor(OUTER.length * i)] ?? [0, 0];
  return { lng: p[0] as number, lat: p[1] as number };
};

const fresh = startDraft('mascoma', false);
const DRAFTS: Record<string, HazardDraft> = {
  what: fresh,
  spot: chooseDrawKind(chooseType(fresh, 'thin_ice'), 'spot'),
  line: [
    { lat: 43.6286, lng: -72.15316 },
    { lat: 43.6292, lng: -72.1497 },
    { lat: 43.62985, lng: -72.14641 },
  ].reduce((d, c) => applyMapClick(d, c, POLY), chooseType(fresh, 'pressure_ridge')),
  area: applyAreaRing(chooseDrawKind(chooseType(fresh, 'thin_ice'), 'area'), [
    { lat: 43.61347, lng: -72.13242 },
    { lat: 43.61275, lng: -72.12847 },
    { lat: 43.60966, lng: -72.1293 },
    { lat: 43.61049, lng: -72.13325 },
  ]),
  shore: applyMapClick(chooseDrawKind(chooseType(fresh, 'open_water'), 'shore'), shore(0.1), POLY),
};
DRAFTS.details = {
  ...stopPlacing(
    applyMapClick(DRAFTS.line as HazardDraft, { lat: 43.63027, lng: -72.14394 }, POLY),
  ),
  note: 'Folded ridge about knee high, wet seam on the Wood Island end. Easiest place over it is by the west shore.',
};
DRAFTS.nearby = {
  ...applyMapClick(chooseType(fresh, 'open_water'), { lat: 43.6334, lng: -72.1556 }, POLY),
  nearbyHazardId: 'h_narrows',
  step: 'confirm',
};

const DAY = 86_400_000;
const START = Date.UTC(2026, 10, 16, 15, 30);
function pass(day: number, landable: boolean, band: string, clear = 0.97): TimelineStop {
  return {
    frame: {
      granuleId: `g${day}`,
      capturedAt: new Date(START + day * DAY).toISOString(),
      cloudCoverPct: band === 'vh' ? null : landable ? 3 : 94,
      bodies: 1,
      band,
      key: `k${day}`,
      footprint: { type: 'Polygon', coordinates: [] },
    } as unknown as TimelineStop['frame'],
    landable,
    basis: 'measured',
    ...(landable ? {} : { blockedBy: 'cloud' as const }),
    ...(band === 'visual'
      ? {
          stats: {
            waterBodyId: 'mascoma',
            coveragePct: 1,
            clearPct: landable ? clear : 0.06,
          } as TimelineStop['stats'],
        }
      : {}),
  };
}
const USABLE_TC = [1, 4, 9, 12, 13, 18, 22, 27, 31, 36, 40, 41, 47, 55, 58];
const TC = Array.from({ length: 62 }, (_, d) => d)
  .filter((d) => USABLE_TC.includes(d) || d % 3 === 0 || d % 5 === 1)
  .map((d) => pass(d, USABLE_TC.includes(d), 'visual'));
const VH = [0, 6, 12, 18, 24, 30, 36, 42, 48, 54, 60].map((d) => pass(d, true, 'vh'));

// ── Frames ────────────────────────────────────────────────────────────────────────────────────

const darkQuad = (root: HTMLElement) =>
  must(root.querySelector<HTMLElement>('section[data-mode="dark"]'));

/** The sidebar column an action opens in, beside a blank map plate. */
function SidebarFrame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid h-full grid-cols-[27.5rem_minmax(0,1fr)]">
      <LakeSidebar label={label} body={<SidebarBody>{children}</SidebarBody>} />
      <div aria-hidden="true" className="bg-raise" />
    </div>
  );
}

/** The hazard pane, live: the screen drives the flow's own model, so the keys can walk it. */
function HazardStory({
  initial,
  container,
  nudge = false,
  lostPhotos = 0,
}: {
  initial: HazardDraft;
  container: HTMLElement | null;
  nudge?: boolean;
  lostPhotos?: number;
}) {
  const [draft, setDraft] = useState(initial);
  const change = (f: (d: HazardDraft) => HazardDraft) => setDraft((d) => f(d));
  return (
    <SidebarFrame label="Mascoma Lake">
      <ActionPane act="hazard" backTo="Mascoma Lake" onBack={fn()} autoFocus={false}>
        <HazardFlowView
          draft={draft}
          photos={[]}
          lostPhotos={lostPhotos}
          nudge={
            nudge
              ? {
                  text: 'There is already an open water / lead marked here — reported 2 days ago.',
                }
              : null
          }
          error={null}
          submitting={false}
          container={container}
          onChooseType={(t) => change((d) => chooseType(d, t))}
          onClearType={() => change(clearType)}
          onChooseDrawKind={(k) => change((d) => chooseDrawKind(d, k))}
          onStopPlacing={() => change(stopPlacing)}
          onUndo={() => change(undoPlacement)}
          onFlipShore={() => change((d) => flipShore(d, POLY))}
          onResize={(dir) => change((d) => resize(d, dir, POLY))}
          onNoteChange={(note) => change((d) => ({ ...d, note }))}
          onAddPhotos={fn()}
          onRemovePhoto={fn()}
          onConfirmNearby={fn()}
          onFileDistinct={fn()}
          onPost={fn()}
          onCancel={fn()}
        />
      </ActionPane>
    </SidebarFrame>
  );
}

const pair = (render: (mode: Mode, container: HTMLElement | null) => ReactNode) => (
  <SkaterPair height="56rem">{render}</SkaterPair>
);

// ── The hazard flow (3.1–3.8) ─────────────────────────────────────────────────────────────────

/** 3.1 — What did you see: the three most-reported as tiles, every other danger, then a crossing. */
export const HazardWhatDidYouSee: Story = {
  render: () =>
    pair((_mode, c) => <HazardStory initial={DRAFTS.what as HazardDraft} container={c} />),
  play: async ({ canvasElement }) => {
    const q = within(darkQuad(canvasElement));
    const tile = q.getByRole('button', { name: 'Pressure ridge' });
    tile.focus();
    await userEvent.keyboard('{Enter}');
    // Picked: the type alone, with the × that starts over; the map is listening for a line.
    await expect(q.getByRole('button', { name: 'Pick a different type' })).toBeVisible();
    await expect(q.getByRole('button', { name: 'A line' })).toHaveAttribute('aria-pressed', 'true');
    await expect(q.getByRole('button', { name: 'Post hazard' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  },
};

/** 3.2 — Placing a spot: the map is the input; the rest steps back. The shore chip explains itself. */
export const HazardPlacingASpot: Story = {
  render: () =>
    pair((_mode, c) => <HazardStory initial={DRAFTS.spot as HazardDraft} container={c} />),
  play: async ({ canvasElement }) => {
    const q = within(darkQuad(canvasElement));
    await expect(q.getByText('Not placed yet.')).toBeVisible();
    const listening = must(
      darkQuad(canvasElement).querySelector('[data-slot="hazard-question"][data-listening]'),
    );
    await expect(listening).toHaveTextContent('Where is it?');
    // A sub-mode is left by a click: another chip.
    q.getByRole('button', { name: 'A line' }).focus();
    await userEvent.keyboard(' ');
    await expect(q.getByRole('button', { name: 'A line' })).toHaveAttribute('aria-pressed', 'true');
  },
};

/** 3.3 / 3.4 — Tracing a line: Undo point and Done while the map listens. */
export const HazardTracingALine: Story = {
  render: () =>
    pair((_mode, c) => <HazardStory initial={DRAFTS.line as HazardDraft} container={c} />),
  play: async ({ canvasElement }) => {
    const q = within(darkQuad(canvasElement));
    await expect(q.getByText('Traced with 3 points.')).toBeVisible();
    q.getByRole('button', { name: 'Undo point' }).focus();
    await userEvent.keyboard('{Enter}');
    await expect(q.getByText('Traced with 2 points.')).toBeVisible();
    q.getByRole('button', { name: 'Done' }).focus();
    await userEvent.keyboard('{Enter}');
    await expect(q.getByRole('button', { name: 'Keep tracing' })).toBeVisible();
    await expect(q.getByRole('button', { name: 'Post hazard' })).not.toHaveAttribute(
      'aria-disabled',
    );
  },
};

/** 3.5 — Drawing an area: four corners, any of them draggable on the map, then Done. */
export const HazardDrawingAnArea: Story = {
  render: () =>
    pair((_mode, c) => <HazardStory initial={DRAFTS.area as HazardDraft} container={c} />),
  play: async ({ canvasElement }) => {
    const q = within(darkQuad(canvasElement));
    await expect(q.getByText('Drawn with 4 corners.')).toBeVisible();
    await expect(q.queryByRole('button', { name: 'Undo point' })).toBeNull();
    q.getByRole('button', { name: 'Done' }).focus();
    await userEvent.keyboard('{Enter}');
    await expect(q.getByRole('button', { name: 'Adjust corners' })).toBeVisible();
  },
};

/** 3.6 — Along the shore: two clicks, then "Long way around" ↔ "Shortest distance". */
export const HazardAlongTheShore: Story = {
  render: () =>
    pair((_mode, c) => (
      <HazardStory
        initial={applyMapClick(DRAFTS.shore as HazardDraft, shore(0.18), POLY)}
        container={c}
      />
    )),
  play: async ({ canvasElement }) => {
    const q = within(darkQuad(canvasElement));
    await expect(q.getByText(/Following about [\d,]+ ft of shoreline\./)).toBeVisible();
    const toggle = q.getByRole('button', { name: 'Long way around' });
    toggle.focus();
    await userEvent.keyboard('{Enter}');
    await expect(q.getByRole('button', { name: 'Shortest distance' })).toBeVisible();
    await userEvent.keyboard('{Enter}');
    await expect(q.getByRole('button', { name: 'Long way around' })).toBeVisible();
  },
};

/** 3.7 — Size, photos and note: placed, so everything opens; the size explains itself on hover. */
export const HazardSizePhotosAndNote: Story = {
  render: () =>
    pair((_mode, c) => <HazardStory initial={DRAFTS.details as HazardDraft} container={c} />),
  play: async ({ canvasElement }) => {
    const q = within(darkQuad(canvasElement));
    const wider = q.getByRole('button', { name: 'Wider' });
    const before = must(
      darkQuad(canvasElement).querySelector('[data-slot="hazard-size"]'),
    ).textContent;
    wider.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(
        must(darkQuad(canvasElement).querySelector('[data-slot="hazard-size"]')).textContent,
      ).not.toBe(before),
    );
    const note = q.getByRole('textbox', { name: 'Anything worth adding?' });
    await expect(note).toHaveClass('ph-no-capture');
    await expect(q.getByRole('button', { name: 'Add' })).toBeVisible();
  },
};

/** 3.8 — Confirm the nearby one: the outcome that helps most is primary; the way past is one tap. */
export const HazardConfirmTheNearbyOne: Story = {
  render: () =>
    pair((_mode, c) => <HazardStory initial={DRAFTS.nearby as HazardDraft} container={c} nudge />),
  play: async ({ canvasElement }) => {
    const q = within(darkQuad(canvasElement));
    await expect(q.getByRole('alert')).toHaveTextContent(
      /already an open water \/ lead marked here/,
    );
    q.getByRole('button', { name: 'Confirm that one' }).focus();
    await userEvent.tab();
    await expect(q.getByRole('button', { name: 'No, this is a different hazard' })).toHaveFocus();
  },
};

/** A draft brought back after a reload: the words came, the photos couldn't. */
export const HazardRestored: Story = {
  render: () =>
    pair((_mode, c) => (
      <HazardStory initial={DRAFTS.details as HazardDraft} container={c} lostPhotos={2} />
    )),
  play: async ({ canvasElement }) => {
    await expect(
      within(darkQuad(canvasElement)).getByText(/The 2 photos you added didn’t come with it/),
    ).toBeVisible();
  },
};

// ── Bounty (3.9–3.11) ─────────────────────────────────────────────────────────────────────────

const BAYS = [
  { id: 'north', name: 'Mascoma North' },
  { id: 'south', name: 'Mascoma South' },
];

function BountyStory({
  container,
  ...props
}: Partial<BountyViewProps> & { container: HTMLElement | null }) {
  const [choice, setChoice] = useState(props.choice ?? 'north');
  return (
    <SidebarFrame label="Mascoma Lake">
      <p className="m-0 p-(--space-4) text-row text-fg2">
        Mascoma Lake’s reports, under the dialog.
      </p>
      <BountyView
        lakeName="Mascoma Lake"
        bays={BAYS}
        limit={{ limit: 3, used: 1, restricted: false }}
        refusal={null}
        pending={false}
        onPost={fn()}
        onClose={fn()}
        {...props}
        choice={choice}
        onChoose={setChoice}
        container={container}
        // Each quad's dialog stays in its quad (the kit's pattern): two modals would hide each other.
        modal={false}
      />
    </SidebarFrame>
  );
}

/** 3.9 / 3.10 — Which part: the whole lake or a bay. */
export const BountyWhichPart: Story = {
  render: () => pair((_mode, c) => <BountyStory container={c} />),
  play: async ({ canvasElement }) => {
    const q = within(darkQuad(canvasElement));
    const north = await q.findByRole('radio', { name: 'Mascoma North' });
    await expect(north).toBeChecked();
    north.focus();
    await userEvent.keyboard('{ArrowDown}');
    await expect(q.getByRole('radio', { name: 'Mascoma South' })).toBeChecked();
    await expect(q.getByRole('button', { name: 'Post bounty' })).toBeEnabled();
  },
};

/** 3.11 — Refused: the server's reason, as it says it; Post waits for a different ask. */
export const BountyRefused: Story = {
  render: () =>
    pair((_mode, c) => (
      <BountyStory
        container={c}
        choice="south"
        refusal="Mascoma South already has fresh eyes — no bounty needed"
      />
    )),
  play: async ({ canvasElement }) => {
    const q = within(darkQuad(canvasElement));
    await expect(await q.findByRole('alert')).toHaveTextContent('already has fresh eyes');
    await expect(q.getByRole('button', { name: 'Post bounty' })).toBeDisabled();
  },
};

/** The limit, known before pressing. */
export const BountyAtTheLimit: Story = {
  render: () =>
    pair((_mode, c) => (
      <BountyStory container={c} limit={{ limit: 3, used: 3, restricted: false }} />
    )),
  play: async ({ canvasElement }) => {
    await expect(await within(darkQuad(canvasElement)).findByRole('alert')).toHaveTextContent(
      /You already have 3 open bounties/,
    );
  },
};

// ── Request a lake (3.13) ─────────────────────────────────────────────────────────────────────

/** The request dialog over the lakes in view, its note live. */
function RequestStory({ container }: { container: HTMLElement | null }) {
  const [note, setNote] = useState('');
  return (
    <SidebarFrame label="In view">
      <p className="m-0 p-(--space-4) text-row text-fg2">The lakes in view, under the dialog.</p>
      <RequestLakeView
        coord={{ lat: 43.6317, lng: -72.0859 }}
        note={note}
        error={null}
        pending={false}
        container={container}
        modal={false}
        onNoteChange={setNote}
        onSend={fn()}
        onClose={fn()}
      />
    </SidebarFrame>
  );
}

/** 3.13 — A click on unlisted water: what you're pointing at, and a note for the moderators. */
export const RequestALake: Story = {
  render: () => pair((_mode, c) => <RequestStory container={c} />),
  play: async ({ canvasElement }) => {
    const q = within(darkQuad(canvasElement));
    await expect(await q.findByText('43.6317° N, 72.0859° W')).toBeVisible();
    const note = q.getByLabelText('Your note to the moderators');
    // Both quads open a dialog; let each settle its own opening focus before typing into one.
    await waitFor(() =>
      expect(document.activeElement?.closest('[data-slot="request-lake"]')).not.toBeNull(),
    );
    await userEvent.click(note);
    await userEvent.keyboard('A pond behind the school');
    await expect(note).toHaveValue('A pond behind the school');
    await userEvent.tab();
    await expect(q.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await userEvent.tab();
    await expect(q.getByRole('button', { name: 'Send to the moderators' })).toHaveFocus();
  },
};

// ── Imagery (3.14 / 3.15) ─────────────────────────────────────────────────────────────────────

function ImageryStory({ band }: { band: ImageryUrlBand }) {
  const stops = band === 'tc' ? TC : VH;
  const [selected, setSelected] = useState(
    selectedStopFor(stops, band === 'tc' ? '2026-12-22' : undefined),
  );
  return (
    <SidebarFrame label="Mascoma Lake">
      <ActionPane act="imagery" backTo="Mascoma Lake" onBack={fn()} autoFocus={false}>
        <ImageryView
          band={band}
          season="winter-2026-27"
          state={{ kind: 'ready', axis: buildImageryAxis(stops, band), stops, selected }}
          onBand={fn()}
          onSelect={setSelected}
        />
      </ActionPane>
    </SidebarFrame>
  );
}

/** 3.14 — True color: tall ticks for usable days, short for hidden ones, the narrow hollow thumb. */
export const ImageryTrueColor: Story = {
  render: () => pair(() => <ImageryStory band="tc" />),
  play: async ({ canvasElement }) => {
    const quad = darkQuad(canvasElement);
    const slider = within(quad).getByRole('slider', { name: 'Freeze-up timeline' });
    await expect(quad.querySelectorAll('[data-tick="short"]').length).toBeGreaterThan(0);
    const before = slider.getAttribute('aria-valuetext');
    slider.focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(slider.getAttribute('aria-valuetext')).not.toBe(before);
    await userEvent.keyboard('{End}');
    await expect(must(quad.querySelector('[data-slot="imagery-thumb"]'))).toBeInTheDocument();
  },
};

/** 3.15 — Radar: every pass usable, so no short ticks — a day between passes simply has none. */
export const ImageryRadar: Story = {
  render: () => pair(() => <ImageryStory band="vh" />),
  play: async ({ canvasElement }) => {
    const quad = darkQuad(canvasElement);
    await expect(quad.querySelectorAll('[data-tick="short"]').length).toBe(0);
    await expect(quad.querySelectorAll('[data-tick="tall"]').length).toBe(11);
    await expect(within(quad).getByText('Rough or snow-covered ice')).toBeVisible();
    const slider = within(quad).getByRole('slider');
    slider.focus();
    await userEvent.keyboard('{Home}');
    await expect(slider).toHaveAttribute('aria-valuenow', '0');
  },
};
