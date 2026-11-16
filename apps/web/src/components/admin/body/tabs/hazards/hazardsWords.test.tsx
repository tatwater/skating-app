import { verdictLabel } from '@skating/core';
import { cleanup, render } from '@testing-library/react';
import fc from 'fast-check';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { stubJsdomAnimations } from '../jsdomStubs';
import { HazardsTabView, type HazardsTabViewProps } from './HazardsTabView';
import {
  dailyFrom,
  FEB_ARCHIVED,
  FEB_HAZARDS,
  FEB_NOW,
  MASCOMA_FEATURE_ROWS,
  MASCOMA_WINTERS,
  PAST_WINTERS,
  SEASON,
  WATCH_OPENED,
} from './hazardsFixtures';
import { archivedRows, hazardRows, wintersFrom, winterWindow } from './hazardsModel';
import {
  CROSSING_CLAIM,
  CROSSING_WORDS,
  HAZARDS_WORDS,
  LAKE_CLAIM,
  VOTE_WORDS,
  type WordsContext,
  wordsContext,
} from './hazardsWords';

beforeAll(stubJsdomAnimations);

/**
 * **The Hazards tab describes the record, never the lake (D3).** Every headline, empty state,
 * summary and note comes from `HAZARDS_WORDS`; each entry is called here over arbitrary contexts,
 * so a string added there is held to the rule the moment it exists. The rendered tab is then read
 * whole, in every state, for the same words.
 */

const context: fc.Arbitrary<WordsContext> = fc.record({
  body: fc.constantFrom('Mascoma', 'Sunapee', 'this body'),
  current: fc.boolean(),
  season: fc.integer({ min: 2000, max: 2090 }),
  watchOpenedAt: fc.option(fc.integer({ min: 0, max: 4_000_000_000_000 }), { nil: null }),
  open: fc.nat(600),
  archived: fc.nat(600),
  count: fc.nat(600),
  unknown: fc.nat(600),
  reported: fc.nat(600),
  capped: fc.boolean(),
  unknownEnds: fc.integer({ min: 1, max: 600 }),
  markedDays: fc.nat(183),
  unsureDays: fc.nat(183),
  named: fc.boolean(),
  begins: fc.option(fc.integer({ min: 0, max: 4_000_000_000_000 }), { nil: null }),
  patterns: fc.nat(50),
});

describe('the words the tab can say', () => {
  it('the rule’s words are caught, so the guard is not vacuous', () => {
    for (const claim of [
      'All voted gone',
      'every day counts them as unknown, never as gone',
      'All clear',
      'all-clear',
      'Healed',
      'Safe to skate',
      'Resolved',
      'The ice is fine',
      'Skateable',
    ]) {
      expect(claim).toMatch(LAKE_CLAIM);
    }
    // "unsafe" is a skater's warning, not an all-clear.
    expect('healing, still unsafe'.replace('healing', '')).not.toMatch(LAKE_CLAIM);
  });

  it('a crossing’s recommendation words are caught too, so its guard is not vacuous', () => {
    for (const claim of [
      'Safe to cross',
      'Safe here',
      'Passable',
      'Still crossable',
      'OK to cross',
      'Okay to cross',
      'Clear to cross',
      'Fine to cross',
      'Good to cross',
      'The way across',
      'Open crossing',
    ]) {
      expect(claim).toMatch(CROSSING_CLAIM);
    }
    // The skater app's own verdict wording reads as a recommendation: the console never copies it.
    expect(verdictLabel('still_there', 'ridge_crossing')).toMatch(CROSSING_CLAIM);
  });

  it('a reported crossing is worded plainly — never safe, passable or clear (fast-check)', () => {
    expect(CROSSING_WORDS.label).not.toMatch(CROSSING_CLAIM);
    expect(CROSSING_WORDS.label).not.toMatch(LAKE_CLAIM);
    fc.assert(
      fc.property(fc.nat(500), (n) => {
        for (const said of [CROSSING_WORDS.again(n), CROSSING_WORDS.live(Math.max(1, n))]) {
          expect(said).not.toMatch(CROSSING_CLAIM);
          expect(said).not.toMatch(LAKE_CLAIM);
        }
      }),
    );
  });

  it('no headline, empty state, summary or note claims anything about the lake (fast-check)', () => {
    const entries = Object.entries(HAZARDS_WORDS);
    expect(entries.length).toBeGreaterThanOrEqual(10);
    fc.assert(
      fc.property(context, (c) => {
        for (const [name, words] of entries) {
          const said = words(c);
          expect(said, name).not.toMatch(LAKE_CLAIM);
          expect(said.length, name).toBeGreaterThan(0);
        }
      }),
    );
  });

  it('an empty record says there are no reports on record, never that there are no hazards', () => {
    fc.assert(
      fc.property(context, (c) => {
        const empty = { ...c, archived: 0 };
        expect(HAZARDS_WORDS.quietHeadline(empty)).toMatch(/^No hazard reports/);
        expect(HAZARDS_WORDS.quietDetail(empty)).toMatch(/no hazard reports on record/);
        expect(HAZARDS_WORDS.quietDetail(empty)).not.toMatch(/no hazards\b/i);
      }),
    );
  });

  it('archived reports are counted as reports, and may still have been on the lake', () => {
    fc.assert(
      fc.property(context, fc.integer({ min: 1, max: 600 }), (c, archived) => {
        const words = { ...c, archived };
        expect(HAZARDS_WORDS.quietHeadline(words)).toBe(`No open reports · ${archived} archived`);
        expect(HAZARDS_WORDS.quietDetail(words)).toContain('may still have been on the lake');
        expect(HAZARDS_WORDS.unknownEndsNote(words)).toContain('may still have been on the lake');
      }),
    );
  });

  it('says each archived report is marked only when every one is (fast-check)', () => {
    fc.assert(
      fc.property(context, (c) => {
        const note = HAZARDS_WORDS.unknownEndsNote(c);
        if (c.reported >= c.unknownEnds) {
          expect(note).toMatch(/(It|Each) is marked on the day it was first reported/);
        } else {
          expect(note).not.toMatch(/Each is marked|It is marked/);
          expect(note).toContain(`${c.reported} ${c.reported === 1 ? 'is' : 'are'} marked`);
          expect(note).toContain('the rest counted that day without a mark');
        }
      }),
    );
  });

  it('the caption says a mark is a first report, and that how long it stayed isn’t recorded', () => {
    const caption = HAZARDS_WORDS.marksCaption(wordsContext());
    expect(caption).toBe(
      'A bright mark is the day a hazard with no recorded end was first reported. How long it stayed on the lake isn’t recorded; the days after it are not a reading of the ice.',
    );
    expect(caption).not.toMatch(/\bended\b/);
  });

  it('“voted it gone” is only ever a counted, attributed vote on one report', () => {
    fc.assert(
      fc.property(fc.nat(10), fc.integer({ min: 1, max: 10 }), (n, of) => {
        expect(VOTE_WORDS.goneVotes(n, of)).toMatch(/^\d+ skaters? voted it gone; \d+ archive it$/);
      }),
    );
    expect(VOTE_WORDS.column).toBe('Gone votes');
  });
});

const base: HazardsTabViewProps = {
  season: SEASON,
  currentSeason: SEASON,
  onSeasonChange: vi.fn(),
  bodyName: 'Mascoma',
  watchOpenedAt: WATCH_OPENED,
  hazards: [],
  archived: [],
  features: MASCOMA_FEATURE_ROWS,
  winters: MASCOMA_WINTERS,
  patternsWaiting: { count: 2, capped: false },
  onRetry: vi.fn(),
  lit: null,
  onLitChange: vi.fn(),
};

const FEB_START = winterWindow(SEASON - 1).start;
const CAPPED = wintersFrom(
  [
    dailyFrom(
      SEASON - 1,
      [
        { first: FEB_START + 70 * 86_400_000, active: false },
        { first: FEB_START + 95 * 86_400_000, active: true },
      ],
      FEB_NOW,
      { capped: true },
    ),
  ],
  FEB_NOW,
);

/** Every state the tab draws, as its props. */
const STATES: Record<string, Partial<HazardsTabViewProps>> = {
  'empty current winter': {},
  'empty past winter': { season: SEASON - 1, winters: PAST_WINTERS },
  'no open report, all archived': { archived: archivedRows(FEB_ARCHIVED) },
  'one archived, past': { season: SEASON - 1, archived: archivedRows(FEB_ARCHIVED).slice(0, 1) },
  'a list': { hazards: hazardRows(FEB_HAZARDS, FEB_NOW), archived: archivedRows(FEB_ARCHIVED) },
  'a capped winter with unknown days': {
    season: SEASON - 1,
    hazards: hazardRows(FEB_HAZARDS, FEB_NOW),
    winters: CAPPED ?? undefined,
  },
  'before the record': {
    watchOpenedAt: null,
    winters:
      wintersFrom(
        [
          {
            season: SEASON,
            days: [],
            unknownEnds: 0,
            hazards: [],
            capped: false,
            watchOpensOn: null,
          },
        ],
        new Date(2026, 7, 20, 12, 0).getTime(),
      ) ?? undefined,
  },
  'every read failed': { hazards: 'error', features: 'error', patternsWaiting: 'error' },
  loading: { hazards: undefined, archived: undefined, winters: undefined },
};

const CROSSING = hazardRows(
  [
    {
      _id: 'h-cross',
      type: 'ridge_crossing',
      subAreaName: 'Black Point to Wood Island',
      freshness: 'fresh',
      provisional: false,
      confirmCount: 1,
      goneCount: 0,
      lastConfirmedAt: FEB_NOW - 2 * 86_400_000,
      firstReportedAt: FEB_NOW - 2 * 86_400_000,
      status: 'active',
    },
  ],
  FEB_NOW,
);

describe('a reported crossing in the list', () => {
  it('reads "Reported crossing · 2 d" in neutral ink — not a danger, not a recommendation', () => {
    const { container } = render(
      <HazardsTabView {...base} hazards={[...CROSSING, ...hazardRows(FEB_HAZARDS, FEB_NOW)]} />,
    );
    const row = container.querySelector<HTMLElement>('[data-slot="hazard-row"]');
    const kicker = row?.querySelector('[data-slot="hazard-kicker"]');
    expect(kicker).toHaveTextContent(/^Reported crossing$/);
    expect(kicker).toHaveAttribute('data-kind', 'crossing');
    // Neither the warning red nor the amber, and never a positive tone.
    expect(kicker?.className).toMatch(/\btext-fg2\b/);
    expect(kicker?.className).not.toMatch(/text-(bad|warn|good|ok|acc)\b/);
    expect(row).toHaveTextContent('2 d');
    expect(row).toHaveTextContent('Reported again once');
    expect(row?.textContent).not.toMatch(CROSSING_CLAIM);
    // A danger beside it keeps its red.
    const danger = container.querySelectorAll('[data-slot="hazard-kicker"]')[1];
    expect(danger).toHaveAttribute('data-kind', 'danger');
    expect(danger?.className).toMatch(/text-(bad|warn)\b/);
    cleanup();
  });
});

describe('the rendered tab', () => {
  it.each(Object.entries(STATES))('%s claims nothing about the lake', (_name, props) => {
    const { container } = render(<HazardsTabView {...base} {...props} />);
    const tab = container.cloneNode(true) as HTMLElement;
    // A hazard row quotes skaters' own words on one report ("healing") and counts their gone
    // votes, under the vote's own column head; everything else is the tab's.
    for (const el of tab.querySelectorAll(
      '[data-slot="hazard-row"], [data-slot="gone-votes-head"]',
    )) {
      el.remove();
    }
    const said = [
      tab.textContent ?? '',
      ...[...tab.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label') ?? ''),
    ].join(' · ');
    expect(said).not.toMatch(LAKE_CLAIM);
    cleanup();
  });
});
