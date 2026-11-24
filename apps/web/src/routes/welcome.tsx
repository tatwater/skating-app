import type { WelcomeStep } from '@skating/core';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';

import { WelcomePage } from '../components/skater/onboarding/EntryPages';
import { welcomeSearchSchema } from '../components/skater/onboarding/entrySearch';

/**
 * A new or re-introduced account's last two steps (B03 §9.6, D298): Home, then Profile. Both are
 * optional; the profile's `welcomeStep` says which one is due, and the URL follows it.
 */
export const Route = createFileRoute('/welcome')({
  validateSearch: welcomeSearchSchema,
  component: WelcomeRoute,
});

function WelcomeRoute() {
  const { step } = Route.useSearch();
  const navigate = useNavigate({ from: '/welcome' });
  const onStep = useCallback(
    (next: WelcomeStep, options?: { replace?: boolean }) =>
      void navigate({ search: { step: next }, replace: options?.replace ?? false }),
    [navigate],
  );
  return <WelcomePage step={step} onStep={onStep} />;
}
