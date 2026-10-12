import { describe, expect, it } from 'vitest';
import {
  landmarkDrifted,
  locksRow,
  pickReview,
  type ReviewState,
  watchReview,
} from './reviewWatch';

const ask = { lat: 44.5, lng: -73.3 };
const far = { lat: 44.6, lng: -73.3 };
const isle = { lat: 44.62, lng: -73.42 };
const row = {
  coord: ask,
  name: 'Gull Rock',
  similarLandmark: { landmarkId: 'lm1', point: isle, name: 'Gull Rock' },
  similarProposal: { requestId: 'reqB', coord: far, name: 'Gull Rock' },
};

describe('pickReview — a click, frozen', () => {
  it('draws the asked-for pair and remembers what it is about', () => {
    expect(pickReview('reqA', row, 'spot')).toEqual({
      id: 'reqA',
      review: { ask, name: 'Gull Rock' },
    });
    expect(pickReview('reqA', row, 'proposal')).toEqual({
      id: 'reqA',
      review: {
        ask,
        name: 'Gull Rock',
        other: { point: far, kind: 'proposal', name: 'Gull Rock' },
      },
      otherRequestId: 'reqB',
    });
    expect(pickReview('reqA', row, 'landmark')).toMatchObject({
      landmarkId: 'lm1',
      review: { other: { kind: 'landmark', point: isle } },
    });
    // A pair the row no longer reports is the spot alone, about nothing else.
    expect(pickReview('reqA', { coord: ask }, 'proposal')).toEqual({ id: 'reqA', review: { ask } });
  });
});

describe('watchReview — what became of a pick', () => {
  const pair = pickReview('reqA', row, 'proposal');
  const landmarkPair = pickReview('reqA', row, 'landmark');
  const open = (id: string) => ({ requestId: id, status: 'open' as const, name: 'Gull Rock' });

  it('is live while the server has not answered, or nothing it is about changed', () => {
    expect(watchReview(pair, undefined)).toEqual({ kind: 'live' });
    expect(watchReview(pair, { requests: [open('reqA'), open('reqB')] })).toEqual({
      kind: 'live',
    });
    const standing: ReviewState = {
      requests: [open('reqA')],
      landmark: { removed: false, name: 'Gull Rock', point: isle, byMe: false },
    };
    expect(watchReview(landmarkPair, standing)).toEqual({ kind: 'live' });
  });

  it('is mine when the moderator decided it themselves', () => {
    const state: ReviewState = {
      requests: [
        { requestId: 'reqA', status: 'approved', name: 'Gull Rock', by: 'Teagan', byMe: true },
        open('reqB'),
      ],
    };
    expect(watchReview(pair, state)).toEqual({ kind: 'mine' });
    const removedByMe: ReviewState = {
      requests: [open('reqA')],
      landmark: { removed: true, name: 'Gull Rock', by: 'Teagan', byMe: true },
    };
    expect(watchReview(landmarkPair, removedByMe)).toEqual({ kind: 'mine' });
  });

  it('says who closed the other end of a pair', () => {
    const state: ReviewState = {
      requests: [
        open('reqA'),
        { requestId: 'reqB', status: 'declined', name: 'Gull Rock', by: 'Mathew', byMe: false },
      ],
    };
    expect(watchReview(pair, state)).toEqual({
      kind: 'closed',
      text: 'The other “Gull Rock” proposal was declined by Mathew. This pair is closed.',
    });
  });

  it('says how the picked proposal was answered, by whom, or that it is gone', () => {
    const answered: ReviewState = {
      requests: [
        {
          requestId: 'reqA',
          status: 'approved',
          name: 'Gull Rock',
          by: 'Mathew',
          byMe: false,
          answeredWith: 'Gull Island',
        },
      ],
    };
    expect(watchReview(pair, answered)).toEqual({
      kind: 'closed',
      text: '“Gull Rock” was answered by Mathew: the landmark “Gull Island”.',
    });
    const declined: ReviewState = {
      requests: [{ requestId: 'reqA', status: 'declined', name: 'Gull Rock', byMe: false }],
    };
    expect(watchReview(pair, declined)).toEqual({
      kind: 'closed',
      text: '“Gull Rock” was declined by another moderator.',
    });
    const gone: ReviewState = { requests: [{ requestId: 'reqB', status: 'gone' }] };
    expect(watchReview(pair, gone)).toEqual({
      kind: 'closed',
      text: '“Gull Rock” is no longer in the queue.',
    });
  });

  it('calls a request with no name the request, never a quoted placeholder', () => {
    // The queue's other kinds — a lake to activate, admit, restore — carry no name.
    const lake = pickReview('reqL', { coord: ask }, 'spot');
    const approved: ReviewState = {
      requests: [{ requestId: 'reqL', status: 'approved', name: '', by: 'Mathew', byMe: false }],
    };
    expect(watchReview(lake, approved)).toEqual({
      kind: 'closed',
      text: 'This request was approved by Mathew.',
    });
    expect(watchReview(lake, { requests: [{ requestId: 'reqL', status: 'gone' }] })).toEqual({
      kind: 'closed',
      text: 'This request is no longer in the queue.',
    });
    const unnamedPair = pickReview(
      'reqA',
      { coord: ask, similarProposal: { requestId: 'reqB', coord: far, name: '' } },
      'proposal',
    );
    expect(
      watchReview(unnamedPair, {
        requests: [open('reqA'), { requestId: 'reqB', status: 'declined', name: '', byMe: false }],
      }),
    ).toEqual({
      kind: 'closed',
      text: 'The other proposal was declined by another moderator. This pair is closed.',
    });
  });

  it('says a paired landmark was taken off the map, or moved, and by whom when a person did', () => {
    const removed: ReviewState = {
      requests: [open('reqA')],
      landmark: { removed: true, name: 'Gull Rock', by: 'Mathew', byMe: false },
    };
    expect(watchReview(landmarkPair, removed)).toEqual({
      kind: 'closed',
      text: 'The landmark “Gull Rock” was taken off the map by Mathew.',
    });
    // A catalog drop or a merge names nobody; a deleted row still reads by its drawn name.
    expect(
      watchReview(landmarkPair, {
        requests: [open('reqA')],
        landmark: { removed: true, byMe: false },
      }),
    ).toEqual({ kind: 'closed', text: 'The landmark “Gull Rock” was taken off the map.' });
    const moved: ReviewState = {
      requests: [open('reqA')],
      landmark: { removed: false, name: 'Gull Rock', point: far, by: 'Mathew', byMe: false },
    };
    expect(watchReview(landmarkPair, moved)).toEqual({
      kind: 'closed',
      text: 'The landmark “Gull Rock” was moved by Mathew.',
    });
    expect(
      watchReview(landmarkPair, {
        requests: [open('reqA')],
        landmark: { removed: false, name: 'Gull Rock', point: far, by: 'Mathew', byMe: true },
      }),
    ).toEqual({ kind: 'mine' });
  });
});

describe('locksRow — the rows a closed review is about', () => {
  const pair = pickReview('reqA', row, 'proposal');
  const closed = { kind: 'closed', text: 'closed' } as const;

  it('locks the picked row and its other end only while the review is closed', () => {
    expect(locksRow(pair, closed, 'reqA')).toBe(true);
    expect(locksRow(pair, closed, 'reqB')).toBe(true);
    expect(locksRow(pair, closed, 'reqC')).toBe(false);
    expect(locksRow(pair, { kind: 'live' }, 'reqA')).toBe(false);
    expect(locksRow(pair, { kind: 'mine' }, 'reqA')).toBe(false);
    expect(locksRow(null, closed, 'reqA')).toBe(false);
  });
});

describe('landmarkDrifted — Same place answers only the landmark on the map', () => {
  const landmarkPair = pickReview('reqA', row, 'landmark');

  it('holds the picked row’s answer when its lookalike is no longer the drawn landmark', () => {
    expect(landmarkDrifted(landmarkPair, 'reqA', row)).toBe(false);
    const nearer = { similarLandmark: { landmarkId: 'lm2', point: far, name: 'Gull Rock' } };
    expect(landmarkDrifted(landmarkPair, 'reqA', nearer)).toBe(true);
    // Another row, a spot or proposal pick, or no pick: the badge answers what it names.
    expect(landmarkDrifted(landmarkPair, 'reqC', nearer)).toBe(false);
    expect(landmarkDrifted(pickReview('reqA', row, 'spot'), 'reqA', nearer)).toBe(false);
    expect(landmarkDrifted(pickReview('reqA', row, 'proposal'), 'reqA', nearer)).toBe(false);
    expect(landmarkDrifted(null, 'reqA', nearer)).toBe(false);
  });
});
