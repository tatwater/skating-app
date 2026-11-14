import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Body › Places as the console mounts it: six reads (mocked at the Convex hooks), five writes, each
 * behind its capability and announced for undo — the map tools drawn only as entry points that say
 * they aren't here yet, and every read's state said in its place.
 */

const mocks = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  calls: [] as Array<[string, unknown]>,
  can: new Set<string>(),
  announce: vi.fn(async () => {}),
  refuse: null as string | null,
  roleLoading: false,
}));

vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  return {
    useQueries: (queries: Record<string, { query: never; args: unknown }>) =>
      Object.fromEntries(
        Object.entries(queries).map(([key, { query }]) => [
          key,
          mocks.results.get(getFunctionName(query)),
        ]),
      ),
    useMutation: (ref: Parameters<typeof getFunctionName>[0]) => async (args: unknown) => {
      mocks.calls.push([getFunctionName(ref), args]);
      if (mocks.refuse !== null) {
        const { ConvexError } = await import('convex/values');
        throw new ConvexError(mocks.refuse);
      }
    },
  };
});
vi.mock('@/lib/useRole', () => ({
  useRole: () => ({ can: (c: string) => mocks.can.has(c), isLoading: mocks.roleLoading }),
}));
vi.mock('../../../shell/undo', () => ({ useUndo: () => ({ announce: mocks.announce }) }));

import { api } from '@skating/convex/api';
import { getFunctionName } from 'convex/server';

import { stubJsdomAnimations } from '../jsdomStubs';
import { PlacesTab } from './PlacesTab';

beforeAll(stubJsdomAnimations);

const ALL = ['body.places', 'corpus.placeNames', 'inbox.request', 'inbox.read'];

/** 29 Sep 2026 at local midday. */
const PASS = new Date(2026, 8, 29, 12).getTime();

beforeEach(() => {
  mocks.results.clear();
  mocks.calls.length = 0;
  mocks.can = new Set(ALL);
  mocks.announce.mockClear();
  mocks.refuse = null;
  mocks.roleLoading = false;
  const set = (ref: Parameters<typeof getFunctionName>[0], value: unknown) =>
    mocks.results.set(getFunctionName(ref), value);
  set(api.landmarks.listForEditor, [
    {
      _id: 'lm-dam',
      name: 'Mascoma Lake Dam',
      kind: 'dam',
      point: { lat: 43.6497, lng: -72.1798 },
      aliases: [],
      source: 'osm',
      externalIds: ['osm:way/768393630'],
      subAreaId: 'bay-n',
    },
  ]);
  set(api.subAreas.listForBody, [{ _id: 'bay-n', name: 'Mascoma North' }]);
  set(api.corpusPlaceNames.openForBody, [{ _id: 'pn1', name: 'the Narrows', messages: 12 }]);
  set(api.corpusRequests.openLandmarkRequestsForBody, {
    proposals: [
      {
        requestId: 'rq1',
        name: 'the flats by the dam',
        coord: { lat: 43.6468, lng: -72.1787 },
        askers: 1,
        similarLandmark: {
          landmarkId: 'lm-dam',
          name: 'Mascoma Lake Dam',
          point: { lat: 43.6497, lng: -72.1798 },
          meters: 333,
        },
      },
    ],
    more: false,
  });
  set(api.bodyConsole.landmarkProvenance, [
    { landmarkId: 'lm-dam', source: 'osm', createdAt: PASS, createdBy: null },
  ]);
  set(api.bodyConsole.landmarkProposers, [
    {
      requestId: 'rq1',
      requester: { userId: 'u1', username: 'kdonovan', displayName: 'Kate Donovan' },
      createdAt: PASS,
    },
  ]);
});

const fn = (ref: Parameters<typeof getFunctionName>[0]) => getFunctionName(ref);

describe('PlacesTab', () => {
  it('answers a proposal with the landmark it may be, and announces it', async () => {
    render(<PlacesTab bodyId="wb1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Same place' }));
    expect(mocks.calls).toEqual([
      [
        'corpusRequests:approve',
        {
          requestId: 'rq1',
          sameAs: {
            landmarkId: 'lm-dam',
            name: 'Mascoma Lake Dam',
            point: { lat: 43.6497, lng: -72.1798 },
          },
        },
      ],
    ]);
    expect(mocks.announce).toHaveBeenCalledWith(
      expect.objectContaining({ target: { targetType: 'waterBodyRequest', targetId: 'rq1' } }),
    );
  });

  it('declines with the note the skaters read, and keeps the dialog open on a refusal', async () => {
    mocks.refuse = 'This request has been decided';
    render(<PlacesTab bodyId="wb1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Already on the map');
    await userEvent.click(within(dialog).getByRole('button', { name: /^Decline/ }));
    expect(mocks.calls).toEqual([
      ['corpusRequests:decline', { requestId: 'rq1', note: 'Already on the map' }],
    ]);
    expect(await within(dialog).findByText('This request has been decided')).toBeTruthy();
    expect(mocks.announce).not.toHaveBeenCalled();
  });

  it('dismisses an emailed name with its reason', async () => {
    render(<PlacesTab bodyId="wb1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('radio', { name: /Too vague|vague/i }));
    await userEvent.click(within(dialog).getByRole('button', { name: /^Dismiss/ }));
    await waitFor(() =>
      expect(mocks.calls).toEqual([
        ['corpusPlaceNames:dismiss', { id: 'pn1', reason: 'too_vague' }],
      ]),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('opens the selected landmark’s card and saves a field through landmarks.update', async () => {
    render(<PlacesTab bodyId="wb1" lit="landmark:lm-dam" />);
    expect(screen.getByText('Mascoma North')).toBeTruthy();
    const name = screen.getByRole('textbox', { name: 'Name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Mascoma Dam{Enter}');
    expect(mocks.calls).toEqual([
      ['landmarks:update', { landmarkId: 'lm-dam', name: 'Mascoma Dam' }],
    ]);
    expect(mocks.announce).toHaveBeenCalledWith({
      title: 'Saved · Mascoma Dam',
      target: { targetType: 'bodyLandmark', targetId: 'lm-dam' },
    });
  });

  it('draws no lever a viewer without the capabilities holds, and no map tool', () => {
    mocks.can = new Set();
    render(<PlacesTab bodyId="wb1" lit="landmark:lm-dam" />);
    // Who added it is a link to their page, inside their lockup: none here (the landmark pass).
    expect(screen.queryByRole('textbox')).toBeNull();
    // Only the card's own Back remains.
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      '‹Back to landmarksEsc',
    ]);
  });

  it('names who asked, with the handle as the link to their page', () => {
    render(<PlacesTab bodyId="wb1" />);
    const ask = screen.getAllByText(/the flats by the dam/)[0]?.closest('[data-slot="ask"]');
    expect(ask).toHaveTextContent('Kate Donovan');
    expect(within(ask as HTMLElement).getByRole('link', { name: '@kdonovan' })).toHaveAttribute(
      'href',
      '/admin/users/u1',
    );
  });

  it('reads no askers for a viewer without inbox.read, and draws no blank where one would be', () => {
    mocks.can = new Set(['body.places']);
    render(<PlacesTab bodyId="wb1" />);
    const ask = screen.getAllByText(/the flats by the dam/)[0]?.closest('[data-slot="ask"]');
    expect(ask).not.toHaveTextContent('Kate Donovan');
    expect(ask?.querySelector('[data-slot="person-lockup"], [aria-hidden="true"]')).toBeNull();
    expect(screen.queryByText(/Couldn’t/)).toBeNull();
  });

  it('says who asked isn’t recorded when the askers’ read holds no row for an ask — never a blank', () => {
    // The askers' read covers the same newest 200 proposals: a missing row is no requester on record.
    mocks.results.set(fn(api.bodyConsole.landmarkProposers), []);
    render(<PlacesTab bodyId="wb1" />);
    const ask = screen.getAllByText(/the flats by the dam/)[0]?.closest('[data-slot="ask"]');
    expect(ask).toHaveTextContent('Who asked: Not recorded yet');
    expect(ask).not.toHaveTextContent('past what this read shows');
  });

  it('holds who asked as loading while the viewer’s role is on its way', () => {
    mocks.can = new Set();
    mocks.roleLoading = true;
    render(<PlacesTab bodyId="wb1" />);
    const ask = screen.getAllByText(/the flats by the dam/)[0]?.closest('[data-slot="ask"]');
    expect(ask?.querySelector('[data-slot="skeleton"]')).not.toBeNull();
  });

  it('says when and by what the selected landmark was added', () => {
    render(<PlacesTab bodyId="wb1" lit="landmark:lm-dam" />);
    expect(screen.getByText('29 Sep 2026')).toBeTruthy();
    expect(screen.getByText('By the landmark pass')).toBeTruthy();
  });

  it('holds each list’s place while its read loads; the bays are not waited on', () => {
    mocks.results.delete(fn(api.subAreas.listForBody));
    mocks.results.delete(fn(api.corpusPlaceNames.openForBody));
    const { container, rerender } = render(<PlacesTab bodyId="wb1" />);
    const asks = () => container.querySelector('[data-slot="asks"]');
    expect(asks()).toHaveAttribute('aria-busy', 'true');
    // The landmarks don't wait on the asks, nor on the bays.
    expect(screen.getAllByText('Mascoma Lake Dam').length).toBeGreaterThan(0);
    mocks.results.set(fn(api.corpusPlaceNames.openForBody), []);
    rerender(<PlacesTab bodyId="wb1" />);
    expect(asks()).not.toHaveAttribute('aria-busy');
  });

  it('says what failed, in place and once at the top, and tries again on a press', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.results.set(fn(api.landmarks.listForEditor), new Error('down'));
      mocks.results.set(fn(api.bodyConsole.landmarkProposers), new Error('down'));
      const { rerender } = render(<PlacesTab bodyId="wb1" />);
      const note = screen.getByRole('status');
      expect(note).toHaveTextContent('Couldn’t read the landmarks and who asked.');
      expect(screen.getByText('Who asked couldn’t be read')).toBeTruthy();
      expect(
        within(screen.getByRole('region', { name: /Landmarks/ })).getByText('Couldn’t be read'),
      ).toBeTruthy();
      // The server answers now: Try again lets go of the failed reads, then asks again.
      mocks.results.set(fn(api.landmarks.listForEditor), []);
      mocks.results.set(fn(api.bodyConsole.landmarkProposers), []);
      await userEvent.click(within(note).getByRole('button', { name: 'Try again' }));
      await vi.advanceTimersByTimeAsync(100);
      rerender(<PlacesTab bodyId="wb1" />);
      // The note stays mounted (its next words will be announced), and says nothing now.
      expect(screen.getByRole('status')).toBeEmptyDOMElement();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says the asks are a floor when the proposals read stopped short', () => {
    mocks.results.set(fn(api.corpusRequests.openLandmarkRequestsForBody), {
      proposals: [],
      more: true,
    });
    const { container } = render(<PlacesTab bodyId="wb1" />);
    expect(
      container.querySelector('[data-slot="asks"] [data-slot="section-count"]'),
    ).toHaveTextContent('1+');
  });
});
