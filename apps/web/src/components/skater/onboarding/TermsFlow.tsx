import { useAuth } from '@clerk/tanstack-react-start';
import { api } from '@skating/convex/api';
import {
  consentRefusalAction,
  knowBeforeYouGoDue,
  needsProfileSetup,
  ONBOARDING_COPY,
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
  recordReceipt,
  releaseHold,
  returnToAccount,
  useEntryStore,
} from '@/lib/entryHold';

import { clientReport, toastRefusal, useProfileNow } from './consentRefusal';
import { OutdatedStep, reloadPage } from './OutdatedStep';
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
 *    Recorded, the box unlocks. Failed, the toast, and the end stays disarmed until the marker has
 *    left the screen and come back — as on the phone — so a persistent error is said once. A
 *    reading the server doesn't have (the open failed, or `terms_not_opened`) starts again from the
 *    top of whichever reader is open, disarmed the same way.
 * 3. *Record acceptance*: the hold first (`lib/entryHold` says why), then `acceptTerms`. Through,
 *    the receipt draws under the hold; refused, a toast, the hold let go, and — by core's
 *    `consentRefusalAction` — the end marker re-arms (`terms_not_read`), or a new account goes
 *    back to the Account step for any refusal of its fields (the age, the name, the handle's
 *    shape, its being taken — marked — or its cooldown), as on the phone.
 *
 * Any of the three refused `client_outdated` — this tab's bundled terms or notice aren't the
 * server's — stops the step on `OutdatedStep`, which offers a reload: reading the same text again
 * can't fix it, so nothing here re-arms after it.
 *    The events count only an acceptance this call recorded (`repeat` says when it didn't).
 * 4. The receipt's button lets go, and the gate takes it from there. *Start the questions* opens
 *    them on the first one: the receipt has just said what comes next.
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
  /** A refusal of the Account step's fields: back to it (the store keeps the fields as typed). */
  onBackToAccount: () => void;
  onSignOut: () => void;
}) {
  const analytics = useAnalytics();
  const { sessionId } = useAuth();
  const openTerms = useMutation(api.consent.openTerms);
  const reachTermsEnd = useMutation(api.consent.reachTermsEnd);
  const acceptTerms = useMutation(api.consent.acceptTerms);
  const profile = useQuery(api.profiles.current, {});
  // The profile as it stands when a refusal is heard (the gate's can't-act hold records it).
  const profileNow = useProfileNow();
  const watch = useQuery(api.consent.watchAnchor, {});
  const held = useEntryStore((s) => s.hold === 'receipt');
  const recorded = useEntryStore((s) => s.recorded);
  const receipt = useQuery(api.consent.latestTermsReceipt, recorded ? {} : 'skip');

  const [read, setRead] = useState(false);
  const [reaching, setReaching] = useState(false);
  // A failed stamp disarms the end until the marker has left the screen and come back (the phone's
  // rule): a persistent error is one toast, not a storm of retries while the end sits in view.
  const [disarmed, setDisarmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  // `client_outdated`: the step stops for good (a ref too, for the answers already on their way).
  const [outdated, setOutdated] = useState(false);
  const stopped = useRef(false);
  const stop = () => {
    stopped.current = true;
    setOutdated(true);
  };
  // What the profile was before this acceptance, for the record's context in the event.
  const before = useRef(profile);
  if (!held) before.current = profile;

  // The reading starts (again, on a reset): whether it did is what the end waits on. A refusal
  // is said here, once; the end then has nothing to record.
  const opened = useRef<Promise<boolean>>(Promise.resolve(false));
  // biome-ignore lint/correctness/useExhaustiveDependencies: the reset key is the trigger
  useEffect(() => {
    if (held) return;
    const open: Promise<boolean> = openTerms({ ...TERMS_CLAIM, surface: 'web' }).then(
      () => true,
      (error: unknown) => {
        if (opened.current === open && !stopped.current) {
          const { code } = toastRefusal(error, profileNow.current);
          if (consentRefusalAction(code) === 'outdated') stop();
        }
        return false;
      },
    );
    opened.current = open;
  }, [resetKey]);

  // The reading starts again from the top — the reader scrolls there, in the full-screen reader as
  // inline — and the end stays disarmed until the marker has left the view and come back: reached
  // again, never re-stamped the instant the new reading opens (the marker may still sit in view
  // while the scroll lands), and never a loop of opens against a server that keeps refusing.
  const restart = () => {
    setRead(false);
    setDisarmed(true);
    setResetKey((k) => k + 1);
  };

  // In flight, by ref: two sightings in one frame (both readers, a re-render) send one write.
  const inFlight = useRef(false);
  const onEnd = async (via: TermsReaderVia) => {
    if (read || inFlight.current) return;
    inFlight.current = true;
    setReaching(true);
    try {
      // A reading the server never started has no end to record: begin it again from the top —
      // unless it was refused as out of date, which no new reading can fix.
      if (!(await opened.current)) {
        if (!stopped.current) restart();
        return;
      }
      await reachTermsEnd({ ...TERMS_CLAIM, via });
      setRead(true);
      analytics.capture('terms_read_to_end', { via });
    } catch (error) {
      const { code } = toastRefusal(error, profileNow.current);
      const action = consentRefusalAction(code);
      switch (action) {
        case 'outdated':
          stop();
          break;
        case 'reopen':
          // Nothing to reach the end of: the reading starts again from the top.
          restart();
          break;
        case 'rearm':
        case 'account':
        case 'say':
          // Tried again only once the end has been off screen and back.
          setDisarmed(true);
          break;
        default: {
          const unhandled: never = action;
          throw new Error(`unhandled refusal action: ${String(unhandled)}`);
        }
      }
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
      const { repeat } = await acceptTerms({
        ...TERMS_CLAIM,
        privacyVersion: PRIVACY_NOTICE_VERSION,
        privacyHash: PRIVACY_NOTICE_SHA256,
        ...clientReport(),
        ...(sessionId ? { clientSessionId: sessionId } : {}),
        ...(account !== null ? { account } : {}),
      });
      recordReceipt();
      // A repeat (a second tab, a retry after a lost answer) returned the first acceptance: the
      // receipt draws, but the one sealed record is counted once.
      if (repeat) return;
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
      const { code } = toastRefusal(error, profileNow.current);
      const action = consentRefusalAction(code);
      if (account !== null && action === 'account') {
        returnToAccount(code === 'username_taken' ? account.username : undefined);
        onBackToAccount();
        return;
      }
      releaseHold();
      switch (action) {
        case 'outdated':
          stop();
          break;
        case 'reopen':
          restart();
          break;
        case 'rearm':
          setRead(false);
          setDisarmed(false);
          break;
        // An existing account has no Account step: its toast is all there is.
        case 'account':
        case 'say':
          break;
        default: {
          const unhandled: never = action;
          throw new Error(`unhandled refusal action: ${String(unhandled)}`);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  if (outdated) {
    return (
      <OutdatedStep
        kicker={ONBOARDING_COPY.terms.kicker}
        email={email}
        onReload={reloadPage}
        onSignOut={onSignOut}
      />
    );
  }

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
        onContinue={() => finishReceipt(due)}
        onSignOut={onSignOut}
      />
    );
  }

  return (
    <TermsStep
      step={step}
      read={read}
      armed={!read && !reaching && !held && !disarmed}
      disarmed={disarmed}
      onEndGone={() => setDisarmed(false)}
      busy={busy || (held && !recorded)}
      resetKey={resetKey}
      email={email}
      onEnd={(via) => void onEnd(via)}
      onRecord={() => void onRecord()}
      onSignOut={onSignOut}
    />
  );
}
