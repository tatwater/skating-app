import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { POST_POND_SHELVED, SPECTACLE_RULING } from '../handlers/Request/requestFixtures';
import { dormancyRows } from '../handlers/Request/requestModel';
import { itemMapScene } from '../map/itemMapAdapters';
import { DRAWN, DRAWN_MAP } from '../map/itemMapFixtures';
import { rulingEvent } from './rulingEvent';
import { shownName } from './shownName';
import { TimelineEventBody } from './TimelineEventBody';

/**
 * **Nobody gone or leaving is named** (R9): a person whose account is being deleted is still served
 * with their real name while it is pending, so every place the Inbox draws a name asks `shownName`.
 */
const leaving = <T extends { deleted: boolean }>(p: T): T => ({ ...p, deleted: true });

describe('a person gone or leaving is never named', () => {
  it('names a present person, and no one gone, leaving or absent', () => {
    expect(shownName({ displayName: 'Kate Donovan', deleted: false })).toBe('Kate Donovan');
    expect(shownName({ displayName: 'Kate Donovan', deleted: true })).toBeNull();
    expect(shownName(null)).toBeNull();
    expect(shownName(undefined)).toBeNull();
  });

  it('the drawn map’s legend: the day it was drawn, and no drawer’s name', () => {
    const drawer = (DRAWN as { drawer: { displayName: string } }).drawer;
    const gone = { ...DRAWN, drawer: { ...drawer, deleted: true } } as typeof DRAWN;
    const labels = itemMapScene(gone, DRAWN_MAP, 'America/New_York')?.legend.map((r) => r.label);
    expect(labels).toContain('Drawn 12 Oct');
    expect(labels?.join(' ')).not.toContain('Kate Donovan');
  });

  it('a standing ruling’s ruler: a former moderator, not their name', () => {
    const by = SPECTACLE_RULING.by as NonNullable<typeof SPECTACLE_RULING.by>;
    render(<TimelineEventBody event={rulingEvent({ ...SPECTACLE_RULING, by: leaving(by) })} />);
    expect(screen.getByText('A former moderator')).toBeInTheDocument();
    expect(screen.queryByText(by.displayName)).toBeNull();
  });

  it('a dormancy’s Set by: no row for a staffer who is gone or leaving', () => {
    const by = POST_POND_SHELVED.by as NonNullable<typeof POST_POND_SHELVED.by>;
    expect(dormancyRows(POST_POND_SHELVED).map((r) => r.value)).toContain('Matt');
    const rows = dormancyRows({ ...POST_POND_SHELVED, by: leaving(by) });
    expect(rows.map((r) => r.value).join(' ')).not.toContain('Matt');
  });
});
