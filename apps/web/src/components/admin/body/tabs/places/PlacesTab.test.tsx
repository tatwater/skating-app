import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Body › Places as the console mounts it: four reads, five writes, each behind its capability and
 * announced for undo — and the map tools drawn only as entry points that say they aren't here yet.
 */

const mocks = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  calls: [] as Array<[string, unknown]>,
  can: new Set<string>(),
  announce: vi.fn(async () => {}),
  refuse: null as string | null,
}));

vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  return {
    useQuery: (ref: Parameters<typeof getFunctionName>[0]) =>
      mocks.results.get(getFunctionName(ref)),
    useMutation: (ref: Parameters<typeof getFunctionName>[0]) => async (args: unknown) => {
      mocks.calls.push([getFunctionName(ref), args]);
      if (mocks.refuse !== null) {
        const { ConvexError } = await import('convex/values');
        throw new ConvexError(mocks.refuse);
      }
    },
  };
});
vi.mock('@/lib/useRole', () => ({ useRole: () => ({ can: (c: string) => mocks.can.has(c) }) }));
vi.mock('../../../shell/undo', () => ({ useUndo: () => ({ announce: mocks.announce }) }));

import { api } from '@skating/convex/api';
import { getFunctionName } from 'convex/server';

import { stubJsdomAnimations } from '../names/jsdomStubs';
import { PlacesTab } from './PlacesTab';

beforeAll(stubJsdomAnimations);

const ALL = ['body.places', 'corpus.placeNames', 'inbox.request'];

beforeEach(() => {
  mocks.results.clear();
  mocks.calls.length = 0;
  mocks.can = new Set(ALL);
  mocks.announce.mockClear();
  mocks.refuse = null;
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
});

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
    expect(screen.queryByRole('textbox')).toBeNull();
    // Only the card's own Back remains.
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      '‹Back to landmarksEsc',
    ]);
  });

  it('holds its place until the three reads land; the bays are not waited on', () => {
    mocks.results.delete(getFunctionName(api.subAreas.listForBody));
    mocks.results.delete(getFunctionName(api.corpusPlaceNames.openForBody));
    const { container, rerender } = render(<PlacesTab bodyId="wb1" />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    mocks.results.set(getFunctionName(api.corpusPlaceNames.openForBody), []);
    rerender(<PlacesTab bodyId="wb1" />);
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });
});
