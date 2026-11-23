import { REQUEST_KINDS } from '@skating/core';
import { describe, expect, it } from 'vitest';

import { askFrom, REQUEST_ASKS, REQUEST_WORDS } from './askWords';

describe('an ask', () => {
  it('words a request by its kind, its name and its note', () => {
    expect(
      askFrom({
        id: 'r1',
        kind: 'request',
        requestKind: 'name_bay',
        name: 'Shaker cove',
        note: 'Near the Shaker Bridge launch',
        createdAt: 1,
      }),
    ).toEqual({
      id: 'r1',
      item: 'request:r1',
      kicker: 'Bay name · Inbox',
      title: '“Shaker cove”',
      sub: 'Near the Shaker Bridge launch',
    });
    expect(
      askFrom({
        id: 'r2',
        kind: 'request',
        requestKind: 'activate',
        name: null,
        note: null,
        createdAt: 1,
      }),
    ).toEqual({
      id: 'r2',
      item: 'request:r2',
      kicker: 'Activation · Inbox',
      title: 'Make it active',
      sub: null,
    });
  });

  it('words a place name by its emails, and a flag by its reason, linked to its Inbox item', () => {
    expect(
      askFrom({ id: 'p1', kind: 'placeName', name: 'the Narrows', messages: 12, createdAt: 1 }),
    ).toEqual({ id: 'p1', kicker: 'Place name · 12 emails', title: '“the Narrows”', sub: null });
    expect(
      askFrom({ id: 'p2', kind: 'placeName', name: 'the Gut', messages: 1, createdAt: 1 }).kicker,
    ).toBe('Place name · 1 email');
    expect(askFrom({ id: 'f1', kind: 'flag', reason: 'no_public_access', createdAt: 1 })).toEqual({
      id: 'f1',
      item: 'flag:f1',
      kicker: 'Flag · Inbox',
      title: 'No public access',
      sub: null,
    });
  });
});

describe('the ask words', () => {
  it('word every request kind, both as a kicker and as what it asks for', () => {
    expect(Object.keys(REQUEST_WORDS).sort()).toEqual([...REQUEST_KINDS].sort());
    expect(Object.keys(REQUEST_ASKS).sort()).toEqual([...REQUEST_KINDS].sort());
  });
});
