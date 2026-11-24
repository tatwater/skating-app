import { useEntrySession } from '../src/components/onboarding/EntrySession';
import { TermsStep } from '../src/components/onboarding/TermsStep';

/**
 * **The terms, for an existing account** (D295; B03 §9.6 boards 11.2–11.5): the first sign-in after
 * the terms changed, or after this build retired the old acknowledgment. The same reading and
 * receipt as a new account's Terms step, with no Account fields and — a returning account — no step
 * counter. The root holds this screen for the receipt.
 */
export default function TermsScreen() {
  const { session } = useEntrySession();
  return <TermsStep account={null} showStep={session.accountSeen} heldOn="terms" />;
}
