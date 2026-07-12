import { SignUp } from '@clerk/tanstack-react-start'
import { createFileRoute } from '@tanstack/react-router'

/**
 * Sign-up (D26): Clerk's prebuilt `<SignUp>` (see the sign-in note for why prebuilt over a
 * hand-rolled `useSignUp` flow). It creates the Clerk account (email + password +
 * verification) only — the profile fields and the blocking Phase 0 gates (16+ age gate D41,
 * assumption-of-risk ack D45) are collected right after on the onboarding page and passed
 * to the enforced `upsertFromClerk` mutation. Once the session is active the `AuthGate`
 * routes the (still unprovisioned) user to onboarding.
 */
export const Route = createFileRoute('/sign-up')({ component: SignUpPage })

function SignUpPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <SignUp routing="hash" signInUrl="/sign-in" fallbackRedirectUrl="/" />
    </div>
  )
}
