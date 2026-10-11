import type { Id } from '@skating/convex/dataModel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { calls, refusal, useMutation } = vi.hoisted(() => {
  const calls: { name: string; args: unknown }[] = [];
  const refusal: { next: Error | null } = { next: null };
  return {
    calls,
    refusal,
    // One spy per mutation, named by the reference the mocked `api` hands it.
    useMutation: vi.fn((ref: unknown) => {
      const name = String((ref as { _name?: string })?._name ?? ref);
      return async (args: unknown) => {
        if (refusal.next) {
          const error = refusal.next;
          refusal.next = null;
          throw error;
        }
        calls.push({ name, args });
      };
    }),
  };
});
/** What each query returns, by the name the mocked `api` gives it; anything unset is empty. */
const { queryResults, useQuery } = vi.hoisted(() => {
  const queryResults: Record<string, unknown> = {};
  return {
    queryResults,
    useQuery: vi.fn(
      (ref: unknown) => queryResults[String((ref as { _name?: string })?._name)] ?? [],
    ),
  };
});
vi.mock('convex/react', () => ({ useMutation, useQuery }));
vi.mock('@skating/convex/api', () => ({
  api: {
    landmarks: {
      create: { _name: 'create' },
      update: { _name: 'update' },
      remove: { _name: 'remove' },
      restore: { _name: 'restore' },
    },
    corpusRequests: {
      approve: { _name: 'approve' },
      decline: { _name: 'decline' },
      openLandmarkRequestsForBody: { _name: 'openLandmarkRequestsForBody' },
    },
    corpusPlaceNames: {
      openForBody: { _name: 'openForBody' },
      fileAsSpelling: { _name: 'fileAsSpelling' },
      dismiss: { _name: 'dismiss' },
    },
  },
}));

const { LandmarkTool } = await import('./LandmarkTool');
type Row = Parameters<typeof LandmarkTool>[0]['landmarks'] extends readonly (infer R)[] | undefined
  ? R
  : never;

const BODY = 'body1' as Id<'waterBodies'>;

function row(name: string, extra: Partial<Row> = {}): Row {
  return {
    _id: `lm-${name}` as Id<'bodyLandmarks'>,
    name,
    kind: 'island',
    point: { lat: 44.5, lng: -73.3 },
    aliases: [],
    prominence: 2,
    minZoom: 14,
    source: 'osm',
    externalIds: [],
    ...extra,
  } as Row;
}

function renderTool(props: Partial<Parameters<typeof LandmarkTool>[0]> = {}) {
  const handlers = {
    onArm: vi.fn(),
    onClearPoint: vi.fn(),
    onFocus: vi.fn(),
    onPromote: vi.fn(),
    onPlacePoint: vi.fn(),
    onReview: vi.fn(),
    onResult: vi.fn(),
  };
  const view = render(
    <LandmarkTool
      waterBodyId={BODY}
      landmarks={[
        row('Apple Island', { corpusMessages: 24 }),
        row('Kingsland Bay', { kind: 'bay', source: 'gnis' }),
        row('Old Pier', { kind: 'other', removedAt: 1 }),
      ]}
      armed={false}
      point={null}
      {...handlers}
      {...props}
    />,
  );
  return { ...handlers, ...view };
}

beforeEach(() => {
  calls.length = 0;
  refusal.next = null;
  for (const key of Object.keys(queryResults)) delete queryResults[key];
});

describe('LandmarkTool', () => {
  it('lists the live landmarks with their kind, source and mentions, and hides removed ones', () => {
    renderTool();
    expect(screen.getByText(/2 on the map/)).toBeInTheDocument();
    expect(screen.getByText(/island · OSM · 24 mentions/)).toBeInTheDocument();
    expect(screen.queryByText('Old Pier')).toBeNull();
    fireEvent.click(screen.getByLabelText('Removed'));
    expect(screen.getByText('Old Pier')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
  });

  it('says why a row is off the map, and keeps a catalog drop off when asked', async () => {
    renderTool({
      landmarks: [
        row('Butler Island', { removedAt: 1, catalogDroppedAt: 1 }),
        row('Gull Island', { removedAt: 1, mergedIntoId: 'lm-Gull' as Id<'bodyLandmarks'> }),
        row('Gull'),
      ],
    });
    fireEvent.click(screen.getByLabelText('Removed'));
    expect(screen.getByText(/no longer in the catalogs/)).toBeInTheDocument();
    expect(screen.getByText(/folded into its twin by a merge/)).toBeInTheDocument();
    // Only the drop offers Restore: the folded row's twin is live.
    expect(screen.getAllByRole('button', { name: 'Restore' })).toHaveLength(1);
    const keep = screen.getAllByRole('button', { name: 'Keep off' });
    expect(keep).toHaveLength(1);
    fireEvent.click(keep[0] as HTMLElement);
    await waitFor(() =>
      expect(calls).toContainEqual({ name: 'remove', args: { landmarkId: 'lm-Butler Island' } }),
    );
  });

  it('disarms a pending drop when an edit or a promotion starts', () => {
    const { onArm, onPromote } = renderTool({ armed: true });
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0] as HTMLElement);
    expect(onArm).toHaveBeenLastCalledWith(false);
    onArm.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Draw as bay' }));
    expect(onArm).toHaveBeenLastCalledWith(false);
    expect(onPromote).toHaveBeenCalled();
  });

  it('leaves another tool’s arming alone', () => {
    const { onArm } = renderTool({ armed: false });
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0] as HTMLElement);
    expect(onArm).not.toHaveBeenCalled();
  });

  it('filters by name or kind, and says when nothing matches', () => {
    renderTool();
    const filter = screen.getByPlaceholderText('Find by name, alias or kind');
    fireEvent.change(filter, { target: { value: 'kingsland' } });
    expect(screen.queryByText('Apple Island')).toBeNull();
    fireEvent.change(filter, { target: { value: 'island' } });
    expect(screen.getByText('Apple Island')).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: 'zzz' } });
    expect(screen.getByText('Nothing matches.')).toBeInTheDocument();
  });

  it('offers a bay to the chord tool, but never an island', () => {
    const { onPromote } = renderTool();
    const buttons = screen.getAllByRole('button', { name: 'Draw as bay' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0] as HTMLElement);
    expect(onPromote).toHaveBeenCalledWith(expect.objectContaining({ name: 'Kingsland Bay' }));
  });

  it('focuses the map on a landmark when its name is clicked', () => {
    const { onFocus } = renderTool();
    fireEvent.click(screen.getByText('Apple Island'));
    expect(onFocus).toHaveBeenCalledWith(expect.objectContaining({ name: 'Apple Island' }));
  });

  it('saves a dropped point with its name and spellings', async () => {
    const { onResult, onClearPoint } = renderTool({ point: { lat: 44.3, lng: -73.2 } });
    fireEvent.change(screen.getByPlaceholderText('Name — e.g. Bird Poop Rock'), {
      target: { value: 'Bird Poop Rock' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Other spellings, comma-separated \(optional\)/), {
      target: { value: 'the poop rock, , gull rock' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save landmark' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      name: 'create',
      args: {
        waterBodyId: BODY,
        name: 'Bird Poop Rock',
        kind: 'other',
        point: { lat: 44.3, lng: -73.2 },
        aliases: ['the poop rock', 'gull rock'],
      },
    });
    expect(onResult).toHaveBeenCalledWith({ tone: 'ok', text: 'Added “Bird Poop Rock”.' });
    expect(onClearPoint).toHaveBeenCalled();
  });

  it('edits a landmark in place', async () => {
    renderTool();
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0] as HTMLElement);
    expect(screen.getByText('Editing “Apple Island”')).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('Apple Island'), { target: { value: 'Apple Isle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      name: 'update',
      args: { landmarkId: 'lm-Apple Island', name: 'Apple Isle', kind: 'island', aliases: [] },
    });
  });

  it('arms a move, and the next point on the map moves it', async () => {
    const { onArm, rerender, onClearPoint } = renderTool();
    fireEvent.click(screen.getAllByRole('button', { name: 'Move' })[0] as HTMLElement);
    expect(onArm).toHaveBeenCalledWith(true);
    rerender(
      <LandmarkTool
        waterBodyId={BODY}
        landmarks={[row('Apple Island')]}
        armed
        point={{ lat: 44.6, lng: -73.4 }}
        onArm={onArm}
        onClearPoint={onClearPoint}
        onFocus={vi.fn()}
        onPromote={vi.fn()}
        onPlacePoint={vi.fn()}
        onReview={vi.fn()}
        onResult={vi.fn()}
      />,
    );
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      name: 'update',
      args: { landmarkId: 'lm-Apple Island', point: { lat: 44.6, lng: -73.4 } },
    });
  });

  it('shows a proposal on the map, flags a possible duplicate, and answers it with the landmark', async () => {
    const proposal = {
      requestId: 'req1',
      name: 'Long Point',
      coord: { lat: 44.31, lng: -73.21 },
      askers: 1,
      reportIds: [],
      createdAt: 0,
      similarLandmark: {
        landmarkId: 'lm-Long Point',
        name: 'Long Point',
        point: { lat: 44.36, lng: -73.21 },
        meters: 5_560,
      },
    };
    queryResults.openLandmarkRequestsForBody = { proposals: [proposal], more: false };
    const { onReview, rerender } = renderTool();
    fireEvent.click(screen.getByRole('button', { name: 'Long Point' }));
    expect(onReview).toHaveBeenLastCalledWith({ ask: proposal.coord, name: 'Long Point' });
    expect(screen.getByRole('link', { name: /44\.3100, -73\.2100/ })).toBeInTheDocument();
    expect(screen.getByText('Possible duplicate')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Same place' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Answer with this landmark' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      name: 'approve',
      args: { requestId: 'req1', landmarkId: 'lm-Long Point' },
    });
    // Answered: the proposal leaves the list, and its markers leave the map.
    queryResults.openLandmarkRequestsForBody = { proposals: [], more: false };
    rerender(
      <LandmarkTool
        waterBodyId={BODY}
        landmarks={[]}
        armed={false}
        point={null}
        onArm={vi.fn()}
        onClearPoint={vi.fn()}
        onFocus={vi.fn()}
        onPromote={vi.fn()}
        onPlacePoint={vi.fn()}
        onReview={onReview}
        onResult={vi.fn()}
      />,
    );
    expect(onReview).toHaveBeenLastCalledWith(null);
  });

  it('draws a pair until either end is decided, and Add moves the markers to its own proposal', () => {
    const near = { lat: 44.31, lng: -73.21 };
    const far = { lat: 44.61, lng: -73.21 };
    const base = { askers: 1, reportIds: [], createdAt: 0, name: 'Long Point' };
    const a = {
      ...base,
      requestId: 'reqA',
      coord: near,
      similarProposal: { requestId: 'reqB', name: 'Long Point', coord: far, meters: 33_000 },
    };
    const b = {
      ...base,
      requestId: 'reqB',
      coord: far,
      similarProposal: { requestId: 'reqA', name: 'Long Point', coord: near, meters: 33_000 },
    };
    queryResults.openLandmarkRequestsForBody = { proposals: [a, b], more: false };
    const { onReview, onPlacePoint, rerender } = renderTool();
    fireEvent.click(screen.getAllByRole('button', { name: 'Show both' })[0] as HTMLElement);
    expect(onReview).toHaveBeenLastCalledWith({
      ask: near,
      name: 'Long Point',
      other: { point: far, kind: 'proposal', name: 'Long Point' },
    });
    // Add on the other one: its own spot, alone.
    fireEvent.click(screen.getAllByRole('button', { name: 'Add as landmark' })[1] as HTMLElement);
    expect(onReview).toHaveBeenLastCalledWith({ ask: far, name: 'Long Point' });
    expect(onPlacePoint).toHaveBeenCalledWith(far);
    // Show the pair again, then decide the far end: the pair leaves the map.
    fireEvent.click(screen.getAllByRole('button', { name: 'Show both' })[0] as HTMLElement);
    queryResults.openLandmarkRequestsForBody = {
      proposals: [{ ...a, similarProposal: undefined }],
      more: false,
    };
    rerender(
      <LandmarkTool
        waterBodyId={BODY}
        landmarks={[]}
        armed={false}
        point={null}
        onArm={vi.fn()}
        onClearPoint={vi.fn()}
        onFocus={vi.fn()}
        onPromote={vi.fn()}
        onPlacePoint={onPlacePoint}
        onReview={onReview}
        onResult={vi.fn()}
      />,
    );
    expect(onReview).toHaveBeenLastCalledWith(null);
  });

  it('says when more proposals wait than the card holds (Greptile P2 on #84)', () => {
    const proposal = {
      requestId: 'req1',
      name: 'Bird Poop Rock',
      coord: { lat: 44.31, lng: -73.21 },
      askers: 1,
      reportIds: [],
      createdAt: 0,
    };
    queryResults.openLandmarkRequestsForBody = { proposals: [proposal], more: false };
    const { unmount } = renderTool();
    expect(screen.queryByText(/More are waiting/)).not.toBeInTheDocument();
    unmount();
    queryResults.openLandmarkRequestsForBody = { proposals: [proposal], more: true };
    renderTool();
    expect(screen.getByText(/More are waiting/)).toBeInTheDocument();
  });

  it('reports a refused write in the server’s words', async () => {
    const { ConvexError } = await import('convex/values');
    refusal.next = new ConvexError('"Apple Island" is already a landmark here');
    const { onResult } = renderTool({ point: { lat: 44.3, lng: -73.2 } });
    fireEvent.change(screen.getByPlaceholderText('Name — e.g. Bird Poop Rock'), {
      target: { value: 'Apple Island' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save landmark' }));
    await waitFor(() =>
      expect(onResult).toHaveBeenCalledWith({
        tone: 'error',
        text: '"Apple Island" is already a landmark here',
      }),
    );
  });

  it('answers a skater’s proposal by adding the landmark with the ask attached', async () => {
    queryResults.openLandmarkRequestsForBody = {
      proposals: [
        {
          requestId: 'req1',
          name: 'Bird Poop Rock',
          coord: { lat: 44.31, lng: -73.21 },
          askers: 2,
          reportIds: [],
          createdAt: 0,
        },
        {
          requestId: 'req2',
          name: 'Apple Island',
          coord: { lat: 44.5, lng: -73.3 },
          askers: 1,
          reportIds: [],
          createdAt: 0,
          existingLandmarkId: 'lm-Apple Island',
        },
      ],
      more: false,
    };
    const onPlacePoint = vi.fn();
    const { rerender } = renderTool({ onPlacePoint });
    expect(screen.getByText(/2 skaters/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add as landmark' }));
    expect(onPlacePoint).toHaveBeenCalledWith({ lat: 44.31, lng: -73.21 });
    rerender(
      <LandmarkTool
        waterBodyId={BODY}
        landmarks={[]}
        armed={false}
        point={{ lat: 44.31, lng: -73.21 }}
        onArm={vi.fn()}
        onClearPoint={vi.fn()}
        onFocus={vi.fn()}
        onPromote={vi.fn()}
        onPlacePoint={onPlacePoint}
        onReview={vi.fn()}
        onResult={vi.fn()}
      />,
    );
    expect(screen.getByDisplayValue('Bird Poop Rock')).toBeInTheDocument();
    // Moving the proposed spot keeps the name and the ask.
    fireEvent.click(screen.getByRole('button', { name: 'Pick a different spot' }));
    expect(screen.getByDisplayValue('Bird Poop Rock')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save landmark' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      name: 'create',
      args: { name: 'Bird Poop Rock', requestId: 'req1' },
    });
    // One the lake already has is approved, not added.
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({ name: 'approve', args: { requestId: 'req2' } });
  });

  it('places a corpus name with its spellings, or files it as another spelling', async () => {
    queryResults.openForBody = [
      { _id: 'cn1', name: 'Apple Island', aliases: ['Apple Is'], messages: 24, skatedMessages: 11 },
      { _id: 'cn2', name: 'Isle LaMotte', aliases: [], messages: 4, skatedMessages: 3 },
      {
        _id: 'cn3',
        name: 'Cedar Island',
        aliases: [],
        messages: 9,
        skatedMessages: 5,
        alreadyNamed: true,
      },
    ];
    const onArm = vi.fn();
    const { rerender } = renderTool({ onArm });
    expect(screen.getByText(/24 mentions · also Apple Is/)).toBeInTheDocument();
    // Already a landmark: nothing to place, only which one.
    expect(screen.getAllByRole('button', { name: 'Place it' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Which one?' })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Place it' })[0] as HTMLElement);
    expect(onArm).toHaveBeenCalledWith(true);
    rerender(
      <LandmarkTool
        waterBodyId={BODY}
        landmarks={[row('Isle La Motte')]}
        armed={false}
        point={{ lat: 44.62, lng: -73.3 }}
        onArm={onArm}
        onClearPoint={vi.fn()}
        onFocus={vi.fn()}
        onPromote={vi.fn()}
        onPlacePoint={vi.fn()}
        onReview={vi.fn()}
        onResult={vi.fn()}
      />,
    );
    expect(screen.getByDisplayValue('Apple Island')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Apple Is')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save landmark' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      name: 'create',
      args: { name: 'Apple Island', aliases: ['Apple Is'], corpusNameId: 'cn1' },
    });

    fireEvent.click(screen.getAllByRole('button', { name: 'Already here' })[1] as HTMLElement);
    fireEvent.change(screen.getByLabelText('The landmark “Isle LaMotte” is another spelling of'), {
      target: { value: 'lm-Isle La Motte' },
    });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({
      name: 'fileAsSpelling',
      args: { id: 'cn2', landmarkId: 'lm-Isle La Motte' },
    });
  });

  it('says so when the lake has none', () => {
    renderTool({ landmarks: [] });
    expect(screen.getByText('No landmarks on this lake yet.')).toBeInTheDocument();
  });
});
