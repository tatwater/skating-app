import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';

import { OnboardingPage } from '../components/skater/onboarding/EntryPages';
import {
  type OnboardingStep,
  onboardingSearchSchema,
} from '../components/skater/onboarding/entrySearch';

/**
 * A new account's way in (B03 §9.6, D298): the Account step, then the Terms step at
 * `?step=terms`. Reached only when the skater is signed in with no profile row, or a canceled
 * deletion's emptied one (`AuthGate`). Nothing is written until *Record acceptance*, which is
 * where the profile is born; the gate moves on when the profile says so and the receipt lets go.
 */
export const Route = createFileRoute('/onboarding')({
  validateSearch: onboardingSearchSchema,
  component: OnboardingRoute,
});

function OnboardingRoute() {
  const { step } = Route.useSearch();
  const navigate = useNavigate({ from: '/onboarding' });
  const onStep = useCallback(
    (next: OnboardingStep, options?: { replace?: boolean }) =>
      void navigate({ search: { step: next }, replace: options?.replace ?? false }),
    [navigate],
  );
  return <OnboardingPage step={step} onStep={onStep} />;
}
