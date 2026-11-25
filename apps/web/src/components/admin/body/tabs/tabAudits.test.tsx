import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { createPortal } from 'react-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { FAILED_READ } from '@/components/admin/reads/readFailureFixtures';
import { KeysProvider } from '@/lib/keys';
import { expectNoBlanks } from '@/test/blanksAudit';
import { ARRIVALS, InConsole } from '@/test/consoleArrivals';
import { expectKeyboardOperable } from '@/test/keyboardAudit';
import { AccessView } from './access/AccessView';
import { BOARD_TODAY, MASCOMA_ACCESS } from './access/accessFixtures';
import type { AccessData } from './access/accessModel';
import type { FeatureRowWithGlyph } from './hazards/HazardsTabView';
import { HazardsTabView } from './hazards/HazardsTabView';
import {
  FEB_ARCHIVED,
  FEB_HAZARDS,
  FEB_NOW,
  SEASON as HAZARD_SEASON,
  MASCOMA_FEATURE_ROWS,
  MASCOMA_WINTERS,
  PAST_WINTERS,
  WATCH_OPENED,
} from './hazards/hazardsFixtures';
import { archivedRows, hazardRows } from './hazards/hazardsModel';
import { ImageryTabView } from './imagery/ImageryTabView';
import {
  granuleOf,
  SEASON as IMAGERY_SEASON,
  INFERRED_STOP,
  MASCOMA_PASSES,
  MASCOMA_SATELLITE,
} from './imagery/imageryFixtures';
import type { PassRow } from './imagery/imageryModel';
import { passRows } from './imagery/imageryModel';
import { stubJsdomAnimations } from './jsdomStubs';
import { LinksTabView } from './links/LinksTabView';
import { MASCOMA as LINKS_BODY, BODY_NOW as LINKS_NOW, SMALL_POND } from './links/linksFixtures';
import { NamesView } from './names/NamesView';
import { MASCOMA_NAMES } from './names/namesFixtures';
import type { NamesData } from './names/namesModel';
import { PlacesView } from './places/PlacesView';
import { MASCOMA_LANDMARKS, MASCOMA_PLACES, SELECTED_UPPER } from './places/placesFixtures';
import type { PlacesData } from './places/placesModel';
import { StandingTabView } from './standing/StandingTabView';
import {
  ACTIVE,
  ACTIVE_SINCE,
  DORMANT_BY_HAND,
  MASCOMA_RETENTION,
  BODY_NOW as STANDING_NOW,
} from './standing/standingFixtures';
import { WaterView } from './water/WaterView';
import { MASCOMA_WATER } from './water/waterFixtures';
import type { WaterData } from './water/waterModel';

/**
 * Every tab of the console, held to three rules — one test per tab for each:
 *
 * 1. **What answers a click answers the keyboard** (`expectKeyboardOperable`), with every lever drawn.
 * 2. **No absent fact renders as a blank** (`expectNoBlanks`), with every fact the record may lack
 *    absent: *Not recorded yet* (or the house wording), never an empty slot, "undefined" or a
 *    dangling "·".
 * 3. **A tab's keys work however the tab is reached** (`ARRIVALS`): the list's Open or a deep link,
 *    the tab strip by press and by arrows, an ask.
 */

const toasts = vi.hoisted(() => ({ said: [] as unknown[] }));
vi.mock('@/components/kit/toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/kit/toast')>()),
  toast: (options: unknown) => {
    toasts.said.push(options);
    return 'toast';
  },
}));

beforeAll(stubJsdomAnimations);
beforeEach(() => {
  toasts.said = [];
});

const inKeys = (node: ReactNode) => <KeysProvider>{node}</KeysProvider>;
const settle = async () => true;
/** The landmark tools' entry points (B01-6b): the wiring opens them; here they're only counted. */
const dropped = vi.fn();
const moved = vi.fn();
/** Access's map tasks started (B01-6b): P places a put-in, L a lot. */
const placing = vi.fn();

// ── The tabs with every lever ─────────────────────────────────────────────────────────────────

const LEVERS: Record<string, ReactNode> = {
  Names: (
    <NamesView
      data={{ ...MASCOMA_NAMES, aliases: ['Mascoma'] }}
      onChooseName={() => {}}
      onClassChange={() => {}}
      onAliasesChange={() => {}}
      canEditAliases
      canEditClass
    />
  ),
  Places: (
    <PlacesView
      data={MASCOMA_PLACES}
      lit={SELECTED_UPPER}
      canPlace
      onLitChange={() => {}}
      onFileAsSpelling={() => {}}
      onDismissName={settle}
      onSamePlace={() => {}}
      onDecline={settle}
      onEditLandmark={() => {}}
      onMoveLandmark={moved}
    />
  ),
  'Places, the list': (
    <PlacesView
      data={MASCOMA_PLACES}
      canPlace
      onLitChange={() => {}}
      onEditLandmark={() => {}}
      onDropLandmark={dropped}
    />
  ),
  Access: (
    <AccessView
      data={MASCOMA_ACCESS}
      now={BOARD_TODAY}
      canPlace
      onRule={settle}
      onMakeOfficial={() => {}}
      onHide={settle}
      onAddPutIn={placing}
      onAddLot={placing}
    />
  ),
  Water: <WaterView data={MASCOMA_WATER} onChooseDepth={() => {}} canChooseDepth canFileSurvey />,
  Imagery: (
    <ImageryTabView
      season={IMAGERY_SEASON}
      rows={MASCOMA_PASSES}
      lit={granuleOf(10)}
      onLitChange={() => {}}
      onOverride={async () => true}
      onRetry={() => {}}
      satellite={MASCOMA_SATELLITE}
      onSatelliteChange={async () => true}
    />
  ),
  Hazards: (
    <HazardsTabView
      season={HAZARD_SEASON}
      currentSeason={HAZARD_SEASON}
      onSeasonChange={() => {}}
      bodyName="Mascoma"
      watchOpenedAt={WATCH_OPENED}
      hazards={hazardRows(FEB_HAZARDS, FEB_NOW)}
      archived={archivedRows(FEB_ARCHIVED)}
      features={MASCOMA_FEATURE_ROWS}
      winters={MASCOMA_WINTERS}
      patternsWaiting={{ count: 2, capped: false }}
      onOpenRecurrence={() => {}}
      onDemote={async () => true}
      onRetry={() => {}}
      onAddFeature={() => {}}
      onEditShape={() => {}}
      lit={null}
      onLitChange={() => {}}
    />
  ),
  Standing: (
    <StandingTabView
      standing={ACTIVE}
      activeSince={ACTIVE_SINCE}
      retention={MASCOMA_RETENTION}
      now={STANDING_NOW}
      canSetStanding
      canRemove
      onSetDormant={async () => true}
      onSetActive={async () => true}
      onRemove={async () => true}
      onRestore={async () => true}
    />
  ),
  Links: (
    <LinksTabView
      body={LINKS_BODY}
      now={LINKS_NOW}
      canEdit
      onSave={async () => {}}
      lakeSheetHref="/water/k1"
    />
  ),
};

// ── The tabs with every fact absent ───────────────────────────────────────────────────────────

const NAMES_BARE: NamesData = {
  ...MASCOMA_NAMES,
  rungs: [],
  aliases: [],
  classOptions: null,
  perCatalogClaims: null,
  place: { admin: 'not-computed', states: [], townLines: null },
};

const PLACES_BARE: PlacesData = {
  ...MASCOMA_PLACES,
  asks: [
    {
      kind: 'proposal',
      id: 'ask-bare',
      name: 'the flats',
      aliases: [],
      point: { lat: 43.64, lng: -72.17 },
      askers: 1,
      asked: null,
      asker: null,
      existingLandmarkId: null,
      similar: null,
    },
  ],
  landmarks: MASCOMA_LANDMARKS.slice(0, 2).map((l) => ({
    ...l,
    aliases: [],
    bay: null,
    areaSqM: null,
    added: null,
  })),
};

const ACCESS_BARE: AccessData = {
  ruling: {
    verdict: null,
    statement: null,
    decidedAt: null,
    decidedBy: null,
    before: undefined,
    history: { earlier: 0, capped: false },
  },
  putIns: [
    {
      id: 'pi-x',
      name: 'Unnamed put-in',
      unnamed: true,
      source: 'osm',
      at: { lat: 43.63, lng: -72.15 },
      walk: null,
      approach: null,
      lotId: null,
      hikeIn: false,
      where: null,
    },
  ],
  lots: [{ id: 'lot-x', name: null, at: { lat: 43.63, lng: -72.15 } }],
  postedRule: null,
  alerts: [{ id: 'al-x', label: 'Gate locked', on: null, official: false }],
  failures: [],
};

const WATER_BARE: WaterData = {
  ...MASCOMA_WATER,
  name: '',
  state: null,
  depthNote: null,
  depth: { rungs: [], meanFrom: null, maxFrom: null, others: null },
  sampling: { interior: null, points: null, acrossKm: null, wide: false },
  bathymetry: { searched: null, found: 'No contour lines', missing: true },
  box: null,
};

const IMAGERY_BARE = passRows([INFERRED_STOP], {});

const HAZARDS_BARE = (
  <HazardsTabView
    season={HAZARD_SEASON - 1}
    currentSeason={HAZARD_SEASON}
    onSeasonChange={() => {}}
    bodyName="this body"
    watchOpenedAt={null}
    hazards={hazardRows(FEB_HAZARDS, FEB_NOW).map((h) => ({ ...h, place: null }))}
    archived={archivedRows(FEB_ARCHIVED).map((a) => ({ ...a, place: null }))}
    features={MASCOMA_FEATURE_ROWS.map((f) => ({ ...f, place: null, glyph: null }))}
    winters={PAST_WINTERS}
    patternsWaiting={null}
    lit={null}
    onLitChange={() => {}}
  />
);

const BARE_LANDMARK = MASCOMA_LANDMARKS[0]?.id ?? '';

const BARE: Record<string, ReactNode> = {
  Names: <NamesView data={NAMES_BARE} />,
  Places: <PlacesView data={PLACES_BARE} lit={`landmark:${BARE_LANDMARK}`} />,
  'Places, the list': <PlacesView data={PLACES_BARE} />,
  Access: <AccessView data={ACCESS_BARE} now={BOARD_TODAY} />,
  Water: <WaterView data={WATER_BARE} />,
  Imagery: (
    <ImageryTabView
      season={IMAGERY_SEASON}
      rows={IMAGERY_BARE}
      lit={null}
      onLitChange={() => {}}
      satellite={{ ...MASCOMA_SATELLITE, name: '', url: null }}
    />
  ),
  Hazards: HAZARDS_BARE,
  Standing: (
    <StandingTabView
      standing={DORMANT_BY_HAND}
      activeSince={null}
      retention={{
        lastActivity: null,
        curatedBoost: { value: 0.3, at: null },
        favorites: null,
        savedPutIns: null,
        putInKeeps: null,
      }}
      now={STANDING_NOW}
      canSetStanding={false}
      canRemove={false}
    />
  ),
  Links: <LinksTabView body={SMALL_POND} now={LINKS_NOW} canEdit={false} lakeSheetHref={null} />,
};

describe('every tab answers the keyboard wherever it answers a click', () => {
  it.each(Object.entries(LEVERS))('%s', (_tab, node) => {
    const { container } = render(inKeys(node));
    expect(expectKeyboardOperable(container).length).toBeGreaterThan(0);
  });
});

describe('every picture a pointer reads day by day is read from the keyboard too', () => {
  it.each(Object.entries(LEVERS))('%s', (_tab, node) => {
    const { container } = render(inKeys(node));
    const pictures = container.querySelectorAll<SVGElement>('[data-slot="day-strips"]');
    // Hazards draws its winters so; a tab that draws none has nothing to check.
    if (_tab === 'Hazards') expect(pictures.length).toBeGreaterThan(0);
    for (const strips of pictures) {
      const frame = strips.closest('[data-slot="day-strips-frame"]') as HTMLElement;
      const keys = frame.querySelector<HTMLElement>('[role="slider"]') as HTMLElement;
      // One tab stop, which the arrows move and which says the day it is on.
      expect(keys.tabIndex).toBe(0);
      keys.focus();
      fireEvent.keyDown(keys, { key: 'Home' });
      expect(keys.getAttribute('aria-valuenow')).toBe('0');
      fireEvent.keyDown(keys, { key: 'ArrowRight' });
      expect(keys.getAttribute('aria-valuenow')).toBe('1');
      // Its words: the day, the strip, what the strip holds that day.
      expect(keys.getAttribute('aria-valuetext')).toMatch(/^\d{1,2} [A-Z][a-z]{2}, .+: .+$/);
      // The picture names its table of days.
      const table = document.getElementById(strips.getAttribute('aria-details') ?? '');
      expect(table?.tagName).toBe('TABLE');
    }
  });
});

describe('no tab draws an absent fact as a blank', () => {
  it('a launch with no landmark near it says so, not an empty line', () => {
    render(inKeys(BARE.Access));
    expect(screen.getByText('No landmark near it')).toBeInTheDocument();
  });

  it.each(Object.entries(BARE))('%s', (_tab, node) => {
    const { container } = render(inKeys(node));
    expectNoBlanks(container);
  });
});

// ── Each tab's keys, every way it is reached ──────────────────────────────────────────────────

const marked = vi.fn();
const overridden = vi.fn(async () => true);

/** Each tab with keys, one of its keys, and how to tell the right tool acted. */
const KEYED: [string, () => ReactNode, string, () => boolean][] = [
  ['Access', () => LEVERS.Access, 'p', () => placing.mock.calls.length === 1],
  ['Places', () => LEVERS['Places, the list'], 'l', () => dropped.mock.calls.length === 1],
  ['a landmark’s card in Places', () => LEVERS.Places, 'm', () => moved.mock.calls.length === 1],
  [
    'Hazards',
    () => (
      <HazardsTabView
        season={HAZARD_SEASON}
        currentSeason={HAZARD_SEASON}
        onSeasonChange={() => {}}
        bodyName="Mascoma"
        watchOpenedAt={WATCH_OPENED}
        hazards={[]}
        archived={[]}
        features={MASCOMA_FEATURE_ROWS}
        winters={MASCOMA_WINTERS}
        patternsWaiting={{ count: 2, capped: false }}
        onAddFeature={marked}
        lit={null}
        onLitChange={() => {}}
      />
    ),
    'f',
    () => marked.mock.calls.length === 1,
  ],
  [
    'Imagery',
    () => (
      <ImageryTabView
        season={IMAGERY_SEASON}
        rows={MASCOMA_PASSES}
        lit={granuleOf(10)}
        onLitChange={() => {}}
        onOverride={overridden}
        satellite={MASCOMA_SATELLITE}
      />
    ),
    's',
    () => overridden.mock.calls.length === 1,
  ],
];

describe('a tab’s keys work however the tab is reached', () => {
  beforeEach(() => {
    marked.mockClear();
    overridden.mockClear();
    dropped.mockClear();
    moved.mockClear();
    placing.mockClear();
  });
  for (const [tab, node, key, acted] of KEYED) {
    it.each(ARRIVALS)(`${tab}: ${key.toUpperCase()} after %s`, async (_way, arrive) => {
      const user = userEvent.setup();
      render(<InConsole panel={node()} />);
      await arrive(user);
      await user.keyboard(key);
      expect(acted()).toBe(true);
    });
  }
});

describe('a tab’s key answers only while its control is drawn', () => {
  // The inspector listens whatever the tab draws, so a key must rest with its control.
  it.each<[string, ReactNode, string]>([
    [
      'Access, loading',
      <AccessView key="a" data={undefined} now={BOARD_TODAY} canPlace onAddPutIn={placing} />,
      'p',
    ],
    [
      'Access, its read failed',
      <AccessView key="a" data={FAILED_READ} now={BOARD_TODAY} canPlace onAddLot={placing} />,
      'l',
    ],
    [
      'Access, a task already up',
      <AccessView
        key="a"
        data={MASCOMA_ACCESS}
        now={BOARD_TODAY}
        canPlace
        onAddPutIn={placing}
        task={<p>A task</p>}
      />,
      'p',
    ],
    [
      'Access, a posted rule already written',
      <AccessView
        key="a"
        data={{ ...MASCOMA_ACCESS, postedRule: 'Open sunrise to sunset' }}
        now={BOARD_TODAY}
        canPlace
      />,
      'r',
    ],
    ['Places, loading', <PlacesView key="p" data={undefined} canPlace />, 'l'],
  ])('%s', async (_case, node, key) => {
    const user = userEvent.setup();
    render(<InConsole panel={node} />);
    placing.mockClear();
    await user.keyboard(key);
    expect(toasts.said).toEqual([]);
    expect(placing).not.toHaveBeenCalled();
  });
});

describe('a landmark’s card hands focus back to its row', () => {
  function PlacesLit() {
    const [lit, setLit] = useState<string | null>(SELECTED_UPPER);
    return (
      <PlacesView
        data={MASCOMA_PLACES}
        lit={lit}
        canPlace
        onLitChange={setLit}
        onDropLandmark={dropped}
      />
    );
  }

  it('so the tab’s keys answer once the card is gone', async () => {
    dropped.mockClear();
    const user = userEvent.setup();
    render(<InConsole panel={<PlacesLit />} />);
    await user.keyboard('{Escape}');
    expect(document.activeElement).toHaveAttribute('data-landmark-id', 'lm-upper');
    await user.keyboard('l');
    expect(dropped).toHaveBeenCalledTimes(1);
  });
});

// ── A settling action never drops the keyboard to the page ────────────────────────────────────

/** Focus is in the tab's region (the inspector's panel), and not on the page. */
function expectFocusKept() {
  const panel = screen.getByRole('tabpanel');
  expect(document.activeElement).not.toBe(document.body);
  expect(panel.contains(document.activeElement)).toBe(true);
}

/** Presses the control named `name` from the keyboard: focus it, ⏎. */
async function press(
  user: ReturnType<typeof userEvent.setup>,
  name: RegExp | string,
  root?: HTMLElement,
) {
  const scope = root === undefined ? screen : within(root);
  scope.getAllByRole('button', { name })[0]?.focus();
  await user.keyboard('{Enter}');
}

/** Each tab with an action that changes what it draws once its write lands. */
function AccessSettles() {
  const [data, setData] = useState(MASCOMA_ACCESS);
  return (
    <AccessView
      data={data}
      now={BOARD_TODAY}
      onRule={async (verdict) => {
        setData({ ...data, ruling: { ...data.ruling, verdict: verdict ?? null, before: 'open' } });
        return true;
      }}
    />
  );
}

function WaterSettles() {
  const [data, setData] = useState(MASCOMA_WATER);
  return (
    <WaterView
      data={data}
      canChooseDepth
      onChooseDepth={(measurement, source) =>
        setData({
          ...data,
          depth: { ...data.depth, [measurement === 'mean' ? 'meanFrom' : 'maxFrom']: source },
        })
      }
    />
  );
}

function HazardsSettles() {
  const [features, setFeatures] = useState<readonly FeatureRowWithGlyph[]>(MASCOMA_FEATURE_ROWS);
  return (
    <HazardsTabView
      season={HAZARD_SEASON}
      currentSeason={HAZARD_SEASON}
      onSeasonChange={() => {}}
      bodyName="Mascoma"
      watchOpenedAt={WATCH_OPENED}
      hazards={[]}
      archived={[]}
      features={features}
      winters={MASCOMA_WINTERS}
      patternsWaiting={null}
      onDemote={async (id) => {
        setFeatures(features.filter((f) => f.id !== id));
        return true;
      }}
      lit={null}
      onLitChange={() => {}}
    />
  );
}

function ImagerySettles() {
  const [rows, setRows] = useState<readonly PassRow[]>(MASCOMA_PASSES);
  return (
    <ImageryTabView
      season={IMAGERY_SEASON}
      rows={rows}
      lit={granuleOf(10)}
      onLitChange={() => {}}
      onOverride={async (id, verdict) => {
        setRows(
          rows.map((r) =>
            r.id === id
              ? {
                  ...r,
                  seen: verdict === 'show' ? 'shown-anyway' : 'hidden-by-staff',
                  override: { verdict, by: 'Teagan', at: BOARD_TODAY },
                }
              : r,
          ),
        );
        return true;
      }}
      satellite={MASCOMA_SATELLITE}
    />
  );
}

function StandingSettles() {
  const [standing, setStanding] = useState(DORMANT_BY_HAND);
  return (
    <StandingTabView
      standing={standing}
      activeSince={null}
      retention={MASCOMA_RETENTION}
      now={STANDING_NOW}
      canSetStanding
      canRemove={false}
      onSetActive={async () => {
        setStanding(ACTIVE);
        return true;
      }}
      onSetDormant={async () => true}
    />
  );
}

function PlacesSettles() {
  const [data, setData] = useState(MASCOMA_PLACES);
  return (
    <PlacesView
      data={data}
      canPlace
      onLitChange={() => {}}
      onDecline={async (askId) => {
        setData({
          ...data,
          asks: Array.isArray(data.asks) ? data.asks.filter((a) => a.id !== askId) : data.asks,
        });
        return true;
      }}
    />
  );
}

describe('a settling action never drops the keyboard to the page', () => {
  it('Access: ruling no public access hides its trigger without losing focus', async () => {
    const user = userEvent.setup();
    render(<InConsole panel={<AccessSettles />} />);
    const trigger = screen.getByRole('button', { name: 'Rule no public access' });
    await press(user, 'Rule no public access');
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'Every approach is posted');
    await press(user, /^Rule no public access/, dialog);
    await vi.waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute('hidden');
    await vi.waitFor(expectFocusKept);
  });

  it('Water: choosing a depth’s source takes its button away; focus stays', async () => {
    const user = userEvent.setup();
    render(<InConsole panel={<WaterSettles />} />);
    // Pick another source for the mean from the keyboard, then use it.
    const mean = screen.getAllByRole('radiogroup')[0] as HTMLElement;
    (
      within(mean)
        .getAllByRole('radio')
        .find((r) => r.getAttribute('aria-checked') === 'true') ??
      within(mean).getAllByRole('radio')[0]
    )?.focus();
    await user.keyboard('{ArrowDown}');
    const choose = screen.queryAllByRole('button', { name: /^Use .* for the (mean|max)/ });
    expect(choose.length).toBeGreaterThan(0);
    choose[0]?.focus();
    await user.keyboard('{Enter}');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expectFocusKept();
  });

  it('Hazards: a demoted feature leaves the list; focus stays', async () => {
    const user = userEvent.setup();
    render(<InConsole panel={<HazardsSettles />} />);
    await press(user, 'Demote');
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'Not a spring');
    await press(user, /Demote/, dialog);
    await press(user, /again/, dialog);
    await vi.waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expectFocusKept();
  });

  it('Imagery: showing a hidden pass turns its button into another; focus stays', async () => {
    const user = userEvent.setup();
    render(<InConsole panel={<ImagerySettles />} />);
    await press(user, /Show to skaters anyway/);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expectFocusKept();
  });

  it('Standing: making a dormant body active again; focus stays', async () => {
    const user = userEvent.setup();
    render(<InConsole panel={<StandingSettles />} />);
    const active = screen.getByRole('radio', { name: /^Active/ });
    active.focus();
    await user.keyboard(' ');
    const set = screen.queryAllByRole('button', { name: /active/i });
    set.at(-1)?.focus();
    await user.keyboard('{Enter}');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expectFocusKept();
  });

  it('Places: a declined proposal leaves the asks; focus stays', async () => {
    const user = userEvent.setup();
    render(<InConsole panel={<PlacesSettles />} />);
    await press(user, /^Decline/);
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'Not on this lake');
    await press(user, /^Decline/, dialog);
    await vi.waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expectFocusKept();
  });

  it('Names: a class chosen from the keyboard; focus stays on its row', async () => {
    const user = userEvent.setup();
    function NamesSettles() {
      const [data, setData] = useState(MASCOMA_NAMES);
      return (
        <NamesView data={data} canEditClass onClassChange={(cls) => setData({ ...data, cls })} />
      );
    }
    render(<InConsole panel={<NamesSettles />} />);
    const radios = screen.queryAllByRole('radio');
    radios[0]?.focus();
    await user.keyboard('{ArrowDown}');
    expectFocusKept();
  });

  it('focus taken elsewhere on purpose is left there, even when what had it goes', async () => {
    function Goes() {
      const [shown, setShown] = useState(true);
      return shown ? (
        <button type="button" onClick={() => setShown(false)}>
          Goes
        </button>
      ) : (
        <p>Gone</p>
      );
    }
    render(<InConsole panel={<Goes />} />);
    const goes = screen.getByRole('button', { name: 'Goes' });
    goes.focus();
    const list = screen.getByRole('listbox', { name: 'Asked of this body' });
    list.focus();
    // Gone in its own act, so the watch has its turn in the wait after it.
    act(() => goes.click());
    expect(screen.getByText('Gone')).toBeInTheDocument();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(list).toHaveFocus();
  });

  it('a press outside on something that takes no focus is leaving too: focus is not pulled back', async () => {
    let hide = () => {};
    function Goes() {
      const [shown, setShown] = useState(true);
      hide = () => setShown(false);
      return shown ? <button type="button">Goes</button> : <p>Gone</p>;
    }
    render(<InConsole panel={<Goes />} />);
    const goes = screen.getByRole('button', { name: 'Goes' });
    goes.focus();
    // A press on the map, which takes no focus here: the browser drops focus to the page.
    fireEvent.pointerDown(screen.getByText('map'));
    goes.blur();
    // What had focus goes (its own act, so it is gone before the wait), then the watch's turn.
    act(() => hide());
    expect(screen.getByText('Gone')).toBeInTheDocument();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(document.activeElement).toBe(document.body);
  });

  it('a menu opened from the tab keeps the watch: picking the item that takes its trigger away', async () => {
    function Menu() {
      const [state, setState] = useState<'closed' | 'open' | 'picked'>('closed');
      if (state === 'picked') return <p>Picked</p>;
      return (
        <>
          <button type="button" onClick={() => setState('open')}>
            Another class
          </button>
          {state === 'open' &&
            createPortal(
              <div role="menu">
                <button
                  type="button"
                  role="menuitem"
                  ref={(el) => el?.focus()}
                  onClick={() => setState('picked')}
                >
                  The last one
                </button>
              </div>,
              document.body,
            )}
        </>
      );
    }
    const user = userEvent.setup();
    render(<InConsole panel={<Menu />} />);
    await press(user, 'Another class');
    expect(screen.getByRole('menuitem')).toHaveFocus();
    await user.keyboard('{Enter}');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expectFocusKept();
  });
});
