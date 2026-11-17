import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { stubJsdomAnimations } from '../jsdomStubs';
import { HazardsTabView, type HazardsTabViewProps } from './HazardsTabView';
import {
  FEB_HAZARDS,
  FEB_NOW,
  MASCOMA_FEATURE_ROWS,
  MASCOMA_WINTERS,
  SEASON,
  WATCH_OPENED,
} from './hazardsFixtures';
import { hazardRows } from './hazardsModel';

/**
 * **A failed archive read is said where it can be seen** (B01-3o, an owed review leftover). Over a
 * list of open reports the archived group is collapsed; a failure said only inside it was a note no
 * one saw, and the body read as though its archive held nothing. The note stands outside the group,
 * once.
 */

const base: HazardsTabViewProps = {
  season: SEASON,
  currentSeason: SEASON,
  onSeasonChange: vi.fn(),
  bodyName: 'Mascoma',
  watchOpenedAt: WATCH_OPENED,
  hazards: hazardRows(FEB_HAZARDS, FEB_NOW),
  archived: 'error',
  features: MASCOMA_FEATURE_ROWS,
  winters: MASCOMA_WINTERS,
  patternsWaiting: null,
  onRetry: vi.fn(),
  lit: null,
  onLitChange: vi.fn(),
};

beforeAll(stubJsdomAnimations);

describe('the archived group over a list', () => {
  it('says a failed read outside the collapsed group, once', () => {
    render(<HazardsTabView {...base} />);
    const notes = screen.getAllByText('The archived hazards couldn’t be read');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toBeVisible();
    // The group stays collapsed: the note is not inside it.
    expect(notes[0]?.closest('[data-slot="collapsible-content"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('keeps the note’s region mounted while the read is fine, so its words are announced', () => {
    render(<HazardsTabView {...base} archived={[]} />);
    expect(screen.queryByText('The archived hazards couldn’t be read')).toBeNull();
    expect(document.querySelectorAll('[data-slot="archived-failed"]')).toHaveLength(1);
  });
});
