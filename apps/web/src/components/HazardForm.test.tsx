import {
  applyDraftMapClick,
  draftForType,
  HAZARD_DEFAULT_BUFFER_M,
  HAZARD_DEFAULT_RADIUS_M,
  type HazardDraft,
  type HazardType,
} from '@skating/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { HazardFormFields } from './HazardForm';

const A = { lat: 44.4759, lng: -73.2121 };
const B = { lat: 44.481, lng: -73.204 };

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
  } = {},
) {
  const spies = {
    onRequestPlace: vi.fn(),
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    onAddFiles: vi.fn(),
    onRemovePhoto: vi.fn(),
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
        onChooseType={(next) => {
          setType(next);
          setDraft(draftForType(next));
        }}
        onDraftChange={setDraft}
        onDescriptionChange={() => {}}
        {...spies}
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

  it('offers the other primitive either way — both mistakes are real', () => {
    const { get } = renderFields({
      type: 'open_water',
      draft: applyDraftMapClick(draftForType('open_water'), A),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Draw it as a line instead' }));
    expect(get().draft).toEqual({
      geometryKind: 'line',
      vertices: [A], // the spot you already knew is kept, not thrown away
      bufferMeters: HAZARD_DEFAULT_BUFFER_M.open_water,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Mark a single spot instead' }));
    expect(get().draft?.geometryKind).toBe('point_radius');
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
