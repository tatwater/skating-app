import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_RECENT_PICKS,
  type RecentPick,
  readPersistedRecents,
  useSearchStore,
} from './searchStore';

const initial = useSearchStore.getState();

const pick = (id: string): RecentPick => ({ kind: 'water_body', id });

beforeEach(() => {
  localStorage.clear();
  useSearchStore.setState({ ...initial, open: false, owner: null, recents: [] }, true);
});

describe('recents', () => {
  it('adds newest first, deduplicating by kind and id', () => {
    const s = useSearchStore.getState();
    s.addRecent(pick('a'));
    s.addRecent(pick('b'));
    s.addRecent(pick('a'));
    expect(useSearchStore.getState().recents.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('treats the same id under a different kind as a different pick', () => {
    const s = useSearchStore.getState();
    s.addRecent({ kind: 'water_body', id: 'x' });
    s.addRecent({ kind: 'skater', id: 'x' });
    expect(useSearchStore.getState().recents).toHaveLength(2);
  });

  it(`caps at ${MAX_RECENT_PICKS}`, () => {
    const s = useSearchStore.getState();
    for (let i = 0; i < MAX_RECENT_PICKS + 3; i += 1) s.addRecent(pick(`p${i}`));
    expect(useSearchStore.getState().recents).toHaveLength(MAX_RECENT_PICKS);
    expect(useSearchStore.getState().recents[0]?.id).toBe(`p${MAX_RECENT_PICKS + 2}`);
  });

  it('persists only for a bound owner', () => {
    useSearchStore.getState().addRecent(pick('anon'));
    expect(localStorage.getItem('gli-search-recents')).toBeNull();

    useSearchStore.getState().bindOwner('user_a');
    useSearchStore.getState().addRecent(pick('mine'));
    expect(readPersistedRecents(localStorage, 'user_a').map((r) => r.id)).toContain('mine');
  });
});

describe('owner binding', () => {
  it('restores the bound owner recents', () => {
    localStorage.setItem(
      'gli-search-recents',
      JSON.stringify({ owner: 'user_a', recents: [pick('a')] }),
    );
    useSearchStore.getState().bindOwner('user_a');
    expect(useSearchStore.getState().recents).toEqual([pick('a')]);
  });

  it("clears another account's stored recents", () => {
    localStorage.setItem(
      'gli-search-recents',
      JSON.stringify({ owner: 'user_a', recents: [pick('a')] }),
    );
    useSearchStore.getState().bindOwner('user_b');
    expect(useSearchStore.getState().recents).toEqual([]);
    expect(localStorage.getItem('gli-search-recents')).toBeNull();
  });
});

describe('open state', () => {
  it('is plain state for the shell and the / hotkey', () => {
    useSearchStore.getState().setOpen(true);
    expect(useSearchStore.getState().open).toBe(true);
  });
});

describe('readPersistedRecents', () => {
  it('caps and tolerates junk', () => {
    const many = Array.from({ length: 10 }, (_, i) => pick(`p${i}`));
    localStorage.setItem('gli-search-recents', JSON.stringify({ owner: 'u', recents: many }));
    expect(readPersistedRecents(localStorage, 'u')).toHaveLength(MAX_RECENT_PICKS);
    localStorage.setItem('gli-search-recents', JSON.stringify({ owner: 'u', recents: 'x' }));
    expect(readPersistedRecents(localStorage, 'u')).toEqual([]);
    expect(readPersistedRecents(localStorage, null)).toEqual([]);
  });
});
