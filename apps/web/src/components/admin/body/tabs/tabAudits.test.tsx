import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { KeysProvider } from '@/lib/keys';
import { expectNoBlanks } from '@/test/blanksAudit';
import { ARRIVALS, InConsole } from '@/test/consoleArrivals';
import { expectKeyboardOperable } from '@/test/keyboardAudit';
import { AccessView } from './access/AccessView';
import { BOARD_TODAY, MASCOMA_ACCESS } from './access/accessFixtures';
import type { AccessData } from './access/accessModel';
import { stubJsdomAnimations } from './jsdomStubs';
import { NamesView } from './names/NamesView';
import { MASCOMA_NAMES } from './names/namesFixtures';
import type { NamesData } from './names/namesModel';
import { PlacesView } from './places/PlacesView';
import { MASCOMA_LANDMARKS, MASCOMA_PLACES, SELECTED_UPPER } from './places/placesFixtures';
import type { PlacesData } from './places/placesModel';
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
const async = vi.fn(async () => null);

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
      onDismissName={async}
      onSamePlace={() => {}}
      onDecline={async}
      onEditLandmark={() => {}}
    />
  ),
  'Places, the list': (
    <PlacesView data={MASCOMA_PLACES} canPlace onLitChange={() => {}} onEditLandmark={() => {}} />
  ),
  Access: (
    <AccessView
      data={MASCOMA_ACCESS}
      now={BOARD_TODAY}
      canPlace
      onRule={async}
      onMakeOfficial={() => {}}
      onHide={async}
    />
  ),
  Water: <WaterView data={MASCOMA_WATER} onChooseDepth={() => {}} canChooseDepth canFileSurvey />,
};

// ── The tabs with every fact absent ───────────────────────────────────────────────────────────

const NAMES_BARE: NamesData = {
  ...MASCOMA_NAMES,
  rungs: [],
  aliases: [],
  classOptions: null,
  perCatalogClaims: null,
  place: { admin: null, states: [], townLines: null },
};

const PLACES_BARE: PlacesData = {
  ...MASCOMA_PLACES,
  asks: [
    {
      kind: 'proposal',
      id: 'ask-bare',
      name: 'the flats',
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
      walkM: null,
      approach: null,
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
  depth: { rungs: [], meanFrom: null, maxFrom: null, others: null },
  sampling: { interior: null, points: null, acrossKm: null, wide: false },
  bathymetry: { searched: null, found: 'No contour lines', missing: true },
  box: null,
};

const BARE_LANDMARK = MASCOMA_LANDMARKS[0]?.id ?? '';

const BARE: Record<string, ReactNode> = {
  Names: <NamesView data={NAMES_BARE} />,
  Places: <PlacesView data={PLACES_BARE} lit={`landmark:${BARE_LANDMARK}`} />,
  'Places, the list': <PlacesView data={PLACES_BARE} />,
  Access: <AccessView data={ACCESS_BARE} now={BOARD_TODAY} />,
  Water: <WaterView data={WATER_BARE} />,
};

describe('every tab answers the keyboard wherever it answers a click', () => {
  it.each(Object.entries(LEVERS))('%s', (_tab, node) => {
    const { container } = render(inKeys(node));
    expect(expectKeyboardOperable(container).length).toBeGreaterThan(0);
  });
});

describe('no tab draws an absent fact as a blank', () => {
  it.each(Object.entries(BARE))('%s', (_tab, node) => {
    const { container } = render(inKeys(node));
    expectNoBlanks(container);
  });
});

// ── Each tab's keys, every way it is reached ──────────────────────────────────────────────────

const KEYED: [string, ReactNode, string][] = [
  ['Access', LEVERS.Access, 'p'],
  ['Places', LEVERS['Places, the list'], 'l'],
  ['a landmark’s card in Places', LEVERS.Places, 'm'],
];

describe('a tab’s keys work however the tab is reached', () => {
  for (const [tab, node, key] of KEYED) {
    it.each(ARRIVALS)(`${tab}: ${key.toUpperCase()} after %s`, async (_way, arrive) => {
      const user = userEvent.setup();
      render(<InConsole panel={node} />);
      await arrive(user);
      await user.keyboard(key);
      expect(toasts.said).toHaveLength(1);
    });
  }
});
