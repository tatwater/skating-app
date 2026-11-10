import {
  emptySheet,
  endTimeRow,
  openPostSheet,
  type PostSheet,
  type SheetReport,
  selectedValues,
  sheetReducer,
  startTimeChips,
} from '@skating/core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getFunctionName } from 'convex/server';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSheet, useSheet } from '@/lib/sheetStore';
import { installFakeStore, reloadPage, stubObjectUrls } from '@/lib/sheetStore.fixtures';
import { BOARD_NOW_NH } from '@/test/boardNow';
import { DayCalendar } from './DayCalendar';
import { EndTimePanel } from './EndTimePanel';
import { LakeNameSearch } from './LakeNameSearch';
import { dayStartOf } from './reportCalendar';
import { SheetWords } from './SheetWords';
import { ReportHazardButton, SheetSlotsProvider } from './sheetSlots';
import { WhichLakeCards } from './WhichLakeCards';

vi.mock('@/components/photoPipeline', () => import('@/lib/sheetPhotoPipeline.fake'));

const h = vi.hoisted(() => ({ capture: vi.fn(), queries: new Map<string, unknown>() }));
vi.mock('@/lib/analytics', () => ({ useAnalytics: () => ({ capture: h.capture }) }));
vi.mock('convex/react', () => ({
  useQuery: (ref: unknown, args: unknown) =>
    args === 'skip' ? undefined : h.queries.get(getFunctionName(ref as never)),
}));

const NH = 'America/New_York';
const NOW = BOARD_NOW_NH;
let seq = 0;
const mint = () => `s-${++seq}`;

beforeEach(() => {
  window.localStorage.clear();
  stubObjectUrls();
  installFakeStore();
  reloadPage('user_1');
  h.capture.mockReset();
  h.queries.clear();
});

describe('DayCalendar (5.6/5.7)', () => {
  function Harness({ onPick }: { onPick: (ms: number) => void }) {
    const [day, setDay] = useState(dayStartOf(NOW, NH));
    return (
      <DayCalendar
        dayStartMs={day}
        nowMs={NOW}
        timeZone={NH}
        onPick={(d) => {
          setDay(d.startMs);
          onPick(d.startMs);
        }}
      />
    );
  }

  it('opens two rows with only the last 7 days live, and picks one', async () => {
    const picked = vi.fn();
    render(<Harness onPick={picked} />);
    const chip = screen.getByRole('button', { name: /Today · Sat, Jan 16/ });
    fireEvent.click(chip);
    const days = within(
      await screen.findByRole('group', { name: 'Which day was it?' }),
    ).getAllByRole('button');
    expect(days).toHaveLength(14);
    expect(days.filter((d) => !(d as HTMLButtonElement).disabled)).toHaveLength(8);
    expect(screen.getByText('January 2027')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Thursday, January 14' }));
    expect(picked).toHaveBeenCalledWith(dayStartOf(Date.UTC(2027, 0, 14, 15), NH));
    expect(await screen.findByRole('button', { name: /^Thu, Jan 14/ })).toBeInTheDocument();
  });

  it('refuses a day outside the window', async () => {
    render(<Harness onPick={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Today/ }));
    expect(await screen.findByRole('button', { name: 'Friday, January 8' })).toBeDisabled();
  });

  it('agrees with the ladder the server rule allows', () => {
    const row = endTimeRow({ openedAtMs: NOW, nowMs: NOW, timeZone: NH, sun: null });
    expect(row.pickerMinMs).toBe(NOW - 7 * 24 * 3600_000);
  });
});

describe('SheetWords — the words and photos', () => {
  function Connected({ editing = false }: { editing?: boolean }) {
    const post = useSheet();
    if (post === null) return null;
    const first = post.reports[0];
    if (first === undefined) return null;
    return <SheetWords post={post} ordered={post.reports} editing={editing} activeReport={first} />;
  }

  it('writes the title and the story into the Post, and keeps them out of analytics', () => {
    setSheet(openPostSheet('body', { waterBodyId: 'b1', bodyName: 'Morey' }, NOW, mint));
    render(<Connected />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Morey, first ice' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'How was it?' }), {
      target: { value: 'Glass.' },
    });
    let post: PostSheet | null = null;
    function Probe() {
      post = useSheet();
      return null;
    }
    render(<Probe />);
    expect(post).toMatchObject({ title: 'Morey, first ice', body: 'Glass.', dirty: true });
    expect(document.querySelector('[data-slot="sheet-words"]')).toHaveClass('ph-no-capture');
  });

  it('adds photos from the device and counts them', async () => {
    setSheet(openPostSheet('body', { waterBodyId: 'b1', bodyName: 'Morey' }, NOW, mint));
    render(<Connected />);
    const input = screen.getByLabelText('Photos to add') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, {
        target: { files: [new File(['x'], 'a.jpg', { type: 'image/jpeg' })] },
      });
    });
    await waitFor(() =>
      expect(h.capture).toHaveBeenCalledWith('report_photos_added', { source: 'device', count: 1 }),
    );
    expect(document.querySelectorAll('[data-slot="photo-tile"]')).toHaveLength(1);
  });

  it('removes a kept photo from an edit, by its own button', () => {
    const post = openPostSheet('body', { waterBodyId: 'b1', bodyName: 'Morey' }, NOW, mint);
    const first = post.reports[0];
    if (first === undefined) throw new Error('no report');
    h.queries.set('photos:getUrls', [{ photoId: 'kept-1', thumbUrl: 'https://t/1.jpg' }]);
    setSheet({
      ...post,
      mode: { kind: 'edit', reportId: first.id },
      reports: [{ ...first, keptPhotoIds: ['kept-1'] }],
    });
    render(<Connected editing />);
    expect(document.querySelectorAll('[data-slot="photo-tile"]')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Remove this photo' }));
    expect(document.querySelectorAll('[data-slot="photo-tile"]')).toHaveLength(0);
  });

  it('hands a tile’s mark to the photo menu when the second half mounts one', async () => {
    const post = openPostSheet('body', { waterBodyId: 'b1', bodyName: 'Morey' }, NOW, mint);
    setSheet({
      ...post,
      photos: [{ id: 'pool-1', fullUri: 'f', thumbUri: 't', placeOnMap: false }],
    });
    const menu = vi.fn(({ trigger }: { trigger: React.ReactNode }) => (
      <span data-testid="menu">{trigger}</span>
    ));
    render(
      <SheetSlotsProvider value={{ photoTileMenu: menu }}>
        <Connected />
      </SheetSlotsProvider>,
    );
    expect(within(screen.getByTestId('menu')).getByText('?')).toBeInTheDocument();
    expect(menu.mock.calls[0]?.[0]).toMatchObject({ reportId: null });
  });

  it('still mounts the menu on an assigned photo in a one-lake Post, which shows no number', () => {
    const post = openPostSheet('body', { waterBodyId: 'b1', bodyName: 'Morey' }, NOW, mint);
    const first = post.reports[0];
    if (first === undefined) throw new Error('no report');
    setSheet({
      ...post,
      reports: [
        { ...first, photos: [{ id: 'on-1', fullUri: 'f', thumbUri: 't', placeOnMap: false }] },
      ],
    });
    const menu = vi.fn(({ trigger }: { trigger: React.ReactNode }) => (
      <span data-testid="menu">{trigger}</span>
    ));
    render(
      <SheetSlotsProvider value={{ photoTileMenu: menu }}>
        <Connected />
      </SheetSlotsProvider>,
    );
    expect(menu).toHaveBeenCalledTimes(1);
    expect(menu.mock.calls[0]?.[0]).toMatchObject({ reportId: first.id });
    expect(
      within(screen.getByTestId('menu')).getByText(
        (_, el) => el?.getAttribute('data-slot') === 'photo-tile-mark',
      ),
    ).toBeInTheDocument();
  });

  it('gives a kept photo no menu and no mark', () => {
    const post = openPostSheet('body', { waterBodyId: 'b1', bodyName: 'Morey' }, NOW, mint);
    const first = post.reports[0];
    if (first === undefined) throw new Error('no report');
    h.queries.set('photos:getUrls', [{ photoId: 'kept-1', thumbUrl: 'https://t/1.jpg' }]);
    setSheet({
      ...post,
      mode: { kind: 'edit', reportId: first.id },
      reports: [{ ...first, keptPhotoIds: ['kept-1'] }],
    });
    const menu = vi.fn();
    render(
      <SheetSlotsProvider value={{ photoTileMenu: menu }}>
        <Connected editing />
      </SheetSlotsProvider>,
    );
    expect(menu).not.toHaveBeenCalled();
    expect(document.querySelector('[data-slot="photo-tile-mark"]')).toBeNull();
  });
});

describe('LakeNameSearch — the keyboard path', () => {
  it('/ focuses it; arrows move; Enter picks; a bay picks its lake', async () => {
    const user = userEvent.setup();
    h.queries.set('waterBodies:searchByName', [
      {
        kind: 'body',
        _id: 'b1',
        waterBodyId: 'b1',
        name: 'Mascoma Lake',
        type: 'lake',
        states: ['NH'],
      },
      {
        kind: 'subArea',
        _id: 's1',
        waterBodyId: 'b1',
        name: 'Mascoma North',
        parentName: 'Mascoma Lake',
        type: 'bay',
        states: ['NH'],
      },
    ]);
    const onPick = vi.fn();
    render(<LakeNameSearch onPick={onPick} />);
    await user.keyboard('/');
    const box = screen.getByRole('searchbox', { name: 'Find a lake by name' });
    expect(box).toHaveFocus();
    await user.type(box, 'masc');
    await screen.findByRole('button', { name: /Mascoma North/ });
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}{ArrowDown}{Enter}');
    expect(onPick).toHaveBeenCalledWith({ waterBodyId: 'b1', name: 'Mascoma Lake' });
  });

  it('says when nothing matches', async () => {
    h.queries.set('waterBodies:searchByName', []);
    render(<LakeNameSearch onPick={vi.fn()} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
    expect(await screen.findByText(/No lake by that name/)).toBeInTheDocument();
  });

  it('leaves / alone while the author is typing elsewhere', async () => {
    const user = userEvent.setup();
    render(
      <>
        <textarea aria-label="Story" />
        <LakeNameSearch onPick={vi.fn()} />
      </>,
    );
    await user.click(screen.getByRole('textbox', { name: 'Story' }));
    await user.keyboard('/');
    expect(screen.getByRole('textbox', { name: 'Story' })).toHaveValue('/');
  });
});

describe('ReportHazardButton — the stacked hazard’s mount point (5.10)', () => {
  it('is inert until the flow is mounted', () => {
    render(<ReportHazardButton waterBodyId="b1" reportId="r1" />);
    expect(screen.getByRole('button', { name: /Report a new hazard/ })).toBeDisabled();
  });

  it('opens the mounted flow over the report and records where it started', () => {
    const stackedHazard = vi.fn(({ onClose }: { onClose: () => void }) => (
      <button type="button" onClick={onClose}>
        Stacked
      </button>
    ));
    render(
      <SheetSlotsProvider value={{ stackedHazard }}>
        <ReportHazardButton waterBodyId="b1" reportId="r1" />
      </SheetSlotsProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Report a new hazard/ }));
    expect(h.capture).toHaveBeenCalledWith('hazard_flow_started', { entry: 'report_sheet' });
    expect(stackedHazard.mock.calls[0]?.[0]).toMatchObject({ waterBodyId: 'b1', reportId: 'r1' });
    fireEvent.click(screen.getByRole('button', { name: 'Stacked' }));
    expect(screen.queryByRole('button', { name: 'Stacked' })).not.toBeInTheDocument();
  });
});

describe('EndTimePanel — the day and the ladder (5.6/5.7)', () => {
  function Panel({ sunset }: { sunset?: number }) {
    const [report, setReport] = useState<SheetReport>(() => ({
      id: 'r1',
      idempotencyKey: 'k1',
      sheet: { ...emptySheet(Date.now(), 'b1'), collapsed: { ...emptySheet(0).collapsed } },
      photos: [],
      keptPhotoIds: [],
      bundleCandidateIds: [],
      unbundledHazardIds: [],
    }));
    latest = report;
    const dispatch = (action: Parameters<typeof sheetReducer>[1]) =>
      setReport((r) => ({ ...r, sheet: sheetReducer(r.sheet, action) }));
    panelDispatch = dispatch;
    return (
      <EndTimePanel
        report={report}
        body={
          sunset === undefined
            ? null
            : ({ sunAt: () => ({ sunriseMs: sunset - 9 * 3600_000, sunsetMs: sunset }) } as never)
        }
        dispatch={dispatch}
        setReport={(u) => setReport(u)}
        gaps={new Set()}
        editing={false}
        timeZone={NH}
      />
    );
  }
  let latest: SheetReport | undefined;
  let panelDispatch: ((action: Parameters<typeof sheetReducer>[1]) => void) | undefined;

  /** The founder's phone: the primary pointer is a finger, so "now" is on offer. */
  function coarsePointer() {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query === '(pointer: coarse)',
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    );
  }
  // Only the clock is faked (never the timers — the async utils need those real): a typed
  // "6:15 AM" must sit in the past whatever hour the suite runs at.
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: NOW }));
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('under a finger, preselects the minute in daylight, and moves the end to the day picked', async () => {
    coarsePointer();
    render(<Panel />);
    const [end] = selectedValues((latest as SheetReport).sheet, 'endTime');
    expect(end?.precision).toBe('minute');
    expect(screen.getByRole('button', { name: /· now/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Today/ }));
    const days = within(
      await screen.findByRole('group', { name: 'Which day was it?' }),
    ).getAllByRole('button');
    const yesterday = days.filter((d) => !(d as HTMLButtonElement).disabled).at(-2) as HTMLElement;
    fireEvent.click(yesterday);
    const [moved] = selectedValues((latest as SheetReport).sheet, 'endTime');
    expect(moved?.ms).toBeLessThan(end?.ms ?? 0);
    expect(moved?.precision).toBe('half_hour');
    // The ladder moved with the day: the same clocks, none of them "now", the moved end chosen.
    expect(screen.queryByRole('button', { name: /· now/ })).not.toBeInTheDocument();
    const chosenChip = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('aria-pressed') === 'true');
    expect(chosenChip).toHaveTextContent(/\d{1,2}:\d{2} [AP]M/);
  });

  it('on a desk, offers no "now" and preselects nothing — a few half hours and Another time', () => {
    render(<Panel />);
    expect(selectedValues((latest as SheetReport).sheet, 'endTime')).toEqual([]);
    expect(screen.queryByRole('button', { name: /· now/ })).not.toBeInTheDocument();
    // One short row: three half hours and the picker. Nothing to wrap.
    const timeChips = screen
      .getAllByRole('button')
      .filter((b) => /^\d{1,2}:\d{2} [AP]M$/.test(b.textContent ?? ''));
    expect(timeChips).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Another time' })).toBeInTheDocument();
  });

  it('on a desk, picking a day seeds the end from the ladder, never the sheet-open minute', async () => {
    render(<Panel />);
    fireEvent.click(screen.getByRole('button', { name: /^Today/ }));
    const days = within(
      await screen.findByRole('group', { name: 'Which day was it?' }),
    ).getAllByRole('button');
    const yesterday = days.filter((d) => !(d as HTMLButtonElement).disabled).at(-2) as HTMLElement;
    fireEvent.click(yesterday);
    const [moved] = selectedValues((latest as SheetReport).sheet, 'endTime');
    expect(moved?.precision).toBe('half_hour');
    // A half-hour clock, so the moved end sits ON the moved ladder — the row keeps its chips
    // instead of collapsing to a value no desk was offered.
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
    const chosenChip = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('aria-pressed') === 'true');
    expect(chosenChip).toHaveTextContent(/^\d{1,2}:(00|30) [AP]M$/);
  });

  it('an end set off the chips collapses the row to the value, and Reset brings the chips back', () => {
    coarsePointer();
    render(<Panel />);
    // The ruler's drag lands on a half minute no chip offers.
    act(() => {
      panelDispatch?.({
        type: 'select',
        field: 'endTime',
        key: 'chosen',
        value: { ms: Date.now() - 47 * 60_000 + 30_000, precision: 'minute' },
      });
    });
    expect(screen.queryByRole('button', { name: /· now/ })).not.toBeInTheDocument();
    // The end row's ladder and picker are gone; the one "Another time" left is the start row's.
    expect(screen.getAllByRole('button', { name: 'Another time' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    // Back to the default: the chips return and the pinned minute is selected again.
    const [end] = selectedValues((latest as SheetReport).sheet, 'endTime');
    expect(end?.precision).toBe('minute');
    expect(screen.getByRole('button', { name: /· now/ })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Another time' })).toHaveLength(2);
  });

  it('Another time is a time-only input on the chosen day', () => {
    coarsePointer();
    render(<Panel />);
    // Two rows offer "Another time"; the end row's comes first.
    fireEvent.click(screen.getAllByRole('button', { name: 'Another time' })[0] as HTMLElement);
    const input = screen.getByLabelText('The minute you got off the ice');
    expect(input).toHaveAttribute('type', 'time');
    fireEvent.change(input, { target: { value: '06:15' } });
    const [end] = selectedValues((latest as SheetReport).sheet, 'endTime');
    expect(end).toBeDefined();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: NH,
      hour: 'numeric',
      minute: '2-digit',
      hour12: false,
    }).format(end?.ms);
    expect(parts).toBe('06:15');
  });

  it('after dark, asks which day and when, and preselects nothing', () => {
    coarsePointer();
    render(<Panel sunset={Date.now() - 3 * 3600_000} />);
    expect(screen.getByText(/It's after dark/)).toBeInTheDocument();
    expect(selectedValues((latest as SheetReport).sheet, 'endTime')).toEqual([]);
  });

  it('offers the half hours before the end as start chips, and one sets the start', () => {
    coarsePointer();
    render(<Panel />);
    const [end] = selectedValues((latest as SheetReport).sheet, 'endTime');
    const expected = startTimeChips(end?.ms as number, NH);
    const clock = new Intl.DateTimeFormat('en-US', {
      timeZone: NH,
      hour: 'numeric',
      minute: '2-digit',
    });
    // The deepest chip's clock is the start row's alone — the end ladder stops a chip earlier.
    const deepest = expected[2] as number;
    fireEvent.click(screen.getByRole('button', { name: clock.format(deepest) }));
    expect((latest as SheetReport).sheet.scalars.skateStartTime).toBe(deepest);
    // How long reads back from it.
    expect(screen.getByRole('button', { name: /\d h \d{2}/ })).toBeInTheDocument();
  });

  it('a typed start is time-only, its date inferred: a later clock reading is last night', () => {
    coarsePointer();
    render(<Panel />);
    const [end] = selectedValues((latest as SheetReport).sheet, 'endTime');
    fireEvent.click(screen.getAllByRole('button', { name: 'Another time' })[1] as HTMLElement);
    const input = screen.getByLabelText('The minute you got on the ice');
    expect(input).toHaveAttribute('type', 'time');
    fireEvent.change(input, { target: { value: '23:30' } });
    const start = (latest as SheetReport).sheet.scalars.skateStartTime;
    expect(start).toBeDefined();
    expect(start as number).toBeLessThan(end?.ms as number);
    expect((end?.ms as number) - (start as number)).toBeLessThan(25 * 3600_000);
  });
});

describe('WhichLakeCards — the photo drop', () => {
  it('takes dropped photos, and a dragged-over zone says so', () => {
    const onPhotos = vi.fn();
    render(
      <WhichLakeCards
        ordinal={1}
        gpxEnabled={false}
        photosBusy={false}
        onPhotos={onPhotos}
        search={null}
      />,
    );
    const zone = document.querySelector('[data-mount="photos"]') as HTMLElement;
    fireEvent.dragOver(zone);
    expect(zone).toHaveAttribute('data-dragging');
    fireEvent.dragLeave(zone);
    expect(zone).not.toHaveAttribute('data-dragging');
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    expect(onPhotos).toHaveBeenCalledWith([file]);
    fireEvent.click(screen.getByRole('button', { name: /Photos/ }));
  });
});

describe('SheetWords — the rest of the strip', () => {
  function Connected({ editing = false }: { editing?: boolean }) {
    const post = useSheet();
    const first = post?.reports[0];
    if (post === null || first === undefined) return null;
    return <SheetWords post={post} ordered={post.reports} editing={editing} activeReport={first} />;
  }

  it('in an edit, adds new photos to the Report and removes one again', async () => {
    const post = openPostSheet('body', { waterBodyId: 'b1', bodyName: 'Morey' }, NOW, mint);
    const first = post.reports[0];
    if (first === undefined) throw new Error('no report');
    setSheet({ ...post, mode: { kind: 'edit', reportId: first.id } });
    render(<Connected editing />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Photos to add'), {
        target: { files: [new File(['x'], 'a.jpg', { type: 'image/jpeg' })] },
      });
    });
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="photo-tile"]')).toHaveLength(1),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove this photo' }));
    expect(document.querySelectorAll('[data-slot="photo-tile"]')).toHaveLength(0);
  });

  it('offers Google Photos on an empty strip when it is mounted', () => {
    setSheet(openPostSheet('body', { waterBodyId: 'b1', bodyName: 'Morey' }, NOW, mint));
    const googlePhotos = vi.fn(({ onPhotos }: { onPhotos: (d: never[]) => void }) => (
      <button type="button" onClick={() => onPhotos([])}>
        From Google Photos
      </button>
    ));
    render(
      <SheetSlotsProvider value={{ googlePhotos }}>
        <Connected />
      </SheetSlotsProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'From Google Photos' }));
    expect(googlePhotos).toHaveBeenCalled();
  });

  it('ignores a pick with no images in it', async () => {
    setSheet(openPostSheet('body', { waterBodyId: 'b1', bodyName: 'Morey' }, NOW, mint));
    render(<Connected />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Photos to add'), {
        target: { files: [new File(['x'], 'a.txt', { type: 'text/plain' })] },
      });
    });
    expect(h.capture).not.toHaveBeenCalled();
  });
});
