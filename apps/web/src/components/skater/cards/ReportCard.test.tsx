import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  BOARD_NOW,
  CARD_KATE_BLOCKED,
  CARD_PAT,
  CARD_SARAH,
  POST_ANA,
} from '../panels/panelFixtures';
import { FeedCard } from './FeedCard';
import { ReportCard } from './ReportCard';

const now = BOARD_NOW;

describe('ReportCard', () => {
  it('is one link to the report that routes in-app on a plain click and keys focus return', async () => {
    const onOpen = vi.fn();
    render(<ReportCard report={CARD_PAT} now={now} href="/report/r1" onOpen={onOpen} />);
    const card = screen.getByRole('link', {
      name: /Report on Mascoma South · Mascoma Lake, Today · 11:40 AM/,
    });
    expect(card).toHaveAttribute('href', '/report/r1');
    expect(card).toHaveAttribute('data-panel-trigger', 'report:r1');
    await userEvent.click(card);
    expect(onOpen).toHaveBeenCalledOnce();
    // A modified click is the browser's: a new tab, not an in-app route.
    fireEvent.click(card, { metaKey: true });
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('draws a row: the face and name, the day, where and how long, the claims, the chips, the counts', () => {
    render(
      <ReportCard
        report={{ ...CARD_PAT, photoThumbUrls: ['https://img/1.jpg'], edited: true }}
        now={now}
        href="/report/r1"
        onOpen={vi.fn()}
        excerpt="Black ice from the launch to the islands."
        helpfulCount={6}
        commentCount={1}
        last
      />,
    );
    const card = screen.getByRole('link');
    expect(within(card).getByText('Pat Lacasse')).toHaveClass('ph-no-capture');
    expect(within(card).getByText('Today · 11:40 AM · edited')).toBeInTheDocument();
    expect(
      within(card).getByText('Mascoma South · Mascoma Lake · on the ice 2h'),
    ).toBeInTheDocument();
    expect(within(card).getByText('Experienced only')).toBeInTheDocument();
    expect(within(card).getByText('Good')).toBeInTheDocument();
    expect(within(card).getByText('Black ice')).toBeInTheDocument();
    expect(within(card).getByText('6 helpful')).toBeInTheDocument();
    expect(within(card).getByText('1 comment')).toBeInTheDocument();
    expect(card.querySelectorAll('img')).toHaveLength(1);
    expect(card).toHaveClass('border-b-0');
  });

  it('says the bay, not the lake, on the lake’s own tab — and nothing when there’s no bay', () => {
    const { rerender } = render(
      <ReportCard report={CARD_PAT} now={now} href="/report/r1" onOpen={vi.fn()} hideBody />,
    );
    expect(screen.getByText('Mascoma South · on the ice 2h')).toBeInTheDocument();
    const { subAreaName: _bay, ...lake } = CARD_PAT;
    rerender(<ReportCard report={lake} now={now} href="/report/r1" onOpen={vi.fn()} hideBody />);
    expect(screen.getByText('on the ice 2h')).toBeInTheDocument();
  });

  it('leads with a red "Don’t go" and says how it was seen', () => {
    render(<ReportCard report={CARD_SARAH} now={now} href="/report/r2" onOpen={vi.fn()} />);
    const badges = screen.getByText("Don't go").parentElement as HTMLElement;
    expect(badges.firstElementChild).toHaveTextContent("Don't go");
    expect(badges.firstElementChild).toHaveClass('bg-bad');
    expect(screen.getByText('From shore')).toBeInTheDocument();
  });

  it('dims a blocked author and says so — the report itself is never hidden (D3)', () => {
    render(<ReportCard report={CARD_KATE_BLOCKED} now={now} href="/report/r3" onOpen={vi.fn()} />);
    const card = screen.getByRole('link');
    expect(card).toHaveAttribute('data-blocked');
    expect(within(card).getByText('Kate Donovan')).toHaveClass('text-fg3');
    expect(within(card).getByText('Blocked')).toBeInTheDocument();
    expect(within(card).getByText('Snow ice')).toBeInTheDocument();
  });

  it('marks the open one, and shows the place first when the author is said elsewhere', () => {
    render(
      <ReportCard
        report={{ ...CARD_PAT, isFavorite: true }}
        now={now}
        href="/latest?report=r1"
        onOpen={vi.fn()}
        showAuthor={false}
        selected
      />,
    );
    const card = screen.getByRole('link');
    expect(card).toHaveAttribute('aria-current', 'true');
    expect(within(card).getByRole('img', { name: 'Favorite' })).toBeInTheDocument();
    expect(within(card).queryByText('Pat Lacasse')).toBeNull();
  });

  it('draws a block: the lake, the silhouette and the hours, the byline only when asked', () => {
    const { rerender } = render(
      <ReportCard report={CARD_PAT} now={now} href="/report/r1" onOpen={vi.fn()} variant="block" />,
    );
    const card = screen.getByRole('link');
    expect(card).toHaveAttribute('data-variant', 'block');
    expect(within(card).getByText('9:40–11:40')).toBeInTheDocument();
    expect(within(card).getByText('Skated 2h')).toBeInTheDocument();
    expect(card.querySelector('svg')).not.toBeNull();
    rerender(
      <ReportCard
        report={{ ...CARD_SARAH, accessKind: 'hike_in' }}
        now={now}
        href="/report/r2"
        onOpen={vi.fn()}
        variant="block"
        showAuthor
        hideBody
      />,
    );
    expect(screen.getByText('Sarah Berman')).toBeInTheDocument();
    expect(screen.getByText('Hike-in')).toBeInTheDocument();
    expect(screen.getByText('3:15')).toBeInTheDocument();
  });

  it('says "Watched from shore" for a block that wasn’t skated', () => {
    render(
      <ReportCard
        report={CARD_SARAH}
        now={now}
        href="/report/r2"
        onOpen={vi.fn()}
        variant="block"
      />,
    );
    expect(screen.getByText('Watched from shore')).toBeInTheDocument();
  });
});

describe('FeedCard', () => {
  it('draws a post over two lakes as an itinerary, with the author once', async () => {
    const onOpenReport = vi.fn();
    render(
      <FeedCard
        post={POST_ANA}
        now={now}
        reportHref={(id) => `/latest?report=${id}`}
        onOpenReport={onOpenReport}
        selectedReportId="r5"
        helpfulCount={9}
        commentCount={1}
        last
      />,
    );
    const post = screen.getByRole('article');
    expect(post).toHaveClass('ph-no-capture', 'border-b-0');
    expect(within(post).getAllByText('Ana Morales')).toHaveLength(1);
    expect(
      within(post).getByRole('heading', { name: 'Two stops on the way home' }),
    ).toBeInTheDocument();
    const reports = within(post).getAllByRole('link');
    expect(reports.map((r) => r.getAttribute('href'))).toEqual([
      '/latest?report=r4',
      '/latest?report=r5',
    ]);
    expect(reports[1]).toHaveAttribute('aria-current', 'true');
    expect(within(post).getByText('Hike-in')).toBeInTheDocument();
    expect(within(post).getByText('9 helpful')).toBeInTheDocument();
    await userEvent.click(reports[0] as HTMLElement);
    expect(onOpenReport).toHaveBeenCalledWith('r4');
  });

  it('folds a long body behind Read more', async () => {
    const body = 'A long day. '.repeat(40);
    render(
      <FeedCard
        post={{ ...POST_ANA, body, edited: true, omittedCount: 1 }}
        now={now}
        reportHref={(id) => `/report/${id}`}
        onOpenReport={vi.fn()}
      />,
    );
    const more = screen.getByRole('button', { name: 'Read more' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(more);
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByText('1 more lake outside your filters')).toBeInTheDocument();
    expect(screen.getByText(/· edited/)).toBeInTheDocument();
  });

  it('puts the day first on the profile, where whose it is is the page', () => {
    render(
      <FeedCard
        post={{ ...POST_ANA, blocked: true }}
        now={now}
        reportHref={(id) => `/report/${id}`}
        onOpenReport={vi.fn()}
        head="date"
      />,
    );
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('4:50 PM')).toBeInTheDocument();
  });

  it('draws a blocked author dimmed in the head', () => {
    render(
      <FeedCard
        post={{ ...POST_ANA, blocked: true }}
        now={now}
        reportHref={(id) => `/report/${id}`}
        onOpenReport={vi.fn()}
      />,
    );
    expect(screen.getByText('Ana Morales')).toHaveClass('text-fg3');
    expect(screen.getByText('Blocked')).toBeInTheDocument();
  });

  it('is just its report, with the byline, when the post has no words and one lake', () => {
    const { title: _title, ...wordless } = POST_ANA;
    render(
      <FeedCard
        post={{ ...wordless, reports: [CARD_PAT] }}
        now={now}
        reportHref={(id) => `/report/${id}`}
        onOpenReport={vi.fn()}
      />,
    );
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByText('Pat Lacasse')).toBeInTheDocument();
  });
});
