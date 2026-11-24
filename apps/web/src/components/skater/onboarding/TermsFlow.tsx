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
  TERMS_WAITING_LINE_MS,
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

/** One try at opening a reading. */
interface Opening {
  /** `out` until the server answers, `open` once it has the reading. */
  status: 'out' | 'open';
  /** An earlier try of this reading failed: most of it was read with no reading on the server. */
  retry: boolean;
  /** The end was reached while this try was out, and waits on its answer, which it speaks for. */
  awaited: boolean;
  /** How it answered; `stale` once a newer reading (or the step's leaving) overtook it. */
  answer: Promise<'open' | 'failed' | 'stale'>;
}

/**
 * **The Terms step, wired** (boards 10.3–10.5, 11.2–11.5; D295): the same for a new account
 * (`/onboarding?step=terms`, with the Account step's fields) and an existing one (`/terms`).
 *
 * 1. The reader opens: `openTerms` stamps the reading (the server keeps the first stamp). A failed
 *    opening is said, then tried again quietly as the skater scrolls (no more often than core's
 *    `TERMS_OPEN_RETRY_GAP_MS`), so the server normally has the reading by the end — as on the phone.
 * 2. The end marker on screen: `reachTermsEnd` with the reader it was reached in — only on an
 *    opening that has answered. An end reached while one is out waits for its answer: the
 *    reading's first opening, answered, is stamped then (a slow connection, a text that fits the
 *    screen); a retry's answer, whatever it is, means most of the text was read with no reading on
 *    the server, so it starts over as below. Recorded, the box unlocks. Failed, the toast, and the
 *    end stays disarmed until the marker has left the screen and come back — as on the phone — so a
 *    persistent error is said once. A reading the server doesn't have (no opening succeeded — said
 *    in `terms_not_opened`'s words, or the server's own when it refused the account as unable to
 *    act — or `terms_not_opened` itself) starts again from the top of whichever reader is open,
 *    and its end counts only once the marker has left the screen and been reached again.
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
  // A reached end still waiting on the server after a while (its opening unanswered, or its stamp
  // out — offline, say): a quiet line says why the box is still locked, as on the phone.
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    setWaiting(false);
    if (!reaching) return;
    const timer = setTimeout(() => setWaiting(true), TERMS_WAITING_LINE_MS);
    return () => clearTimeout(timer);
  }, [reaching]);
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

  // The step is gone (the phone's `disposed`): a late answer says nothing on another screen.
  const gone = useRef(false);
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
    };
  }, []);

  // The reading starts (again, on a reset). Its opening is `out` until the server answers and
  // `open` once it has the reading; `null` once its last try failed (`failure` says how): the server
  // has nothing for the end to finish. A failure is said here when it is the step's first opening,
  // or when it is out of date (which stops the step) — unless an end waits on it, which says why
  // itself. A retry, or a reading started again, opens quietly: the skater was told already, and
  // the end says why if it is still unopened.
  const opening = useRef<Opening | null>(null);
  const failure = useRef<{ error: unknown } | null>(null);
  const lastTry = useRef<number | null>(null);
  const openReading = (quiet: boolean) => {
    const mine: Opening = {
      status: 'out',
      retry: failure.current !== null,
      awaited: false,
      answer: Promise.resolve('stale'),
    };
    opening.current = mine;
    failure.current = null;
    lastTry.current = Date.now();
    mine.answer = openTerms({ ...TERMS_CLAIM, surface: 'web' }).then(
      () => {
        if (opening.current !== mine || gone.current) return 'stale';
        mine.status = 'open';
        return 'open';
      },
      (error: unknown) => {
        if (opening.current !== mine || stopped.current || gone.current) return 'stale';
        opening.current = null;
        failure.current = { error };
        const final = consentRefusalAction(readConsentRefusal(error).code) === 'outdated';
        if (final || (!quiet && !mine.awaited)) toastRefusal(error);
        if (final) stop();
        return 'failed';
      },
    );
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the reset key is the trigger
  useEffect(() => {
    if (held) return;
    openReading(resetKey !== 0);
  }, [resetKey]);
  // Still reading with no opening: the next scroll tries again, at most once per gap.
  const onReading = () => {
    if (failure.current === null || stopped.current || held) return;
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

  // The end reached on a reading the server doesn't have: said — in `terms_not_opened`'s words, or
  // the server's own for a refusal of the account as unable to act — and begun again from the top.
  const unopened = () => {
    if (stopped.current) return;
    const failed = failure.current;
    if (failed !== null && readConsentRefusal(failed.error).cannotAct) toastRefusal(failed.error);
    else toast({ title: consentRefusalMessage('terms_not_opened'), tone: 'bad' });
    restart();
  };

  // In flight, by ref: two sightings in one frame (both readers, a re-render) send one write.
  const inFlight = useRef(false);
  const onEnd = async (via: TermsReaderVia) => {
    if (read || inFlight.current) return;
    const mine = opening.current;
    if (mine === null) {
      unopened();
      return;
    }
    inFlight.current = true;
    setReaching(true);
    try {
      // An opening still out: the end waits on its answer. The reading's first, answered, counts;
      // a retry's answer, whatever it is, starts the reading over.
      if (mine.status === 'out') {
        mine.awaited = true;
        const answer = await mine.answer;
        if (answer === 'stale' || gone.current) return;
        if (answer === 'failed' || mine.retry) {
          unopened();
          return;
        }
      }
      await reachTermsEnd({ ...TERMS_CLAIM, via });
      setRead(true);
      analytics.capture('terms_read_to_end', { via });
    } catch (error) {
      if (gone.current) return;
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
      waiting={waiting && reaching}
      armed={!read && !reaching && !held && !disarmed}
      disarmed={disarmed}
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
