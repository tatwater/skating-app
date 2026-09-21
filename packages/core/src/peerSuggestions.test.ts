import { describe, expect, it } from 'vitest';
import { PEER_WINDOW_MS, type PeerCard, peerLine, peerSuggestions } from './peerSuggestions';

const NOW = Date.UTC(2026, 0, 10, 20);
const HOUR = 60 * 60 * 1000;

function card(username: string, ageHours: number, extra: Partial<PeerCard> = {}): PeerCard {
  return {
    skateEndTime: NOW - ageHours * HOUR,
    iceTypes: [],
    surfaceTags: [],
    author: { username },
    ...extra,
  };
}

describe('peerSuggestions (§4.4 / D188)', () => {
  it('counts distinct reporters per value inside the window, excluding the author, sorted by count', () => {
    const cards = [
      card('ann', 2, { iceTypes: ['black_ice'], surfaceTags: ['glass'], skateQuality: 'good' }),
      card('ann', 5, { iceTypes: ['black_ice'], surfaceTags: ['glass'] }), // ann twice — one vote
      card('bob', 3, {
        iceTypes: ['shell_ice', 'black_ice'],
        skateQuality: 'good',
        suitability: 'dont_go',
      }),
      card('me', 1, { iceTypes: ['snow_ice'] }), // the author's own
      card('cat', 30, { iceTypes: ['black_ice'] }), // last week
      { ...card('dan', -2, { iceTypes: ['black_ice'] }) }, // a clock in the future
    ];
    const s = peerSuggestions(cards, { now: NOW, authorUsername: 'me' });
    expect(s.reporters).toBe(2);
    expect(s.iceTypes).toEqual([
      { key: 'black_ice', count: 2 },
      { key: 'shell_ice', count: 1 },
    ]);
    expect(s.surfaceTags).toEqual([{ key: 'glass', count: 1 }]);
    expect(s.quality).toEqual([{ key: 'good', count: 2 }]);
    expect(s.suitability).toEqual([{ key: 'dont_go', count: 1 }]);
    expect(PEER_WINDOW_MS).toBe(24 * HOUR);
  });

  it('an empty window offers nothing', () => {
    const s = peerSuggestions([card('ann', 40)], { now: NOW });
    expect(s.reporters).toBe(0);
    expect(s.iceTypes).toEqual([]);
  });
});

describe('peerLine', () => {
  it('names up to three values and the number of people; null with nothing to say', () => {
    expect(peerLine([], 3)).toBeNull();
    expect(peerLine([{ key: 'glass', count: 1 }], 0)).toBeNull();
    expect(peerLine([{ key: 'glass', count: 1 }], 1)).toBe(
      'Someone said glass earlier today — same?',
    );
    expect(
      peerLine(
        [
          { key: 'black_ice', count: 2 },
          { key: 'glass', count: 2 },
          { key: 'shell_ice', count: 1 },
          { key: 'snow_ice', count: 1 },
        ],
        2,
      ),
    ).toBe('2 people said black ice, glass, shell ice earlier today — same?');
  });
});
