import { render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { isFailed, type Loadable, readState } from '@/components/admin/reads/consoleReads';
import { FAILED_READ } from '@/components/admin/reads/readFailureFixtures';
import { stubJsdomAnimations } from '../jsdomStubs';
import { patternsWaitingOf } from './HazardsTab';
import { HazardsTabView, type HazardsTabViewProps } from './HazardsTabView';
import { MASCOMA_FEATURE_ROWS, MASCOMA_WINTERS, SEASON, WATCH_OPENED } from './hazardsFixtures';

/**
 * **Hazards' patterns-waiting count keeps its four answers apart** (B01-3o): on its way, failed (the
 * tab's note), settled with nothing (*Not recorded yet*), and a value — a settled zero is a value,
 * "no patterns waiting", never folded into *not recorded*. Written in the shape of the four-answers
 * table (`tabs/secondaryReads.test.ts`), which this row joins once that file is free to edit.
 */

type Count = { count: number; capped: boolean };
type Answer = { failed: boolean; notRecorded: boolean; loading: boolean };

const answer = (state: 'failed' | 'loading' | 'none'): Answer => {
  const read: Loadable<Count | null> =
    state === 'failed' ? FAILED_READ : state === 'loading' ? undefined : null;
  const shown = patternsWaitingOf(readState<Count>(read));
  return {
    failed: shown === 'error',
    notRecorded: shown === 'none',
    loading: shown === undefined,
  };
};

describe('Hazards: the patterns waiting (`recurrence.waitingCountForBody`)', () => {
  it.each([
    ['failed', { failed: true, notRecorded: false, loading: false }],
    ['loading', { failed: false, notRecorded: false, loading: true }],
    ['none', { failed: false, notRecorded: true, loading: false }],
  ] as const)('%s is said as itself', (state, expected) => {
    expect(answer(state)).toEqual(expected);
  });

  it('a settled zero is a value — none waiting — never not recorded', () => {
    expect(patternsWaitingOf(readState({ count: 0, capped: false }))).toEqual({
      count: 0,
      capped: false,
    });
  });

  it('a count that stopped short keeps its floor', () => {
    const shown = patternsWaitingOf(readState({ count: 1_000, capped: true }));
    expect(shown).toEqual({ count: 1_000, capped: true });
    expect(isFailed(shown)).toBe(false);
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
  lit: null,
  onLitChange: vi.fn(),
};

beforeAll(stubJsdomAnimations);

describe('the Promotion section draws each answer as itself', () => {
  const section = () =>
    screen.getByRole('heading', { name: /Promotion/ }).closest('section') as HTMLElement;

  it('a settled nothing is *Not recorded yet*, never a zero', () => {
    render(<HazardsTabView {...base} patternsWaiting="none" />);
    expect(within(section()).getByText('Not recorded yet')).toBeVisible();
    expect(within(section()).queryByText(/wait in the pre-ice pass/)).toBeNull();
  });

  it('a settled zero says none wait — a value, not *Not recorded yet*', () => {
    render(<HazardsTabView {...base} patternsWaiting={{ count: 0, capped: false }} />);
    expect(
      within(section()).getByText('No patterns on Mascoma wait in the pre-ice pass'),
    ).toBeVisible();
    expect(within(section()).queryByText('Not recorded yet')).toBeNull();
  });
});
