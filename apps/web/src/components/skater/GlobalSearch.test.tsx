import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChromeStore } from '@/stores/chromeStore';
import { useSearchStore } from '@/stores/searchStore';

import { convexReact, fakes, resetFakes, router } from './testMocks';

vi.mock('convex/react', () => convexReact);
vi.mock('@tanstack/react-router', () => router);
vi.mock('@clerk/tanstack-react-start', () => ({ useAuth: () => fakes.auth }));
vi.mock('@/lib/analytics', async (load) => ({
  ...(await load<typeof import('@/lib/analytics')>()),
  useAnalytics: () => ({ capture: fakes.capture }),
}));

import { GlobalSearch, resolvePicks, useOpenSearch, useSearchOwnerBinding } from './GlobalSearch';

const HOUR = 3_600_000;
const lake = {
  kind: 'body',
  _id: 'w1',
  waterBodyId: 'w1',
  name: 'Mascoma Lake',
  type: 'reservoir',
  states: ['NH'],
};
const bay = {
  kind: 'subArea',
  _id: 's1',
  waterBodyId: 'w1',
  name: 'Mascoma North',
  parentName: 'Mascoma Lake',
  type: 'reservoir',
  states: ['NH'],
};
const person = { userId: 'u1', username: 'mochs', displayName: 'Matt Ochs' };

beforeEach(() => {
  resetFakes();
  localStorage.clear();
  useChromeStore.setState({ overlay: null });
  useSearchStore.setState({ owner: null, recents: [], open: false });
});
afterEach(() => useChromeStore.setState({ overlay: null }));

describe('useSearchOwnerBinding', () => {
  it('binds the recents to the signed-in account once Clerk has loaded', () => {
    fakes.auth = { isLoaded: false, isSignedIn: false, userId: null };
    const { rerender } = renderHook(() => useSearchOwnerBinding());
    expect(useSearchStore.getState().owner).toBeNull();
    fakes.auth = { isLoaded: true, isSignedIn: true, userId: 'user_9' };
    rerender();
    expect(useSearchStore.getState().owner).toBe('user_9');
    fakes.auth = { isLoaded: true, isSignedIn: false, userId: null };
    rerender();
    expect(useSearchStore.getState().owner).toBeNull();
    fakes.auth = { isLoaded: true, isSignedIn: true, userId: undefined };
    rerender();
    expect(useSearchStore.getState().owner).toBeNull();
  });
});

describe('useOpenSearch', () => {
  it('opens search once and records where from', () => {
    const { result } = renderHook(() => useOpenSearch());
    act(() => result.current('hotkey'));
    act(() => result.current('top_bar'));
    expect(useChromeStore.getState().overlay).toBe('search');
    expect(fakes.capture).toHaveBeenCalledTimes(1);
    expect(fakes.capture).toHaveBeenCalledWith('search_opened', { surface: 'hotkey' });
  });
});

describe('GlobalSearch', () => {
  it('opens from / and from the field, recording each surface', async () => {
    render(<GlobalSearch />);
    fireEvent.keyDown(document.body, { key: '/' });
    expect(useChromeStore.getState().overlay).toBe('search');
    expect(fakes.capture).toHaveBeenLastCalledWith('search_opened', { surface: 'hotkey' });
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveFocus());
    act(() => useChromeStore.getState().setOverlay(null));
    fireEvent.click(await screen.findByRole('button', { name: 'Search lakes, bays, and skaters' }));
    expect(fakes.capture).toHaveBeenLastCalledWith('search_opened', { surface: 'top_bar' });
  });

  it('searches lakes, bays and skaters, then opens a pick and records it without the text', async () => {
    const now = Date.now();
    fakes.queries.set('waterBodies:searchByName', [lake, bay]);
    fakes.queries.set('profiles:searchProfiles', [person]);
    fakes.queries.set('reports:recentCardsForBodies', [
      { waterBodyId: 'w1', skateEndTime: now - HOUR, subAreaName: 'Mascoma North' },
    ]);
    act(() => useChromeStore.getState().setOverlay('search'));
    render(<GlobalSearch />);
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'ma' } });
    await screen.findByText('Bays');
    expect(fakes.calls.find((c) => c.name === 'waterBodies:searchByName')?.args).toEqual({
      query: 'ma',
      limit: 6,
    });
    expect(fakes.calls.find((c) => c.name === 'reports:recentCardsForBodies')?.args).toEqual({
      waterBodyIds: ['w1'],
    });
    expect(screen.getByText('Lakes')).toBeInTheDocument();
    expect(screen.getByText('Skaters')).toBeInTheDocument();
    expect(screen.getAllByText('1 report today')).toHaveLength(2);

    fireEvent.click(screen.getByRole('option', { name: /Matt Ochs/ }));
    expect(fakes.capture).toHaveBeenLastCalledWith('search_result_opened', {
      result_kind: 'skater',
      rank: 3,
      query_length_bucket: '1-2',
    });
    for (const [, props] of fakes.capture.mock.calls) {
      expect(JSON.stringify(props ?? {})).not.toContain('ma"');
    }
    expect(useSearchStore.getState().recents[0]).toEqual({ kind: 'skater', id: 'mochs' });
    expect(fakes.push).toHaveBeenCalledWith('/u/mochs');
    expect(useChromeStore.getState().overlay).toBeNull();
  });

  it('says so when nothing matches, once per query, and never sends the text', async () => {
    fakes.queries.set('waterBodies:searchByName', []);
    fakes.queries.set('profiles:searchProfiles', []);
    act(() => useChromeStore.getState().setOverlay('search'));
    render(<GlobalSearch />);
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'mud pond' } });
    await screen.findByText(/No lakes, bays, or skaters match “mud pond”/);
    expect(screen.getByText(/Click it on the Explore map/)).toBeInTheDocument();
    const sent = fakes.capture.mock.calls.filter(([name]) => name === 'search_no_results');
    expect(sent).toEqual([['search_no_results', { query_length_bucket: '6-11' }]]);
  });

  it('keeps the last results up while the next query loads', async () => {
    fakes.queries.set('waterBodies:searchByName', (args: { query: string }) =>
      args.query === 'mas' ? [lake] : undefined,
    );
    fakes.queries.set('profiles:searchProfiles', (args: { query: string }) =>
      args.query === 'mas' ? [] : undefined,
    );
    act(() => useChromeStore.getState().setOverlay('search'));
    render(<GlobalSearch />);
    const box = await screen.findByRole('combobox');
    fireEvent.change(box, { target: { value: 'mas' } });
    await screen.findByText('Lakes');
    fireEvent.change(box, { target: { value: 'masc' } });
    await waitFor(() =>
      expect(fakes.calls.some((c) => (c.args as { query?: string }).query === 'masc')).toBe(true),
    );
    expect(screen.getByText('Lakes')).toBeInTheDocument();
    expect(screen.queryByText(/No lakes, bays/)).toBeNull();
  });

  it('shows the recents with no query, resolved through their queries', async () => {
    useSearchStore.setState({
      owner: 'user_1',
      recents: [
        { kind: 'water_body', id: 'w1' },
        { kind: 'sub_area', id: 'w1/s1' },
        { kind: 'skater', id: 'placasse' },
      ],
    });
    fakes.queries.set('waterBodies:get', {
      available: true,
      body: { name: 'Mascoma Lake', type: 'reservoir', states: ['NH'] },
    });
    fakes.queries.set('subAreas:listForBody', [{ _id: 's1', name: 'Mascoma North' }]);
    fakes.queries.set('profiles:getPublicProfile', {
      username: 'placasse',
      displayName: 'Pat Lacasse',
    });
    act(() => useChromeStore.getState().setOverlay('search'));
    render(<GlobalSearch />);
    await screen.findByText('Recent');
    expect(screen.getByText('Mascoma North')).toBeInTheDocument();
    expect(screen.getByText('@placasse')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Mascoma North'));
    expect(fakes.push).toHaveBeenCalledWith('/water/w1?sub=s1');
  });

  it('prompts for a name when there are no recents yet', async () => {
    act(() => useChromeStore.getState().setOverlay('search'));
    render(<GlobalSearch />);
    expect(
      await screen.findByText('Type the name of a lake, a bay, or a skater.'),
    ).toBeInTheDocument();
  });
});

describe('resolvePicks', () => {
  it('resolves what answered and drops what failed, vanished or never parsed', () => {
    const picks = [
      { kind: 'water_body', id: 'w1' },
      { kind: 'water_body', id: 'gone' },
      { kind: 'water_body', id: 'err' },
      { kind: 'sub_area', id: 'w1/s1' },
      { kind: 'sub_area', id: 'w1/missing' },
      { kind: 'sub_area', id: 'broken' },
      { kind: 'skater', id: 'kd' },
      { kind: 'skater', id: 'nobody' },
      { kind: 'skater', id: 'photo' },
    ] as const;
    const resolved = resolvePicks(picks, {
      'water:w1': { available: true, body: { name: 'Mascoma Lake', type: 'reservoir' } },
      'water:gone': { available: false },
      'water:err': new Error('bad id'),
      'bays:w1': [{ _id: 's1', name: 'Mascoma North' }],
      'skater:kd': { username: 'kd', displayName: 'Kate Donovan' },
      'skater:nobody': null,
      'skater:photo': { username: 'photo', displayName: 'P', profileImageUrl: 'https://x/p.png' },
    });
    expect([...resolved.keys()]).toEqual([
      'water_body:w1',
      'sub_area:w1/s1',
      'skater:kd',
      'skater:photo',
    ]);
    expect(resolved.get('water_body:w1')).toEqual({
      kind: 'water_body',
      name: 'Mascoma Lake',
      type: 'reservoir',
      states: [],
    });
    expect(resolved.get('skater:photo')).toMatchObject({ imageUrl: 'https://x/p.png' });
  });
});
