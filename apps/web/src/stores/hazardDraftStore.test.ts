import { beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_HAZARD_DRAFT,
  type HazardDraft,
  readPersistedDraft,
  useHazardDraftStore,
} from './hazardDraftStore';

const initial = useHazardDraftStore.getState();

const DRAFT: HazardDraft = {
  ...EMPTY_HAZARD_DRAFT,
  step: 'details',
  note: 'thin strip by the point',
};

beforeEach(() => {
  localStorage.clear();
  useHazardDraftStore.setState({ ...initial, owner: null, draft: null, photoFiles: [] }, true);
});

describe('owner binding', () => {
  it('restores the bound owner draft', () => {
    localStorage.setItem('gli-hazard-draft', JSON.stringify({ owner: 'user_a', draft: DRAFT }));
    useHazardDraftStore.getState().bindOwner('user_a');
    expect(useHazardDraftStore.getState().draft).toEqual(DRAFT);
  });

  it("discards another account's stored draft, storage included", () => {
    localStorage.setItem('gli-hazard-draft', JSON.stringify({ owner: 'user_a', draft: DRAFT }));
    useHazardDraftStore.getState().bindOwner('user_b');
    expect(useHazardDraftStore.getState().draft).toBeNull();
    expect(localStorage.getItem('gli-hazard-draft')).toBeNull();
  });

  it('restores nothing when signed out, and leaves the owner draft stored', () => {
    localStorage.setItem('gli-hazard-draft', JSON.stringify({ owner: 'user_a', draft: DRAFT }));
    useHazardDraftStore.getState().bindOwner(null);
    expect(useHazardDraftStore.getState().draft).toBeNull();
    // Signed out is not an account mismatch: user_a may sign back in on this browser.
    expect(localStorage.getItem('gli-hazard-draft')).not.toBeNull();
  });

  it('rebinding the same owner is a no-op (does not clobber an open draft)', () => {
    useHazardDraftStore.getState().bindOwner('user_a');
    useHazardDraftStore.getState().setDraft(DRAFT);
    useHazardDraftStore.getState().bindOwner('user_a');
    expect(useHazardDraftStore.getState().draft).toEqual(DRAFT);
  });
});

describe('draft lifecycle', () => {
  it('persists words and geometry for the bound owner; photos stay in memory', () => {
    useHazardDraftStore.getState().bindOwner('user_a');
    useHazardDraftStore.getState().setDraft(DRAFT);
    useHazardDraftStore.getState().setPhotoFiles([new File(['x'], 'ice.jpg')]);
    expect(readPersistedDraft(localStorage, 'user_a')).toEqual({ ...DRAFT, photoCount: 1 });
    const raw = localStorage.getItem('gli-hazard-draft') ?? '';
    expect(raw).not.toContain('ice.jpg');
  });

  it('updateDraft merges into the open draft and re-persists', () => {
    useHazardDraftStore.getState().bindOwner('user_a');
    useHazardDraftStore.getState().setDraft(DRAFT);
    useHazardDraftStore.getState().updateDraft({ note: 'twelve' });
    expect(useHazardDraftStore.getState().draft?.note).toBe('twelve');
    expect(readPersistedDraft(localStorage, 'user_a')?.note).toBe('twelve');
  });

  it('updateDraft with no open draft is a no-op', () => {
    useHazardDraftStore.getState().updateDraft({ note: 'x' });
    expect(useHazardDraftStore.getState().draft).toBeNull();
  });

  it('clearDraft ends the flow: memory, photos and storage', () => {
    useHazardDraftStore.getState().bindOwner('user_a');
    useHazardDraftStore.getState().setDraft(DRAFT);
    useHazardDraftStore.getState().setPhotoFiles([new File(['x'], 'ice.jpg')]);
    useHazardDraftStore.getState().clearDraft();
    const state = useHazardDraftStore.getState();
    expect(state.draft).toBeNull();
    expect(state.photoFiles).toEqual([]);
    expect(localStorage.getItem('gli-hazard-draft')).toBeNull();
  });
});

describe('readPersistedDraft', () => {
  it('fills missing fields from the empty draft, so an older shape still restores', () => {
    const partial = { step: 'what', note: 'old' };
    localStorage.setItem('gli-hazard-draft', JSON.stringify({ owner: 'user_a', draft: partial }));
    expect(readPersistedDraft(localStorage, 'user_a')).toEqual({
      ...EMPTY_HAZARD_DRAFT,
      note: 'old',
    });
  });

  it('is null for a mangled record', () => {
    localStorage.setItem('gli-hazard-draft', JSON.stringify({ owner: 'user_a' }));
    expect(readPersistedDraft(localStorage, 'user_a')).toBeNull();
  });
});

describe('restore rules (agent J)', () => {
  it('a restored draft is never mid-placement, never mid-nudge, and says it was restored', () => {
    localStorage.setItem(
      'gli-hazard-draft',
      JSON.stringify({
        owner: 'user_a',
        draft: { ...DRAFT, placing: true, nearbyHazardId: 'h1', step: 'confirm', photoCount: 2 },
      }),
    );
    useHazardDraftStore.getState().bindOwner('user_a');
    const state = useHazardDraftStore.getState();
    expect(state.restored).toBe(true);
    expect(state.draft).toMatchObject({
      placing: false,
      nearbyHazardId: null,
      step: 'details',
      photoCount: 2,
    });
  });

  it('a mangled stored draft restores nothing', () => {
    localStorage.setItem('gli-hazard-draft', JSON.stringify({ owner: 'user_a', draft: 'nope' }));
    expect(readPersistedDraft(localStorage, 'user_a')).toBeNull();
  });

  it('clearing ends the restored state too', () => {
    localStorage.setItem('gli-hazard-draft', JSON.stringify({ owner: 'user_a', draft: DRAFT }));
    useHazardDraftStore.getState().bindOwner('user_a');
    useHazardDraftStore.getState().clearDraft();
    expect(useHazardDraftStore.getState().restored).toBe(false);
  });
});
