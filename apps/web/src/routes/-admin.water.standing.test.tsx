import { render, screen, within } from '@testing-library/react';
import { getFunctionName } from 'convex/server';
import type { ComponentType, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Route } from './admin.water.standing';

// The `-` prefix keeps this file out of the generated route tree (`routeFileIgnorePrefix`).

/**
 * `/admin/water/standing` after B01-6a: the five off-map lanes went to the Corpus library, and the
 * page keeps *Recently activated* with its enrichment column — one read, nothing else.
 */
const m = vi.hoisted(() => ({
  recent: undefined as unknown,
  reads: [] as unknown[],
}));

vi.mock('convex/react', () => ({
  useQuery: (ref: unknown) => {
    m.reads.push(ref);
    return m.recent;
  },
}));
vi.mock('@tanstack/react-router', async (actual) => ({
  ...(await actual<typeof import('@tanstack/react-router')>()),
  Link: ({ params, children }: { params: { id: string }; children: ReactNode }) => (
    <a href={`/admin/water/${params.id}`}>{children}</a>
  ),
}));

const Page = (Route as unknown as { options: { component: ComponentType } }).options.component;

const ROW = {
  _id: 'wb1',
  name: 'Mill Pond',
  type: 'pond',
  states: ['NH'],
  surfaceAreaSqM: 40_000,
  centroid: { lat: 43.6, lng: -72.1 },
  activatedAt: new Date(2026, 10, 2, 12).getTime(),
  standing: { standing: 'active' },
  via: 'report',
  missing: ['elevation', 'depth'],
};

beforeEach(() => {
  m.recent = undefined;
  m.reads = [];
});

describe('the Standing page', () => {
  it('lists what came back, with what brought it and what enrichment it awaits', () => {
    m.recent = [ROW, { ...ROW, _id: 'wb2', name: '', via: undefined, missing: [] }];
    render(<Page />);
    expect(screen.getByRole('heading', { name: 'Recently activated' })).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Lake', 'When', 'Via', 'Awaiting']);
    const [, first, second] = within(table).getAllByRole('row');
    expect(within(first as HTMLElement).getByRole('link', { name: 'Mill Pond' })).toHaveAttribute(
      'href',
      '/admin/water/wb1',
    );
    expect(first).toHaveTextContent('report');
    expect(first).toHaveTextContent('elevation, depth');
    expect(within(second as HTMLElement).getByRole('link', { name: '(unnamed)' })).toBeVisible();
    expect(second).toHaveTextContent('—');
    expect(second).toHaveTextContent('nothing');
  });

  it('draws no off-map lanes, and reads nothing but the activations', () => {
    m.recent = [ROW];
    render(<Page />);
    expect(screen.queryByRole('heading', { name: 'Off the active map' })).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getAllByRole('table')).toHaveLength(1);
    expect(new Set(m.reads.map((r) => getFunctionName(r as never)))).toEqual(
      new Set(['standing:listRecentActivations']),
    );
  });

  it('says when nothing has come back, and draws nothing while loading', () => {
    m.recent = [];
    const { unmount } = render(<Page />);
    expect(screen.getByText('Nothing has come back yet.')).toBeInTheDocument();
    unmount();
    m.recent = undefined;
    render(<Page />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('Nothing has come back yet.')).toBeNull();
  });
});
