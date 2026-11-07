import { createFileRoute, Link } from '@tanstack/react-router';
import { ChipLink } from '../components/skater/auth/ChipLink';
import { SignUpFlow } from '../components/skater/auth/SignUpFlow';
import { SystemStage } from '../components/skater/auth/SystemStage';

/**
 * Sign-up (D26), a custom flow over the region (B03 §1.6, 8.4). It creates the Clerk account only;
 * once the session is active the `AuthGate` routes the still unprovisioned user to onboarding.
 */
export const Route = createFileRoute('/sign-up')({ component: SignUpPage });

function SignUpPage() {
  return (
    <SystemStage corner={<ChipLink link={<Link to="/about" />}>About Gli</ChipLink>}>
      <SignUpFlow otherLink={<ChipLink link={<Link to="/sign-in" />}>Sign in</ChipLink>} />
    </SystemStage>
  );
}
