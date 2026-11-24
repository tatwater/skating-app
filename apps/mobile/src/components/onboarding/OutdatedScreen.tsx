import { ONBOARDING_COPY } from '@skating/core';
import { OnboardingFrame, StepHeader } from './OnboardingFrame';

/**
 * **Time for an update** (not drawn): where the terms or the questions stop when the server refuses
 * `client_outdated` — the words this build carries aren't the ones the server knows, and only a new
 * build carries the new ones. Blocking on purpose: nothing here re-arms the step, and there is no
 * button but the bar's *Sign out*. It never says what changed (a Privacy Notice change alone isn't
 * new terms).
 */
export function OutdatedScreen({ kicker, onSignOut }: { kicker: string; onSignOut: () => void }) {
  const copy = ONBOARDING_COPY.outdated;
  return (
    <OnboardingFrame onSignOut={onSignOut}>
      <StepHeader kicker={kicker} step={null} heading={copy.heading} lede={copy.phone} />
    </OnboardingFrame>
  );
}
