import { describe, expect, it } from 'vitest';
import {
  type HomeChoice,
  homeCoordOf,
  initialProfileDraft,
  profileStepPatch,
  townOf,
} from './welcomeSteps';

const PICKED: HomeChoice = {
  kind: 'address',
  suggestion: {
    label: '14 School Street, Hanover, NH 03755, USA',
    lat: 43.7,
    lng: -72.29,
    town: 'Hanover, NH',
  },
};
const HERE: HomeChoice = { kind: 'location', lat: 44.1, lng: -72.5 };

describe('homeCoordOf', () => {
  it('saves the picked address or the phone’s location, nothing otherwise', () => {
    expect(homeCoordOf(PICKED)).toEqual({ lat: 43.7, lng: -72.29 });
    expect(homeCoordOf(HERE)).toEqual({ lat: 44.1, lng: -72.5 });
    expect(homeCoordOf(null)).toBeNull();
  });
});

describe('townOf', () => {
  it('takes the town from a picked address only', () => {
    expect(townOf(PICKED)).toBe('Hanover, NH');
    expect(townOf({ kind: 'address', suggestion: { label: 'Somewhere', lat: 1, lng: 1 } })).toBe(
      '',
    );
    expect(townOf(HERE)).toBe('');
    expect(townOf(null)).toBe('');
  });
});

describe('initialProfileDraft', () => {
  it('starts with both switches on and the town prefilled (board 11.12)', () => {
    expect(initialProfileDraft(PICKED, 'public')).toEqual({
      bio: '',
      town: 'Hanover, NH',
      publicProfile: true,
      showTown: true,
    });
    expect(initialProfileDraft(null, undefined).publicProfile).toBe(true);
    expect(initialProfileDraft(null, 'private').publicProfile).toBe(false);
  });
});

describe('profileStepPatch', () => {
  const draft = initialProfileDraft(PICKED, 'public');

  it('saves the town only while Show my town is on', () => {
    expect(profileStepPatch(draft, 'public')).toEqual({ homeTownLabel: 'Hanover, NH' });
    expect(profileStepPatch({ ...draft, showTown: false }, 'public')).toBeNull();
  });

  it('writes visibility only when the switch differs from the row', () => {
    const blank = { ...draft, town: '' };
    // A new account (public): switched off writes private; left on writes nothing.
    expect(profileStepPatch({ ...blank, publicProfile: false }, 'public')).toEqual({
      profileVisibility: 'private',
    });
    expect(profileStepPatch(blank, 'public')).toBeNull();
    // A re-introduced account (private, D298): left off writes nothing; switched on writes public.
    const reintroduced = initialProfileDraft(null, 'private');
    expect(profileStepPatch(reintroduced, 'private')).toBeNull();
    expect(profileStepPatch({ ...reintroduced, publicProfile: true }, 'private')).toEqual({
      profileVisibility: 'public',
    });
  });

  it('saves a trimmed bio and a tidied town, and nothing for blank fields', () => {
    expect(
      profileStepPatch(
        { ...draft, bio: '  Lunchtime skater.  ', town: ' Norwich,   VT ' },
        'public',
      ),
    ).toEqual({ bio: 'Lunchtime skater.', homeTownLabel: 'Norwich, VT' });
    expect(profileStepPatch({ ...draft, bio: '   ', town: '  ' }, 'public')).toBeNull();
  });
});
