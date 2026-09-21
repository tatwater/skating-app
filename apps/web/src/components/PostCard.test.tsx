import type { FeedCardData, PostCardData } from '@skating/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PostCard } from './PostCard';

const NOW = Date.UTC(2026, 0, 5, 12, 0);

const REPORT: FeedCardData = {
  reportId: 'r1',
  waterBodyId: 'wb1',
  bodyName: 'Lake Morey',
  place: { town: 'Fairlee', county: 'Orange County', state: 'VT' },
  skateEndTime: Date.UTC(2026, 0, 5, 11, 0),
  iceTypes: ['black_ice'],
  surfaceTags: ['glass'],
  skateQuality: 'great',
  photoThumbUrls: [],
  author: { displayName: 'Ada Skater', username: 'ada' },
  blocked: false,
};
const SECOND: FeedCardData = {
  ...REPORT,
  reportId: 'r2',
  waterBodyId: 'wb2',
  bodyName: 'Lake Fairlee',
  skateEndTime: Date.UTC(2026, 0, 5, 9, 0),
  suitability: 'dont_go',
  observedFrom: 'shore',
  sighting: 'open',
  iceTypes: [],
  surfaceTags: [],
  skateQuality: undefined,
};
const POST: PostCardData = {
  postId: 'p1',
  latestSkateEndTime: REPORT.skateEndTime,
  author: REPORT.author,
  blocked: false,
  isFavorite: false,
  reports: [REPORT],
  omittedCount: 0,
};

describe('PostCard (A10 / D186)', () => {
  it('a legacy Post is the report card, unchanged — one author line, one time, no header', () => {
    render(<PostCard data={POST} now={NOW} onOpenReport={() => {}} />);
    expect(screen.getByText('Lake Morey')).toBeInTheDocument();
    expect(screen.getAllByText('Ada Skater')).toHaveLength(1);
    expect(screen.getAllByText('1h ago')).toHaveLength(1);
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('a titled Post puts the author and time up top once, and each lake is its own button', () => {
    const onOpen = vi.fn();
    render(
      <PostCard
        data={{ ...POST, title: 'Morey and Fairlee, 1/5', reports: [REPORT, SECOND] }}
        now={NOW}
        onOpenReport={onOpen}
      />,
    );
    expect(screen.getByRole('article')).toBeInTheDocument();
    expect(screen.getByText('Morey and Fairlee, 1/5')).toBeInTheDocument();
    expect(screen.getAllByText('Ada Skater')).toHaveLength(1);
    // The header carries the Post's time; the nested cards carry their own.
    expect(screen.getAllByText('1h ago')).toHaveLength(2);
    expect(screen.getByText('3h ago')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Lake Fairlee'));
    expect(onOpen).toHaveBeenCalledWith('r2');
  });

  it('the A10 axes show on the nested card: the who-claim first, the vantage, the sighting', () => {
    render(<PostCard data={{ ...POST, reports: [REPORT, SECOND] }} now={NOW} onOpenReport={() => {}} />);
    expect(screen.getByText("Don't go")).toBeInTheDocument();
    expect(screen.getByText('From shore')).toBeInTheDocument();
    expect(screen.getByText('Still open')).toBeInTheDocument();
  });

  it('long prose is clamped with the rest a tap away, in place', () => {
    const body = 'Glass all the way up the east shore. '.repeat(12).trim();
    render(<PostCard data={{ ...POST, body }} now={NOW} onOpenReport={() => {}} />);
    const prose = screen.getByText(body);
    expect(prose.className).toContain('line-clamp-4');
    fireEvent.click(screen.getByRole('button', { name: 'Read more' }));
    expect(prose.className).not.toContain('line-clamp-4');
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
  });

  it('says how many lakes the filters hid, and never pretends a two-lake day was one', () => {
    render(<PostCard data={{ ...POST, omittedCount: 1 }} now={NOW} onOpenReport={() => {}} />);
    expect(screen.getByText('1 more lake outside your filters')).toBeInTheDocument();
  });
});
