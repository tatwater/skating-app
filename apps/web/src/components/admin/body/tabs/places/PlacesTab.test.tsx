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
  /** A write held on its way until the test lets it land. */
  gate: null as Promise<void> | null,
  /** The server's own effect of a write on the reads, applied when the write lands. */
  server: null as ((name: string, args: Record<string, unknown>) => void) | null,
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
      if (mocks.gate !== null) await mocks.gate;
      if (mocks.refuse !== null) {
        const { ConvexError } = await import('convex/values');
        throw new ConvexError(mocks.refuse);
      }
      mocks.server?.(getFunctionName(ref), args as Record<string, unknown>);
    },
  };
});
vi.mock('@/lib/useRole', () => ({
  useRole: () => ({ can: (c: string) => mocks.can.has(c), isLoading: mocks.roleLoading }),
}));
vi.mock('../../../shell/undo', () => ({ useUndo: () => ({ announce: mocks.announce }) }));
const toasts = vi.hoisted(() => [] as unknown[]);
vi.mock('@/components/kit/toast', async (original) => ({
  ...(await original<typeof import('@/components/kit/toast')>()),
  toast: (t: unknown) => toasts.push(t),
}));

import { api } from '@skating/convex/api';
import { getFunctionName } from 'convex/server';
import { resetConsoleReads } from '@/components/admin/reads/consoleReads';
import { BodyTabHost } from '../../frame/BodyConsoleRoute';
import { stubJsdomAnimations } from '../jsdomStubs';
import { PlacesTab } from './PlacesTab';

beforeAll(stubJsdomAnimations);

const ALL = ['body.places', 'corpus.placeNames', 'inbox.request', 'inbox.read'];

/** 29 Sep 2026 at local midday. */
const PASS = new Date(2026, 8, 29, 12).getTime();

beforeEach(() => {
  // The read layer's registry (paused reads, retries, reports) is module state: start each test clean.
  resetConsoleReads();
  mocks.results.clear();
  mocks.calls.length = 0;
  mocks.can = new Set(ALL);
  mocks.announce.mockClear();
  mocks.refuse = null;
  mocks.roleLoading = false;
  mocks.gate = null;
  mocks.server = null;
  toasts.length = 0;
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
  set(api.corpusPlaceNames.openForBody, {
    names: [{ _id: 'pn1', name: 'the Narrows', messages: 12 }],
    more: false,
  });
  set(api.corpusRequests.openLandmarkRequestsForBody, {
    proposals: [
      {
        requestId: 'rq1',
        name: 'the flats by the dam',
        coord: { lat: 43.6468, lng: -72.1787 },
        askers: 1,
        createdAt: new Date(2026, 9, 11, 12).getTime(),
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
    // Refused: one toast naming what wasn't saved; the dialog stays open over its note, printing nothing.
    await waitFor(() =>
      expect(toasts).toEqual([
        expect.objectContaining({
          description: expect.stringMatching(/^Declined “.*”: This request has been decided$/),
          tone: 'bad',
        }),
      ]),
    );
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    expect(within(dialog).getByRole('textbox')).toHaveValue('Already on the map');
    expect(within(dialog).queryByText('This request has been decided')).toBeNull();
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

  it('sends a name once when ⏎ is followed by a blur, and again after a refusal', async () => {
    let land = () => {};
    mocks.gate = new Promise<void>((resolve) => {
      land = resolve;
    });
    mocks.refuse = 'A landmark on this lake already has that name';
    render(<PlacesTab bodyId="wb1" lit="landmark:lm-dam" />);
    const name = screen.getByRole('textbox', { name: 'Name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Mascoma Dam{Enter}');
    // The answer hasn't landed: leaving the field doesn't send it a second time.
    await userEvent.tab();
    expect(mocks.calls).toHaveLength(1);
    mocks.gate = null;
    land();
    await waitFor(() =>
      expect(toasts).toEqual([expect.objectContaining({ title: 'Not saved', tone: 'bad' })]),
    );
    expect(mocks.announce).not.toHaveBeenCalled();
    // Refused: the same name can be sent again.
    mocks.refuse = null;
    await userEvent.type(name, '{Enter}');
    await waitFor(() => expect(mocks.calls).toHaveLength(2));
    expect(mocks.calls[1]).toEqual([
      'landmarks:update',
      { landmarkId: 'lm-dam', name: 'Mascoma Dam' },
    ]);
  });

  it('a spelling added while another is saving lands on top of it, never over it', async () => {
    let land = () => {};
    mocks.gate = new Promise<void>((resolve) => {
      land = resolve;
    });
    render(<PlacesTab bodyId="wb1" lit="landmark:lm-dam" />);
    const spellings = screen.getByRole('combobox', { name: 'Other spellings' });
    await userEvent.type(spellings, 'the Dam{Enter}');
    // The first save hasn't landed (and the page still shows the record without it).
    await userEvent.type(spellings, 'Shaker Dam{Enter}');
    expect(mocks.calls).toEqual([
      ['landmarks:update', { landmarkId: 'lm-dam', aliases: ['the Dam'], expectedAliases: [] }],
    ]);
    mocks.gate = null;
    land();
    // The second is built on the first, acknowledged — not on the render's empty list.
    await waitFor(() => expect(mocks.calls).toHaveLength(2));
    expect(mocks.calls[1]).toEqual([
      'landmarks:update',
      { landmarkId: 'lm-dam', aliases: ['the Dam', 'Shaker Dam'], expectedAliases: ['the Dam'] },
    ]);
  });

  it('shows the record’s name again once it moves — an Undo never leaves its draft to re-save', async () => {
    const { rerender } = render(<PlacesTab bodyId="wb1" lit="landmark:lm-dam" />);
    const name = () => screen.getByRole('textbox', { name: 'Name' });
    await userEvent.clear(name());
    await userEvent.type(name(), 'Mascoma Dam{Enter}');
    expect(mocks.calls).toHaveLength(1);
    const rows = mocks.results.get(fn(api.landmarks.listForEditor)) as Array<{ name: string }>;
    const named = (n: string) => {
      mocks.results.set(fn(api.landmarks.listForEditor), [{ ...rows[0], name: n }]);
      rerender(<PlacesTab bodyId="wb1" lit="landmark:lm-dam" />);
    };
    named('Mascoma Dam');
    // The save is undone: the record goes back, and so does the field.
    named('Mascoma Lake Dam');
    expect(name()).toHaveValue('Mascoma Lake Dam');
    await userEvent.click(name());
    await userEvent.tab();
    expect(mocks.calls).toHaveLength(1);
  });

  it('writes out a landmark no catalog lists by its source, never its key twice', () => {
    mocks.results.set(fn(api.landmarks.listForEditor), [
      {
        _id: 'lm-mod',
        name: 'Warming hut',
        kind: 'other',
        point: { lat: 43.65, lng: -72.18 },
        aliases: [],
        source: 'moderator',
        externalIds: [],
      },
    ]);
    render(<PlacesTab bodyId="wb1" lit="landmark:lm-mod" />);
    const source = screen.getByText('A moderator').closest('span') as HTMLElement;
    expect(source).toHaveTextContent('A moderatorMODERATOR');
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

  it('says when each proposal was first asked, beside who asked — or that the read doesn’t say', () => {
    const { unmount } = render(<PlacesTab bodyId="wb1" />);
    const ask = () => screen.getAllByText(/the flats by the dam/)[0]?.closest('[data-slot="ask"]');
    expect(ask()).toHaveTextContent('Asked 11 Oct 2026');
    unmount();
    mocks.results.set(fn(api.corpusRequests.openLandmarkRequestsForBody), {
      proposals: [
        { requestId: 'rq1', name: 'the flats by the dam', coord: { lat: 1, lng: 2 }, askers: 1 },
      ],
      more: false,
    });
    render(<PlacesTab bodyId="wb1" />);
    expect(ask()).toHaveTextContent('Asked: Not recorded yet');
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

  it('says when a moderator last edited the selected landmark and a merge last changed it, or that neither is recorded', () => {
    const { unmount } = render(<PlacesTab bodyId="wb1" lit="landmark:lm-dam" />);
    const changed = () =>
      [...document.querySelectorAll('[data-slot="key-value-row"]')].find((r) =>
        r.textContent?.startsWith('Changed'),
      );
    expect(changed()).toHaveTextContent('Changed' + 'Not recorded yet');
    unmount();
    mocks.results.set(fn(api.bodyConsole.landmarkProvenance), [
      {
        landmarkId: 'lm-dam',
        source: 'osm',
        createdAt: PASS,
        createdBy: null,
        moderatorEditedAt: new Date(2026, 9, 5, 12).getTime(),
        movedAt: new Date(2026, 9, 7, 12).getTime(),
      },
    ]);
    render(<PlacesTab bodyId="wb1" lit="landmark:lm-dam" />);
    // A merge is said as one: "Moved" would read as the card's Move, a moved point.
    expect(changed()).toHaveTextContent('Edited 5 Oct 2026 · By a merge 7 Oct 2026');
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
    mocks.results.set(fn(api.corpusPlaceNames.openForBody), { names: [], more: false });
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

  /**
   * Each write control, once the reads return what the server answers for that write (from each
   * mutation's source): `approve` and `decline` decide the request (the open-requests read drops
   * it), `dismiss` and `fileAsSpelling` close the emailed name (the open-names read drops it; filing
   * also adds the name to the landmark's spellings), `update` patches the landmark in place. The
   * lever is gone or inert, and a second press writes nothing.
   */
  describe('after the server answers, a write control is gone and a second press writes nothing', () => {
    const names = fn(api.corpusPlaceNames.openForBody);
    const requests = fn(api.corpusRequests.openLandmarkRequestsForBody);
    const landmarks = fn(api.landmarks.listForEditor);
    beforeEach(() => {
      mocks.server = (name, args) => {
        if (name === 'corpusRequests:approve' || name === 'corpusRequests:decline') {
          const prior = mocks.results.get(requests) as { proposals: { requestId: string }[] };
          mocks.results.set(requests, {
            ...prior,
            proposals: prior.proposals.filter((p) => p.requestId !== args.requestId),
          });
        }
        if (name === 'corpusPlaceNames:dismiss' || name === 'corpusPlaceNames:fileAsSpelling') {
          const prior = mocks.results.get(names) as { names: { _id: string; name: string }[] };
          const filed = prior.names.find((n) => n._id === args.id);
          mocks.results.set(names, {
            ...prior,
            names: prior.names.filter((n) => n._id !== args.id),
          });
          if (name === 'corpusPlaceNames:fileAsSpelling' && filed) {
            const rows = mocks.results.get(landmarks) as { _id: string; aliases: string[] }[];
            mocks.results.set(
              landmarks,
              rows.map((l) =>
                l._id === args.landmarkId ? { ...l, aliases: [...l.aliases, filed.name] } : l,
              ),
            );
          }
        }
        if (name === 'landmarks:update') {
          const rows = mocks.results.get(landmarks) as Record<string, unknown>[];
          const { landmarkId, ...edit } = args;
          mocks.results.set(
            landmarks,
            rows.map((l) => (l._id === landmarkId ? { ...l, ...edit } : l)),
          );
        }
      };
    });

    it('Same place', async () => {
      const { rerender } = render(<PlacesTab bodyId="wb1" />);
      await userEvent.click(screen.getByRole('button', { name: 'Same place' }));
      await waitFor(() => expect(mocks.calls).toHaveLength(1));
      rerender(<PlacesTab bodyId="wb1" />);
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Same place' })).toBeNull());
      expect(mocks.calls).toHaveLength(1);
    });

    it('Decline', async () => {
      const { rerender } = render(<PlacesTab bodyId="wb1" />);
      await userEvent.click(screen.getByRole('button', { name: 'Decline' }));
      const dialog = await screen.findByRole('alertdialog');
      await userEvent.type(within(dialog).getByRole('textbox'), 'Already on the map');
      await userEvent.click(within(dialog).getByRole('button', { name: /^Decline/ }));
      await waitFor(() => expect(mocks.calls).toHaveLength(1));
      rerender(<PlacesTab bodyId="wb1" />);
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull());
      expect(mocks.calls).toHaveLength(1);
    });

    it('Dismiss', async () => {
      const { rerender } = render(<PlacesTab bodyId="wb1" />);
      await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      const dialog = await screen.findByRole('alertdialog');
      await userEvent.click(within(dialog).getByRole('radio', { name: /Too vague|vague/i }));
      await userEvent.click(within(dialog).getByRole('button', { name: /^Dismiss/ }));
      await waitFor(() => expect(mocks.calls).toHaveLength(1));
      rerender(<PlacesTab bodyId="wb1" />);
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull());
      expect(screen.queryByText('the Narrows')).toBeNull();
      expect(mocks.calls).toHaveLength(1);
    });

    it('Already here (file as a spelling)', async () => {
      const { rerender } = render(<PlacesTab bodyId="wb1" />);
      await userEvent.click(screen.getByRole('button', { name: /Already here/ }));
      await userEvent.click(await screen.findByRole('menuitem', { name: /Mascoma Lake Dam/ }));
      await waitFor(() => expect(mocks.calls).toHaveLength(1));
      rerender(<PlacesTab bodyId="wb1" />);
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: /Already here/ })).toBeNull(),
      );
      expect(mocks.calls).toEqual([
        ['corpusPlaceNames:fileAsSpelling', { id: 'pn1', landmarkId: 'lm-dam' }],
      ]);
    });

    it('A landmark’s kind', async () => {
      const { rerender } = render(<PlacesTab bodyId="wb1" lit="landmark:lm-dam" />);
      await userEvent.click(screen.getByRole('combobox', { name: 'Kind' }));
      await userEvent.click(await screen.findByRole('option', { name: 'Island' }));
      await waitFor(() => expect(mocks.calls).toHaveLength(1));
      rerender(<PlacesTab bodyId="wb1" lit="landmark:lm-dam" />);
      // The record holds the kind now: choosing it again writes nothing.
      await userEvent.click(screen.getByRole('combobox', { name: 'Kind' }));
      await userEvent.click(await screen.findByRole('option', { name: 'Island' }));
      expect(mocks.calls).toEqual([['landmarks:update', { landmarkId: 'lm-dam', kind: 'island' }]]);
    });

    it('A landmark’s name', async () => {
      const { rerender } = render(<PlacesTab bodyId="wb1" lit="landmark:lm-dam" />);
      const name = screen.getByRole('textbox', { name: 'Name' });
      await userEvent.clear(name);
      await userEvent.type(name, 'Mascoma Dam{Enter}');
      await waitFor(() => expect(mocks.calls).toHaveLength(1));
      rerender(<PlacesTab bodyId="wb1" lit="landmark:lm-dam" />);
      await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), '{Enter}');
      expect(mocks.calls).toHaveLength(1);
    });
  });

  describe('a switch to another body that is already read', () => {
    it('drops the card’s typed name and an open decline with its note; nothing is sent for the other body', async () => {
      const { rerender } = render(
        <BodyTabHost Wiring={PlacesTab} bodyId="wb1" lit="landmark:lm-dam" />,
      );
      const name = screen.getByRole('textbox', { name: 'Name' });
      await userEvent.clear(name);
      await userEvent.type(name, 'Mascoma Dam');
      // The same card lit on the other body (its reads answer alike), so only the body's own
      // subtree, not a closed card, can drop the draft.
      rerender(<BodyTabHost Wiring={PlacesTab} bodyId="wb2" lit="landmark:lm-dam" />);
      expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Mascoma Lake Dam');
      expect(screen.queryByDisplayValue('Mascoma Dam')).toBeNull();
      // The decline's note, typed on one body, never reaches the next.
      rerender(<BodyTabHost Wiring={PlacesTab} bodyId="wb1" lit={null} />);
      await userEvent.click(screen.getByRole('button', { name: 'Decline' }));
      await userEvent.type(
        within(await screen.findByRole('alertdialog')).getByRole('textbox'),
        'Already on the map',
      );
      rerender(<BodyTabHost Wiring={PlacesTab} bodyId="wb2" lit={null} />);
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(screen.queryByDisplayValue('Already on the map')).toBeNull();
      expect(mocks.calls).toEqual([]);
    });

    it('a write started on one body still lands after the switch, and its receipt names that body', async () => {
      let land = () => {};
      mocks.gate = new Promise<void>((resolve) => {
        land = resolve;
      });
      const { rerender } = render(
        <BodyTabHost Wiring={PlacesTab} name="Mascoma Lake" bodyId="wb1" />,
      );
      await userEvent.click(screen.getByRole('button', { name: 'Decline' }));
      const dialog = await screen.findByRole('alertdialog');
      await userEvent.type(within(dialog).getByRole('textbox'), 'Already on the map');
      await userEvent.click(within(dialog).getByRole('button', { name: /^Decline/ }));
      rerender(<BodyTabHost Wiring={PlacesTab} name="Crystal Lake" bodyId="wb2" />);
      land();
      await new Promise((r) => setTimeout(r, 0));
      // Pressed is committed: it lands on its own body, and its receipt says whose it was.
      expect(mocks.announce).toHaveBeenCalledTimes(1);
      expect(mocks.announce).toHaveBeenCalledWith(
        expect.objectContaining({ subject: 'Mascoma Lake' }),
      );
      expect(toasts).toEqual([]);
      expect(mocks.calls).toEqual([
        ['corpusRequests:decline', { requestId: 'rq1', note: 'Already on the map' }],
      ]);
    });
  });
});
