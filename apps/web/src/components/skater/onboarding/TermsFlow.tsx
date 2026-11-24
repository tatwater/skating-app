import { useAuth } from '@clerk/tanstack-react-start';
import { api } from '@skating/convex/api';
import {
  knowBeforeYouGoDue,
  needsProfileSetup,
  PRIVACY_NOTICE_SHA256,
  PRIVACY_NOTICE_VERSION,
  receiptLine,
  TERMS,
  TERMS_SHA256,
  termsAcceptanceContext,
} from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { useEffect, useRef, useState } from 'react';

import { useAnalytics } from '@/lib/analytics';
import {
  type AccountDraft,
  finishReceipt,
  holdForReceipt,
  markUsernameTaken,
  recordReceipt,
  releaseHold,
  useEntryStore,
} from '@/lib/entryHold';

import { clientReport, toastRefusal } from './consentRefusal';
import type { TermsReaderVia } from './TermsReader';
import { ReceiptStep, TermsStep } from './TermsStep';

const TERMS_CLAIM = { termsVersion: TERMS.version, termsHash: TERMS_SHA256 };

/**
 * **The Terms step, wired** (boards 10.3–10.5, 11.2–11.5; D295): the same for a new account
 * (`/onboarding?step=terms`, with the Account step's fields) and an existing one (`/terms`).
 *
 * 1. The reader opens: `openTerms` stamps the reading (the server keeps the first stamp).
 * 2. The end marker on screen: `reachTermsEnd` with the reader it was reached in — after the open
 *    has answered, so a fast scroll can't reach the end of a reading the server hasn't started.
 *    Recorded, the box unlocks.
 * 3. *Record acceptance*: the hold first (`lib/entryHold` says why), then `acceptTerms`. Through,
 *    the receipt draws under the hold; refused, a toast, the hold let go, and — by code — the
 *    reading starts again (`terms_changed`), the end marker re-arms (`terms_not_read`), or the
 *    skater goes back to the Account step with the handle marked (`username_taken`).
 * 4. The receipt's button lets go, and the gate takes it from there.
 */
export function TermsFlow({
  account,
  step,
  email,
  onBackToAccount,
  onSignOut,
}: {
  /** The Account step's values for a new or re-introduced account; `null` for an existing one. */
  account: AccountDraft | null;
  /** "2 of 5" for an account new this session. */
  step: number | null;
  email: string | null;
  /** `username_taken`: back to the Account step (the store marks the handle). */
  onBackToAccount: () => void;
  onSignOut: () => void;
}) {
  const analytics = useAnalytics();
  const { sessionId } = useAuth();
  const openTerms = useMutation(api.consent.openTerms);
  const reachTermsEnd = useMutation(api.consent.reachTermsEnd);
  const acceptTerms = useMutation(api.consent.acceptTerms);
  const profile = useQuery(api.profiles.current, {});
  const watch = useQuery(api.consent.watchAnchor, {});
  const held = useEntryStore((s) => s.hold === 'receipt');
  const recorded = useEntryStore((s) => s.recorded);
  const receipt = useQuery(api.consent.latestTermsReceipt, recorded ? {} : 'skip');

  const [read, setRead] = useState(false);
  const [reaching, setReaching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  // What the profile was before this acceptance, for the record's context in the event.
  const before = useRef(profile);
  if (!held) before.current = profile;

  // The reading starts (again, on a reset): its promise is what the end waits on.
  const opened = useRef<Promise<unknown> | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the reset key is the trigger
  useEffect(() => {
    if (held) return;
    const open = openTerms({ ...TERMS_CLAIM, surface: 'web' });
    opened.current = open;
    open.catch((error: unknown) => {
      if (opened.current === open) toastRefusal(error);
    });
  }, [resetKey]);

  const restart = () => {
    setRead(false);
    setResetKey((k) => k + 1);
  };

  // In flight, by ref: two sightings in one frame (both readers, a re-render) send one write.
  const inFlight = useRef(false);
  const onEnd = async (via: TermsReaderVia) => {
    if (read || inFlight.current) return;
    inFlight.current = true;
    setReaching(true);
    try {
      await opened.current;
      await reachTermsEnd({ ...TERMS_CLAIM, via });
      setRead(true);
      analytics.capture('terms_read_to_end', { via });
    } catch (error) {
      const { code } = toastRefusal(error);
      // Nothing to reach the end of: the reading starts again from the top.
      if (code === 'terms_changed' || code === 'terms_not_opened') restart();
    } finally {
      inFlight.current = false;
      setReaching(false);
    }
  };

  const onRecord = async () => {
    if (busy) return;
    setBusy(true);
    const found = before.current;
    holdForReceipt();
    try {
      await acceptTerms({
        ...TERMS_CLAIM,
        privacyVersion: PRIVACY_NOTICE_VERSION,
        privacyHash: PRIVACY_NOTICE_SHA256,
        ...clientReport(),
        ...(sessionId ? { clientSessionId: sessionId } : {}),
        ...(account !== null ? { account } : {}),
      });
      recordReceipt();
      const context = termsAcceptanceContext(
        found === null || found === undefined
          ? { profile: 'none' }
          : needsProfileSetup(found)
            ? { profile: 'emptied' }
            : { profile: 'live', termsVersion: found.termsVersion },
      );
      analytics.capture('terms_accepted', { context });
      if (context === 'first_run') analytics.capture('onboarding_completed');
    } catch (error) {
      const { code } = toastRefusal(error);
      if (code === 'username_taken' && account !== null) {
        markUsernameTaken(account.username);
        onBackToAccount();
      } else {
        releaseHold();
        if (code === 'terms_changed') restart();
        else if (code === 'terms_not_read') setRead(false);
      }
    } finally {
      setBusy(false);
    }
  };

  if (held && recorded) {
    const due =
      profile === undefined || profile === null
        ? true
        : knowBeforeYouGoDue(
            profile.knowBeforeYouGoAt,
            watch === undefined || watch === null ? null : { openedAt: watch.openedAt },
          ) !== null;
    // `pending` with no address yet says nothing: the copy may still go, to an address found later.
    const line =
      receipt === undefined || receipt === null
        ? null
        : receipt.copy === 'pending' && receipt.email === null
          ? null
          : receiptLine(receipt.copy, receipt.email);
    return (
      <ReceiptStep
        step={step}
        line={line}
        questionsDue={due}
        email={email}
        onContinue={finishReceipt}
        onSignOut={onSignOut}
      />
    );
  }

  return (
    <TermsStep
      step={step}
      read={read}
      armed={!read && !reaching && !held}
      busy={busy || (held && !recorded)}
      resetKey={resetKey}
      email={email}
      onEnd={(via) => void onEnd(via)}
      onRecord={() => void onRecord()}
      onSignOut={onSignOut}
    />
  );
}
