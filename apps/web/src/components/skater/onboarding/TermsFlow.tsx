import { useAuth } from '@clerk/tanstack-react-start';
import { api } from '@skating/convex/api';
import {
  consentRefusalAction,
  consentRefusalMessage,
  knowBeforeYouGoDue,
  needsProfileSetup,
  ONBOARDING_COPY,
  PRIVACY_NOTICE_SHA256,
  PRIVACY_NOTICE_VERSION,
  receiptLine,
  TERMS,
  TERMS_SHA256,
  termsAcceptanceContext,
  termsOpenRetryDue,
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

import { toast } from '../../kit/toast';
import { clientReport, readConsentRefusal, toastRefusal } from './consentRefusal';
import { OutdatedStep, reloadPage } from './OutdatedStep';
import type { TermsReaderVia } from './TermsReader';
import { ReceiptStep, TermsStep } from './TermsStep';

const TERMS_CLAIM = { termsVersion: TERMS.version, termsHash: TERMS_SHA256 };

/**
 * **The Terms step, wired** (boards 10.3–10.5, 11.2–11.5; D295): the same for a new account
 * (`/onboarding?step=terms`, with the Account step's fields) and an existing one (`/terms`).
 *
 * 1. The reader opens: `openTerms` stamps the reading (the server keeps the first stamp). A failed
 *    opening is said, then tried again quietly as the skater scrolls (no more often than core's
 *    `TERMS_OPEN_RETRY_GAP_MS`), so the server normally has the reading by the end — as on the phone.
 * 2. The end marker on screen: `reachTermsEnd` with the reader it was reached in — only on an
 *    opening that has answered. An end reached while one is out (the first, or a retry) never
 *    counts on it: once it answers, the marker must leave the screen and come back, so the record
 *    can never say the terms were opened and finished in one instant. Recorded, the box unlocks.
 *    Failed, the toast, and the end stays disarmed until the marker has left the screen and come
 *    back — as on the phone — so a persistent error is said once. A reading the server doesn't
 *    have (no opening ever succeeded — said in `terms_not_opened`'s words — or `terms_not_opened`
 *    itself) starts again from the top of whichever reader is open, disarmed the same way; one the
 *    server refused as unable to act says the server's words instead, and only disarms.
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

  // The reading starts (again, on a reset). Its opening is `out` until the server answers and
  // `open` once it has the reading; `null` once its last try failed (`failure` says how): the server
  // has nothing for the end to finish. A failure is said here when it is the step's first opening,
  // or when it is out of date (which stops the step). A retry, or a reading started again, opens
  // quietly: the skater was told already, and the end says why if it is still unopened.
  const opening = useRef<{ status: 'out' | 'open' } | null>(null);
  const failure = useRef<{ error: unknown } | null>(null);
  const lastTry = useRef<number | null>(null);
  // An opening is out: a disarmed end waits for it to answer before it watches the marker leave, so
  // an arrival while it was out never counts on it (the phone's rule).
  const [openingOut, setOpeningOut] = useState(false);
  const openReading = (quiet: boolean) => {
    const mine: { status: 'out' | 'open' } = { status: 'out' };
    opening.current = mine;
    failure.current = null;
    lastTry.current = Date.now();
    setOpeningOut(true);
    openTerms({ ...TERMS_CLAIM, surface: 'web' }).then(
      () => {
        if (opening.current !== mine) return;
        mine.status = 'open';
        setOpeningOut(false);
      },
      (error: unknown) => {
        if (opening.current !== mine || stopped.current) return;
        opening.current = null;
        failure.current = { error };
        setOpeningOut(false);
        const final = consentRefusalAction(readConsentRefusal(error).code) === 'outdated';
        if (final || !quiet) toastRefusal(error);
        if (final) stop();
      },
    );
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the reset key is the trigger
  useEffect(() => {
    if (held) return;
    openReading(resetKey !== 0);
  }, [resetKey]);
  // Still reading with no opening: the next scroll tries again, at most once per gap — not while the
  // end waits for the marker to leave (it has just said why).
  const onReading = () => {
    if (failure.current === null || stopped.current || held || disarmed) return;
    if (termsOpenRetryDue(lastTry.current, Date.now())) openReading(true);
  };

  // The reading starts again from the top — the reader scrolls there, in the full-screen reader as
  // inline — and the end stays disarmed until the marker has left the view and come back: reached
  // again, never re-stamped the instant the new reading opens (the marker may still sit in view
  // while the scroll lands), and never a loop of opens against a server that keeps refusing.
  const restart = () => {
    failure.current = null;
    setRead(false);
    setDisarmed(true);
    setResetKey((k) => k + 1);
  };

  // The end reached on a reading the server never opened: said in `terms_not_opened`'s words, and
  // begun again from the top. A can't-act refusal is said in the server's words instead, and the end
  // waits for the marker to come back: no second toast, no restart, no new opening on top of it.
  const unopened = () => {
    if (stopped.current) return;
    const failed = failure.current;
    if (failed !== null && readConsentRefusal(failed.error).cannotAct) {
      toastRefusal(failed.error);
      setDisarmed(true);
      return;
    }
    toast({ title: consentRefusalMessage('terms_not_opened'), tone: 'bad' });
    restart();
  };

  // In flight, by ref: two sightings in one frame (both readers, a re-render) send one write.
  const inFlight = useRef(false);
  const onEnd = async (via: TermsReaderVia) => {
    if (read || inFlight.current) return;
    const mine = opening.current;
    // An opening still out: this arrival never counts on it, even once it answers.
    if (mine?.status === 'out') {
      setDisarmed(true);
      return;
    }
    if (mine === null) {
      unopened();
      return;
    }
    inFlight.current = true;
    setReaching(true);
    try {
      await reachTermsEnd({ ...TERMS_CLAIM, via });
      setRead(true);
      analytics.capture('terms_read_to_end', { via });
    } catch (error) {
      const { code } = toastRefusal(error);
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
      const { code } = toastRefusal(error);
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
      // Watched for leaving only once no opening is out.
      disarmed={disarmed && !openingOut}
      onEndGone={() => setDisarmed(false)}
      busy={busy || (held && !recorded)}
      resetKey={resetKey}
      email={email}
      onEnd={(via) => void onEnd(via)}
      onScrollActivity={onReading}
      onRecord={() => void onRecord()}
      onSignOut={onSignOut}
    />
  );
}
