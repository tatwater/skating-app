import { SignIn } from '@clerk/tanstack-react-start';
import { createFileRoute } from '@tanstack/react-router';

/**
 * Sign-in (D26). We use Clerk's prebuilt `<SignIn>` component rather than hand-rolling the
 * flow with `useSignIn` (as mobile does): this SDK version exposes the newer "signals"
 * custom-flow API, and the prebuilt component gives email/password + verification, error
 * handling, and resend for free — same outcome, far less surface. `routing="hash"` keeps
 * Clerk's multi-step flow on this single path (no catch-all route needed). On success the
 * `AuthGate` takes over: a provisioned user lands in the app, a new one goes to onboarding.
 */
export const Route = createFileRoute('/sign-in')({ component: SignInPage });

function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <SignIn routing="hash" signUpUrl="/sign-up" fallbackRedirectUrl="/" />
    </div>
  );
}
