import { render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { InspectorProvider } from '../../inspector/inspectorContext';
import { AskList, askWhen, newestFirst, shownLine } from './AskList';
import {
  ASKS_NOW,
  ASKS_TZ,
  BOARD_ASKS,
  GONE_ASK,
  KATE_ASK,
  LUC_ASK,
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
  it('lists the askers newest first, each with their byline, time and note (2.3)', () => {
    inPane(<AskList asks={BOARD_ASKS} now={ASKS_NOW} />);
    const [first, second] = asks();
    expect(within(first as HTMLElement).getByText('Luc Pelletier')).toBeInTheDocument();
    expect(within(first as HTMLElement).getByText('12 Oct · 2 d ago')).toBeInTheDocument();
    expect(
      within(first as HTMLElement).getByText('Same pond. Everyone in town calls it Lot Pond.'),
    ).toBeInTheDocument();
    expect(within(second as HTMLElement).getByText('Kate Donovan')).toBeInTheDocument();
    expect(within(second as HTMLElement).getByText('11 Oct · 3 d ago')).toBeInTheDocument();
    // Her ask came with a recorded skate; his didn't.
    expect(within(second as HTMLElement).getByText('With a recorded skate')).toBeInTheDocument();
    expect(within(first as HTMLElement).queryByText('With a recorded skate')).toBeNull();
    expect(screen.getByRole('list', { name: 'The asks' })).toBeInTheDocument();
  });

  it('names nobody for a gone asker, and draws no empty quote', () => {
    inPane(<AskList asks={[GONE_ASK]} now={ASKS_NOW} />);
    expect(screen.getByText('A former skater')).toBeInTheDocument();
    expect(screen.queryByText('Deleted user')).toBeNull();
    expect(document.querySelector('[data-slot="ask-note"]')).toBeNull();
  });

  it('says an ask filed from a report, and the day of that skate', () => {
    inPane(<AskList asks={[REPORT_ASK]} now={ASKS_NOW} />);
    expect(screen.getByText('From their report · 14 Oct')).toBeInTheDocument();
  });

  it('says how many of how many when the server cut the list short — a floor past its count', () => {
    const { rerender } = inPane(
      <AskList asks={MANY_ASKS} now={ASKS_NOW} total={{ count: 500, floor: true }} />,
    );
    expect(screen.getByText('Showing 50 of 500+ asks')).toBeInTheDocument();
    rerender(<AskList asks={MANY_ASKS} now={ASKS_NOW} total={{ count: 50, floor: false }} />);
    expect(screen.queryByText(/Showing/)).toBeNull();
  });
});

describe('its rules', () => {
  it('sorts newest first, keeping the served order on a tie', () => {
    expect(newestFirst(BOARD_ASKS).map((a) => a.requestId)).toEqual([
      LUC_ASK.requestId,
      KATE_ASK.requestId,
    ]);
    const tie = { ...LUC_ASK, requestId: 'tie' as typeof LUC_ASK.requestId };
    expect(newestFirst([LUC_ASK, tie]).map((a) => a.requestId)).toEqual([LUC_ASK.requestId, 'tie']);
    // A copy: the served list is never reordered in place.
    const served = [...BOARD_ASKS];
    newestFirst(served);
    expect(served).toEqual(BOARD_ASKS);
  });

  it('says how long ago from the clock it is given, never negative', () => {
    expect(askWhen(ASKS_NOW - 5 * 3_600_000, ASKS_NOW, ASKS_TZ)).toBe('14 Oct · 5 h ago');
    expect(askWhen(ASKS_NOW + 60_000, ASKS_NOW, ASKS_TZ)).toBe('14 Oct · 0 min ago');
  });

  it('draws the count line only past what is shown', () => {
    expect(shownLine(2, undefined)).toBeNull();
    expect(shownLine(2, { count: 2, floor: false })).toBeNull();
    expect(shownLine(50, { count: 51, floor: false })).toBe('Showing 50 of 51 asks');
    expect(shownLine(50, { count: 50, floor: true })).toBe('Showing 50 of 50+ asks');
  });
});
