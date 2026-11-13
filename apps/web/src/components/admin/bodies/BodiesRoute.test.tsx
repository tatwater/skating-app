import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The library as the app mounts it: its place from the URL, the reads that exist today, and every
 * lane or block no read serves said as such — never a fixture.
 */

const mocks = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  calls: new Map<string, unknown>(),
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
  audit: true,
}));

vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  return {
    useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => {
      const name = getFunctionName(ref);
      mocks.calls.set(name, args);
      return args === 'skip' ? undefined : mocks.results.get(name);
    },
  };
});
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => mocks.search,
  useNavigate: () => mocks.navigate,
  Link: ({ to, children, ...props }: { to: string; children?: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/useRole', () => ({
  useRole: () => ({ can: (c: string) => c !== 'audit.read' || mocks.audit }),
}));

import { api } from '@skating/convex/api';
import { getFunctionName } from 'convex/server';

import { KeysProvider } from '@/lib/keys';

import { BodiesRoute } from './BodiesRoute';
import { resetScrollMemory } from './BodiesTable';

const ACRE = 4046.8564224;
const ID = 'k17abcdefghijklmnopqrstuvwxyz012';

beforeAll(() => {
  for (const [name, value] of [
    ['animate', () => ({ cancel: () => {}, finished: Promise.resolve() })],
    ['getAnimations', () => []],
    ['scrollIntoView', () => {}],
  ] as const) {
    if (!(name in Element.prototype)) {
      Object.defineProperty(Element.prototype, name, { configurable: true, value });
    }
  }
  if (!('fonts' in document)) {
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
  }
});

beforeEach(() => {
  resetScrollMemory();
  mocks.search = {};
  mocks.navigate.mockReset();
  mocks.results.clear();
  mocks.calls.clear();
  mocks.audit = true;
});

const name = (ref: Parameters<typeof getFunctionName>[0]) => getFunctionName(ref);
const mount = () =>
  render(
    <KeysProvider>
      <BodiesRoute />
    </KeysProvider>,
  );

describe('Active, which no read lists yet', () => {
  it('says so, runs no lane read, and offers only the search', () => {
    mount();
    expect(screen.getByText('Not recorded yet')).toBeInTheDocument();
    expect(mocks.calls.get(name(api.standing.listLane))).toBe('skip');
    expect(mocks.calls.get(name(api.waterBodies.searchByName))).toBe('skip');
    expect(screen.getByRole('searchbox', { name: 'Find a body' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Filter/ })).toBeDisabled();
  });

  it('searches by name from two letters, active matches first', () => {
    mocks.search = { q: 'mor' };
    mocks.results.set(name(api.waterBodies.searchByName), [
      {
        kind: 'body',
        _id: 'a',
        waterBodyId: 'a',
        name: 'Lake Morey',
        type: 'lakePond',
        states: ['VT'],
        surfaceAreaSqM: 545 * ACRE,
      },
      {
        kind: 'body',
        _id: 'b',
        waterBodyId: 'b',
        name: 'Morey Pond',
        type: 'lakePond',
        states: ['NH'],
        inactive: true,
      },
    ]);
    mount();
    expect(mocks.calls.get(name(api.waterBodies.searchByName))).toEqual({
      query: 'mor',
      limit: 20,
      bodiesOnly: true,
    });
    const grid = screen.getByRole('grid');
    const rows = [...grid.querySelectorAll('[data-clickable]')];
    expect(rows.map((r) => r.textContent?.slice(0, 10))).toEqual(['Lake Morey', 'Morey Pond']);
    expect(screen.getByText('1 active · 1 dormant')).toBeInTheDocument();
  });
});

describe('a standing lane', () => {
  it('reads standing.listLane and answers it whole, its count exact', () => {
    mocks.search = { lane: 'moderator' };
    mocks.results.set(name(api.standing.listLane), {
      truncated: false,
      rows: [
        {
          _id: 'e',
          name: 'Echo Lake',
          type: 'lakePond',
          states: ['VT'],
          surfaceAreaSqM: 550 * ACRE,
          centroid: { lat: 0, lng: 0 },
          standing: { standing: 'dormant', since: 1, reason: 'moderator' },
          lastActivityAt: null,
          includedByRequest: false,
          curatedBoost: 0,
        },
      ],
    });
    mount();
    expect(mocks.calls.get(name(api.standing.listLane))).toEqual({ lane: 'moderator' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Dormant by a moderator');
    expect(within(screen.getByRole('navigation', { name: 'Bodies' })).getByText('1')).toBeVisible();
    expect(screen.getByText('All 1')).toBeInTheDocument();
  });
});

describe('the place in the URL', () => {
  it('navigates to the same route with the new search, replacing for a row', async () => {
    mocks.search = { lane: 'moderator' };
    mocks.results.set(name(api.standing.listLane), {
      truncated: false,
      rows: [
        {
          _id: ID,
          name: 'Echo Lake',
          type: 'lakePond',
          states: ['VT'],
          surfaceAreaSqM: 550 * ACRE,
          centroid: { lat: 0, lng: 0 },
          standing: { standing: 'dormant', since: 1, reason: 'moderator' },
          lastActivityAt: null,
          includedByRequest: false,
          curatedBoost: 0,
        },
      ],
    });
    mount();
    await userEvent.click(screen.getByText('Echo Lake'));
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      to: '.',
      search: { lane: 'moderator', body: ID },
      replace: true,
    });
    await userEvent.click(screen.getByRole('button', { name: /^Active/ }));
    expect(mocks.navigate).toHaveBeenLastCalledWith({ to: '.', search: {} });
  });
});

describe('the preview', () => {
  const body = {
    _id: ID,
    name: 'Mascoma Lake',
    type: 'reservoir',
    states: ['NH'],
    centroid: { lat: 43.63, lng: -72.15 },
    bbox: { minLng: -72.18, minLat: 43.6, maxLng: -72.12, maxLat: 43.65 },
    polygon: {
      type: 'Polygon',
      coordinates: [
        [
          [-72.18, 43.6],
          [-72.12, 43.6],
          [-72.12, 43.65],
          [-72.18, 43.6],
        ],
      ],
    },
    surfaceAreaSqM: 1143 * ACRE,
    dedupStatus: 'clean',
  };

  it('reads the open body and its put-ins, sub-areas and history, and opens its console', async () => {
    mocks.search = { body: ID };
    mocks.results.set(name(api.waterBodies.get), { available: true, body });
    mocks.results.set(name(api.putIns.listForBody), []);
    mocks.results.set(name(api.subAreas.listForBody), [{}, {}]);
    mocks.results.set(name(api.moderation.listActions), []);
    mount();
    expect(mocks.calls.get(name(api.moderation.listActions))).toEqual({
      targetType: 'waterbody',
      targetId: ID,
      limit: 7,
    });
    const preview = screen.getByRole('region', { name: 'Preview' });
    expect(within(preview).getByRole('heading', { name: 'Mascoma Lake' })).toBeInTheDocument();
    expect(within(preview).getByText(/2 bays/)).toBeInTheDocument();
    // What no read gives is left out: no reports, no asks. Completeness draws from what is read,
    // the parts no read here serves dashed and uncounted.
    expect(within(preview).queryByText('This season')).toBeNull();
    expect(within(preview).getByRole('meter', { name: 'Complete' })).toHaveAttribute(
      'aria-valuemax',
      '10',
    );
    expect(
      within(preview)
        .getByText(/Open in Body/)
        .closest('a'),
    ).toHaveAttribute('href', `/admin/body/${ID}`);
    act(() => preview.focus());
    await userEvent.keyboard('{Enter}');
    expect(mocks.navigate).toHaveBeenLastCalledWith({ to: `/admin/body/${ID}` });
  });

  it('skips the history for a viewer who can’t read the audit', () => {
    mocks.audit = false;
    mocks.search = { body: ID };
    mocks.results.set(name(api.waterBodies.get), { available: true, body });
    mount();
    expect(mocks.calls.get(name(api.moderation.listActions))).toBe('skip');
    expect(screen.queryByText('Last changed')).toBeNull();
  });

  it('never sends a junk id to a query, and says nothing is open', () => {
    mocks.search = { body: 'not-an-id' };
    mount();
    expect(mocks.calls.get(name(api.waterBodies.get))).toBe('skip');
    expect(screen.getByText('No body open')).toBeInTheDocument();
  });

  it('says nothing is open for a body that isn’t available', () => {
    mocks.search = { body: ID };
    mocks.results.set(name(api.waterBodies.get), { available: false });
    mount();
    expect(screen.getByText('No body open')).toBeInTheDocument();
  });
});
