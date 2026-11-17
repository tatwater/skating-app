import { render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { stubJsdomAnimations } from '../jsdomStubs';
import { HazardsTabView, type HazardsTabViewProps } from './HazardsTabView';
import { MASCOMA_FEATURE_ROWS, MASCOMA_WINTERS, SEASON, WATCH_OPENED } from './hazardsFixtures';

/**
 * **The Promotion section draws the patterns-waiting count's answers as themselves** (B01-3o): a
 * settled nothing as *Not recorded yet*, a settled zero as none waiting. The read's four answers are
 * held by the four-answers table (`tabs/secondaryReads.test.ts`).
 */

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
