import { useEffect, useState } from 'react';
import { BackHandler } from 'react-native';
import { AccountStep } from '../src/components/onboarding/AccountStep';
import { useEntrySession } from '../src/components/onboarding/EntrySession';
import { type AccountFields, TermsStep } from '../src/components/onboarding/TermsStep';
import { type AccountDraft, EMPTY_ACCOUNT_DRAFT } from '../src/lib/accountStep';
import { useSignOut } from '../src/lib/useSignOut';

/**
 * **A new account's way in** (D298; B03 §9.6 boards 11.1–11.5, §9.7): Account, then Terms, as
 * internal steps of one screen, so the Account fields ride in memory to the acceptance and nothing
 * is written before *Record acceptance* creates the row. Reached when the gate says `account` — no
 * profile row yet, or a canceled deletion's emptied one (re-introduced in place by the acceptance).
 *
 * After the acceptance the root holds this screen for the receipt (the row now exists and the route
 * has moved on); the receipt's button releases it, and the gate takes the skater on to the
 * questions. A sign-out from either step goes back to the sign-in.
 */
export default function OnboardingScreen() {
  const { session, dispatch } = useEntrySession();
  const signOut = useSignOut();
  const [step, setStep] = useState<'account' | 'terms'>('account');
  const [draft, setDraft] = useState<AccountDraft>(EMPTY_ACCOUNT_DRAFT);
  const [account, setAccount] = useState<AccountFields | null>(null);
  const [refused, setRefused] = useState<ReadonlySet<string>>(new Set());

  // The Account step was on screen: this is a new account, and its steps carry "N of 5".
  useEffect(() => {
    dispatch({ type: 'accountSeen' });
  }, [dispatch]);

  // Android's back goes from Terms to Account, not out of the app — until the acceptance is in.
  const held = session.hold === 'receipt';
  useEffect(() => {
    if (step !== 'terms') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!held) setStep('account');
      return true;
    });
    return () => sub.remove();
  }, [step, held]);

  if (step === 'terms' && account !== null) {
    return (
      <TermsStep
        account={account}
        showStep
        heldOn="onboarding"
        onAccountRefused={(code, username) => {
          // A name someone took between the steps stays marked; any other account refusal just
          // sends the skater back to fix the field (the toast says which).
          if (code === 'username_taken') setRefused((names) => new Set(names).add(username));
          setStep('account');
        }}
      />
    );
  }

  return (
    <AccountStep
      draft={draft}
      onDraft={setDraft}
      refused={refused}
      // The 18+ rule's clock: read per render, as the field is typed.
      nowMs={Date.now()}
      onSignOut={() => void signOut()}
      onContinue={(fields) => {
        setAccount(fields);
        setStep('terms');
      }}
    />
  );
}
