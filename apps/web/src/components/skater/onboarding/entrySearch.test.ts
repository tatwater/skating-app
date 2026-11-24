import { describe, expect, it } from 'vitest';

import {
  onboardingSearchSchema,
  onboardingStepShown,
  welcomeSearchSchema,
  welcomeStepShown,
} from './entrySearch';

describe('the way in’s search params', () => {
  it('reads /onboarding’s step, and degrades anything else to the Account step', () => {
    expect(onboardingSearchSchema.parse({ step: 'terms' })).toEqual({ step: 'terms' });
    expect(onboardingSearchSchema.parse({ step: 'account' })).toEqual({ step: 'account' });
    expect(onboardingSearchSchema.parse({})).toEqual({ step: 'account' });
    expect(onboardingSearchSchema.parse({ step: 'questions' })).toEqual({ step: 'account' });
    expect(onboardingSearchSchema.parse({ step: 2 })).toEqual({ step: 'account' });
  });

  it('reads /welcome’s step, and degrades anything else to Home', () => {
    expect(welcomeSearchSchema.parse({ step: 'profile' })).toEqual({ step: 'profile' });
    expect(welcomeSearchSchema.parse({})).toEqual({ step: 'home' });
    expect(welcomeSearchSchema.parse({ step: 'map' })).toEqual({ step: 'home' });
  });
});

describe('onboardingStepShown', () => {
  it('draws the Terms step only with the Account step’s fields carried', () => {
    expect(onboardingStepShown('terms', { account: true, held: false })).toBe('terms');
    // A reload or a pasted link: the fields are gone, so back to the Account step.
    expect(onboardingStepShown('terms', { account: false, held: false })).toBe('account');
  });

  it('never skips the Account step on its own say-so', () => {
    expect(onboardingStepShown('account', { account: true, held: false })).toBe('account');
    expect(onboardingStepShown('account', { account: false, held: false })).toBe('account');
  });

  it('keeps the receipt where it was recorded, though the fields are spent', () => {
    expect(onboardingStepShown('terms', { account: false, held: true })).toBe('terms');
    expect(onboardingStepShown('account', { account: false, held: true })).toBe('terms');
  });
});

describe('welcomeStepShown', () => {
  it('draws the profile’s own step, whatever the URL asks', () => {
    expect(welcomeStepShown('profile', 'home')).toBe('home');
    expect(welcomeStepShown('home', 'profile')).toBe('profile');
  });

  it('follows the URL only until the profile has said', () => {
    expect(welcomeStepShown('profile', undefined)).toBe('profile');
    expect(welcomeStepShown('home', undefined)).toBe('home');
  });
});
