import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The `-` prefix keeps this file out of the generated route tree (`routeFileIgnorePrefix`).

/** Each query's answer by the name the mocked `api` gives it; the queue's rows by tab. */
const { queryResults, reviewArgs, useMutation, useQuery } = vi.hoisted(() => {
  const queryResults: Record<string, unknown> = {};
  const reviewArgs: unknown[] = [];
  return {
    queryResults,
    reviewArgs,
    useMutation: vi.fn(() => async () => undefined),
    useQuery: vi.fn((ref: unknown, args: unknown) => {
      const name = String((ref as { _name?: string })?._name);
      if (name === 'listQueue') {
        return queryResults[`listQueue:${(args as { status: string }).status}`] ?? [];
      }
      if (name === 'reviewState') {
        reviewArgs.push(args);
        return args === 'skip' ? undefined : queryResults.reviewState;
      }
      return queryResults[name];
    }),
  };
});
vi.mock('convex/react', () => ({ useMutation, useQuery }));
vi.mock('@skating/convex/api', () => ({
  api: {
    corpusRequests: {
      listQueue: { _name: 'listQueue' },
      queueCount: { _name: 'queueCount' },
      approve: { _name: 'approve' },
      decline: { _name: 'decline' },
      reresolve: { _name: 'reresolve' },
      reviewState: { _name: 'reviewState' },
    },
  },
}));
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  Link: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <a href="/admin/water" className={className}>
      {children}
    </a>
  ),
}));
// The canvas is MapLibre; here it says what it was handed.
vi.mock('../components/admin/RequestPreviewMap', () => ({
  RequestPreviewMap: ({ review }: { review: unknown }) => (
    <div data-testid="map">{JSON.stringify(review)}</div>
  ),
}));

const { Route } = await import('./admin.water.requests');
const RequestQueue = (Route as unknown as { options: { component: () => React.ReactNode } }).options
  .component;

const lakeSpot = { lat: 44.2, lng: -73.1 };
const near = { lat: 44.31, lng: -73.21 };
const far = { lat: 44.61, lng: -73.21 };
const requester = { displayName: 'Skater', username: 'skater', trustClass: null };
const body = {
  _id: 'body1',
  name: 'Lake Champlain',
  type: 'lake',
  states: ['VT'],
  surfaceAreaSqM: 1_000_000,
  standing: 'active',
};
const activate = {
  _id: 'reqL',
  kind: 'activate',
  status: 'open',
  coord: lakeSpot,
  createdAt: 0,
  requester,
  body,
  askers: 1,
};
const proposal = (id: string, coord: typeof near, other?: { id: string; coord: typeof near }) => ({
  _id: id,
  kind: 'name_landmark',
  status: 'open',
  name: 'Long Point',
  coord,
  createdAt: 1,
  requester,
  body,
  askers: 1,
  ...(other
    ? {
        similarProposal: {
          requestId: other.id,
          name: 'Long Point',
          coord: other.coord,
          meters: 33_000,
        },
      }
    : {}),
});

const drawn = () => JSON.parse(screen.getByTestId('map').textContent ?? 'null');

beforeEach(() => {
  for (const key of Object.keys(queryResults)) delete queryResults[key];
  reviewArgs.length = 0;
  queryResults.queueCount = { count: 3, capped: false };
  queryResults.reviewState = { requests: [] };
  queryResults['listQueue:open'] = [
    activate,
    proposal('reqA', near, { id: 'reqB', coord: far }),
    proposal('reqB', far, { id: 'reqA', coord: near }),
  ];
});

describe('the request queue’s review', () => {
  it('freezes a pair a colleague closed, says who over the map, locks it, and goes back to the queue', () => {
    const { rerender } = render(<RequestQueue />);
    // Unpicked, the map shows the oldest row.
    expect(drawn()).toEqual({ ask: lakeSpot });
    fireEvent.click(screen.getAllByRole('button', { name: 'Show both' })[0] as HTMLElement);
    expect(reviewArgs.at(-1)).toEqual({ requestIds: ['reqA', 'reqB'] });
    const pair = drawn();
    expect(pair.other).toEqual({ point: far, kind: 'proposal', name: 'Long Point' });
    // A colleague declines the far end: it leaves the list, and the near row stops naming it.
    queryResults['listQueue:open'] = [activate, proposal('reqA', near)];
    queryResults.reviewState = {
      requests: [
        { requestId: 'reqA', status: 'open', name: 'Long Point' },
        { requestId: 'reqB', status: 'declined', name: 'Long Point', by: 'Mathew', byMe: false },
      ],
    };
    rerender(<RequestQueue />);
    expect(drawn()).toEqual(pair);
    expect(screen.getByRole('status')).toHaveTextContent(
      'The other “Long Point” proposal was declined by Mathew. This pair is closed.',
    );
    const [lakeDecline, nearDecline] = screen.getAllByRole('button', { name: 'Decline' });
    expect(lakeDecline).toBeEnabled();
    expect(nearDecline).toBeDisabled();
    // A closed pick goes Back, not Clear: one way out, the one that explains.
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to queue' }));
    expect(drawn()).toEqual({ ask: lakeSpot });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Decline' })[1]).toBeEnabled();
  });

  it('clears a pick that still stands by hand, back to the oldest row', () => {
    render(<RequestQueue />);
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Show both' })[0] as HTMLElement);
    expect(drawn().other).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(drawn()).toEqual({ ask: lakeSpot });
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
  });

  it('clears quietly after the moderator’s own decision', () => {
    const { rerender } = render(<RequestQueue />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Show on map' })[1] as HTMLElement);
    expect(drawn()).toEqual({ ask: near, name: 'Long Point' });
    queryResults['listQueue:open'] = [activate, proposal('reqB', far)];
    queryResults.reviewState = {
      requests: [
        { requestId: 'reqA', status: 'declined', name: 'Long Point', by: 'Teagan', byMe: true },
      ],
    };
    rerender(<RequestQueue />);
    expect(drawn()).toEqual({ ask: lakeSpot });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('names a request with no name as the request', () => {
    const { rerender } = render(<RequestQueue />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Show on map' })[0] as HTMLElement);
    queryResults.reviewState = {
      requests: [{ requestId: 'reqL', status: 'approved', name: '', by: 'Mathew', byMe: false }],
    };
    rerender(<RequestQueue />);
    expect(screen.getByRole('status')).toHaveTextContent('This request was approved by Mathew.');
  });

  it('shows a decided row on a decided tab without reading it as just closed', () => {
    queryResults['listQueue:approved'] = [{ ...activate, status: 'approved', decidedAt: 5 }];
    // Whoever decided it — a colleague or this moderator — did so before the click.
    queryResults.reviewState = {
      requests: [{ requestId: 'reqL', status: 'approved', name: '', by: 'Mathew', byMe: false }],
    };
    render(<RequestQueue />);
    fireEvent.click(screen.getByRole('button', { name: 'Approved' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show on map' }));
    expect(reviewArgs.at(-1)).toBe('skip');
    expect(drawn()).toEqual({ ask: lakeSpot });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
