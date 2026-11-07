import { createFileRoute, Link } from '@tanstack/react-router';
import { ChipLink } from '../components/skater/auth/ChipLink';
import { SignInFlow } from '../components/skater/auth/SignInFlow';
import { SystemStage } from '../components/skater/auth/SystemStage';

/**
 * Sign-in (D26), a custom flow over the region (B03 §1.6, 8.1–8.3). On success the `AuthGate` takes
 * over: a provisioned user lands in the app, a new one goes to onboarding.
 */
export const Route = createFileRoute('/sign-in')({ component: SignInPage });

function SignInPage() {
  return (
    <SystemStage corner={<ChipLink link={<Link to="/about" />}>About Gli</ChipLink>}>
      <SignInFlow
        otherLink={<ChipLink link={<Link to="/sign-up" />}>Create an account</ChipLink>}
      />
    </SystemStage>
  );
}
