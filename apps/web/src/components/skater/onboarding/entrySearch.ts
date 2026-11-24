import type { WelcomeStep } from '@skating/core';
import { z } from 'zod';

/**
 * The way in's search params (B03 §9.6): zod objects with `.catch` defaults, so a bad link
 * degrades to the step's default instead of an error (§1's grammar rule). The step a page *draws*
 * is then settled against what the skater actually has ({@link onboardingStepShown},
 * {@link welcomeStepShown}): a URL can ask for a step, never skip one.
 */

/** `/onboarding?step=account|terms`: a new account's first two steps. */
export const onboardingSearchSchema = z.object({
  step: z.enum(['account', 'terms']).catch('account'),
});

export type OnboardingStep = z.infer<typeof onboardingSearchSchema>['step'];

/** `/welcome?step=home|profile`. */
export const welcomeSearchSchema = z.object({
  step: z.enum(['home', 'profile']).catch('home'),
});

/**
 * Which of `/onboarding`'s steps draws. The Terms step needs the Account step's fields, which ride
 * in memory: with none carried (a reload, a pasted link) it falls back to the Account step. A held
 * receipt is the exception — the fields are spent by then, and the receipt draws where the
 * acceptance was recorded.
 */
export function onboardingStepShown(
  asked: OnboardingStep,
  carried: { account: boolean; held: boolean },
): OnboardingStep {
  if (carried.held) return 'terms';
  return asked === 'terms' && carried.account ? 'terms' : 'account';
}

/**
 * Which welcome step draws: the profile's own (`welcomeStep`, which only the server moves), so a
 * link to `?step=profile` can't skip Home. Before the profile has loaded, the URL's.
 */
export function welcomeStepShown(
  asked: WelcomeStep,
  current: WelcomeStep | undefined,
): WelcomeStep {
  return current ?? asked;
}
