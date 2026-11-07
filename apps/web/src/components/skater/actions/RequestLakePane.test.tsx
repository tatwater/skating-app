import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConvexError } from 'convex/values';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSkaterMapStore } from '@/stores/skaterMapStore';

import { convexReact, fakes, resetFakes } from '../testMocks';

const router = vi.hoisted(() => ({ history: { push: vi.fn() } }));
vi.mock('@tanstack/react-router', () => ({ useRouter: () => router }));
vi.mock('convex/react', () => convexReact);
vi.mock('@/lib/analytics', async (load) => ({
  ...(await load<typeof import('@/lib/analytics')>()),
  useAnalytics: () => ({ capture: fakes.capture }),
}));

import {
  formatCoord,
  RequestLakeHost,
  RequestLakePane,
  SkaterRequestLakeHost,
} from './RequestLakePane';

const CLICK = { lng: -72.0859, lat: 43.6317 };

beforeEach(() => {
  resetFakes();
  useSkaterMapStore.setState({ pendingMapClick: null });
  fakes.queries.set('waterBodies:resolveBodyForCoord', null);
});

function mount() {
  const onOpenLake = vi.fn();
  render(<RequestLakeHost onOpenLake={onOpenLake} />);
  return { onOpenLake };
}

describe('a click on water we don’t list (3.13)', () => {
  it('opens on the map’s pending click, files an admit, and clears the click', async () => {
    const create = vi.fn().mockResolvedValue('r1');
    fakes.mutations.set('corpusRequests:create', create);
    mount();
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => useSkaterMapStore.getState().setPendingMapClick(CLICK));
    expect(screen.getByRole('dialog', { name: 'Ask us to add it' })).toBeInTheDocument();
    expect(screen.getByText('43.6317° N, 72.0859° W')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Your note to the moderators'), {
      target: { value: '  A pond behind the school  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send to the moderators' }));
    await waitFor(() => expect(useSkaterMapStore.getState().pendingMapClick).toBeNull());
    expect(create).toHaveBeenCalledWith({
      kind: 'admit',
      coord: CLICK,
      note: 'A pond behind the school',
    });
    // The kind only — never the note, never where.
    expect(fakes.capture).toHaveBeenCalledWith('water_body_request_submitted', {
      request_kind: 'admit',
    });
    expect(JSON.stringify(fakes.capture.mock.calls)).not.toContain('43.63');
  });

  it('a lake we already hold under the click opens that lake instead', () => {
    fakes.queries.set('waterBodies:resolveBodyForCoord', {
      waterBodyId: 'george',
      name: 'George Pond',
    });
    const { onOpenLake } = mount();
    act(() => useSkaterMapStore.getState().setPendingMapClick(CLICK));
    expect(onOpenLake).toHaveBeenCalledWith('george');
    expect(useSkaterMapStore.getState().pendingMapClick).toBeNull();
  });

  it('waits on the lookup before showing anything', () => {
    fakes.queries.set('waterBodies:resolveBodyForCoord', undefined);
    mount();
    act(() => useSkaterMapStore.getState().setPendingMapClick(CLICK));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the server finding known water hands off to it', async () => {
    fakes.mutations.set(
      'corpusRequests:create',
      vi.fn().mockRejectedValue(new ConvexError({ code: 'known_water', waterBodyId: 'smith' })),
    );
    const { onOpenLake } = mount();
    act(() => useSkaterMapStore.getState().setPendingMapClick(CLICK));
    fireEvent.click(screen.getByRole('button', { name: 'Send to the moderators' }));
    await waitFor(() => expect(onOpenLake).toHaveBeenCalledWith('smith'));
  });

  it('any other refusal shows in amber and keeps the form', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError({ message: 'You asked about this already.' }))
      .mockRejectedValueOnce(new ConvexError('Slow down.'))
      .mockRejectedValueOnce(new Error('offline'));
    fakes.mutations.set('corpusRequests:create', create);
    mount();
    act(() => useSkaterMapStore.getState().setPendingMapClick(CLICK));
    const send = () =>
      fireEvent.click(screen.getByRole('button', { name: 'Send to the moderators' }));
    send();
    expect(await screen.findByRole('alert')).toHaveTextContent('You asked about this already.');
    send();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Slow down.'));
    send();
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/Check your connection/),
    );
  });

  it('Cancel clears the click', () => {
    mount();
    act(() => useSkaterMapStore.getState().setPendingMapClick(CLICK));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useSkaterMapStore.getState().pendingMapClick).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the layout’s one host', () => {
  it('a lake under the click opens its page', () => {
    router.history.push.mockClear();
    fakes.queries.set('waterBodies:resolveBodyForCoord', { waterBodyId: 'george', name: 'George' });
    render(<SkaterRequestLakeHost />);
    act(() => useSkaterMapStore.getState().setPendingMapClick(CLICK));
    expect(router.history.push).toHaveBeenCalledWith('/water/george');
    expect(useSkaterMapStore.getState().pendingMapClick).toBeNull();
  });
});

describe('the pieces', () => {
  it('formats a coordinate in every quadrant', () => {
    expect(formatCoord({ lat: -33.86, lng: 151.2 })).toBe('33.8600° S, 151.2000° E');
  });

  it('the deep-linked pane says how to start', () => {
    render(<RequestLakePane />);
    expect(screen.getByText(/Click water we don’t list on the map/)).toBeInTheDocument();
  });
});
