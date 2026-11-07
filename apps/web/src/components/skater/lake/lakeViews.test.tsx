import { BODY_FEATURE_CAVEAT } from '@skating/core';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { convexReact } from '../testMocks';

vi.mock('convex/react', () => convexReact);

import { BOARD_NOW, CARD_PAT, CARD_SARAH } from '../panels/panelFixtures';
import { IceHistoryView, iceHistoryLines, LinksView } from './AboutTab';
import { ActionPane } from './ActionPane';
import { AlertStripView } from './AlertStrip';
import { HazardListView } from './HazardList';
import { LakeRow } from './LakeRow';
import { StandingNoticeView } from './LakeStates';
import { ONLY_OLDER_MARKERS } from './lakeModel';
import { AccessRulingCardView } from './ModeratorCard';
import { ReportsListView } from './ReportsTab';

const now = Date.now();
const DAY = 86_400_000;

beforeAll(() => {
  Element.prototype.animate ??= (() => ({
    cancel: () => {},
    finished: Promise.resolve(),
  })) as never;
});

const hazard = (id: string, freshness: 'fresh' | 'aging' | 'stale') => ({
  _id: id,
  type: 'pressure_ridge' as const,
  freshness,
  provisional: false,
  firstReportedAt: now - 9 * DAY,
  confirmCount: 0,
});

describe('Known hazards', () => {
  it('keeps old markers behind a toggle, never drops them (D3)', () => {
    const onOpen = vi.fn();
    render(
      <HazardListView
        hazards={[hazard('old1', 'stale'), hazard('old2', 'stale')]}
        features={[]}
        now={now}
        hrefFor={(id) => `/hazard/${id}`}
        onOpen={onOpen}
      />,
    );
    expect(screen.getByText(ONLY_OLDER_MARKERS)).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Show 2 older markers' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    const rows = screen.getAllByRole('link');
    expect(rows).toHaveLength(2);
    // An old marker keeps its warning and says how sure it still is.
    expect(rows[0]).toHaveTextContent('Old report — unverified');
    expect(rows[0]).toHaveTextContent('Ridges do not heal within a season');
    fireEvent.click(rows[0] as HTMLElement);
    expect(onOpen).toHaveBeenCalledWith('old1', expect.anything());
    expect(screen.getByRole('button', { name: 'Hide older markers' })).toBeInTheDocument();
  });

  it('names one older marker in the singular, beside the current ones', () => {
    render(
      <HazardListView
        hazards={[{ ...hazard('a', 'aging'), provisional: true }, hazard('b', 'stale')]}
        features={[]}
        now={now}
        hrefFor={(id) => `/hazard/${id}`}
        onOpen={() => {}}
      />,
    );
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByText('Not confirmed recently')).toBeInTheDocument();
    expect(screen.getByText('Unconfirmed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show 1 older marker' })).toBeInTheDocument();
  });

  it('lists a lake’s permanent features with their own caveat, and counts as populated', () => {
    render(
      <HazardListView
        hazards={[]}
        features={[
          { _id: 'f1', type: 'spring_current' },
          { _id: 'f2', type: 'something_new' },
        ]}
        now={now}
        hrefFor={(id) => `/hazard/${id}`}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText('Spring / current, something_new')).toBeInTheDocument();
    expect(screen.getByText(BODY_FEATURE_CAVEAT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About known hazards' })).toBeInTheDocument();
  });
});

describe('the rows', () => {
  it('draws each report as the shared card, the bay and not the lake, no rule under the last', () => {
    const onOpen = vi.fn();
    render(
      <ReportsListView
        model={{
          status: 'ready',
          cards: [
            { ...CARD_PAT, notesExcerpt: 'Black ice to the islands.', helpfulCount: 2 },
            { ...CARD_SARAH, helpfulCount: 20, helpfulCountCapped: true, commentCount: 3 },
          ],
          canLoadMore: false,
          loadingMore: false,
        }}
        onOpen={onOpen}
        onLoadMore={() => {}}
        emptyLine="None."
        now={BOARD_NOW}
      />,
    );
    const cards = document.querySelectorAll('[data-slot="report-card"]');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent('Black ice to the islands.');
    expect(cards[0]).toHaveTextContent('Mascoma South');
    expect(cards[0]).toHaveAttribute('href', '/report/r1');
    // The server's cap carries through: a floor, not a total.
    expect(cards[1]).toHaveTextContent('20+ helpful');
    expect(cards[1]).toHaveTextContent('3 comments');
    fireEvent.click(cards[1] as Element);
    expect(onOpen).toHaveBeenCalledWith('r2');
  });

  it('holds a lake row’s place when it has no outline', () => {
    render(
      <LakeRow
        row={{
          id: 'x',
          name: 'Halfmile Pond',
          sub: 'Pond · 9 acres',
          href: '/water/x',
          favorite: false,
          inactive: false,
          trailing: { kind: 'note', text: 'No recent reports' },
          silhouette: null,
        }}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByRole('link')).toHaveTextContent('Halfmile Pond');
    expect(document.querySelector('[data-slot="lake-silhouette"]')).toBeNull();
  });
});

describe('About’s pieces', () => {
  it('says ice history with its disclaimer, and nothing without a history', () => {
    const lines = iceHistoryLines([
      {
        family: 'ridge',
        seasonsObserved: [2023, 2024, 2025],
        windowSeasons: 5,
        subAreaName: 'Mascoma North',
        firstReportedDayOfSeasonP25: 40,
        firstReportedDayOfSeasonP75: 60,
      },
      {
        family: 'gas',
        seasonsObserved: [],
        windowSeasons: 5,
        firstReportedDayOfSeasonP25: 0,
        firstReportedDayOfSeasonP75: 0,
      },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^Skaters have reported a pressure ridge near Mascoma North in 3 of the last 5 winters/,
    );
    const { rerender } = render(<IceHistoryView lines={lines} />);
    const section = screen.getByRole('region', { name: 'Ice history' });
    expect(within(section).getByText(lines[0] as string)).toBeInTheDocument();
    expect(section.textContent).toMatch(/not|never|isn/i);
    rerender(<IceHistoryView lines={[]} />);
    expect(screen.queryByRole('region', { name: 'Ice history' })).toBeNull();
  });

  it('draws nothing for no links, and the URL itself when it has no host', () => {
    const { rerender } = render(<LinksView links={[]} />);
    expect(screen.queryByRole('region')).toBeNull();
    rerender(<LinksView links={[{ id: 'odd', label: 'Odd', url: 'not a url', note: 'A note' }]} />);
    expect(screen.getByText('not a url')).toBeInTheDocument();
    expect(screen.getByText('A note')).toBeInTheDocument();
  });

  it('offers no Clear before there is a ruling', () => {
    const onRule = vi.fn();
    render(
      <AccessRulingCardView
        verdict={undefined}
        pendingCount={2}
        busy={false}
        error={null}
        onRule={onRule}
      />,
    );
    expect(screen.getByText(/2 reports of no public access are waiting\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm public access' }));
    expect(onRule).toHaveBeenCalledWith('open');
  });
});

describe('notices', () => {
  it('draws an alert with no headline, and nothing with no alert', () => {
    const { rerender } = render(
      <AlertStripView
        alerts={[
          {
            id: 'a',
            event: 'Wind Advisory',
            severity: 'Minor',
            areaDesc: 'Grafton',
            zones: [],
            states: [],
          },
        ]}
      />,
    );
    expect(screen.getByText('Wind Advisory — Grafton')).toBeInTheDocument();
    rerender(<AlertStripView alerts={[]} />);
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('names a removal as a removal, and an active lake as nothing', () => {
    const { rerender } = render(
      <StandingNoticeView
        standing={{ standing: 'removed', since: 1, reason: 'landowner_request' }}
      />,
    );
    expect(screen.getByText('Removed')).toBeInTheDocument();
    rerender(<StandingNoticeView standing={{ standing: 'active' }} />);
    expect(screen.queryByRole('note')).toBeNull();
  });
});

describe('an action’s focus (§1.8)', () => {
  it('takes the focus on open and hands it back to its opener on close', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(<ActionPane act="bounty" backTo="Mascoma Lake" onBack={() => {}} />);
    expect(screen.getByRole('button', { name: 'Back to Mascoma Lake' })).toHaveFocus();
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('falls back to the sidebar’s first control when the opener is gone', () => {
    const { rerender } = render(
      <aside data-slot="lake-sidebar">
        <a href="/x">First</a>
        <ActionPane act="imagery" backTo="Mascoma Lake" onBack={() => {}} />
      </aside>,
    );
    rerender(
      <aside data-slot="lake-sidebar">
        <a href="/x">First</a>
      </aside>,
    );
    expect(screen.getByRole('link', { name: 'First' })).toHaveFocus();
  });

  it('leaves the focus alone when it isn’t asked to take it', () => {
    render(<ActionPane act="hazard" backTo="Explore" onBack={() => {}} autoFocus={false} />);
    expect(screen.getByRole('button', { name: 'Back to Explore' })).not.toHaveFocus();
  });
});
