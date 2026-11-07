import { type PostDraft, type PostSheet, sheetReducer } from '@skating/core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getFunctionName } from 'convex/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSheet, setSheetAttempt, useSheet } from '@/lib/sheetStore';
import { installFakeStore, openSheet, reloadPage, stubObjectUrls } from '@/lib/sheetStore.fixtures';
import { NAME_SEARCH_DEBOUNCE_MS } from './LakeNameSearch';
import { ReportSheet } from './ReportSheet';
import { SheetSlotsProvider } from './sheetSlots';

vi.mock('@/components/photoPipeline', () => import('@/lib/sheetPhotoPipeline.fake'));

const h = vi.hoisted(() => ({
  capture: vi.fn(),
  queries: new Map<string, unknown>(),
  status: 'online' as 'online' | 'offline' | 'connecting',
  post: vi.fn(),
  save: vi.fn(),
  flag: false,
  lost: 0,
  notKept: false,
  phone: false,
}));
vi.mock('../phone/usePhoneLayout', () => ({ useIsPhone: () => h.phone }));

vi.mock('@/lib/sheetStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sheetStore')>()),
  useSheetPhotosLost: () => h.lost,
  useSheetPhotosNotKept: () => h.notKept,
  dismissSheetPhotosLost: () => {
    h.lost = 0;
  },
}));

vi.mock('@/lib/analytics', () => ({ useAnalytics: () => ({ capture: h.capture }) }));
vi.mock('@/lib/featureFlags', () => ({ useFeatureFlag: () => h.flag }));
vi.mock('@/lib/useConnection', () => ({ useConnection: () => ({ status: h.status }) }));
vi.mock('convex/react', () => ({
  useConvex: () => ({}),
  useMutation: () => vi.fn(),
  useQuery: (ref: unknown, args: unknown) =>
    args === 'skip' ? undefined : h.queries.get(getFunctionName(ref as never)),
}));
vi.mock('@/lib/sheetActions', () => ({
  postSheetOnWeb: (...a: unknown[]) => h.post(...a),
  saveSheetEditOnWeb: (...a: unknown[]) => h.save(...a),
}));
// The instrument's map is MapLibre; its own tests cover it.
vi.mock('./InstrumentMap', () => ({
  InstrumentMap: ({ label }: { label: string }) => <section aria-label={label} />,
}));
vi.mock('./useSkateWeather', () => ({ useSkateWeather: () => [], useSkateWindowHours: () => [] }));
vi.mock('./useSheetBody', () => ({
  useSheetBody: (id: string | undefined) =>
    id === undefined
      ? null
      : {
          waterBodyId: id,
          name: 'Mascoma Lake',
          polygon: {
            type: 'Polygon',
            coordinates: [
              [
                [-72.2, 43.6],
                [-72.1, 43.6],
                [-72.1, 43.7],
                [-72.2, 43.6],
              ],
            ],
          },
          silhouette: null,
          frame: null,
          bays: [],
          landmarks: [],
          putIns: [],
          parking: [],
          hazards: [],
          recentCards: [],
          sunAt: () => null,
          timeZone: 'America/New_York',
        },
}));

const exits = { onClose: vi.fn(), onDiscard: vi.fn(), onDone: vi.fn() };

function Connected() {
  const post = useSheet();
  return post === null ? null : <ReportSheet post={post} exits={exits} />;
}

/**
 * An end time chosen by hand: the desk's When row no longer preselects the pinned minute
 * (founder, 2026-11-07), so a Post that must go out whole says its end here.
 */
function withEnd(post: PostSheet): PostSheet {
  return {
    ...post,
    reports: post.reports.map((r) => ({
      ...r,
      sheet: sheetReducer(r.sheet, {
        type: 'select',
        field: 'endTime',
        key: 'chosen',
        value: { ms: Date.now() - 60_000, precision: 'minute' },
      }),
    })),
  };
}

function withLake(post: PostSheet, bodyName = 'Mascoma Lake'): PostSheet {
  return {
    ...post,
    reports: post.reports.map((r) => ({
      ...r,
      bodyName,
      sheet: { ...r.sheet, waterBodyId: 'b1' },
    })),
  };
}

function blank(): PostSheet {
  const post = openSheet();
  return {
    ...post,
    reports: post.reports.map((r) => {
      const { bodyName: _n, ...rest } = r;
      return { ...rest, sheet: { ...r.sheet, waterBodyId: undefined } };
    }),
  };
}

beforeEach(() => {
  window.localStorage.clear();
  stubObjectUrls();
  installFakeStore();
  reloadPage('user_1');
  h.capture.mockReset();
  h.post.mockReset();
  h.save.mockReset();
  h.queries.clear();
  h.status = 'online';
  h.flag = false;
  h.lost = 0;
  h.notKept = false;
  h.phone = false;
  for (const f of Object.values(exits)) f.mockReset();
});
afterEach(() => setSheet(null));

describe('on a phone (9.8, 9.9)', () => {
  it('draws the instrument as its strip, the meter in the foot, and Change asks first', () => {
    h.phone = true;
    setSheet(withLake(openSheet()));
    render(<Connected />);
    expect(screen.queryByRole('region', { name: 'The lake and the day' })).toHaveAttribute(
      'data-slot',
      'phone-instrument',
    );
    expect(document.querySelector('[data-slot="instrument"]')).toBeNull();
    expect(document.querySelector('[data-slot="sheet-foot-meter"]')).toHaveTextContent(/of 10/);
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByRole('alertdialog', { name: 'Remove Mascoma Lake?' })).toBeInTheDocument();
  });
});

describe('Which lake? (5.2)', () => {
  it('asks for the lake first, with the questions waiting behind it', () => {
    setSheet(blank());
    render(<Connected />);
    expect(screen.getByRole('heading', { name: 'Which lake?' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'From a GPX file' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'From your photos' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Garmin' })).toBeInTheDocument();
    // GPX waits on its flag; Garmin is later.
    expect(screen.getAllByText('Coming soon')).toHaveLength(2);
    // The words are live; the questions wait.
    expect(screen.getByRole('textbox', { name: 'Title' })).toBeEnabled();
  });

  it('picks the lake from the search, and the instrument takes its place', async () => {
    h.queries.set('waterBodies:searchByName', [
      {
        kind: 'body',
        _id: 'b1',
        waterBodyId: 'b1',
        name: 'Mascoma Lake',
        type: 'lake',
        states: ['NH'],
      },
    ]);
    setSheet(blank());
    render(<Connected />);
    // The search debounces; on a loaded runner the real 200 ms plus a render outran findBy's
    // 1 s, so the clock steps past the debounce and the rows are there to read synchronously.
    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByRole('searchbox', { name: 'Find a lake by name' }), {
        target: { value: 'masc' },
      });
      act(() => vi.advanceTimersByTime(NAME_SEARCH_DEBOUNCE_MS));
    } finally {
      vi.useRealTimers();
    }
    fireEvent.click(screen.getByRole('button', { name: /Mascoma Lake/ }));
    expect(await screen.findByRole('heading', { name: 'Mascoma Lake' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Which lake?' })).not.toBeInTheDocument();
  });

  it('shows the GPX card’s mount point when the flag is on', () => {
    h.flag = true;
    setSheet(blank());
    render(<Connected />);
    const gpx = screen.getByRole('region', { name: 'From a GPX file' });
    expect(within(gpx).getByRole('button', { name: /Choose a file/ })).toBeDisabled();
    expect(screen.getAllByText('Coming soon')).toHaveLength(1);
  });
});

describe('the sheet (5.1)', () => {
  it('draws the lake, the words first, then the questions in their fixed order', () => {
    setSheet(withLake(openSheet()));
    render(<Connected />);
    expect(screen.getByRole('heading', { name: 'Mascoma Lake' })).toBeInTheDocument();
    const sections = screen
      .getAllByRole('button', { expanded: true })
      .concat(screen.getAllByRole('button', { expanded: false }))
      .map((b) => b.getAttribute('data-attr'))
      .filter((a) => a?.startsWith('section-'));
    expect(sections).toEqual(
      expect.arrayContaining(['section-how', 'section-ice', 'section-note']),
    );
    const order = Array.from(document.querySelectorAll('[data-slot="sheet-section"]')).map(
      (el) =>
        el.querySelector('[data-slot="sheet-section-trigger"] span:nth-child(2)')?.textContent,
    );
    expect(order).toEqual([
      'How was it?',
      'How did you see it?',
      'When',
      'Ice and surface',
      'Snow',
      'Thickness',
      'Hazards',
      'Access',
      'Anything else',
    ]);
    // The meter counts; it never says "ready".
    expect(screen.getByRole('img', { name: /of 10 questions answered/ })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/ready/i);
  });

  it('folds and unfolds a question from its row, by keyboard too', async () => {
    const user = userEvent.setup();
    setSheet(withLake(openSheet()));
    render(<Connected />);
    const snow = screen.getByRole('button', { name: 'Snow' });
    expect(snow).toHaveAttribute('aria-expanded', 'false');
    snow.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Snow' })).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard(' ');
    expect(screen.getByRole('button', { name: 'Snow' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes from its own Close (the Esc key is the frame’s)', () => {
    setSheet(withLake(openSheet()));
    render(<Connected />);
    fireEvent.click(screen.getByRole('button', { name: /Close/ }));
    expect(exits.onClose).toHaveBeenCalledTimes(1);
  });
});

describe('posting (5.23–5.27)', () => {
  it('a refused Post marks what it needs, says so, and never sends', async () => {
    setSheet(withLake(openSheet()));
    render(<Connected />);
    fireEvent.click(screen.getByRole('button', { name: 'Post' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Before this can post|add/i);
    expect(h.post).not.toHaveBeenCalled();
    const refused = h.capture.mock.calls.find((c) => c[0] === 'report_sheet_refused');
    expect(refused?.[1]).toEqual({ missing_count: expect.any(Number) });
    expect(screen.getAllByText('Needed').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('[data-cell="need"]').length).toBeGreaterThan(0);
  });

  it('folds Ice and surface to the board’s row, the whole list under More (5.9)', () => {
    setSheet(withLake(openSheet()));
    render(<Connected />);
    const section = document.getElementById('section-ice') as HTMLElement;
    // The fold's row: the chips before its More / Fewer control, by their names.
    const chipNames = () => {
      const fold = section.querySelector('[data-attr="sheet-ice-more"]') as HTMLElement;
      return [
        ...(fold.parentElement as HTMLElement).querySelectorAll('[data-attr="sheet-chip"]'),
      ].map((c) => c.getAttribute('aria-label'));
    };
    expect(chipNames()).toEqual(['Glass', 'Smooth', 'Rough', 'Bumpy']);
    expect(within(section).queryByRole('button', { name: 'Black ice' })).toBeNull();
    // A chosen chip stays in the folded row wherever it sits in the list.
    fireEvent.click(within(section).getByRole('button', { name: 'More' }));
    expect(within(section).getByRole('button', { name: 'Fewer' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    fireEvent.click(within(section).getByRole('button', { name: 'Black ice' }));
    fireEvent.click(within(section).getByRole('button', { name: 'Fewer' }));
    expect(chipNames()).toEqual(['Black ice', 'Glass', 'Smooth', 'Rough', 'Bumpy']);
  });

  it('writes the story on the underline, as the board draws it (5.1)', () => {
    setSheet(withLake(openSheet()));
    render(<Connected />);
    expect(screen.getByRole('textbox', { name: 'How was it?' })).toHaveAttribute(
      'data-variant',
      'underline',
    );
  });

  it('fades everything while posting, the tab included, then hands over the posted report', async () => {
    let land: (v: unknown) => void = () => {};
    h.post.mockImplementation(() => new Promise((r) => (land = r)));
    const post = withEnd(withLake(openSheet()));
    // A minimum set, so the Post goes out.
    setSheet(post);
    render(<Connected />);
    fireEvent.click(screen.getByRole('button', { name: 'Good' }));
    fireEvent.click(screen.getByRole('button', { name: /Experienced only/ }));
    const ice = screen.getAllByRole('button', { name: 'Glass' })[0] as HTMLElement;
    fireEvent.click(ice);
    fireEvent.click(screen.getByRole('button', { name: 'Post' }));
    await waitFor(() =>
      expect(document.querySelector('[data-slot="report-sheet"]')).toHaveAttribute('data-posting'),
    );
    expect(screen.getByRole('tablist')).toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeDisabled();
    await act(async () => land({ kind: 'posted', postId: 'p1', reportId: 'rep-1' }));
    await waitFor(() => expect(exits.onDone).toHaveBeenCalledWith('rep-1'));
    expect(h.capture).toHaveBeenCalledWith('report_posted', { report_count: 1 });
  });

  it('a Post that lands after another sheet opened counts, but hands nothing over', async () => {
    let land: (v: unknown) => void = () => {};
    h.post.mockImplementation(() => new Promise((r) => (land = r)));
    setSheet(withLake(openSheet()));
    render(<Connected />);
    fireEvent.click(screen.getByRole('button', { name: 'Good' }));
    fireEvent.click(screen.getByRole('button', { name: /Experienced only/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Glass' })[0] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Post' }));
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(1));
    // Another sheet is open by the time it lands (an account change, say).
    act(() => setSheet(withLake(openSheet())));
    await act(async () => land({ kind: 'posted', postId: 'p1', reportId: 'rep-1' }));
    expect(h.capture).toHaveBeenCalledWith('report_posted', { report_count: 1 });
    expect(exits.onDone).not.toHaveBeenCalled();
  });

  it('a Post sent with no answer says it may be up, takes no change, and offers Try again', () => {
    const post = withLake(openSheet());
    setSheet(post);
    const sent: PostDraft = {
      kind: 'post',
      id: post.draftId,
      idempotencyKey: post.idempotencyKey,
      status: 'creating',
      reports: [],
      createdAt: 1,
      updatedAt: 1,
    };
    setSheetAttempt(sent);
    render(<Connected />);
    expect(screen.getByText(/may already be up/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Title' }).closest('[inert]')).not.toBeNull();
  });

  it('offline, the sheet keeps working and the Post waits', () => {
    h.status = 'offline';
    setSheet(withLake(openSheet()));
    render(<Connected />);
    expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled();
    expect(screen.getByText(/Post once you’re back online/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Still' },
    });
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Still');
  });
});

describe('leaving and removing (5.4.1, 5.31)', () => {
  it('Cancel on a touched sheet asks first: Keep writing stays, Leave discards', async () => {
    setSheet({ ...withLake(openSheet()), dirty: true });
    render(<Connected />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Leave without posting?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Keep writing/ }));
    await waitFor(() =>
      expect(screen.queryByText('Leave without posting?')).not.toBeInTheDocument(),
    );
    expect(exits.onDiscard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(await screen.findByRole('button', { name: /Leave without posting/ }));
    expect(exits.onDiscard).toHaveBeenCalledTimes(1);
  });

  it('Cancel on an untouched sheet just goes', () => {
    setSheet(withLake(openSheet()));
    render(<Connected />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(exits.onDiscard).toHaveBeenCalledTimes(1);
  });

  it('removing the only lake asks, then starts over on Which lake?', async () => {
    setSheet(withLake(openSheet()));
    render(<Connected />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Mascoma Lake from the report' }));
    expect(await screen.findByText('Remove Mascoma Lake?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByRole('heading', { name: 'Which lake?' })).toBeInTheDocument();
  });
});

describe('the restore’s notices and the edit (5.28–5.30)', () => {
  it('reads as an edit, with Save changes', () => {
    setSheet({ ...withLake(openSheet()), mode: { kind: 'edit', reportId: 'r1' } });
    render(<Connected />);
    expect(screen.getByText('Editing a post')).toBeInTheDocument();
    expect(screen.getByText('Editing the published report')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Remove Mascoma Lake from the report/ }),
    ).not.toBeInTheDocument();
  });

  it('saves an edit and hands over the report', async () => {
    h.save.mockResolvedValue('r1');
    setSheet({ ...withEnd(withLake(openSheet())), mode: { kind: 'edit', reportId: 'r1' } });
    render(<Connected />);
    fireEvent.click(screen.getByRole('button', { name: 'Good' }));
    fireEvent.click(screen.getByRole('button', { name: 'Glass' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(exits.onDone).toHaveBeenCalledWith('r1'));
    expect(h.capture).toHaveBeenCalledWith('report_updated');
  });
});

describe('the rest of the paths', () => {
  const failed = (post: PostSheet): PostDraft => ({
    kind: 'post',
    id: post.draftId,
    idempotencyKey: post.idempotencyKey,
    status: 'pending',
    reports: [],
    createdAt: 1,
    updatedAt: 1,
  });

  it('a send the server refuses says why; pressing again counts as a retry', async () => {
    const post = withEnd(withLake(openSheet()));
    h.post.mockResolvedValue({
      kind: 'refused',
      message: 'The server said no.',
      draft: failed(post),
    });
    setSheet(post);
    setSheetAttempt(failed(post));
    render(<Connected />);
    fireEvent.click(screen.getByRole('button', { name: 'Good' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Glass' })[0] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Post' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The server said no.');
    expect(h.capture).toHaveBeenCalledWith('report_post_retried', { offline: false });
  });

  it('resends on the way back online, and counts it', async () => {
    h.post.mockResolvedValue({ kind: 'posted', postId: 'p1', reportId: 'rep-2' });
    h.status = 'offline';
    // A Post that went out whole: its end time chosen, so nothing on the sheet moves when it mounts.
    const base = withLake(openSheet());
    const post = {
      ...base,
      reports: base.reports.map((r) => ({
        ...r,
        sheet: sheetReducer(r.sheet, {
          type: 'select',
          field: 'endTime',
          key: 'chosen',
          value: { ms: Date.now() - 60_000, precision: 'minute' },
        }),
      })),
    };
    setSheet(post);
    setSheetAttempt(failed(post));
    const { rerender } = render(<Connected />);
    h.status = 'online';
    rerender(<Connected />);
    await waitFor(() => expect(exits.onDone).toHaveBeenCalledWith('rep-2'));
    expect(h.capture).toHaveBeenCalledWith('report_post_retried', { offline: true });
  });

  it('an edit the server refuses keeps the sheet and says why', async () => {
    h.save.mockRejectedValue(new Error('Not yours.'));
    setSheet({ ...withEnd(withLake(openSheet())), mode: { kind: 'edit', reportId: 'r1' } });
    render(<Connected />);
    fireEvent.click(screen.getByRole('button', { name: 'Good' }));
    fireEvent.click(screen.getByRole('button', { name: 'Glass' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not yours.');
    expect(exits.onDone).not.toHaveBeenCalled();
  });

  it('takes photos from the Which lake? card, and counts them', async () => {
    setSheet(blank());
    render(<Connected />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Photos from the day'), {
        target: {
          files: [
            new File(['x'], 'a.jpg', { type: 'image/jpeg' }),
            new File(['y'], 'n.txt', { type: 'text/plain' }),
          ],
        },
      });
    });
    await waitFor(() =>
      expect(h.capture).toHaveBeenCalledWith('report_photos_added', { source: 'device', count: 1 }),
    );
    // A photo nobody has placed waits on the Post: its tile says so.
    expect(document.querySelector('[data-unassigned]')).not.toBeNull();
  });

  it('switches between the lakes of a Post by their tabs', () => {
    const post = withLake(openSheet());
    const first = post.reports[0] as PostSheet['reports'][number];
    setSheet({
      ...post,
      reports: [first, { ...first, id: 'second', bodyName: 'Crystal Lake' }],
    });
    render(<Connected />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    fireEvent.click(tabs[1] as HTMLElement);
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps a lake when the author thinks better of removing it', async () => {
    setSheet(withLake(openSheet()));
    render(<Connected />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Mascoma Lake from the report' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(screen.queryByText('Remove Mascoma Lake?')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Mascoma Lake' })).toBeInTheDocument();
  });

  it('says what a restore could not keep, and lets the author dismiss it', () => {
    h.lost = 2;
    h.notKept = true;
    setSheet(withLake(openSheet()));
    const { rerender } = render(<Connected />);
    expect(screen.getByText(/2 photos couldn't be kept/)).toBeInTheDocument();
    expect(screen.getByText(/won't keep these photos/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    rerender(<Connected />);
    expect(screen.queryByText(/couldn't be kept/)).not.toBeInTheDocument();
  });

  it('mounts Google Photos and the second half’s flows where they belong', () => {
    setSheet(blank());
    render(
      <SheetSlotsProvider
        value={{
          googlePhotos: () => <button type="button">From Google Photos</button>,
          anotherReport: () => <button type="button">Another report</button>,
          gpxImport: () => <button type="button">Choose a GPX file</button>,
        }}
      >
        <Connected />
      </SheetSlotsProvider>,
    );
    expect(screen.getAllByRole('button', { name: 'From Google Photos' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Another report' })).toBeInTheDocument();
  });
});
