import { describe, expect, it } from 'vitest';
import { BOARD_NOON } from '@/test/boardNow';
import {
  type BountyDetail,
  bountyCards,
  dayKicker,
  expiresLabel,
  plural,
  profileSubLine,
  shortDay,
  trustMark,
} from './profileModel';

const NOW = BOARD_NOON; // Saturday
const DAY = 86_400_000;

describe('dates', () => {
  it('kicks a post by today, yesterday, the weekday, then the date', () => {
    expect(dayKicker(NOW - 3_600_000, NOW)).toBe('Today');
    expect(dayKicker(NOW - DAY, NOW)).toBe('Yesterday');
    expect(dayKicker(NOW - 3 * DAY, NOW)).toBe('Wednesday');
    expect(dayKicker(NOW - 7 * DAY, NOW)).toBe('January 9');
    expect(dayKicker(NOW + 2 * DAY, NOW)).toBe('January 18');
    expect(dayKicker(Date.UTC(2027, 0, 16, 9), Date.UTC(2027, 0, 16, 18), 'UTC')).toBe('Today');
  });

  it('formats short days', () => {
    expect(shortDay(new Date(2026, 11, 28).getTime())).toBe('Dec 28');
    expect(shortDay(Date.UTC(2026, 11, 28, 12), 'UTC')).toBe('Dec 28');
  });

  it('counts down an expiry in days, then hours', () => {
    expect(expiresLabel(NOW + 5 * DAY, NOW)).toBe('Expires in 5 days');
    expect(expiresLabel(NOW + DAY + 1, NOW)).toBe('Expires in 1 day');
    expect(expiresLabel(NOW + 3 * 3_600_000, NOW)).toBe('Expires in 3 hours');
    expect(expiresLabel(NOW + 60_000, NOW)).toBe('Expires in 1 hour');
    expect(expiresLabel(NOW - 1, NOW)).toBe('Expiring');
  });

  it('pluralizes', () => {
    expect(plural(1, 'candidate report')).toBe('1 candidate report');
    expect(plural(0, 'candidate report')).toBe('0 candidate reports');
  });
});

describe('the header', () => {
  it('reads handle · town, and on your own who can see it', () => {
    expect(profileSubLine({ username: 'placasse', town: 'Enfield, NH', isSelf: false })).toEqual([
      '@placasse',
      'Enfield, NH',
    ]);
    expect(
      profileSubLine({ username: 'kdonovan', town: 'Hanover, NH', isSelf: true, isPublic: true }),
    ).toEqual(['@kdonovan', 'Hanover, NH', 'Public profile']);
    expect(profileSubLine({ username: 'k', isSelf: true, isPublic: false })).toEqual([
      '@k',
      'Private profile',
    ]);
  });

  it('marks trust by class, with the score only when sent', () => {
    expect(trustMark(null, undefined)).toBeNull();
    expect(trustMark('trusted', undefined)).toEqual({ label: 'Trusted' });
    expect(trustMark('trusted', 412)).toEqual({ label: 'Trusted', points: 412 });
  });
});

describe('bountyCards', () => {
  const base = { waterBody: { name: 'Smith Pond' }, subArea: null, fulfillingReports: [] };
  const rows: BountyDetail[] = [
    {
      ...base,
      _id: 'b-open',
      status: 'open',
      createdAt: NOW - 3 * DAY,
      expiresAt: NOW + 5 * DAY,
      fulfillingReports: [
        { _id: 'r1', authorName: 'Ana Morales', skateEndTime: NOW - 2 * DAY, skateQuality: 'fair' },
        { _id: 'r2', authorName: 'Pat Lacasse', skateEndTime: NOW - 3_600_000 },
      ],
    },
    {
      ...base,
      _id: 'b-new',
      status: 'open',
      createdAt: NOW - 60_000,
      expiresAt: NOW + 2 * DAY,
      waterBody: null,
    },
    {
      ...base,
      _id: 'b-done',
      status: 'fulfilled',
      createdAt: NOW - 20 * DAY,
      expiresAt: NOW - 18 * DAY,
      fulfilledAt: new Date(2026, 11, 28).getTime(),
      fulfilledBy: 'Pat Lacasse',
      waterBody: { name: 'Crystal Lake' },
      // Ana came in first; the requester accepted Pat's report.
      fulfillingReports: [
        { _id: 'r3', authorName: 'Ana Morales', skateEndTime: 0 },
        { _id: 'r4', authorName: 'Pat Lacasse', skateEndTime: 0 },
      ],
    },
    {
      ...base,
      _id: 'b-done-quiet',
      status: 'fulfilled',
      createdAt: NOW - 40 * DAY,
      expiresAt: NOW - 38 * DAY,
      // Candidates, but no record of whose report was accepted: nobody is credited.
      fulfillingReports: [{ _id: 'r5', authorName: 'Ana Morales', skateEndTime: 0 }],
    },
    {
      ...base,
      _id: 'b-gone',
      status: 'expired',
      createdAt: NOW - 30 * DAY,
      expiresAt: new Date(2026, 11, 14).getTime(),
      subArea: { name: 'Mascoma South' },
    },
    { ...base, _id: 'b-off', status: 'canceled', createdAt: NOW - 45 * DAY, expiresAt: 0 },
  ];

  it('puts the open ones first, newest first, with what has come in', () => {
    const { open } = bountyCards(rows, NOW);
    expect(open.map((b) => b.id)).toEqual(['b-new', 'b-open']);
    expect(open[0]).toMatchObject({
      place: 'A lake no longer listed',
      posted: 'Posted today',
      meta: 'Expires in 2 days · 0 candidate reports',
    });
    expect(open[1]).toMatchObject({
      place: 'Smith Pond',
      posted: 'Posted Wednesday',
      meta: 'Expires in 5 days · 2 candidate reports',
      candidates: [
        { id: 'r1', name: 'Ana Morales', line: 'Thursday · Fair' },
        { id: 'r2', name: 'Pat Lacasse', line: 'Today' },
      ],
    });
  });

  it('says how each past one ended', () => {
    const { past } = bountyCards(rows, NOW);
    expect(past).toEqual([
      {
        id: 'b-done',
        place: 'Crystal Lake',
        status: 'Fulfilled · Dec 28',
        answeredBy: 'Pat Lacasse',
      },
      {
        id: 'b-gone',
        place: 'Mascoma South',
        status: 'Expired · Dec 14',
        note: 'No reports came in before it ran out',
      },
      {
        id: 'b-done-quiet',
        place: 'Smith Pond',
        status: 'Fulfilled',
        note: 'A report answered it',
      },
      { id: 'b-off', place: 'Smith Pond', status: 'Canceled', note: 'You canceled it' },
    ]);
  });

  it('posted yesterday reads lowercase', () => {
    const { open } = bountyCards([{ ...rows[1], createdAt: NOW - DAY } as BountyDetail], NOW);
    expect(open[0]?.posted).toBe('Posted yesterday');
  });
});
