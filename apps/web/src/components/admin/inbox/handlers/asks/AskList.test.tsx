import { zonedInstant } from '@skating/core';
import { render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { skateWords } from '../../blocks/skateWords';
import { InspectorProvider } from '../../inspector/inspectorContext';
import { AskList, askWhen, skateLine } from './AskList';
import {
  ASKS_NOW,
  ASKS_TZ,
  BOARD_ASKS,
  GONE_ASK,
  KATE_ASK,
  MANY_ASKS,
  REPORT_ASK,
} from './askFixtures';

/** Inside the inspector's context, in the board's zone. */
const inPane = (ui: ReactElement) =>
  render(
    <InspectorProvider
      value={{ pane: { current: null }, decidedOnOpen: false, now: ASKS_NOW, timeZone: ASKS_TZ }}
    >
      {ui}
    </InspectorProvider>,
  );

const asks = () => screen.getAllByRole('listitem');

describe('the ask list', () => {
  it('lists the askers in the server’s order (newest first), each with their byline, time and note (2.3)', () => {
    inPane(
      <AskList asks={BOARD_ASKS} now={ASKS_NOW} total={{ count: 2, floor: false, cut: false }} />,
    );
    const [first, second] = asks();
    expect(within(first as HTMLElement).getByText('Luc Pelletier')).toBeInTheDocument();
    expect(within(first as HTMLElement).getByText('12 Oct · 2 d ago')).toBeInTheDocument();
    expect(
      within(first as HTMLElement).getByText('Same pond. Everyone in town calls it Lot Pond.'),
    ).toBeInTheDocument();
    expect(within(second as HTMLElement).getByText('Kate Donovan')).toBeInTheDocument();
    expect(within(second as HTMLElement).getByText('11 Oct · 3 d ago')).toBeInTheDocument();
    // Her ask came with a recorded skate — its day and its moving time; his didn't.
    expect(
      within(second as HTMLElement).getByText('With a recorded skate · 48m · 10 Oct 12:00–13:15'),
    ).toBeInTheDocument();
    expect(within(first as HTMLElement).queryByText(/With a recorded skate/)).toBeNull();
    expect(screen.getByRole('list', { name: 'The asks' })).toBeInTheDocument();
  });

  it('names nobody for a gone asker, and draws no empty quote', () => {
    inPane(
      <AskList asks={[GONE_ASK]} now={ASKS_NOW} total={{ count: 1, floor: false, cut: false }} />,
    );
    expect(screen.getByText('A former skater')).toBeInTheDocument();
    expect(screen.queryByText('Deleted user')).toBeNull();
    expect(document.querySelector('[data-slot="ask-note"]')).toBeNull();
  });

  it('says an ask filed from a report, and the day of that skate', () => {
    inPane(
      <AskList asks={[REPORT_ASK]} now={ASKS_NOW} total={{ count: 1, floor: false, cut: false }} />,
    );
    expect(screen.getByText('From their report · 14 Oct')).toBeInTheDocument();
  });

  it('says how many of how many when the server cut the list short — a floor past its count', () => {
    const { rerender } = inPane(
      <AskList asks={MANY_ASKS} now={ASKS_NOW} total={{ count: 500, floor: true, cut: false }} />,
    );
    expect(screen.getByText('Showing 50 of 500+ asks')).toBeInTheDocument();
    rerender(
      <AskList asks={MANY_ASKS} now={ASKS_NOW} total={{ count: 50, floor: false, cut: false }} />,
    );
    expect(screen.queryByText(/Showing/)).toBeNull();
  });
});

describe('a kind’s own line under an asker', () => {
  it('draws what the caller says for each ask, and nothing where it says null', () => {
    inPane(
      <AskList
        asks={BOARD_ASKS}
        now={ASKS_NOW}
        total={{ count: 2, floor: false, cut: false }}
        rowMeta={(a) => (a.requestId === BOARD_ASKS[0]?.requestId ? 'first landmark ask' : null)}
      />,
    );
    const [first, second] = asks();
    expect(within(first as HTMLElement).getByText('first landmark ask')).toBeInTheDocument();
    expect((second as HTMLElement).querySelector('[data-slot="ask-meta"]')).toBeNull();
  });
});

describe('its rules', () => {
  it('says how long ago from the clock it is given, never negative', () => {
    expect(askWhen(ASKS_NOW - 5 * 3_600_000, ASKS_NOW, ASKS_TZ)).toBe('14 Oct · 5 h ago');
    expect(askWhen(ASKS_NOW + 60_000, ASKS_NOW, ASKS_TZ)).toBe('14 Oct · 0 min ago');
  });
});

describe('an ask’s recorded skate', () => {
  const skate = KATE_ASK.skate as NonNullable<typeof KATE_ASK.skate>;
  const at = (s: Partial<typeof skate> | null, activityId = KATE_ASK.activityId) =>
    skateLine({ activityId, skate: s === null ? null : { ...skate, ...s } }, ASKS_TZ);

  it('says it in the one skate format: the moving time, then when', () => {
    expect(at({})).toBe(`With a recorded skate · ${skateWords(skate, ASKS_TZ)}`);
    expect(at({})).toMatch(/^With a recorded skate · 48m · 10 Oct \d\d:\d\d–\d\d:\d\d$/);
  });

  it('with no moving time says only when, and with no end only its start', () => {
    expect(at({ elapsedSeconds: null })).toMatch(/^With a recorded skate · 10 Oct \d\d:\d\d–/);
    expect(at({ elapsedSeconds: null, endTime: null })).toMatch(
      /^With a recorded skate · 10 Oct \d\d:\d\d$/,
    );
  });

  it('reads the skate’s day in the inspector’s zone, not the runner’s', () => {
    // 00:30 on 10 Oct in New York is still the evening of 9 Oct at UTC−11.
    const late = zonedInstant(2026, 10, 10, 30, ASKS_TZ);
    const s = { startTime: late, endTime: null, elapsedSeconds: null };
    expect(skateLine({ activityId: null, skate: s }, ASKS_TZ)).toBe(
      'With a recorded skate · 10 Oct 00:30',
    );
    expect(skateLine({ activityId: null, skate: s }, 'Pacific/Pago_Pago')).toMatch(
      /^With a recorded skate · 9 Oct /,
    );
  });

  it('still says a skate came with it when the read couldn’t describe it, and nothing without one', () => {
    expect(at(null)).toBe('With a recorded skate');
    expect(at(null, null)).toBeNull();
  });
});
