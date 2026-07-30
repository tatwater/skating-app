import {
  applyDraftMapClick,
  draftForType,
  HAZARD_DEFAULT_BUFFER_M,
  HAZARD_DEFAULT_RADIUS_M,
  type HazardDraft,
  type HazardType,
  resizeDraft,
  switchDraftKind,
} from '@skating/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { HazardFormFields, type ShoreBandState } from './HazardForm';

const A = { lat: 44.4759, lng: -73.2121 };
const B = { lat: 44.481, lng: -73.204 };
const C = { lat: 44.486, lng: -73.199 };

/**
 * Renders the authoring fields with live draft state, so a test can drive the real transitions the
 * form drives. `place` stands in for the map clicks the fields themselves never handle (MapView owns
 * the canvas) — the fields only ever *request* placement.
 */
function renderFields(
  initial: {
    type?: HazardType | null;
    draft?: HazardDraft | null;
    photos?: { id: string; previewUrl: string; placeOnMap: boolean }[];
    shore?: Partial<ShoreBandState>;
  } = {},
) {
  const spies = {
    onRequestPlace: vi.fn(),
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    onAddFiles: vi.fn(),
    onRemovePhoto: vi.fn(),
    onStartSnap: vi.fn(),
    onFlipSnap: vi.fn(),
  };
  let latest: { type: HazardType | null; draft: HazardDraft | null };
  function Wrapper() {
    const [type, setType] = useState<HazardType | null>(initial.type ?? null);
    const [draft, setDraft] = useState<HazardDraft | null>(initial.draft ?? null);
    latest = { type, draft };
    return (
      <HazardFormFields
        type={type}
        draft={draft}
        description=""
        error={null}
        submitting={false}
        photos={initial.photos ?? []}
        shore={{
          offered: false,
          deriving: false,
          halfWidthMeters: 25,
          haloMeters: 10,
          arcLengthMeters: null,
          error: null,
          onStart: spies.onStartSnap,
          onFlip: spies.onFlipSnap,
          ...initial.shore,
        }}
        onChooseType={(next) => {
          setType(next);
          setDraft(draftForType(next));
        }}
        onChooseKind={(kind) => {
          if (draft && type) setDraft(switchDraftKind(draft, kind, type));
        }}
        onDraftChange={setDraft}
        onResize={(direction) => {
          if (draft) setDraft(resizeDraft(draft, direction));
        }}
        onDescriptionChange={() => {}}
        onRequestPlace={spies.onRequestPlace}
        onSubmit={spies.onSubmit}
        onCancel={spies.onCancel}
        onAddFiles={spies.onAddFiles}
        onRemovePhoto={spies.onRemovePhoto}
      />
    );
  }
  render(<Wrapper />);
  // biome-ignore lint/style/noNonNullAssertion: assigned during the synchronous first render.
  return { spies, get: () => latest! };
}

describe('primitive selection (D51)', () => {
  // The D51 thesis in one test: the drawing primitive follows the hazard's real-world shape, because
  // that's also the shape a person can actually produce accurately.
  it('puts the genuinely linear types straight into polyline mode', () => {
    const { get } = renderFields();
    fireEvent.click(screen.getByRole('button', { name: /Pressure ridge/ }));
    expect(get().draft?.geometryKind).toBe('line');
    expect(screen.getByRole('button', { name: 'Trace on map' })).toBeInTheDocument();
  });

  it('keeps blobs, holes and zones on point+radius', () => {
    const { get } = renderFields();
    fireEvent.click(screen.getByRole('button', { name: /Open water/ }));
    expect(get().draft?.geometryKind).toBe('point_radius');
    expect(screen.getByRole('button', { name: 'Place on map' })).toBeInTheDocument();
  });

  it('offers every other primitive either way — all the mistakes are real', () => {
    const { get } = renderFields({
      type: 'open_water',
      draft: applyDraftMapClick(draftForType('open_water'), A),
    });
    fireEvent.click(screen.getByRole('button', { name: 'A line' }));
    expect(get().draft).toEqual({
      geometryKind: 'line',
      vertices: [A], // the spot you already knew is kept, not thrown away
      bufferMeters: HAZARD_DEFAULT_BUFFER_M.open_water,
    });
    fireEvent.click(screen.getByRole('button', { name: 'A spot' }));
    expect(get().draft?.geometryKind).toBe('point_radius');
  });

  // N5b: the primitive D51 always called opt-in and advanced. No type starts as one — reaching it is
  // always a deliberate choice, which is why `retypeDraft` refuses to take it away again.
  it('never starts a type as an area, and lets one be chosen', () => {
    const { get } = renderFields();
    fireEvent.click(screen.getByRole('button', { name: /Open water/ }));
    expect(get().draft?.geometryKind).not.toBe('polygon');
    fireEvent.click(screen.getByRole('button', { name: 'An area' }));
    expect(get().draft?.geometryKind).toBe('polygon');
  });

  it('adopts the new type’s default size when the type changes mid-draft', () => {
    const { get } = renderFields({
      type: 'open_water',
      draft: applyDraftMapClick(draftForType('open_water'), A),
    });
    fireEvent.click(screen.getByRole('button', { name: /Thin ice/ }));
    expect(get().draft).toMatchObject({ radiusMeters: HAZARD_DEFAULT_RADIUS_M.thin_ice });
  });
});

describe('polyline authoring', () => {
  function lineFields(vertices: (typeof A)[]) {
    let draft = draftForType('pressure_ridge');
    for (const v of vertices) draft = applyDraftMapClick(draft, v);
    return renderFields({ type: 'pressure_ridge', draft });
  }

  // A half-drawn line is a completely normal intermediate state — the UI has to say so plainly
  // rather than either crashing or pretending it's postable.
  it('will not post a line with a single point, and says why', () => {
    lineFields([A]);
    expect(screen.getByText(/a line needs at least two/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Post hazard' })).toBeDisabled();
  });

  it('becomes postable at two points', () => {
    lineFields([A, B]);
    expect(screen.getByText(/Traced with 2 points/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Post hazard' })).toBeEnabled();
  });

  it('undoes one point at a time', () => {
    const { get } = lineFields([A, B]);
    fireEvent.click(screen.getByRole('button', { name: 'Undo last point' }));
    expect(get().draft).toMatchObject({ vertices: [A] });
  });

  it('steps the uncertainty half-width rather than a radius', () => {
    const { get } = lineFields([A, B]);
    fireEvent.click(screen.getByRole('button', { name: 'Wider' }));
    const draft = get().draft;
    expect(draft?.geometryKind).toBe('line');
    expect(draft && 'bufferMeters' in draft ? draft.bufferMeters : 0).toBeGreaterThan(
      HAZARD_DEFAULT_BUFFER_M.pressure_ridge,
    );
  });

  // D3: the width is an uncertainty band, and the copy has to read as one. A folded ridge is loose
  // plates metres wide; a hairline crack is centimetres. Neither is a surveyed edge.
  it('describes the width as an estimate to either side, never an edge', () => {
    lineFields([A, B]);
    expect(screen.getByText(/to either side of the line/)).toBeInTheDocument();
    expect(screen.getByText(/not an exact edge/)).toBeInTheDocument();
  });
});

describe('point+radius authoring', () => {
  it('is postable as soon as it has a centre — the two-tap guarantee', () => {
    renderFields({
      type: 'open_water',
      draft: applyDraftMapClick(draftForType('open_water'), A),
    });
    expect(screen.getByRole('button', { name: 'Post hazard' })).toBeEnabled();
  });

  it('is not postable before it is placed', () => {
    renderFields({ type: 'open_water', draft: draftForType('open_water') });
    expect(screen.getByText('Not placed yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Post hazard' })).toBeDisabled();
  });

  it('steps the radius', () => {
    const { get } = renderFields({
      type: 'open_water',
      draft: applyDraftMapClick(draftForType('open_water'), A),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Bigger' }));
    const draft = get().draft;
    expect(draft && 'radiusMeters' in draft ? draft.radiusMeters : 0).toBeGreaterThan(
      HAZARD_DEFAULT_RADIUS_M.open_water,
    );
  });
});

describe('photos', () => {
  // Ice hazards are intensely visual and notoriously hard to describe — "folded ridges are hard to
  // see" is a recurring cause of death (research §2/§6) — so the photo affordance has to be present
  // and obviously optional, not buried.
  it('offers photos, and says why they help', () => {
    renderFields({ type: 'open_water', draft: draftForType('open_water') });
    expect(screen.getByLabelText('Photos (optional)')).toBeInTheDocument();
    expect(screen.getByText(/helps the next skater recognise it/)).toBeInTheDocument();
  });

  it('never blocks posting on a photo', () => {
    renderFields({
      type: 'open_water',
      draft: applyDraftMapClick(draftForType('open_water'), A),
    });
    expect(screen.getByRole('button', { name: 'Post hazard' })).toBeEnabled();
  });

  it('previews attached photos and lets each be removed', () => {
    const { spies } = renderFields({
      type: 'open_water',
      draft: applyDraftMapClick(draftForType('open_water'), A),
      photos: [{ id: 'p1', previewUrl: 'blob:one', placeOnMap: false }],
    });
    expect(screen.getByAltText('Upload preview')).toHaveAttribute('src', 'blob:one');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(spies.onRemovePhoto).toHaveBeenCalledWith('p1');
  });

  // A hazard already *has* a location. Offering a second, EXIF-derived one would invite a photo's
  // coord to contradict the footprint the proximity alert measures against.
  it('has no place-on-map control — the hazard already has a location', () => {
    renderFields({
      type: 'open_water',
      draft: applyDraftMapClick(draftForType('open_water'), A),
      photos: [{ id: 'p1', previewUrl: 'blob:one', placeOnMap: false }],
    });
    expect(screen.queryByText(/Place this photo/)).not.toBeInTheDocument();
  });
});

describe('freeform area authoring (N5b)', () => {
  function areaFields(corners: (typeof A)[]) {
    let draft = switchDraftKind(draftForType('thawed_rotten'), 'polygon', 'thawed_rotten');
    for (const c of corners) draft = applyDraftMapClick(draft, c);
    return renderFields({ type: 'thawed_rotten', draft });
  }

  it('will not post an area with two corners, and says why', () => {
    areaFields([A, B]);
    expect(screen.getByText(/an area needs at least three/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Post hazard' })).toBeDisabled();
  });

  it('becomes postable at three', () => {
    areaFields([A, B, C]);
    expect(screen.getByText(/Drawn with 3 corners/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Post hazard' })).toBeEnabled();
  });

  // Corners are dragged on the map by terra-draw, not popped from a list — offering "undo" here
  // would be a second, disagreeing way to edit the same ring.
  it('sends you back to the map to adjust rather than offering an undo', () => {
    const { spies } = areaFields([A, B, C]);
    expect(screen.queryByRole('button', { name: 'Undo last point' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Adjust corners' }));
    expect(spies.onRequestPlace).toHaveBeenCalled();
  });

  it('describes the width as give around the edge, never a surveyed one', () => {
    areaFields([A, B, C]);
    expect(screen.getByText(/of give around the edge/)).toBeInTheDocument();
    expect(screen.getByText(/not an exact edge/)).toBeInTheDocument();
  });
});

describe('snap to shoreline (N5b)', () => {
  it('is offered for a shore-shaped type', () => {
    renderFields({
      type: 'thin_ice',
      draft: draftForType('thin_ice'),
      shore: { offered: true },
    });
    expect(screen.getByRole('button', { name: 'Along the shore' })).toBeInTheDocument();
    expect(screen.getByText(/follows the lake’s own outline/)).toBeInTheDocument();
  });

  it('is absent for a type that isn’t shore-shaped', () => {
    // A ridge is linear but not shore-*shaped*; snapping one to a shoreline would be offering the
    // wrong geometry, confidently.
    renderFields({
      type: 'pressure_ridge',
      draft: draftForType('pressure_ridge'),
      shore: { offered: false },
    });
    expect(screen.queryByRole('button', { name: 'Along the shore' })).not.toBeInTheDocument();
  });

  it('shows how much shoreline the band covers, and offers the other way round', () => {
    let draft = switchDraftKind(draftForType('thin_ice'), 'polygon', 'thin_ice');
    for (const c of [A, B, C]) draft = applyDraftMapClick(draft, c);
    const { spies } = renderFields({
      type: 'thin_ice',
      draft,
      shore: { offered: true, deriving: true, arcLengthMeters: 1240, halfWidthMeters: 25 },
    });
    expect(screen.getByText(/Following 1240 m of shoreline/)).toBeInTheDocument();
    // Decision 4: shorter is right almost always and silently wrong on a small pond, so the flip is
    // a control rather than an inference.
    fireEvent.click(screen.getByRole('button', { name: 'Go the other way round' }));
    expect(spies.onFlipSnap).toHaveBeenCalled();
  });

  // Decision 3's "one stepper, two meanings": on a snapped band it is the distance out from shore,
  // not a halo around a shape someone drew.
  it('labels the stepper as distance out from shore while snapped', () => {
    let draft = switchDraftKind(draftForType('thin_ice'), 'polygon', 'thin_ice');
    for (const c of [A, B, C]) draft = applyDraftMapClick(draft, c);
    renderFields({
      type: 'thin_ice',
      draft,
      shore: {
        offered: true,
        deriving: true,
        arcLengthMeters: 800,
        halfWidthMeters: 25,
        haloMeters: HAZARD_DEFAULT_BUFFER_M.thin_ice,
      },
    });
    expect(screen.getByText(/about 25 m out from the shoreline/)).toBeInTheDocument();
    expect(screen.getByText(/part that falls on land is trimmed off/)).toBeInTheDocument();
  });

  /**
   * The band is the one primitive whose stepper number is **not** the whole footprint: `hazardFootprint`
   * adds the type's uncertainty margin outside the derived ring (D67), so 25 m out warns from 35 m. That
   * is two quantities rather than one applied twice — a claim about the ice, plus the margin every
   * hazard gets — but left unsaid it reads as a footprint bigger than the skater was told, and a
   * reviewer read exactly that as a double-buffer bug. So the total is on screen.
   */
  it('names the distance that actually warns, not just the band half-width', () => {
    renderFields({
      type: 'thin_ice',
      draft: switchDraftKind(draftForType('thin_ice'), 'polygon', 'thin_ice'),
      shore: {
        offered: true,
        deriving: true,
        halfWidthMeters: 25,
        haloMeters: 10,
        arcLengthMeters: 400,
      },
    });
    expect(
      screen.getByText('about 25 m out from the shoreline — warned to 35 m'),
    ).toBeInTheDocument();
    // And says why the two differ, in the same breath as "an estimate is fine".
    expect(screen.getByText(/estimate rather than a survey/)).toBeInTheDocument();
  });

  it('surfaces a refusal where the affordance is, and names the way out', () => {
    renderFields({
      type: 'thin_ice',
      draft: draftForType('thin_ice'),
      shore: {
        offered: true,
        error: 'Those two points are on different shorelines — an island and the main shore.',
      },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/different shorelines/);
    // The other two primitives are still right there, which is what makes a refusal survivable for
    // someone standing on ice with a hazard to file.
    expect(screen.getByRole('button', { name: 'A line' })).toBeInTheDocument();
  });

  /**
   * The review fix: a refused band must keep every control that could rescue it.
   *
   * The commonest refusal is a band wide enough to close on itself — two ends nearly all the way round
   * a small pond, which is exactly the case Decision 4's "go the other way" exists for. Narrowing fixes
   * it at the same two ends. So the stepper has to still be the band's half-width while the refusal is
   * on screen, and the flip has to still be offered: a refusal with no way through is worse than no
   * affordance, for someone standing on ice with a hazard to file.
   */
  it('keeps the width stepper on the band, and the flip offered, through a refusal', () => {
    const { spies } = renderFields({
      type: 'thin_ice',
      // A first refused snap leaves the draft the circle it started as — so this must not key off the
      // draft being a polygon.
      draft: draftForType('thin_ice'),
      shore: {
        offered: true,
        deriving: true,
        halfWidthMeters: 25,
        arcLengthMeters: null,
        error: 'Couldn’t make a clean band along that stretch of shore — it closes on itself.',
      },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/closes on itself/);
    expect(screen.getByText(/about 25 m out from the shoreline/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Narrower' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Go the other way round' }));
    expect(spies.onFlipSnap).toHaveBeenCalled();
  });

  // A ring nobody tapped has no corner count worth reporting — and quoting one would imply the stepper
  // and the undo apply to it.
  it('describes a band being derived as a stretch of shore, never as corners', () => {
    renderFields({
      type: 'open_water',
      draft: switchDraftKind(draftForType('open_water'), 'polygon', 'open_water'),
      shore: { offered: true, deriving: true, halfWidthMeters: 25, arcLengthMeters: null },
    });
    expect(screen.getByText(/Picking a stretch of shore/)).toBeInTheDocument();
    // No corner *count*. The "adjusting the corners takes it off the shoreline" hint stays — that one
    // is about what happens next, not a claim about placements someone made.
    expect(screen.queryByText(/Drawn with \d+ corner/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo last point' })).not.toBeInTheDocument();
  });
});
