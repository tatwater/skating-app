import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { calls, queryArgs, rows, useMutation, useQuery } = vi.hoisted(() => {
  const calls: { name: string; args: unknown }[] = [];
  const queryArgs: unknown[] = [];
  const rows: { current: unknown[] } = { current: [] };
  return {
    calls,
    queryArgs,
    rows,
    useMutation: vi.fn((ref: unknown) => {
      const name = String((ref as { _name?: string })?._name);
      return async (args: unknown) => {
        calls.push({ name, args });
      };
    }),
    useQuery: vi.fn((_ref: unknown, args: unknown) => {
      queryArgs.push(args);
      return { rows: rows.current, capped: false };
    }),
  };
});
vi.mock('convex/react', () => ({ useMutation, useQuery }));
vi.mock('@skating/convex/api', () => ({
  api: {
    corpusPlaceNames: {
      listQueue: { _name: 'listQueue' },
      setLake: { _name: 'setLake' },
      reopen: { _name: 'reopen' },
      dismiss: { _name: 'dismiss' },
    },
    waterBodies: { searchByName: { _name: 'searchByName' } },
  },
}));
// The lake editor link needs a router; the assertion is where it points.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    params,
    children,
    className,
  }: {
    params: { id: string };
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={`/admin/water/${params.id}`} className={className}>
      {children}
    </a>
  ),
}));
// The lake picker is its own component with its own search; here it is a button that picks one.
vi.mock('../sheet/BodyPicker', () => ({
  BodyPicker: ({
    open,
    onPick,
  }: {
    open: boolean;
    onPick: (body: { waterBodyId: string; name: string }) => void;
  }) =>
    open ? (
      <button type="button" onClick={() => onPick({ waterBodyId: 'picked', name: 'Picked Pond' })}>
        pick Picked Pond
      </button>
    ) : null,
}));

const { PlaceNameQueue } = await import('./PlaceNameQueue');

const champlain = { _id: 'champlain', label: 'Lake Champlain · VT, NY' };
const george = { _id: 'george', label: 'Lake George · NY' };

beforeEach(() => {
  calls.length = 0;
  queryArgs.length = 0;
  rows.current = [
    {
      _id: 'apple',
      name: 'Apple Island',
      aliases: ['Apple Is'],
      messages: 24,
      skatedMessages: 11,
      states: ['VT'],
      status: 'open',
      parentName: 'Lake Champlain',
      lake: champlain,
      candidates: [],
    },
    {
      _id: 'long',
      name: 'Long Point',
      aliases: [],
      messages: 3,
      skatedMessages: 0,
      states: ['NY'],
      status: 'open',
      candidates: [champlain, george],
    },
    {
      _id: 'hero',
      name: 'Hero’s Welcome',
      aliases: [],
      messages: 12,
      skatedMessages: 4,
      states: ['VT'],
      status: 'open',
      candidates: [],
    },
  ];
});

describe('PlaceNameQueue', () => {
  it('asks for the names mentioned more than once, open, by default — and all of them on request', () => {
    render(<PlaceNameQueue />);
    expect(queryArgs.at(-1)).toEqual({ status: 'open', minMessages: 2 });
    fireEvent.click(screen.getByLabelText('Only names mentioned more than once'));
    expect(queryArgs.at(-1)).toEqual({ status: 'open' });
    fireEvent.click(screen.getByRole('button', { name: 'Dismissed' }));
    expect(queryArgs.at(-1)).toEqual({ status: 'dismissed' });
  });

  it('shows each name’s mentions, spellings and lake, with "Place it" only once it has a lake', () => {
    render(<PlaceNameQueue />);
    expect(screen.getByText('also Apple Is')).toBeInTheDocument();
    expect(screen.getByText('11 skated')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Lake Champlain · VT, NY' })).toHaveAttribute(
      'href',
      '/admin/water/champlain',
    );
    const place = screen.getAllByRole('link', { name: 'Place it' });
    expect(place).toHaveLength(1);
    expect(place[0]).toHaveAttribute('href', '/admin/water/champlain');
  });

  it('chooses among the lakes a name met, or picks one', async () => {
    render(<PlaceNameQueue />);
    fireEvent.click(screen.getByRole('button', { name: 'Lake George · NY' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ name: 'setLake', args: { id: 'long', waterBodyId: 'george' } });
    expect(await screen.findByText('“Long Point” is on Lake George · NY.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Pick a lake…' }));
    fireEvent.click(screen.getByRole('button', { name: 'pick Picked Pond' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({ name: 'setLake', args: { id: 'hero', waterBodyId: 'picked' } });
  });

  it('reopens a dismissed name, and shows why it was dismissed', async () => {
    rows.current = [
      {
        _id: 'baltic',
        name: 'Baltic Sea',
        aliases: [],
        messages: 5,
        skatedMessages: 4,
        states: [],
        status: 'dismissed',
        dismissReason: 'outside_region',
        dismissNote: 'a trip report from Sweden',
        candidates: [],
      },
    ];
    render(<PlaceNameQueue />);
    expect(
      screen.getByText('Outside the five states — a trip report from Sweden'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(calls).toEqual([{ name: 'reopen', args: { id: 'baltic' } }]));
  });

  it('offers "Choose which" for a name already on the map', () => {
    rows.current = [
      {
        _id: 'cedar',
        name: 'Cedar Island',
        aliases: [],
        messages: 9,
        skatedMessages: 5,
        states: ['VT'],
        status: 'open',
        lake: champlain,
        candidates: [],
        alreadyNamed: true,
      },
    ];
    render(<PlaceNameQueue />);
    expect(
      screen.getByText(/Already a landmark — the emails did not say which one/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose which' })).toHaveAttribute(
      'href',
      '/admin/water/champlain',
    );
  });

  it('says the filter may be hiding names when the recurring ones are done', () => {
    rows.current = [];
    render(<PlaceNameQueue />);
    expect(screen.getByText(/Untick the filter for the names one email used/)).toBeInTheDocument();
  });

  it('says so when the queue is empty', () => {
    rows.current = [];
    render(<PlaceNameQueue />);
    fireEvent.click(screen.getByLabelText('Only names mentioned more than once'));
    expect(
      screen.getByText('Nothing waiting — every name is placed or dismissed.'),
    ).toBeInTheDocument();
  });
});
