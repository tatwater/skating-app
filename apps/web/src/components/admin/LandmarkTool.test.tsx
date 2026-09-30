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
const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn(() => [] as unknown[]) }));
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
        onResult={vi.fn()}
      />,
    );
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      name: 'update',
      args: { landmarkId: 'lm-Apple Island', point: { lat: 44.6, lng: -73.4 } },
    });
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
    useQuery.mockReturnValue([
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
    ]);
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
        onResult={vi.fn()}
      />,
    );
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
    useQuery.mockReturnValue([]);
  });

  it('says so when the lake has none', () => {
    renderTool({ landmarks: [] });
    expect(screen.getByText('No landmarks on this lake yet.')).toBeInTheDocument();
  });
});
