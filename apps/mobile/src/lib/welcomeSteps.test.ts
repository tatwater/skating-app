import { describe, expect, it } from 'vitest';
import {
  EMPTY_HOME_FIELD,
  type HomeChoice,
  homeCoordOf,
  homeFieldReducer,
  initialProfileDraft,
  profileStepPatch,
  townOf,
} from './welcomeSteps';

const SUGGESTION = {
  label: '14 School Street, Hanover, NH 03755, USA',
  lat: 43.7,
  lng: -72.29,
  town: 'Hanover, NH',
};
const PICKED: HomeChoice = { kind: 'address', suggestion: SUGGESTION };
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

describe('homeFieldReducer', () => {
  const suggestion = SUGGESTION;

  it('keeps the field and the choice together through a pick, typing and the location', () => {
    const picked = homeFieldReducer(EMPTY_HOME_FIELD, { type: 'picked', suggestion });
    expect(picked).toEqual({ text: suggestion.label, choice: PICKED, reset: 1 });
    // Typing un-picks.
    expect(homeFieldReducer(picked, { type: 'typed', text: '14 School St' })).toEqual({
      text: '14 School St',
      choice: null,
      reset: 1,
    });
    // The location replaces the address, and empties the field.
    expect(homeFieldReducer(picked, { type: 'located', lat: 44.1, lng: -72.5 })).toEqual({
      text: '',
      choice: HERE,
      reset: 2,
    });
  });

  it('signals the field to forget its query on a pick, the location and a skip, never on typing', () => {
    let field = EMPTY_HOME_FIELD;
    const resets: number[] = [];
    const on = (event: Parameters<typeof homeFieldReducer>[1]) => {
      field = homeFieldReducer(field, event);
      resets.push(field.reset);
    };
    on({ type: 'typed', text: '1' });
    on({ type: 'typed', text: '14' });
    on({ type: 'typed', text: '14 School' });
    on({ type: 'picked', suggestion });
    on({ type: 'typed', text: '14 School St' });
    on({ type: 'located', lat: 44.1, lng: -72.5 });
    on({ type: 'typed', text: '9 Main' });
    on({ type: 'skipped' });
    expect(resets).toEqual([0, 0, 0, 1, 1, 2, 2, 3]);
  });

  it('a skip takes the picked address off the field with its choice, so a failed skip leaves no orphan', () => {
    const picked = homeFieldReducer(EMPTY_HOME_FIELD, { type: 'picked', suggestion });
    const skipped = homeFieldReducer(picked, { type: 'skipped' });
    expect(skipped).toEqual({ ...EMPTY_HOME_FIELD, reset: 2 });
    // Nothing on the field said a home was chosen when none is: Save has nothing to save, and
    // shows nothing that suggests otherwise.
    expect(homeCoordOf(skipped.choice)).toBeNull();
    expect(skipped.text).toBe('');
    expect(homeFieldReducer(skipped, { type: 'skipped' })).toBe(skipped);
  });
});
